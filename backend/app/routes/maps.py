import json
import os
import subprocess
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from PIL import Image
from pydantic import BaseModel

from app import (config, data_use, edge_registry, ingest, jobs, map_classes, map_export, model_registry, revert,
                 serializers, store, weights)
from app.backend_client import BackendClient, BackendError, Item
from app.remote_models import scan_image
from app.deps import (attachment, current_user, get_db, get_user, require_job_access,
                      require_page_access, require_region_access, require_role, require_unchanged)

router = APIRouter(tags=['maps'])


@router.get('/api/map-classes')
def get_map_classes():
    # Legacy: the default vocabulary. The editor now reads per-job classes from
    # GET /api/jobs/{id}/map-classes; kept for backward compatibility.
    """The built-in map class vocabulary."""
    return {'classes': map_classes.classes_payload()}


@router.get('/api/map-models')
def get_map_models():
    """Pre-annotation models available in the registry, for the New Job dropdown, and
    whether this deployment can run tiling and pre-annotation at all (`runner`)."""
    problem = jobs.map_runner_problem()
    return {'models': model_registry.list_models(),
            'runner': {'available': problem is None, 'reason': problem}}


def _edge_cli() -> Path:
    return config.EDGE_DETECT_ROOT / 'detect' / 'cli.py'


def _edge_backend() -> BackendClient | None:
    """The edges model backend (4.7), once it is configured with a URL; until then the
    detector runs as the edge_detection repo's CLI."""
    backend = config.MODEL_BACKENDS.get(weights.TASK_BACKENDS['edges'])
    return BackendClient(backend) if backend and backend.url else None


def _backend_methods(client: BackendClient) -> list[dict]:
    try:
        methods = client.info().get('tasks_detail', {}).get('edges', {}).get('methods') or []
    except BackendError as error:
        raise HTTPException(502, f'edge detection backend: {error.message}') from None
    return [{'id': m['id'], 'label': m.get('label', m['id']), 'params': m.get('params', {}), 'available': True}
            for m in methods]


@router.get('/api/edge-methods')
def get_edge_methods():
    """Edge detectors for the tile editor's area-detect tool.

    `configured` is about the host, not the registry: the methods are listed either way,
    but without the interpreter and the repo behind them the tool can only say so. On an
    edges backend, the backend's own list is the one offered.
    """
    client = _edge_backend()
    if client is not None:
        return {'configured': True, 'methods': _backend_methods(client)}
    configured = bool(
        config.EDGE_DETECT_PYTHON and config.EDGE_DETECT_PYTHON.exists() and _edge_cli().exists())
    return {'configured': configured, 'methods': edge_registry.list_methods()}


# --- Map-segmentation regions -------------------------------------------------

def _valid_points(points, minimum: int, what: str) -> list:
    if not isinstance(points, list) or len(points) < minimum:
        raise HTTPException(400, f'a {what} needs at least {minimum} points')
    out = []
    for pt in points:
        if not isinstance(pt, list) or len(pt) != 2:
            raise HTTPException(400, f'{what} points must be [x, y]')
        x, y = float(pt[0]), float(pt[1])
        if not (0 <= x <= 1 and 0 <= y <= 1):
            raise HTTPException(400, f'{what} points must be normalized to [0, 1]')
        out.append([x, y])
    return out


def _valid_ring(ring) -> list:
    return _valid_points(ring, 3, 'ring')


def _valid_polyline(points) -> list:
    # An open traced line: two points already describe one, and it has no interior.
    return _valid_points(points, 2, 'polyline')


def _valid_geometry(kind: str, points, holes):
    """Validate (points, holes) against a region's kind. Polylines carry no holes."""
    if kind == 'polyline':
        if holes:
            raise HTTPException(400, 'a polyline cannot have holes')
        return _valid_polyline(points), []
    return _valid_ring(points), _valid_holes(holes)


def _valid_holes(holes) -> list:
    if holes is None:
        return []
    if not isinstance(holes, list):
        raise HTTPException(400, 'holes must be a list of rings')
    return [_valid_ring(h) for h in holes]


def _drawable_ids(conn, job_id: str) -> list:
    return [r['class_id'] for r in conn.execute(
        'SELECT class_id FROM job_classes WHERE job_id = ? AND class_id != 0 ORDER BY class_id', (job_id,))]


def _valid_class_id(conn, job_id: str, class_id: int) -> int:
    ids = _drawable_ids(conn, job_id)
    if class_id not in ids:
        raise HTTPException(400, f'class_id must be one of {ids}')
    return class_id


class RegionCreate(BaseModel):
    class_id: int
    points: list[list[float]]
    holes: list[list[list[float]]] = []
    # Kind is per-region so a job can hold both; it defaults to polygon, keeping
    # every existing client's payload valid unchanged.
    kind: Literal['polygon', 'polyline'] = 'polygon'


@router.post('/api/pages/{page_id}/regions')
def create_region(page_id: int, body: RegionCreate, conn=Depends(get_db), user: str = Depends(get_user),
                  auth: dict = Depends(current_user)):
    """Add a polygon or polyline region to a map tile."""
    require_page_access(conn, page_id, auth)
    page = conn.execute('SELECT deleted, job_id FROM pages WHERE id = ?', (page_id,)).fetchone()
    if page is None:
        raise HTTPException(404)
    if page['deleted']:
        raise HTTPException(409, 'page is deleted')
    class_id = _valid_class_id(conn, page['job_id'], body.class_id)
    points, holes = _valid_geometry(body.kind, body.points, body.holes)
    mark = store.begin_span(conn)
    order_idx = conn.execute(
        'SELECT COALESCE(MAX(order_idx), -1) + 1 n FROM regions WHERE page_id = ?', (page_id,)).fetchone()['n']
    # A human just drew it, so it is reviewed by construction (mirrors create_element).
    cur = conn.execute(
        'INSERT INTO regions (page_id, order_idx, class_id, points, holes, kind, checked) '
        'VALUES (?,?,?,?,?,?,1)',
        (page_id, order_idx, class_id, json.dumps(points), json.dumps(holes), body.kind))
    store.log_region(conn, cur.lastrowid, user, 'create')
    span = store.end_span(conn, mark)
    conn.commit()
    return {**serializers.get_region(conn, cur.lastrowid), 'span': span}


class RegionDetect(BaseModel):
    method: str
    # The selected area, as a ring. A rectangle marquee arrives as its four corners, so
    # both selection shapes take one path from here down.
    area: list[list[float]]
    class_id: int


def _run_edge_cli(method: dict, image: Path, area: list) -> list:
    """Run one detection and return the polylines it found, normalized to the image.

    The detector needs OpenCV and numpy, which this venv does not have, so it runs in the
    edge_detection_repo's own interpreter with that repo on PYTHONPATH — the arrangement
    _spawn_map_runner uses for the map-segmentation runner, minus the queue: one selection
    is interactive work, and the classical methods answer in a fraction of a second.
    """
    argv = [
        str(config.EDGE_DETECT_PYTHON), '-m', 'detect.cli',
        '--image', str(image),
        '--area', json.dumps(area),
        '--method', method['id'],
        '--params', json.dumps(edge_registry.default_params(method)),
    ]
    ckpt = edge_registry.checkpoint_path(method)
    if ckpt is not None:
        argv += ['--checkpoint', str(ckpt)]
    env = os.environ.copy()
    env['PYTHONPATH'] = str(config.EDGE_DETECT_ROOT)
    try:
        proc = subprocess.run(argv, capture_output=True, text=True, env=env,
                              cwd=str(config.EDGE_DETECT_ROOT), timeout=config.EDGE_DETECT_TIMEOUT)
    except subprocess.TimeoutExpired:
        raise HTTPException(504, f'edge detection timed out after {config.EDGE_DETECT_TIMEOUT:g}s')
    except OSError as exc:
        raise HTTPException(502, f'could not start edge detection: {exc}')
    if proc.returncode != 0:
        raise HTTPException(502, f'edge detection failed: {proc.stderr.strip()[-300:]}')
    try:
        polylines = json.loads(proc.stdout)['polylines']
    except (ValueError, KeyError, TypeError):
        raise HTTPException(502, 'edge detection returned no usable output')
    if not isinstance(polylines, list):
        raise HTTPException(502, 'edge detection returned no usable output')
    return polylines


def _run_edge_backend(client: BackendClient, method: dict, image: Path, area: list) -> list:
    """One detection on the edges backend: synchronous, one tile, the selected area."""
    params = {'method': method['id'], 'area': area,
              'method_params': {name: spec['default'] for name, spec in method.get('params', {}).items()
                                if isinstance(spec, dict) and 'default' in spec}}
    with Image.open(image) as opened:
        tile = scan_image(str(image), opened.convert('RGB'))
    try:
        response = client.predict('edges', None, params, [Item('tile', tile)])
    except BackendError as error:
        raise HTTPException(502, f'edge detection failed: {error.message}') from None
    result = (response.get('results') or [{}])[0]
    if 'error' in result:
        raise HTTPException(502, f"edge detection failed: {result['error'].get('message')}")
    polylines = result.get('polylines')
    if not isinstance(polylines, list):
        raise HTTPException(502, 'edge detection returned no usable output')
    return polylines


def _usable_polylines(polylines: list) -> list:
    """Keep the lines that are storable, drop the rest silently.

    A detector producing one malformed line should cost that line, not the whole run —
    unlike a hand-drawn region, where a bad payload is a bug worth surfacing.
    """
    out = []
    for line in polylines:
        if not isinstance(line, list) or len(line) < 2:
            continue
        points = []
        for pt in line:
            if not isinstance(pt, list) or len(pt) != 2:
                break
            try:
                x, y = float(pt[0]), float(pt[1])
            except (TypeError, ValueError):
                break
            if not (0 <= x <= 1 and 0 <= y <= 1):
                break
            points.append([x, y])
        else:
            out.append(points)
    return out


@router.post('/api/pages/{page_id}/regions/detect')
def detect_regions(page_id: int, body: RegionDetect, conn=Depends(get_db),
                   auth: dict = Depends(current_user)):
    """Trace the edges inside a selected area into polyline regions.

    They land unreviewed and authored `model:edge@<method>`, the convention the map
    runner's predictions use: machine output stays distinguishable from hand tracing, and
    a re-predict keeps whichever ones a human has since edited.
    """
    require_page_access(conn, page_id, auth)
    page = conn.execute(
        'SELECT deleted, job_id, source_file FROM pages WHERE id = ?', (page_id,)).fetchone()
    if page is None:
        raise HTTPException(404)
    if page['deleted']:
        raise HTTPException(409, 'page is deleted')
    job = conn.execute('SELECT task FROM jobs WHERE id = ?', (page['job_id'],)).fetchone()
    if job is None or job['task'] != 'map_lines':
        raise HTTPException(400, 'edge detection is only available on line-tracing jobs')
    class_id = _valid_class_id(conn, page['job_id'], body.class_id)
    area = _valid_ring(body.area)

    client = _edge_backend()
    if client is None:
        if not config.EDGE_DETECT_PYTHON or not config.EDGE_DETECT_PYTHON.exists():
            raise HTTPException(503, 'EDGE_DETECT_PYTHON is not set to an existing interpreter; '
                                     'edge detection is unavailable on this server')
        if not _edge_cli().exists():
            raise HTTPException(503, f'EDGE_DETECT_ROOT ({config.EDGE_DETECT_ROOT}) does not point at '
                                     'the edge_detection repo')
    methods = _backend_methods(client) if client else edge_registry.list_methods()
    method = next((m for m in methods if m['id'] == body.method), None)
    if method is None:
        raise HTTPException(400, f"unknown method {body.method!r}; available: {[m['id'] for m in methods]}")
    if client is None:
        method = edge_registry.get_method(body.method)
        if not edge_registry.available(method):
            raise HTTPException(409, f'the checkpoint for {body.method!r} is missing')
    source = Path(page['source_file'] or '')
    if not source.is_file():
        raise HTTPException(409, 'the tile image is not available on this server')

    found = _run_edge_backend(client, method, source, area) if client else _run_edge_cli(method, source, area)
    lines = _usable_polylines(found)
    if not lines:
        mark = store.revision_mark(conn)
        return {'regions': [], 'span': {'from': mark, 'to': mark}}

    mark = store.begin_span(conn)
    order_idx = conn.execute(
        'SELECT COALESCE(MAX(order_idx), -1) + 1 n FROM regions WHERE page_id = ?', (page_id,)).fetchone()['n']
    author = f'model:edge@{method["id"]}'
    ids = []
    for offset, points in enumerate(lines):
        cur = conn.execute(
            'INSERT INTO regions (page_id, order_idx, class_id, points, holes, kind, checked) '
            "VALUES (?,?,?,?,'[]','polyline',0)",
            (page_id, order_idx + offset, class_id, json.dumps(points)))
        store.log_region(conn, cur.lastrowid, author, 'create')
        ids.append(cur.lastrowid)
    span = store.end_span(conn, mark)
    conn.commit()
    return {'regions': [serializers.get_region(conn, rid) for rid in ids], 'span': span}


class RegionPatch(BaseModel):
    class_id: int | None = None
    points: list[list[float]] | None = None
    holes: list[list[list[float]]] | None = None
    checked: bool | None = None
    deleted: bool | None = None  # deleted=false is the undo-restore path
    # The revision the client loaded; refused with 409 if someone saved since.
    revision: int | None = None


@router.patch('/api/regions/{region_id}')
def patch_region(region_id: int, body: RegionPatch, conn=Depends(get_db), user: str = Depends(get_user),
                 auth: dict = Depends(current_user)):
    """Update a region's geometry, class or reviewed flag."""
    require_region_access(conn, region_id, auth)
    row = conn.execute(
        'SELECT r.id, r.kind, r.class_id, p.job_id FROM regions r JOIN pages p ON r.page_id = p.id '
        'WHERE r.id = ?', (region_id,)).fetchone()
    if row is None:
        raise HTTPException(404)
    store.write_lock(conn)
    require_unchanged(conn, 'region', region_id, body.revision, lambda: serializers.get_region(conn, region_id))
    # A class_id sent along is checked against the palette below.
    if body.deleted is False and body.class_id is None:
        try:
            revert.refuse_missing_class(conn, row['job_id'], row['class_id'])
        except revert.Conflict as exc:
            raise HTTPException(409, exc.detail)
    store.ensure_origin(conn, 'region', region_id, user)
    mark = store.begin_span(conn)
    fields = body.model_fields_set
    # Kind is immutable: revisions and exported pixels are read against it, and a
    # polygon↔polyline switch is a redraw, not an edit.
    kind = row['kind']
    if 'class_id' in fields and body.class_id is not None:
        conn.execute('UPDATE regions SET class_id = ? WHERE id = ?',
                     (_valid_class_id(conn, row['job_id'], body.class_id), region_id))
    if 'points' in fields and body.points is not None:
        points = _valid_polyline(body.points) if kind == 'polyline' else _valid_ring(body.points)
        conn.execute('UPDATE regions SET points = ? WHERE id = ?', (json.dumps(points), region_id))
    if 'holes' in fields and body.holes is not None:
        if kind == 'polyline' and body.holes:
            raise HTTPException(400, 'a polyline cannot have holes')
        conn.execute('UPDATE regions SET holes = ? WHERE id = ?', (json.dumps(_valid_holes(body.holes)), region_id))
    if 'checked' in fields and body.checked is not None:
        conn.execute('UPDATE regions SET checked = ? WHERE id = ?', (int(body.checked), region_id))
    if 'deleted' in fields and body.deleted is not None:
        conn.execute('UPDATE regions SET deleted = ? WHERE id = ?', (int(body.deleted), region_id))
    store.log_region(conn, region_id, user, 'update')
    span = store.end_span(conn, mark)
    conn.commit()
    return {**serializers.get_region(conn, region_id), 'span': span}


@router.delete('/api/regions/{region_id}')
def delete_region(region_id: int, conn=Depends(get_db), user: str = Depends(get_user),
                  auth: dict = Depends(current_user)):
    """Soft-delete a region."""
    require_region_access(conn, region_id, auth)
    if conn.execute('SELECT id FROM regions WHERE id = ?', (region_id,)).fetchone() is None:
        raise HTTPException(404)
    store.ensure_origin(conn, 'region', region_id, user)
    mark = store.begin_span(conn)
    conn.execute('UPDATE regions SET deleted = 1 WHERE id = ?', (region_id,))
    store.log_region(conn, region_id, user, 'delete')
    span = store.end_span(conn, mark)
    conn.commit()
    return {'id': region_id, 'deleted': True, 'span': span}


@router.get('/api/regions/{region_id}/revisions')
def region_revisions(region_id: int, conn=Depends(get_db), auth: dict = Depends(current_user)):
    """One region's change history, newest first."""
    require_region_access(conn, region_id, auth)
    rows = conn.execute(
        'SELECT id, author, action, snapshot, created_at FROM revisions '
        "WHERE target_type = 'region' AND target_id = ? ORDER BY id DESC", (region_id,)).fetchall()
    return [{'id': r['id'], 'author': r['author'], 'action': r['action'],
             'created_at': r['created_at'], 'snapshot': json.loads(r['snapshot'])} for r in rows]


# --- Per-job class vocabulary -------------------------------------------------

def _valid_color(color) -> list:
    if not isinstance(color, list) or len(color) != 3:
        raise HTTPException(400, 'color must be [r, g, b]')
    for v in color:
        if not isinstance(v, int) or not (0 <= v <= 255):
            raise HTTPException(400, 'color channels must be integers 0..255')
    return color


def _class_payload(conn, job_id: str, class_id: int) -> dict:
    r = conn.execute('SELECT class_id, name, color, priority_rank FROM job_classes '
                     'WHERE job_id = ? AND class_id = ?', (job_id, class_id)).fetchone()
    return {'id': r['class_id'], 'name': r['name'], 'color': json.loads(r['color']),
            'priority': r['priority_rank']}


def _region_counts(conn, job_id: str) -> dict:
    return {r['class_id']: r['c'] for r in conn.execute(
        'SELECT r.class_id, COUNT(*) c FROM regions r JOIN pages p ON r.page_id = p.id '
        'WHERE p.job_id = ? AND r.deleted = 0 AND p.deleted = 0 GROUP BY r.class_id', (job_id,))}


@router.get('/api/jobs/{job_id}/map-classes')
def job_map_classes(job_id: str, conn=Depends(get_db), auth: dict = Depends(current_user)):
    """The editable class palette of one map dataset."""
    _require_map_job(conn, job_id, auth)
    counts = _region_counts(conn, job_id)
    return {'classes': [{**c, 'regions': counts.get(c['id'], 0)} for c in store.job_classes(conn, job_id)]}


class ClassCreate(BaseModel):
    name: str
    color: list[int]


@router.post('/api/jobs/{job_id}/map-classes')
def create_job_class(job_id: str, body: ClassCreate, conn=Depends(get_db), user: str = Depends(get_user),
                     auth: dict = Depends(current_user)):
    """Add a class to a map dataset's palette."""
    _require_map_job(conn, job_id, auth)
    name = body.name.strip()
    if not name:
        raise HTTPException(400, 'name must not be empty')
    if any(c['name'].lower() == name.lower() for c in store.job_classes(conn, job_id)):
        raise HTTPException(409, f'a class named "{name}" already exists')
    color = _valid_color(body.color)
    # New id = 1 + max over the palette, every id a region or its revisions ever held
    # (merge rewrites a region's class_id), and the highest id removed from the palette,
    # so masks and predictions made under any earlier id keep their meaning.
    class_id = conn.execute(
        'SELECT COALESCE(MAX(cid), 0) + 1 n FROM ('
        '  SELECT class_id cid FROM job_classes WHERE job_id = ? '
        '  UNION SELECT r.class_id FROM regions r JOIN pages p ON r.page_id = p.id WHERE p.job_id = ? '
        "  UNION SELECT json_extract(snapshot, '$.class_id') FROM revisions "
        "         WHERE target_type = 'region' AND job_id = ? "
        '  UNION SELECT max_retired_class_id FROM jobs WHERE id = ?)',
        (job_id, job_id, job_id, job_id)).fetchone()['n']
    if class_id > map_export.MAX_CLASS_ID:
        raise HTTPException(400, 'no class id left: masks are 8-bit images, so class ids stop at '
                                 f'{map_export.MAX_CLASS_ID} and every one up to it has been used')
    priority = conn.execute(
        'SELECT COALESCE(MAX(priority_rank), -1) + 1 n FROM job_classes WHERE job_id = ?', (job_id,)).fetchone()['n']
    conn.execute('INSERT INTO job_classes (job_id, class_id, name, color, priority_rank) VALUES (?,?,?,?,?)',
                 (job_id, class_id, name, json.dumps(color), priority))
    conn.commit()
    return {**_class_payload(conn, job_id, class_id), 'regions': 0}


class ClassPatch(BaseModel):
    name: str | None = None
    color: list[int] | None = None


@router.patch('/api/jobs/{job_id}/map-classes/{class_id}')
def patch_job_class(job_id: str, class_id: int, body: ClassPatch, conn=Depends(get_db),
                    user: str = Depends(get_user), auth: dict = Depends(current_user)):
    """Rename or recolour a class in the palette."""
    _require_map_job(conn, job_id, auth)
    if class_id == 0:
        raise HTTPException(400, 'background is fixed')
    if conn.execute('SELECT 1 FROM job_classes WHERE job_id = ? AND class_id = ?',
                    (job_id, class_id)).fetchone() is None:
        raise HTTPException(404)
    fields = body.model_fields_set
    if 'name' in fields and body.name is not None:
        name = body.name.strip()
        if not name:
            raise HTTPException(400, 'name must not be empty')
        if any(c['name'].lower() == name.lower() and c['id'] != class_id
               for c in store.job_classes(conn, job_id)):
            raise HTTPException(409, f'a class named "{name}" already exists')
        conn.execute('UPDATE job_classes SET name = ? WHERE job_id = ? AND class_id = ?', (name, job_id, class_id))
    if 'color' in fields and body.color is not None:
        conn.execute('UPDATE job_classes SET color = ? WHERE job_id = ? AND class_id = ?',
                     (json.dumps(_valid_color(body.color)), job_id, class_id))
    conn.commit()
    return {**_class_payload(conn, job_id, class_id), 'regions': _region_counts(conn, job_id).get(class_id, 0)}


class ClassOrder(BaseModel):
    # Drawable class ids, the one that wins an overlap first.
    order: list[int]


@router.put('/api/jobs/{job_id}/map-classes/order')
def reorder_job_classes(job_id: str, body: ClassOrder, conn=Depends(get_db),
                        auth: dict = Depends(current_user)):
    """Set the overlap priority of the palette. Only the ranks change: ids are what
    regions, revisions and exported masks hold. Background always ranks last."""
    _require_map_job(conn, job_id, auth)
    drawable = _drawable_ids(conn, job_id)
    if sorted(body.order) != drawable:
        raise HTTPException(400, f'order must list every class except background exactly once: {drawable}')
    for rank, class_id in enumerate([*body.order, 0]):
        conn.execute('UPDATE job_classes SET priority_rank = ? WHERE job_id = ? AND class_id = ?',
                     (rank, job_id, class_id))
    conn.commit()
    return job_map_classes(job_id, conn, auth)


@router.delete('/api/jobs/{job_id}/map-classes/{class_id}')
def delete_job_class(job_id: str, class_id: int, mode: str = 'delete', into: int | None = None,
                     conn=Depends(get_db), user: str = Depends(get_user),
                     auth: dict = Depends(current_user)):
    """Remove a class from the palette."""
    _require_map_job(conn, job_id, auth)
    if class_id == 0:
        raise HTTPException(400, 'background cannot be removed')
    if conn.execute('SELECT 1 FROM job_classes WHERE job_id = ? AND class_id = ?',
                    (job_id, class_id)).fetchone() is None:
        raise HTTPException(404)
    if mode not in ('delete', 'merge'):
        raise HTTPException(400, "mode must be 'delete' or 'merge'")
    if mode == 'merge':
        if into is None or into == class_id or into == 0:
            raise HTTPException(400, 'merge needs a different, non-background target class')
        if conn.execute('SELECT 1 FROM job_classes WHERE job_id = ? AND class_id = ?',
                        (job_id, into)).fetchone() is None:
            raise HTTPException(400, f'unknown merge target: {into}')
    region_ids = [r['id'] for r in conn.execute(
        'SELECT r.id FROM regions r JOIN pages p ON r.page_id = p.id '
        'WHERE p.job_id = ? AND r.class_id = ? AND r.deleted = 0', (job_id, class_id))]
    for rid in region_ids:
        if mode == 'delete':
            conn.execute('UPDATE regions SET deleted = 1 WHERE id = ?', (rid,))
            store.log_region(conn, rid, user, 'delete')
        else:
            conn.execute('UPDATE regions SET class_id = ? WHERE id = ?', (into, rid))
            store.log_region(conn, rid, user, 'update')  # human-authored → survives re-predict
    conn.execute('DELETE FROM job_classes WHERE job_id = ? AND class_id = ?', (job_id, class_id))
    conn.execute('UPDATE jobs SET max_retired_class_id = MAX(max_retired_class_id, ?) WHERE id = ?',
                 (class_id, job_id))
    conn.commit()
    return {'removed': class_id, 'mode': mode, 'into': into if mode == 'merge' else None,
            'regions_affected': len(region_ids)}


# --- Mask export --------------------------------------------------------------

def _require_map_job(conn, job_id: str, auth: dict) -> dict:
    """The job, gated. Access is checked before existence is confirmed, so an unshared
    job is indistinguishable from a missing one (mirrors deps.require_job_access)."""
    require_job_access(conn, job_id, auth)
    job = store.get_job(conn, job_id)
    if job is None:
        raise HTTPException(404)
    if not ingest.is_tile_task(job['task']):
        raise HTTPException(400, 'not a map job')
    return job


def _export_dest(job: dict, fused: bool) -> Path:
    """Where a server-side export lands. The fused set gets its own directory: the two
    layouts differ (maps/ vs annotations/, map-sized vs tile-sized), and a trainer pointed
    at one directory must never find both."""
    slug = map_export.slug(job['name']) + ('-fused' if fused else '')
    return config.MASK_EXPORT_DIR / slug


def _collect_export(conn, job: dict, include_all: bool, fused: bool) -> tuple[list, dict]:
    """The payload for either export variant, with the refusals both share."""
    if not fused:
        return map_export.collect(conn, job['id'], include_all=include_all)
    if include_all:
        # Not a silent no-op: the fused mask has no per-tile boundary to attribute an
        # unreviewed area to, so shipping one would misstate the whole map.
        raise HTTPException(400, 'fused export is reviewed-only (drop include_all)')
    if not job['run_tile']:
        raise HTTPException(400, 'job has no tiled source maps (its tiles were uploaded directly)')
    return map_export.collect_fused(conn, job['id'])


def _refuse_empty(manifest: dict, fused: bool) -> None:
    if fused and not manifest['maps']:
        raise HTTPException(400, 'no reviewed tiles on any tiled source map')
    if not fused and not manifest['tiles']:
        raise HTTPException(400, 'no tiles to export (mark tiles reviewed, or pass include_all)')


@router.get('/api/jobs/{job_id}/maskset/preview')
def maskset_preview(job_id: str, include_all: bool = False, fused: bool = False,
                    conn=Depends(get_db), auth: dict = Depends(current_user)):
    """What a mask export would contain, without writing anything."""
    job = _require_map_job(conn, job_id, auth)
    _, manifest = _collect_export(conn, job, include_all, fused)
    return {**manifest, 'dest': str(_export_dest(job, fused))}


@router.get('/api/jobs/{job_id}/maskset')
def maskset_download(job_id: str, include_all: bool = False, fused: bool = False,
                     conn=Depends(get_db), auth: dict = Depends(current_user)):
    """Download the prepared mask export."""
    job = _require_map_job(conn, job_id, auth)
    data_use.require_export(conn, job_id, auth)
    payload, manifest = _collect_export(conn, job, include_all, fused)
    _refuse_empty(manifest, fused)
    classes, stroke = store.job_classes(conn, job_id), job['line_width']
    body = (map_export.fused_to_zip(payload, classes, stroke) if fused
            else map_export.to_zip(payload, classes, stroke))
    name = f"{job['name']}-{'full-maps' if fused else 'masks'}.zip"
    return Response(content=body, media_type='application/zip', headers=attachment(name))


@router.post('/api/jobs/{job_id}/maskset')
def maskset_export(job_id: str, include_all: bool = False, fused: bool = False,
                   conn=Depends(get_db), auth: dict = Depends(current_user),
                   _admin=Depends(require_role('admin'))):
    """Render reviewed tiles into class-index PNG masks plus geometry sidecars."""
    job = _require_map_job(conn, job_id, auth)
    data_use.require_export(conn, job_id, auth)
    payload, manifest = _collect_export(conn, job, include_all, fused)
    _refuse_empty(manifest, fused)
    dest = _export_dest(job, fused)
    classes, stroke = store.job_classes(conn, job_id), job['line_width']
    if fused:
        map_export.fused_write(payload, dest, classes, stroke)
    else:
        map_export.write(payload, dest, classes, stroke)
    return {**manifest, 'dest': str(dest)}


# --- Re-predict ---------------------------------------------------------------

# A region "belongs to the model" when its NEWEST revision is still model-authored; any
# human edit (patch/delete/restore) writes a newer username-authored revision, so edited
# regions survive a re-predict. Mirrors the `author NOT LIKE 'model:%'` convention.
# COALESCE so a region with no revision history reads as human-authored rather than SQL
# NULL: NULL LIKE and NULL NOT LIKE are both falsy, which dropped such a region out of
# the discard *and* the kept count while the re-predict itself still kept it.
_LATEST_AUTHOR = ("COALESCE((SELECT rev.author FROM revisions rev WHERE rev.target_type = 'region' "
                  "AND rev.target_id = r.id ORDER BY rev.id DESC LIMIT 1), '')")


def _repredict_scope(conn, job_id: str, force: bool) -> dict:
    """Counts for the re-predict preview/act. Default scope leaves reviewed tiles alone;
    `force` includes them (and clears their reviewed flag on the act)."""
    gate = '' if force else 'AND p.layout_checked = 0 '
    tiles = conn.execute(
        'SELECT COUNT(*) c FROM pages p WHERE p.job_id = ? AND p.deleted = 0 '
        "AND p.status IN ('ingested','done') " + gate, (job_id,)).fetchone()['c']
    discard = conn.execute(
        'SELECT COUNT(*) c FROM regions r JOIN pages p ON r.page_id = p.id '
        'WHERE p.job_id = ? AND p.deleted = 0 AND r.deleted = 0 '
        "AND p.status IN ('ingested','done') " + gate
        + f"AND {_LATEST_AUTHOR} LIKE 'model:%'", (job_id,)).fetchone()['c']
    kept = conn.execute(
        'SELECT COUNT(*) c FROM regions r JOIN pages p ON r.page_id = p.id '
        'WHERE p.job_id = ? AND p.deleted = 0 AND r.deleted = 0 '
        "AND p.status IN ('ingested','done') " + gate
        + f"AND {_LATEST_AUTHOR} NOT LIKE 'model:%'", (job_id,)).fetchone()['c']
    reviewed = conn.execute(
        'SELECT COUNT(*) c FROM pages p WHERE p.job_id = ? AND p.deleted = 0 '
        "AND p.status IN ('ingested','done') AND p.layout_checked = 1", (job_id,)).fetchone()['c']
    return {'tiles': tiles, 'regions_discard': discard, 'regions_kept': kept, 'reviewed': reviewed}


@router.get('/api/jobs/{job_id}/repredict')
def repredict_preview(job_id: str, force: bool = False, conn=Depends(get_db),
                      auth: dict = Depends(current_user)):
    """What re-predicting would discard and what it would keep."""
    _require_map_job(conn, job_id, auth)
    return _repredict_scope(conn, job_id, force)


class RepredictBody(BaseModel):
    force: bool = False


@router.post('/api/jobs/{job_id}/repredict')
def repredict(job_id: str, body: RepredictBody, conn=Depends(get_db), user: str = Depends(get_user),
              auth: dict = Depends(current_user), _admin=Depends(require_role('admin'))):
    """Re-run map pre-annotation, keeping human-edited regions."""
    job = _require_map_job(conn, job_id, auth)
    if job['status'] in ('queued', 'running'):
        raise HTTPException(409, 'job is queued or running')
    problem = jobs.map_runner_problem()
    if problem:
        raise HTTPException(400, problem)
    scope = _repredict_scope(conn, job_id, body.force)
    if not body.force and scope['reviewed']:
        raise HTTPException(409, f"{scope['reviewed']} reviewed tile(s) would be re-predicted; "
                                 'pass force to include them')
    gate = '' if body.force else 'AND p.layout_checked = 0 '
    ids = [r['id'] for r in conn.execute(
        'SELECT r.id FROM regions r JOIN pages p ON r.page_id = p.id '
        'WHERE p.job_id = ? AND p.deleted = 0 AND r.deleted = 0 '
        "AND p.status IN ('ingested','done') " + gate
        + f"AND {_LATEST_AUTHOR} LIKE 'model:%'", (job_id,))]
    for rid in ids:
        conn.execute('UPDATE regions SET deleted = 1 WHERE id = ?', (rid,))
        store.log_region(conn, rid, f'system:repredict@{user}', 'delete')
    # Reset predicted tiles so phase_predict reselects them; force also un-reviews them.
    page_gate = '' if body.force else 'AND layout_checked = 0 '
    conn.execute(
        "UPDATE pages SET status = 'ingested'" + (', layout_checked = 0 ' if body.force else ' ')
        + "WHERE job_id = ? AND deleted = 0 AND status = 'done' " + page_gate, (job_id,))
    # run_predict=1 so a job created annotation-only picks up prediction on re-queue.
    conn.execute("UPDATE jobs SET status = 'queued', phase = NULL, error = NULL, run_predict = 1 WHERE id = ?",
                 (job_id,))
    conn.commit()
    store.recount_pages(conn, job_id)
    return {'ok': True, 'regions_discarded': len(ids), 'tiles': scope['tiles']}
