import json
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from PIL import Image
from pydantic import BaseModel

from app import caches, candidates, config, dataset_sync, geometry, layout_templates, serializers, store, training
from app.deps import (IMMUTABLE_CACHE, current_user, get_db, get_user, require_element_access,
                      require_page_access, require_unchanged)

router = APIRouter(tags=['elements'])


def _resolve_class(conn, page_id: int, name: str) -> tuple[str, str, str]:
    """(class_name, raw_class_name, kind) of one of the page's dataset classes."""
    job_id = conn.execute('SELECT job_id FROM pages WHERE id = ?', (page_id,)).fetchone()['job_id']
    vocabulary = layout_templates.vocabulary(conn, job_id)
    if name not in vocabulary.by_name:
        raise HTTPException(400, f'unknown class: {name}')
    return vocabulary.resolve(name)


def _page_of(conn, element_id: int) -> int:
    return conn.execute('SELECT page_id FROM elements WHERE id = ?', (element_id,)).fetchone()['page_id']


def _sync_element_job(conn, element_id: int):
    row = conn.execute(
        'SELECT p.job_id j FROM elements e JOIN pages p ON e.page_id = p.id WHERE e.id = ?',
        (element_id,)).fetchone()
    if row is not None:
        dataset_sync.enqueue(row['j'])


def _polygon_mode(conn, page_id: int) -> bool:
    row = conn.execute('SELECT j.layout_shape FROM pages p JOIN jobs j ON j.id = p.job_id WHERE p.id = ?',
                       (page_id,)).fetchone()
    return row is not None and row['layout_shape'] == 'polygon'


def _set_shape(conn, element_id: int, bbox: list, polygon: list | None) -> None:
    conn.execute('UPDATE elements SET bbox = ?, polygon = ? WHERE id = ?',
                 (json.dumps(bbox), json.dumps(polygon) if polygon else None, element_id))


class ElementPatch(BaseModel):
    checked: bool | None = None
    class_name: str | None = None
    bbox: list[float] | None = None
    # An outline, for a polygon-mode dataset; the box becomes its bounds.
    polygon: list[list[float]] | None = None
    deleted: bool | None = None
    # The revision the client loaded; refused with 409 if someone saved since.
    revision: int | None = None


@router.patch('/api/elements/{element_id}')
def patch_element(element_id: int, body: ElementPatch, conn=Depends(get_db),
                  auth: dict = Depends(current_user),
                  user: str = Depends(get_user)):
    """Update one element's class, geometry, reading order or reviewed flag."""
    require_element_access(conn, element_id, auth)
    if conn.execute('SELECT id FROM elements WHERE id = ?', (element_id,)).fetchone() is None:
        raise HTTPException(404)
    store.write_lock(conn)
    require_unchanged(conn, 'element', element_id, body.revision,
                      lambda: serializers.element_with_lines(conn, element_id))
    fields = body.model_fields_set
    rechecked = [] if body.checked is None else [r['id'] for r in conn.execute(
        'SELECT id FROM lines WHERE element_id = ? AND deleted = 0 '
        'AND (checked != ? OR check_source IS NOT NULL)',
        (element_id, int(body.checked)))]
    store.ensure_origin(conn, 'element', element_id, user)
    for line_id in rechecked:
        store.ensure_origin(conn, 'line', line_id, user)
    mark = store.begin_span(conn)
    if body.checked is not None:
        conn.execute('UPDATE elements SET checked = ? WHERE id = ?', (int(body.checked), element_id))
        for line_id in rechecked:
            store.check_line_as_person(conn, line_id, body.checked)
            store.log_line(conn, line_id, user, 'update')
    if 'class_name' in fields and body.class_name is not None:
        page_id = conn.execute('SELECT page_id FROM elements WHERE id = ?', (element_id,)).fetchone()['page_id']
        class_name, raw, kind = _resolve_class(conn, page_id, body.class_name)
        conn.execute('UPDATE elements SET class_name = ?, raw_class_name = ?, kind = ? WHERE id = ?',
                     (class_name, raw, kind, element_id))
    if 'polygon' in fields and body.polygon is not None:
        ring = _valid_ring(body.polygon)
        _set_shape(conn, element_id, geometry.valid_bbox(geometry.ring_bounds(ring)), ring)
        caches.drop_element_crop(conn, element_id)
    elif 'bbox' in fields and body.bbox is not None:
        bbox = geometry.valid_bbox(body.bbox)
        current = conn.execute('SELECT bbox, polygon FROM elements WHERE id = ?', (element_id,)).fetchone()
        # A box edited in box mode carries a kept outline with it, so it still fits.
        ring = json.loads(current['polygon']) if current['polygon'] else None
        _set_shape(conn, element_id, bbox, ring and geometry.fit_ring(ring, json.loads(current['bbox']), bbox))
        caches.drop_element_crop(conn, element_id)
    if 'deleted' in fields and body.deleted is not None:
        conn.execute('UPDATE elements SET deleted = ? WHERE id = ?', (int(body.deleted), element_id))
    store.log_element(conn, element_id, user, 'update')
    if fields & {'class_name', 'bbox', 'polygon', 'deleted'}:
        geometry.resequence_page(conn, _page_of(conn, element_id))
    span = store.end_span(conn, mark)
    conn.commit()
    for line_id in rechecked:
        training.enqueue(line_id)
    _sync_element_job(conn, element_id)
    return {**serializers.element_with_lines(conn, element_id), 'span': span}


class ElementCreate(BaseModel):
    class_name: str
    bbox: list[float] | None = None
    # Drawn as an outline with the polygon pen; the box is then its bounds.
    polygon: list[list[float]] | None = None


def _valid_ring(points: list) -> list:
    try:
        return geometry.valid_polygon(points)
    except geometry.InvalidGeometry as error:
        raise HTTPException(400, str(error)) from None


@router.post('/api/pages/{page_id}/elements')
def create_element(page_id: int, body: ElementCreate, conn=Depends(get_db),
                   auth: dict = Depends(current_user),
                   user: str = Depends(get_user)):
    """Add a hand-drawn element to a page."""
    require_page_access(conn, page_id, auth)
    page = conn.execute('SELECT deleted FROM pages WHERE id = ?', (page_id,)).fetchone()
    if page is None:
        raise HTTPException(404)
    if page['deleted']:
        raise HTTPException(409, 'page is deleted')
    class_name, raw, kind = _resolve_class(conn, page_id, body.class_name)
    if (body.bbox is None) == (body.polygon is None):
        raise HTTPException(400, 'pass exactly one of bbox, polygon')
    ring = _valid_ring(body.polygon) if body.polygon is not None else None
    bbox = geometry.valid_bbox(geometry.ring_bounds(ring) if ring else body.bbox)
    if ring is None and _polygon_mode(conn, page_id):
        ring = geometry.bbox_ring(bbox)
    order_idx = conn.execute(
        'SELECT COALESCE(MAX(order_idx), -1) + 1 n FROM elements WHERE page_id = ?', (page_id,)).fetchone()['n']
    mark = store.begin_span(conn)
    # A human just drew it, so it is reviewed by construction.
    cur = conn.execute(
        'INSERT INTO elements (page_id, order_idx, class_name, raw_class_name, bbox, conf, kind, checked, polygon) '
        'VALUES (?,?,?,?,?,?,?,1,?)',
        (page_id, order_idx, class_name, raw, json.dumps(bbox), None, kind, json.dumps(ring) if ring else None))
    store.log_element(conn, cur.lastrowid, user, 'create')
    geometry.resequence_page(conn, page_id)
    span = store.end_span(conn, mark)
    conn.commit()
    dataset_sync.enqueue(conn.execute('SELECT job_id FROM pages WHERE id = ?', (page_id,)).fetchone()['job_id'])
    return {**serializers.element_with_lines(conn, cur.lastrowid), 'span': span}


@router.delete('/api/elements/{element_id}')
def delete_element(element_id: int, conn=Depends(get_db), user: str = Depends(get_user),
                   auth: dict = Depends(current_user)):
    """Soft-delete an element and the lines beneath it."""
    require_element_access(conn, element_id, auth)
    row = conn.execute('SELECT page_id FROM elements WHERE id = ?', (element_id,)).fetchone()
    if row is None:
        raise HTTPException(404)
    # Soft only. The crop stays cached because the delete may be undone.
    _sync_element_job(conn, element_id)
    line_ids = [r['id'] for r in conn.execute(
        'SELECT id FROM lines WHERE element_id = ? AND deleted = 0', (element_id,))]
    store.ensure_origin(conn, 'element', element_id, user)
    for line_id in line_ids:
        store.ensure_origin(conn, 'line', line_id, user)
    mark = store.begin_span(conn)
    conn.execute('UPDATE elements SET deleted = 1 WHERE id = ?', (element_id,))
    store.log_element(conn, element_id, user, 'delete')
    for line_id in line_ids:
        conn.execute('UPDATE lines SET deleted = 1 WHERE id = ?', (line_id,))
        store.log_line(conn, line_id, user, 'delete')
    geometry.resequence_page(conn, row['page_id'])
    span = store.end_span(conn, mark)
    conn.commit()
    candidates.rematch_page(conn, row['page_id'])
    for line_id in line_ids:
        training.enqueue(line_id)
    return {'id': element_id, 'deleted': True, 'span': span}


class ElementSplit(BaseModel):
    cut_x: float | None = None
    cut_y: float | None = None


@router.post('/api/elements/{element_id}/split')
def split_element(element_id: int, body: ElementSplit, conn=Depends(get_db),
                  auth: dict = Depends(current_user),
                  user: str = Depends(get_user)):
    """Split an element in two along a horizontal or vertical cut."""
    require_element_access(conn, element_id, auth)
    row = conn.execute('SELECT * FROM elements WHERE id = ? AND deleted = 0', (element_id,)).fetchone()
    if row is None:
        raise HTTPException(404)
    if (body.cut_x is None) == (body.cut_y is None):
        raise HTTPException(400, 'pass exactly one of cut_x, cut_y')
    x0, y0, x1, y1 = json.loads(row['bbox'])
    if body.cut_x is not None:
        if not (x0 < body.cut_x < x1):
            raise HTTPException(400, 'cut must fall inside the box')
        a_bbox, b_bbox = [x0, y0, body.cut_x, y1], [body.cut_x, y0, x1, y1]
        axis, at = 0, body.cut_x
        in_b = lambda poly: geometry.line_center(poly)[0] >= body.cut_x
    else:
        if not (y0 < body.cut_y < y1):
            raise HTTPException(400, 'cut must fall inside the box')
        a_bbox, b_bbox = [x0, y0, x1, body.cut_y], [x0, body.cut_y, x1, y1]
        axis, at = 1, body.cut_y
        in_b = lambda poly: geometry.line_center(poly)[1] >= body.cut_y
    # An outline is cut along the same line, and each half's box is what is left of it.
    ring = json.loads(row['polygon']) if row['polygon'] else None
    a_ring = b_ring = None
    if ring:
        a_ring, b_ring = geometry.clip_ring(ring, axis, at, False), geometry.clip_ring(ring, axis, at, True)
        if len(a_ring) < 3 or len(b_ring) < 3:
            raise HTTPException(400, 'cut must fall inside the outline')
        a_bbox, b_bbox = geometry.ring_bounds(a_ring), geometry.ring_bounds(b_ring)
    store.ensure_origin(conn, 'element', element_id, user)
    lines = conn.execute('SELECT id, polygon FROM lines WHERE element_id = ? AND deleted = 0',
                         (element_id,)).fetchall()
    for ln in lines:
        if in_b(json.loads(ln['polygon'])):
            store.ensure_origin(conn, 'line', ln['id'], user)
    mark = store.begin_span(conn)
    # Half B inherits A's already-resolved class and review; keep A as the original id so
    # its crop cache and history stay attached. lines_bbox is set to the new geometry on
    # both so phase_relines does not treat them stale and wipe the reassigned lines.
    cur = conn.execute(
        'INSERT INTO elements (page_id, order_idx, class_name, raw_class_name, bbox, conf, kind, checked, lines_bbox, '
        'polygon) VALUES (?,?,?,?,?,?,?,?,?,?)',
        (row['page_id'], row['order_idx'] + 1, row['class_name'], row['raw_class_name'], json.dumps(b_bbox),
         row['conf'], row['kind'], row['checked'], json.dumps(b_bbox), json.dumps(b_ring) if b_ring else None))
    b_id = cur.lastrowid
    conn.execute('UPDATE elements SET bbox = ?, lines_bbox = ?, polygon = ? WHERE id = ?',
                 (json.dumps(a_bbox), json.dumps(a_bbox), json.dumps(a_ring) if a_ring else None, element_id))
    caches.drop_element_crop(conn, element_id)
    moved = []
    for ln in lines:
        if in_b(json.loads(ln['polygon'])):
            conn.execute('UPDATE lines SET element_id = ? WHERE id = ?', (b_id, ln['id']))
            moved.append(ln['id'])
    geometry.resequence_lines(conn, element_id)
    geometry.resequence_lines(conn, b_id)
    store.log_element(conn, element_id, user, 'update')
    store.log_element(conn, b_id, user, 'create')
    for lid in moved:
        store.log_line(conn, lid, user, 'update')
    geometry.resequence_page(conn, row['page_id'])
    span = store.end_span(conn, mark)
    conn.commit()
    _sync_element_job(conn, element_id)
    return {'elements': [serializers.element_with_lines(conn, element_id),
                         serializers.element_with_lines(conn, b_id)],
            'span': span}


class ElementMerge(BaseModel):
    ids: list[int]


@router.post('/api/elements/merge')
def merge_elements(body: ElementMerge, conn=Depends(get_db), user: str = Depends(get_user),
                   auth: dict = Depends(current_user)):
    """Merge several elements into one, keeping their lines in reading order."""
    for eid in body.ids:
        require_element_access(conn, eid, auth)
    if len(body.ids) < 2:
        raise HTTPException(400, 'merge needs at least two elements')
    rows = [conn.execute('SELECT * FROM elements WHERE id = ? AND deleted = 0', (i,)).fetchone()
            for i in body.ids]
    if any(r is None for r in rows):
        raise HTTPException(404)
    if len({r['page_id'] for r in rows}) != 1:
        raise HTTPException(400, 'elements must share a page')
    # Keep the first in reading order; union every box into it and reparent all lines.
    keep = min(rows, key=lambda r: r['order_idx'])
    for r in rows:
        store.ensure_origin(conn, 'element', r['id'], user)
        if r['id'] != keep['id']:
            for ln in conn.execute('SELECT id FROM lines WHERE element_id = ? AND deleted = 0', (r['id'],)):
                store.ensure_origin(conn, 'line', ln['id'], user)
    mark = store.begin_span(conn)
    boxes = [json.loads(r['bbox']) for r in rows]
    union = [min(b[0] for b in boxes), min(b[1] for b in boxes),
             max(b[2] for b in boxes), max(b[3] for b in boxes)]
    rings = [json.loads(r['polygon']) if r['polygon'] else geometry.bbox_ring(json.loads(r['bbox'])) for r in rows]
    # Outlines merge into the convex outline around them all, which never cuts one off.
    merged = geometry.hull([p for ring in rings for p in ring]) if any(r['polygon'] for r in rows) else None
    conn.execute('UPDATE elements SET bbox = ?, lines_bbox = ?, polygon = ? WHERE id = ?',
                 (json.dumps(union), json.dumps(union), json.dumps(merged) if merged else None, keep['id']))
    caches.drop_element_crop(conn, keep['id'])
    moved = []
    for r in rows:
        if r['id'] == keep['id']:
            continue
        moved += [ln['id'] for ln in conn.execute(
            'SELECT id FROM lines WHERE element_id = ? AND deleted = 0', (r['id'],))]
        conn.execute('UPDATE lines SET element_id = ? WHERE element_id = ? AND deleted = 0',
                     (keep['id'], r['id']))
        conn.execute('UPDATE elements SET deleted = 1 WHERE id = ?', (r['id'],))
        store.log_element(conn, r['id'], user, 'delete')
    geometry.resequence_lines(conn, keep['id'])
    store.log_element(conn, keep['id'], user, 'update')
    for lid in moved:
        store.log_line(conn, lid, user, 'update')
    geometry.resequence_page(conn, keep['page_id'])
    span = store.end_span(conn, mark)
    conn.commit()
    _sync_element_job(conn, keep['id'])
    return {**serializers.element_with_lines(conn, keep['id']), 'span': span}


@router.get('/api/elements/{element_id}/revisions')
def element_revisions(element_id: int, conn=Depends(get_db), auth: dict = Depends(current_user)):
    """One element's change history, newest first."""
    require_element_access(conn, element_id, auth)
    rows = conn.execute(
        'SELECT id, author, action, snapshot, created_at FROM revisions '
        "WHERE target_type = 'element' AND target_id = ? ORDER BY id DESC", (element_id,)).fetchall()
    return [{'id': r['id'], 'author': r['author'], 'action': r['action'],
             'created_at': r['created_at'], 'snapshot': json.loads(r['snapshot'])} for r in rows]


@router.get('/api/elements/{element_id}/crop')
def element_crop(element_id: int, conn=Depends(get_db), auth: dict = Depends(current_user)):
    """The cropped element image the viewer shows."""
    require_element_access(conn, element_id, auth)
    # Callers append ?b=<bbox> to bust the immutable cache after a geometry edit;
    # it is part of the URL identity only, so nothing here reads it.
    row = conn.execute(
        'SELECT e.bbox, p.source_file, p.job_id FROM elements e JOIN pages p ON e.page_id = p.id WHERE e.id = ?',
        (element_id,)).fetchone()
    if row is None:
        raise HTTPException(404)
    cache = config.job_dir(row['job_id']) / 'crops' / f'element_{element_id}.jpg'
    if not cache.exists():
        if not Path(row['source_file']).exists():
            raise HTTPException(404, 'source image missing')
        cache.parent.mkdir(parents=True, exist_ok=True)
        bbox = json.loads(row['bbox'])
        with Image.open(row['source_file']) as img:
            img = img.convert('RGB')
            crop = img.crop((round(bbox[0] * img.width), round(bbox[1] * img.height),
                             round(bbox[2] * img.width), round(bbox[3] * img.height)))
            crop.save(cache, quality=90)
    return FileResponse(cache, media_type='image/jpeg', headers=IMMUTABLE_CACHE)
