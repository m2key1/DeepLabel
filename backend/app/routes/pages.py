import asyncio
import json
import shutil
import threading
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse, StreamingResponse
from PIL import Image
from pydantic import BaseModel

from app import (blobs, caches, candidates, config, dataset_sync, geometry, layout_templates, llm_ocr, page_rows,
                 provenance, reading_order, renditions, revert, rotation, serializers, store, training)
from app.deps import (IMMUTABLE_CACHE, current_user, get_db, get_user, require_job_access,
                      require_page_access, require_role)
from app.routes.jobs import Note

router = APIRouter(tags=['pages'])


@router.get('/api/jobs/{job_id}/page-rows')
def job_page_rows(job_id: str, filter: str = 'all', sort: str = 'idx', desc: bool = False,
                  offset: int = 0, limit: int = 100, conn=Depends(get_db),
                  user: dict = Depends(current_user)):
    """A screenful of the dataset's page table, filtered and ordered in the database.

    The dataset endpoint returns every page at once, which is 10 MB of JSON on the largest
    volume here. This answers the same rows a screen at a time, with how many the filter
    matched and what each chip would show.
    """
    require_job_access(conn, job_id, user)
    job = store.get_job(conn, job_id)
    if job is None:
        raise HTTPException(404)
    # A deleted page is for whoever may restore it: the Deleted chip is where one is undone from.
    if filter == 'deleted' and user['role'] == 'viewer':
        raise HTTPException(403, 'not permitted')
    try:
        answer = page_rows.fetch(conn, job_id, task=job['task'], page_filter=filter, sort=sort,
                                 descending=desc, offset=offset, limit=limit)
    except page_rows.BadQuery as e:
        raise HTTPException(400, str(e)) from None
    answer['counts'] = page_rows.counts(conn, job_id, task=job['task'])
    return answer


@router.get('/api/pages/{page_id}/candidates')
def page_candidates(page_id: int, conn=Depends(get_db), user: dict = Depends(current_user)):
    """Every transcription held for this page - what OCR read, what people corrected, what
    a language model returned - whether it currently sits on a line or is waiting for one."""
    require_page_access(conn, page_id, user)
    return {'candidates': candidates.for_page(conn, page_id)}


class CandidatePatch(BaseModel):
    """Which line this reading belongs on. Null releases it back to the pool."""

    line_id: int | None = None


@router.patch('/api/candidates/{candidate_id}')
def patch_candidate(candidate_id: int, body: CandidatePatch, conn=Depends(get_db),
                    user: dict = Depends(current_user)):
    """Put a reading on a line by hand, or take it off again.

    A language model transcribes the whole page and its lines are matched to the detected
    ones by text; where the segmentation found something else, or the model transcribed the
    page number, a reading matches nothing and there is nothing automatic left to try. This
    is the fallback: a person says which line it belongs to."""
    row = conn.execute('SELECT * FROM candidates WHERE id = ?', (candidate_id,)).fetchone()
    if row is None:
        raise HTTPException(404)
    require_page_access(conn, row['page_id'], user)
    if row['dismissed']:
        raise HTTPException(409, 'this reading has been superseded by a newer one')
    if body.line_id is not None and conn.execute(
            'SELECT 1 FROM lines l JOIN elements e ON l.element_id = e.id '
            'WHERE l.id = ? AND l.deleted = 0 AND e.deleted = 0 AND e.page_id = ?',
            (body.line_id, row['page_id'])).fetchone() is None:
        raise HTTPException(404, 'no such line on this page')
    candidates.assign(conn, row, body.line_id)
    return {'candidates': candidates.for_page(conn, row['page_id'])}


@router.delete('/api/candidates/{candidate_id}')
def delete_candidate(candidate_id: int, conn=Depends(get_db), user: dict = Depends(current_user)):
    """Remove one line's reading by a language model, unless a checked line rests on it."""
    row = conn.execute('SELECT page_id FROM candidates WHERE id = ?', (candidate_id,)).fetchone()
    if row is None:
        raise HTTPException(404)
    require_page_access(conn, row['page_id'], user)
    try:
        llm_ocr.remove_candidate(conn, candidate_id)
    except llm_ocr.CannotRemove as error:
        raise HTTPException(409, str(error)) from None
    return {'candidates': candidates.for_page(conn, row['page_id'])}


@router.get('/api/jobs/{job_id}/pages/{page_id}')
def page_results(job_id: str, page_id: int, conn=Depends(get_db), user: dict = Depends(current_user)):
    """One page with its elements, lines and geometry."""
    require_job_access(conn, job_id, user)
    page = conn.execute('SELECT * FROM pages WHERE id = ? AND job_id = ?', (page_id, job_id)).fetchone()
    if page is None:
        raise HTTPException(404)
    element_rows = conn.execute(
        'SELECT * FROM elements WHERE page_id = ? AND deleted = 0 ORDER BY order_idx', (page_id,)).fetchall()
    element_revisions = store.latest_revisions(conn, 'element', [e['id'] for e in element_rows])
    elements = [serializers.element_payload(e, serializers.lines_of_element(conn, e['id']), element_revisions[e['id']])
                for e in element_rows]
    names = store.job_class_names(conn, job_id)
    region_rows = conn.execute(
        'SELECT * FROM regions WHERE page_id = ? AND deleted = 0 ORDER BY order_idx', (page_id,)).fetchall()
    region_revisions = store.latest_revisions(conn, 'region', [r['id'] for r in region_rows])
    regions = [serializers.region_dict(r, names, region_revisions[r['id']]) for r in region_rows]
    return {'id': page['id'], 'idx': page['idx'], 'filename': page['filename'],
            'width': page['width'], 'height': page['height'], 'status': page['status'],
            # How far the scan has been turned. The renditions are served immutable, so
            # this doubles as what tells a browser its copy is of the old way up.
            'rotation': page['rotation'] or 0,
            'layout_checked': bool(page['layout_checked']),
            'lines_checked': bool(page['lines_checked']), 'is_test': bool(page['is_test']),
            'note': store.note_of(dict(page)),
            'elements': elements, 'regions': regions,
            # What the lines of a page with no layout are ordered by: this page's own
            # answer if it has one, and the dataset's, which is what it falls back to.
            'reading_order': page['reading_order'],
            'job_reading_order': conn.execute(
                'SELECT reading_order FROM jobs WHERE id = ?', (job_id,)).fetchone()['reading_order'],
            # Set instead by the layout model's template, where it reads top to bottom.
            'reading_order_template': layout_templates.order_set_by(conn, job_id),
            'provenance': provenance.page_provenance(conn, page),
            # Where a live view of this page starts listening for other people's edits.
            'job_revision': store.job_revision(conn, job_id)}


@router.get('/api/pages/{page_id}/events')
async def page_events(page_id: int, request: Request, since: int = 0, user: dict = Depends(current_user)):
    """Server-sent events: which lines, elements and regions on this page changed, by whom,
    as they change - so a second person's edits show up without a reload. `since` is a
    revision id, normally the page payload's job_revision; a browser that reconnects
    resumes from the Last-Event-ID it saw."""
    conn = store.connect(config.DB_PATH)
    try:
        require_page_access(conn, page_id, user)
        page = conn.execute('SELECT job_id FROM pages WHERE id = ?', (page_id,)).fetchone()
    finally:
        conn.close()
    if page is None:
        raise HTTPException(404)
    cursor = int(request.headers.get('Last-Event-ID') or since)
    return StreamingResponse(page_change_events(page_id, page['job_id'], cursor, request),
                             media_type='text/event-stream')


KEEPALIVE_EVERY = 15


async def page_change_events(page_id: int, job_id: str, cursor: int, request: Request):
    """The SSE body: one event per batch of new revisions on the page, a comment now and
    then so idle proxies keep the connection, and an end as soon as the browser has gone
    - otherwise a closed tab would keep polling the database until the next write failed."""
    quiet = 0
    while not await request.is_disconnected():
        conn = store.connect(config.DB_PATH)
        try:
            cursor, changes = store.page_changes_since(conn, page_id, job_id, cursor)
        finally:
            conn.close()
        if changes:
            quiet = 0
            yield f'id: {cursor}\ndata: {json.dumps({"revision": cursor, "changes": changes})}\n\n'
        else:
            quiet += 1
            if quiet % KEEPALIVE_EVERY == 0:
                yield ': keepalive\n\n'
        await asyncio.sleep(1)


@router.get('/api/pages/{page_id}/rendition')
def rendition(page_id: int, kind: str = 'thumb', conn=Depends(get_db),
              user: dict = Depends(current_user)):
    """A page image at thumbnail or screen size."""
    require_page_access(conn, page_id, user)
    if kind not in ('thumb', 'screen', 'full'):
        raise HTTPException(400, 'kind must be thumb, screen or full')
    page = conn.execute('SELECT job_id, source_file FROM pages WHERE id = ?', (page_id,)).fetchone()
    if page is None:
        raise HTTPException(404)
    # zooming past 1:1 outruns the 1600px screen rendition, so hand back the scan
    if kind == 'full':
        src = Path(page['source_file'])
        # Between job creation and phase_ingest a PDF page's source_file names an
        # image that does not exist yet; never hand back the PDF itself.
        if src.suffix.lower() in config.PDF_EXTENSIONS or not src.exists():
            raise HTTPException(404, 'source image missing')
        return FileResponse(src, headers=IMMUTABLE_CACHE)
    path = config.job_dir(page['job_id']) / 'renditions' / f'{page_id}_{kind}.jpg'
    if not path.exists():
        raise HTTPException(404, 'rendition not ready')
    return FileResponse(path, media_type='image/jpeg', headers=IMMUTABLE_CACHE)


# One page builds its pyramid once, however many tiles asked for it at the same moment.
_tile_builds: dict[int, threading.Lock] = {}
_tile_builds_guard = threading.Lock()


def _ensure_tiles(page: dict, page_id: int) -> Path:
    """The page's tile directory, built from the scan if this is the first ask.

    Pages ingested before the viewer wanted tiles have renditions but no pyramid, and
    re-running ingest over a finished dataset is not something to ask of anyone."""
    rend_dir = config.job_dir(page['job_id']) / 'renditions'
    tiles = renditions.tiles_dir(rend_dir, page_id)
    if tiles.exists():
        return tiles

    with _tile_builds_guard:
        lock = _tile_builds.setdefault(page_id, threading.Lock())
    try:
        with lock:
            if tiles.exists():
                return tiles
            source = Path(page['source_file'])
            if source.suffix.lower() in config.PDF_EXTENSIONS or not source.exists():
                raise HTTPException(404, 'source image missing')
            with Image.open(source) as scan:
                renditions.write_tiles(scan.convert('RGB'), rend_dir, page_id)
    finally:
        # Whoever is already waiting on it holds it; anyone arriving later finds the
        # pyramid built and never needs one. Kept, this would be a lock per page ever
        # looked at.
        with _tile_builds_guard:
            _tile_builds.pop(page_id, None)
    return tiles


@router.get('/api/pages/{page_id}/tiles/{bust}/{level}/{tile}')
def page_tile(page_id: int, bust: int, level: int, tile: str, conn=Depends(get_db),
              user: dict = Depends(current_user)):
    """One deep-zoom tile, so zooming in costs the tiles under the cursor rather than the
    whole scan. Addressed the way OpenSeadragon addresses a Deep Zoom pyramid.

    `bust` is the page's rotation and is not read: turning a page rewrites its tiles in
    place, and they are served immutable, so the way up has to be part of the URL or the
    browser keeps showing the old one."""
    require_page_access(conn, page_id, user)
    # The level and the tile name reach the filesystem, so nothing but digits gets through.
    col, _, row = tile.removesuffix('.jpg').partition('_')
    if not (col.isdigit() and row.isdigit()) or level < 0:
        raise HTTPException(404)
    page = conn.execute('SELECT job_id, source_file FROM pages WHERE id = ?',
                        (page_id,)).fetchone()
    if page is None:
        raise HTTPException(404)
    path = _ensure_tiles(page, page_id) / str(level) / f'{col}_{row}.jpg'
    if not path.exists():
        raise HTTPException(404)
    return FileResponse(path, media_type='image/jpeg', headers=IMMUTABLE_CACHE)


class PagePatch(BaseModel):
    layout_checked: bool | None = None
    lines_checked: bool | None = None
    # This page's own layout when it differs from the volume's - a plate, a title page,
    # a leaf set in one column in a book set in two. 'auto' or '<leaves>x<columns>';
    # empty follows the dataset again. Setting it re-orders the page.
    reading_order: str | None = None


@router.put('/api/pages/{page_id}/note')
def put_page_note(page_id: int, body: Note, conn=Depends(get_db), user: dict = Depends(current_user)):
    """Write the page's shared note; an empty text removes it."""
    require_page_access(conn, page_id, user)
    page = conn.execute('SELECT job_id FROM pages WHERE id = ?', (page_id,)).fetchone()
    if page is None:
        raise HTTPException(404)
    note = store.set_note(conn, 'pages', page_id, body.text, user['username'])
    page_rows.forget_counts(conn, page['job_id'])
    return note


@router.patch('/api/pages/{page_id}')
def patch_page(page_id: int, body: PagePatch, conn=Depends(get_db), user: str = Depends(get_user),
               auth: dict = Depends(current_user)):
    """Update one page's review flags, rotation or deleted state."""
    require_page_access(conn, page_id, auth)
    row = conn.execute('SELECT job_id, deleted, status FROM pages WHERE id = ?', (page_id,)).fetchone()
    if row is None:
        raise HTTPException(404)
    if row['deleted']:
        raise HTTPException(409, 'page is deleted')
    if row['status'] == 'duplicate':
        raise HTTPException(409, 'page is a duplicate of another')
    fields = body.model_fields_set
    snapshot = {'id': page_id}
    mark = store.begin_span(conn)
    if 'layout_checked' in fields and body.layout_checked is not None:
        conn.execute('UPDATE pages SET layout_checked = ? WHERE id = ?', (int(body.layout_checked), page_id))
        snapshot['layout_checked'] = body.layout_checked
    if 'lines_checked' in fields and body.lines_checked is not None:
        conn.execute('UPDATE pages SET lines_checked = ? WHERE id = ?', (int(body.lines_checked), page_id))
        snapshot['lines_checked'] = body.lines_checked
    if 'reading_order' in fields:
        setting = body.reading_order or None
        if setting is not None and setting not in reading_order.CHOICES:
            raise HTTPException(400, f'reading_order must be one of {list(reading_order.CHOICES)}')
        conn.execute('UPDATE pages SET reading_order = ? WHERE id = ?', (setting, page_id))
        snapshot['reading_order'] = setting
        geometry.resequence_page(conn, page_id)
    store.log_revision(conn, 'page', page_id, row['job_id'], user, 'update', snapshot)
    span = store.end_span(conn, mark)
    conn.commit()
    dataset_sync.enqueue(row['job_id'])
    row2 = conn.execute('SELECT layout_checked, lines_checked FROM pages WHERE id = ?', (page_id,)).fetchone()
    return {'id': page_id, 'layout_checked': bool(row2['layout_checked']),
            'lines_checked': bool(row2['lines_checked']), 'span': span}


class RevertBody(BaseModel):
    from_revision: int
    to_revision: int
    direction: Literal['undo', 'redo']


@router.post('/api/pages/{page_id}/revert')
def revert_page_span(page_id: int, body: RevertBody, conn=Depends(get_db), user: str = Depends(get_user),
                     auth: dict = Depends(current_user)):
    """Take a run of this page's edits back, or put them back again. The span is what
    the write that made them answered with; undo and redo differ only in which end of
    it the page is returned to."""
    require_page_access(conn, page_id, auth)
    row = conn.execute('SELECT job_id, deleted FROM pages WHERE id = ?', (page_id,)).fetchone()
    if row is None:
        raise HTTPException(404)
    if row['deleted']:
        raise HTTPException(409, 'page is deleted')
    try:
        return revert.revert_span(conn, page_id, row['job_id'], body.from_revision, body.to_revision,
                                  body.direction, user)
    except revert.Empty:
        raise HTTPException(404, 'nothing to revert in that span')
    except revert.Conflict as exc:
        raise HTTPException(409, exc.detail)


class PageTurn(BaseModel):
    degrees: int


@router.post('/api/pages/{page_id}/turn')
def turn_page(page_id: int, body: PageTurn, conn=Depends(get_db), user: str = Depends(get_user),
              auth: dict = Depends(current_user), _editor=Depends(require_role('admin', 'member'))):
    """Turn a scan the right way up, and everything drawn on it with it. The turn is kept
    rather than carried: what comes back is the page as if it had been scanned that way."""
    require_page_access(conn, page_id, auth)
    try:
        turned = rotation.turn_page(conn, page_id, body.degrees, user)
    except rotation.CannotTurn as exc:
        raise HTTPException(409, str(exc))
    dataset_sync.enqueue(turned['job_id'])
    return turned


class PagesPatch(BaseModel):
    page_ids: list[int]
    deleted: bool


@router.patch('/api/jobs/{job_id}/pages')
def patch_pages(job_id: str, body: PagesPatch, conn=Depends(get_db), user: str = Depends(get_user),
                auth: dict = Depends(current_user)):
    """Apply the same change to several pages at once."""
    require_job_access(conn, job_id, auth)
    """Soft-delete or restore pages in bulk. Nothing is removed from disk here."""
    job = store.get_job(conn, job_id)
    if job is None:
        raise HTTPException(404)
    if job['status'] in ('queued', 'running'):
        raise HTTPException(409, 'job is queued or running')
    if not body.page_ids:
        return {'updated': 0, 'pages_total': store.recount_pages(conn, job_id)}
    marks = ','.join('?' * len(body.page_ids))
    rows = conn.execute(
        f'SELECT id, source_file FROM pages WHERE job_id = ? AND id IN ({marks})',
        (job_id, *body.page_ids)).fetchall()
    if not body.deleted:
        # A purged page has no scan to come back to, and would crash the exporter.
        gone = [r['id'] for r in rows if not Path(r['source_file']).exists()]
        if gone:
            raise HTTPException(409, f'{len(gone)} page(s) were purged and cannot be restored')
    conn.execute(f'UPDATE pages SET deleted = ? WHERE job_id = ? AND id IN ({marks})',
                 (int(body.deleted), job_id, *body.page_ids))
    for row in rows:
        store.log_revision(conn, 'page', row['id'], job_id, user,
                           'delete' if body.deleted else 'update', {'id': row['id'], 'deleted': body.deleted})
    conn.commit()
    dataset_sync.enqueue(job_id)
    return {'updated': len(rows), 'pages_total': store.recount_pages(conn, job_id)}


def _purge_targets(conn, job_id: str) -> list[dict]:
    """Files belonging to each deleted page. A source is only ours to unlink if it
    sits inside the job directory - a path-ingested job points at the user's own
    archival scans, and PDF expansion puts generated images inside job_dir for
    those jobs too, so containment is the only reliable test."""
    job_dir = config.job_dir(job_id).resolve()
    targets = []
    for page in conn.execute(
            'SELECT id, source_file, content_hash FROM pages WHERE job_id = ? AND deleted = 1',
            (job_id,)):
        source = Path(page['source_file'])
        owned = source.is_absolute() and source.resolve().is_relative_to(job_dir)
        rend_dir = config.job_dir(job_id) / 'renditions'
        files = [rend_dir / f"{page['id']}_{kind}.jpg" for kind in ('thumb', 'screen')]
        files += [config.job_dir(job_id) / 'crops' / f"element_{e['id']}.jpg"
                  for e in conn.execute('SELECT id FROM elements WHERE page_id = ?', (page['id'],))]
        if owned:
            files.append(source)
        # The deep-zoom pyramid is hundreds of small files and the largest thing a page
        # leaves behind after its scan, so it is counted tile by tile rather than guessed
        # at - and its directories are taken away with the target below.
        tiles = renditions.tiles_dir(rend_dir, page['id'])
        if tiles.is_dir():
            files += sorted(tiles.rglob('*.jpg'))
        present = [f for f in files if f.exists()]
        # A page with nothing left on disk - purged before, or never ingested - is not a
        # target. Purge keeps the rows, so counting those pages made the button offer
        # "Purge 3" forever, freeing 0 B every time.
        if present:
            targets.append({'page_id': page['id'], 'owned': owned, 'files': present,
                            'tiles': tiles,
                            'blob': (page['content_hash'], page['source_file']) if owned else None})
    return targets


def _purge_manifest(targets: list[dict]) -> dict:
    return {'pages': len(targets),
            'bytes': sum(f.stat().st_size for t in targets for f in t['files']),
            'files': sum(len(t['files']) for t in targets),
            'external_sources': sum(1 for t in targets if not t['owned'])}


@router.get('/api/jobs/{job_id}/purge')
def purge_preview(job_id: str, conn=Depends(get_db), user: dict = Depends(current_user)):
    """What a purge would unlink from disk, and how much space it frees."""
    require_job_access(conn, job_id, user)
    if store.get_job(conn, job_id) is None:
        raise HTTPException(404)
    return _purge_manifest(_purge_targets(conn, job_id))


@router.post('/api/jobs/{job_id}/purge')
def purge_pages(job_id: str, conn=Depends(get_db), _admin=Depends(require_role('admin'))):
    """Unlink the image files of deleted pages; the rows and their history stay."""
    job = store.get_job(conn, job_id)
    if job is None:
        raise HTTPException(404)
    if job['status'] in ('queued', 'running'):
        raise HTTPException(409, 'job is queued or running')
    targets = _purge_targets(conn, job_id)
    manifest = _purge_manifest(targets)
    # Correction pairs are cut from the scan, so they must exist on disk before it
    # goes; deleted pages keep training the OCR model.
    manifest['pairs_written'] = training.flush_pending(conn, [t['page_id'] for t in targets])
    for target in targets:
        for path in target['files']:
            path.unlink(missing_ok=True)
        shutil.rmtree(target['tiles'], ignore_errors=True)
    blobs.release([t['blob'] for t in targets if t['blob']], config.BLOBS_DIR)
    caches.forget_job(job_id)
    dataset_sync.enqueue(job_id)
    return manifest
