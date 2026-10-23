import json
import unicodedata
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from PIL import Image
from pydantic import BaseModel, field_validator

from app import caches, candidates, config, geometry, linecrop, serializers, store, training
from app.deps import (IMMUTABLE_CACHE, check_capability, current_user, get_db, get_user,
                      require_line_access, require_page_access, require_unchanged)
from app.routes.pipeline import PHASE_CAPABILITY

router = APIRouter(tags=['lines'])


class LinePatch(BaseModel):
    corrected_text: str | None = None
    checked: bool | None = None
    polygon: list[list[float]] | None = None
    orientation: int | None = None
    # The revision the client loaded; refused with 409 if someone saved since.
    revision: int | None = None
    # The text was taken from a reading on offer, so a typed correction it displaces is
    # offered back under the person's name rather than lost.
    from_reading: bool = False

    @field_validator('corrected_text')
    @classmethod
    def decomposed(cls, text: str | None) -> str | None:
        """Stored the way the model reads and writes it, whatever keyboard typed it."""
        return None if text is None else unicodedata.normalize('NFD', text)


@router.patch('/api/lines/{line_id}')
def patch_line(line_id: int, body: LinePatch, conn=Depends(get_db), user: str = Depends(get_user),
               auth: dict = Depends(current_user)):
    """Correct a line's text, geometry, orientation or reviewed flag."""
    require_line_access(conn, line_id, auth)
    row = conn.execute(
        'SELECT l.element_id, l.order_idx, l.polygon, l.text, l.checked, l.corrected_text, '
        'l.corrected_by, e.page_id, j.run_ocr '
        'FROM lines l JOIN elements e ON l.element_id = e.id JOIN pages p ON e.page_id = p.id '
        'JOIN jobs j ON j.id = p.job_id WHERE l.id = ?', (line_id,)).fetchone()
    if row is None:
        raise HTTPException(404)
    store.write_lock(conn)
    require_unchanged(conn, 'line', line_id, body.revision, lambda: serializers.get_line(conn, line_id))
    store.ensure_origin(conn, 'line', line_id, user)
    mark = store.begin_span(conn)
    fields = body.model_fields_set
    if 'corrected_text' in fields:
        # Editing the text is itself a review, unless the call says otherwise. A revert
        # withdraws the person's judgement: approving the OCR text is a second, explicit click.
        checked = body.checked if body.checked is not None else body.corrected_text is not None
        corrected_by = user if body.corrected_text is not None else None
        if body.from_reading or body.corrected_text is None:
            _offer_displaced_correction(conn, row, line_id, body.corrected_text)
        conn.execute('UPDATE lines SET corrected_text = ?, corrected_by = ? WHERE id = ?',
                     (body.corrected_text, corrected_by, line_id))
        store.check_line_as_person(conn, line_id, checked)
    elif body.checked is not None:
        store.check_line_as_person(conn, line_id, body.checked)
    if 'polygon' in fields and body.polygon is not None:
        # A reshape is usually a box tweak over the same characters, so keep the
        # existing read and correction; the user re-OCRs explicitly if the box now
        # covers different text. Re-detection is not triggered - the bbox is unchanged.
        conn.execute('UPDATE lines SET polygon = ? WHERE id = ?',
                     (json.dumps(geometry.valid_polygon(body.polygon)), line_id))
        geometry.resequence_lines(conn, row['element_id'])
    if body.orientation is not None:
        conn.execute('UPDATE lines SET orientation = ? WHERE id = ?',
                     (int(body.orientation) % 360, line_id))
    reshaped = 'polygon' in fields and body.polygon is not None
    if reshaped:
        caches.drop_line_crop(conn, line_id)  # the aligned base crop changed: recompute on next view
    # Auto re-OCR only on a reshape (a rotate is a display override, not new content),
    # and only untouched lines when the job OCRs; the batch worker picks these up.
    if reshaped and row['run_ocr'] and not row['checked'] and row['corrected_text'] is None:
        conn.execute('UPDATE lines SET needs_ocr = 1 WHERE id = ?', (line_id,))
    if 'corrected_text' in fields or body.checked is True:
        conn.execute('UPDATE lines SET needs_ocr = 0 WHERE id = ?', (line_id,))  # review cancels re-OCR
    store.log_line(conn, line_id, user, 'update')
    span = store.end_span(conn, mark)
    conn.commit()
    if reshaped:
        _settle_pool(conn, row['element_id'])
    # Checking, editing or reshaping all change the training pair (or whether there is one).
    training.enqueue(line_id)
    return {**serializers.get_line(conn, line_id), 'span': span}


def _offer_displaced_correction(conn, row, line_id: int, taken: str | None) -> None:
    """Taking a reading or reverting to the OCR text must be reversible without retyping, so
    a person's correction either displaces joins the pool under their name. Not a reading
    the line was wearing - that is already on offer under its reader's name - and not the
    models' words, which are nobody's to offer."""
    displaced, author = row['corrected_text'], row['corrected_by']
    if displaced is None or _composed(displaced) in {_composed(taken), _composed(row['text'])}:
        return
    if author is not None and not store.is_person(author):
        return
    on_offer = conn.execute('SELECT 1 FROM candidates WHERE line_id = ? AND text = ? AND dismissed = 0',
                            (line_id, displaced)).fetchone()
    if on_offer is None:
        candidates.add(conn, row['page_id'], author or 'human', displaced, line_id=line_id,
                       polygon=row['polygon'], order_idx=row['order_idx'], checked=bool(row['checked']))


def _composed(text: str | None) -> str | None:
    return None if text is None else unicodedata.normalize('NFC', text)


@router.delete('/api/lines/{line_id}')
def delete_line(line_id: int, revision: int | None = None, conn=Depends(get_db),
                user: str = Depends(get_user), auth: dict = Depends(current_user)):
    """Soft-delete one line. `revision` is the one the client loaded, refused with 409 if
    someone saved since - the same guard as a patch, on the query string since a DELETE
    carries no body."""
    require_line_access(conn, line_id, auth)
    row = conn.execute('SELECT element_id FROM lines WHERE id = ?', (line_id,)).fetchone()
    if row is None:
        raise HTTPException(404)
    store.write_lock(conn)
    require_unchanged(conn, 'line', line_id, revision, lambda: serializers.get_line(conn, line_id))
    store.ensure_origin(conn, 'line', line_id, user)
    mark = store.begin_span(conn)
    conn.execute('UPDATE lines SET deleted = 1 WHERE id = ?', (line_id,))
    store.log_line(conn, line_id, user, 'delete')
    geometry.resequence_lines(conn, row['element_id'])
    span = store.end_span(conn, mark)
    conn.commit()
    _settle_pool(conn, row['element_id'])
    training.enqueue(line_id)  # drop its training pair
    return {'id': line_id, 'deleted': True, 'span': span,
            'revision': store.latest_revision(conn, 'line', line_id)}


@router.post('/api/lines/{line_id}/reocr')
def reocr_line(line_id: int, conn=Depends(get_db), _user: str = Depends(get_user),
               auth: dict = Depends(current_user)):
    """Manually flag one line for re-OCR; the batch worker re-queues its job on the usual
    cadence and the OCR phase re-reads it (old text stays until the fresh read lands)."""
    require_line_access(conn, line_id, auth)
    check_capability(auth, PHASE_CAPABILITY['ocr'])
    row = conn.execute(
        'SELECT l.id, p.job_id FROM lines l JOIN elements e ON l.element_id = e.id '
        'JOIN pages p ON e.page_id = p.id WHERE l.id = ? AND l.deleted = 0', (line_id,)).fetchone()
    if row is None:
        raise HTTPException(404)
    conn.execute('UPDATE lines SET needs_ocr = 1 WHERE id = ?', (line_id,))
    # The batch worker only re-queues datasets that OCR at all, so an imported one has
    # to be given the phase here - otherwise the line spins for good.
    store.enable_ocr_phase(conn, row['job_id'])
    conn.commit()
    return serializers.get_line(conn, line_id)


class LineSplit(BaseModel):
    cut_x: float | None = None
    cut_y: float | None = None
    cut_line: list[list[float]] | None = None  # two points; the line through them is the cut


@router.post('/api/lines/{line_id}/split')
def split_line(line_id: int, body: LineSplit, conn=Depends(get_db), user: str = Depends(get_user),
               auth: dict = Depends(current_user)):
    """Split a line in two: along a drawn cut line, or at an axis-aligned position. A quad
    stays two quads; a polygon line is cut wherever the cut crosses it."""
    require_line_access(conn, line_id, auth)
    row = conn.execute('SELECT * FROM lines WHERE id = ? AND deleted = 0', (line_id,)).fetchone()
    if row is None:
        raise HTTPException(404)
    cuts = [c for c in (body.cut_x, body.cut_y, body.cut_line) if c is not None]
    if len(cuts) != 1:
        raise HTTPException(400, 'pass exactly one of cut_x, cut_y, cut_line')
    if body.cut_line is not None and (len(body.cut_line) != 2 or any(len(p) != 2 for p in body.cut_line)):
        raise HTTPException(400, 'cut_line must be two [x, y] points')
    poly = json.loads(row['polygon'])
    thin = False
    if len(poly) != 4:
        first, second = geometry.split_polygon(poly, *_cut_through(body))
    elif body.cut_line is not None:
        first, second = geometry.split_quad(poly, body.cut_line[0], body.cut_line[1])
    elif body.cut_x is not None:
        tl, tr, br, bl = poly
        # vertical cut: intersect top (tl-tr) and bottom (bl-br) edges
        p1, p2 = geometry.edge_at(tl, tr, 0, body.cut_x), geometry.edge_at(bl, br, 0, body.cut_x)
        if p1 is None or p2 is None:
            raise HTTPException(400, 'cut must fall inside the line')
        first, second = [tl, p1, p2, bl], [p1, tr, br, p2]
        thin = min(p1[0] - tl[0], tr[0] - p1[0]) < 0.003
    else:
        tl, tr, br, bl = poly
        # horizontal cut: intersect left (tl-bl) and right (tr-br) edges
        p1, p2 = geometry.edge_at(tl, bl, 1, body.cut_y), geometry.edge_at(tr, br, 1, body.cut_y)
        if p1 is None or p2 is None:
            raise HTTPException(400, 'cut must fall inside the line')
        first, second = [tl, tr, p2, p1], [p1, p2, br, bl]
        thin = min(p1[1] - tl[1], bl[1] - p1[1]) < 0.003
    if thin:
        raise HTTPException(400, 'split would make a sliver')
    store.ensure_origin(conn, 'line', line_id, user)
    mark = store.begin_span(conn)
    # The correction described the un-split line, so it no longer applies to either half -
    # it goes to the page's pool, where it stays offered on whichever half it overlaps.
    candidates.capture_line(conn, line_id)
    conn.execute('UPDATE lines SET polygon = ?, text = NULL, corrected_text = NULL, corrected_by = NULL, '
                 'confidence = NULL, conf_profile = NULL, checked = 0, check_source = NULL, '
                 'ocr_model_id = NULL, ocr_run_at = NULL, by_hand = 1 WHERE id = ?',
                 (json.dumps(first), line_id))
    caches.drop_line_crop(conn, line_id)  # the loupe would otherwise keep showing the whole line
    cur = conn.execute('INSERT INTO lines (element_id, order_idx, polygon, by_hand) VALUES (?,?,?,1)',
                       (row['element_id'], row['order_idx'], json.dumps(second)))
    geometry.resequence_lines(conn, row['element_id'])
    store.log_line(conn, line_id, user, 'update')
    store.log_line(conn, cur.lastrowid, user, 'create')
    span = store.end_span(conn, mark)
    conn.commit()
    _settle_pool(conn, row['element_id'])
    return {'lines': [serializers.get_line(conn, line_id), serializers.get_line(conn, cur.lastrowid)],
            'span': span}


def _cut_through(body: LineSplit) -> list:
    """Two points on the cut, whichever way it was given."""
    if body.cut_line is not None:
        return body.cut_line
    if body.cut_x is not None:
        return [[body.cut_x, 0], [body.cut_x, 1]]
    return [[0, body.cut_y], [1, body.cut_y]]


class LineMerge(BaseModel):
    ids: list[int]


@router.post('/api/lines/merge')
def merge_lines(body: LineMerge, conn=Depends(get_db), user: str = Depends(get_user),
                auth: dict = Depends(current_user)):
    """Merge adjacent lines into one."""
    for lid in body.ids:
        require_line_access(conn, lid, auth)
    if len(body.ids) < 2:
        raise HTTPException(400, 'merge needs at least two lines')
    rows = [conn.execute('SELECT * FROM lines WHERE id = ? AND deleted = 0', (i,)).fetchone()
            for i in body.ids]
    if any(r is None for r in rows):
        raise HTTPException(404)
    if len({r['element_id'] for r in rows}) != 1:
        raise HTTPException(400, 'lines must share an element')
    for row in rows:
        store.ensure_origin(conn, 'line', row['id'], user)
    mark = store.begin_span(conn)
    for row in rows:
        candidates.capture_line(conn, row['id'])
    polys = [json.loads(r['polygon']) for r in rows]
    # Keep the topmost line's id, and read the direction the text runs off it so the
    # merged quad's top edge stays on top. The box itself is fitted to every corner.
    order = sorted(range(len(rows)), key=lambda i: geometry.poly_key(polys[i]))
    keep = rows[order[0]]
    lead = polys[order[0]]
    merged = geometry.min_area_quad([p for poly in polys for p in poly],
                                    reading=(lead[1][0] - lead[0][0], lead[1][1] - lead[0][1]))
    conn.execute('UPDATE lines SET polygon = ?, text = NULL, corrected_text = NULL, corrected_by = NULL, '
                 'confidence = NULL, conf_profile = NULL, checked = 0, check_source = NULL, '
                 'ocr_model_id = NULL, ocr_run_at = NULL, by_hand = 1 WHERE id = ?',
                 (json.dumps(merged), keep['id']))
    caches.drop_line_crop(conn, keep['id'])
    for r in rows:
        if r['id'] != keep['id']:
            conn.execute('UPDATE lines SET deleted = 1 WHERE id = ?', (r['id'],))
            store.log_line(conn, r['id'], user, 'delete')
    geometry.resequence_lines(conn, keep['element_id'])
    store.log_line(conn, keep['id'], user, 'update')
    span = store.end_span(conn, mark)
    # The merged line starts with no readings of its own - half-readings joined would be
    # guesswork - so the halves' are set aside under this edit. No model is asked again:
    # it reads the page image, which a merge does not change.
    candidates.set_aside_readings(conn, [r['id'] for r in rows], span['to'])
    conn.commit()
    _settle_pool(conn, keep['element_id'])
    return {**serializers.get_line(conn, keep['id']), 'span': span}


def _element_at(conn, page_id: int, cx: float, cy: float) -> int | None:
    """Id of the smallest content element containing the point - the runner's
    _element_at, over live rows."""
    best, best_area = None, None
    for e in conn.execute(
            "SELECT id, bbox FROM elements WHERE page_id = ? AND kind = 'content' AND deleted = 0",
            (page_id,)):
        x0, y0, x1, y1 = json.loads(e['bbox'])
        if x0 <= cx <= x1 and y0 <= cy <= y1:
            area = (x1 - x0) * (y1 - y0)
            if best_area is None or area < best_area:
                best, best_area = e['id'], area
    return best


def _settle_pool(conn, element_id: int) -> int:
    """Which readings have a home changes the moment a line is drawn, reshaped or thrown
    away, so the pool is put right as part of the edit rather than on the next run. It is
    cheap where there is nothing to do: two releases and a look for anything homeless.
    Returns the page it settled."""
    page = conn.execute('SELECT page_id FROM elements WHERE id = ?', (element_id,)).fetchone()
    candidates.rematch_page(conn, page['page_id'])
    return page['page_id']


def _orphan_element(conn, page_id: int, poly: list, user: str) -> int:
    """A kind='orphan' bucket for a line outside every content element - any the page
    has, else a new one spanning the polygon. Which bucket it is read from is settled
    afterwards, by resequence_page."""
    row = conn.execute(
        "SELECT id FROM elements WHERE page_id = ? AND kind = 'orphan' AND deleted = 0", (page_id,)).fetchone()
    if row is not None:
        return row['id']
    xs = [p[0] for p in poly]
    ys = [p[1] for p in poly]
    order_idx = conn.execute(
        'SELECT COALESCE(MAX(order_idx), -1) + 1 n FROM elements WHERE page_id = ?', (page_id,)).fetchone()['n']
    cur = conn.execute(
        'INSERT INTO elements (page_id, order_idx, class_name, bbox, conf, kind, lines_bbox) '
        'VALUES (?,?,?,?,?,?,?)',
        (page_id, order_idx, 'Unassigned', json.dumps([min(xs), min(ys), max(xs), max(ys)]),
         None, 'orphan', json.dumps([min(xs), min(ys), max(xs), max(ys)])))
    store.log_element(conn, cur.lastrowid, user, 'create')
    return cur.lastrowid


class LineCreate(BaseModel):
    polygon: list[list[float]]


@router.post('/api/pages/{page_id}/lines')
def create_line(page_id: int, body: LineCreate, conn=Depends(get_db), user: str = Depends(get_user),
                auth: dict = Depends(current_user)):
    """Add a hand-drawn line to a page."""
    require_page_access(conn, page_id, auth)
    page = conn.execute('SELECT deleted FROM pages WHERE id = ?', (page_id,)).fetchone()
    if page is None:
        raise HTTPException(404)
    if page['deleted']:
        raise HTTPException(409, 'page is deleted')
    poly = geometry.valid_polygon(body.polygon)
    cx = sum(p[0] for p in poly) / len(poly)
    cy = sum(p[1] for p in poly) / len(poly)
    mark = store.begin_span(conn)
    element_id = _element_at(conn, page_id, cx, cy) or _orphan_element(conn, page_id, poly, user)
    order_idx = conn.execute(
        'SELECT COALESCE(MAX(order_idx), -1) + 1 n FROM lines WHERE element_id = ?', (element_id,)).fetchone()['n']
    cur = conn.execute('INSERT INTO lines (element_id, order_idx, polygon, by_hand) VALUES (?,?,?,1)',
                       (element_id, order_idx, json.dumps(poly)))
    store.log_line(conn, cur.lastrowid, user, 'create')
    geometry.resequence_lines(conn, element_id)
    span = store.end_span(conn, mark)
    conn.commit()
    _settle_pool(conn, element_id)
    return {**serializers.get_line(conn, cur.lastrowid), 'span': span}


@router.get('/api/lines/{line_id}/crop')
def line_crop(line_id: int, conn=Depends(get_db), auth: dict = Depends(current_user)):
    """The deskewed line crop the OCR model reads."""
    require_line_access(conn, line_id, auth)
    # The exact image OCR reads. Callers append ?b=<recipe>_<revision> to bust the browser's
    # copy; on disk it is kept under the recipe it was cut with, and a reshape drops it.
    row = conn.execute(
        'SELECT l.polygon, l.orientation, p.source_file, p.job_id '
        'FROM lines l JOIN elements e ON l.element_id = e.id JOIN pages p ON e.page_id = p.id '
        'WHERE l.id = ?', (line_id,)).fetchone()
    if row is None:
        raise HTTPException(404)
    cache = caches.line_crop_path(row['job_id'], line_id)
    if not cache.exists():
        if not Path(row['source_file']).exists():
            raise HTTPException(404, 'source image missing')
        cache.parent.mkdir(parents=True, exist_ok=True)
        with Image.open(row['source_file']) as img:
            img = img.convert('RGB')
            poly = [[x * img.width, y * img.height] for x, y in json.loads(row['polygon'])]
            # The deskewed base at orientation 0; the loupe spins the manual orientation
            # on top with CSS, so a rotate needs no refetch. OCR/training bake orientation in.
            out = linecrop.crop_line(img, poly, mask=config.LINE_CROP_MASK)
        if out is None:
            raise HTTPException(422, 'degenerate line polygon')
        out.save(cache, quality=90)
        for stale in caches.line_crop_files(row['job_id'], line_id):
            if stale != cache:
                stale.unlink(missing_ok=True)
    return FileResponse(cache, media_type='image/jpeg', headers=IMMUTABLE_CACHE)
