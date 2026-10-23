import argparse
import json
import math
import statistics
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageDraw, ImageStat

from app import (align, backend_client, candidates, config, conventions, corpus, geometry, layout_classes,
                 layout_templates, ocr_phase, pdf, registry, scans, store)
from app.caches import counted_page
from app.ocr_phase import is_cancelled
from app.remote_models import RemoteLayout, RemoteLines, RemoteOcrEngine, scan_image

Image.MAX_IMAGE_PIXELS = None

MAX_LAYOUT_HEIGHT = 3000

# a page number is one short token; detection on it only invents splits
FULL_BBOX_CLASSES = {'Pagenumber'}

# The stages that need a model, and the job flag that turns each on.
MODEL_STAGES = (('layout', 'run_layout'), ('lines', 'run_lines'), ('ocr', 'run_ocr'))


@dataclass
class OcrStage:
    author: str
    model_id: int | None
    read: ocr_phase.Read
    honoured: Callable[[], list[str] | None] = lambda: None
    close: Callable[[], None] = lambda: None


def _remote_ocr(conn, job_id: str, client, model_id: int) -> OcrStage:
    job = conn.execute('SELECT ocr_decode, ocr_convention FROM jobs WHERE id = ?', (job_id,)).fetchone()
    engine = RemoteOcrEngine(conn, client, model_id, job['ocr_decode'], conventions.parse(job['ocr_convention']))
    return OcrStage(author=ocr_author(conn, model_id, job['ocr_decode']), model_id=model_id,
                    read=lambda images, contexts: engine.predict_batch(images, contexts=contexts),
                    honoured=lambda: engine.honoured)


REMOTE_STAGES = {
    'layout': lambda conn, job_id, client, model_id: RemoteLayout(conn, client, model_id,
                                                                  layout_templates.vocabulary(conn, job_id)),
    'lines': lambda conn, job_id, client, model_id: RemoteLines(conn, client, model_id),
    'ocr': _remote_ocr,
}


def ocr_author(conn, model_id: int, decode: str) -> str:
    suffix = '#greedy' if decode == 'greedy' else ''
    return f'model:ocr@{registry.reader_name(conn, model_id)}{suffix}'


def open_stage(conn, job_id: str, task: str):
    """The job's model for one stage, on its model backend."""
    model_id = registry.running_model_id(task)
    client = backend_client.client_for(conn, model_id)
    if client is None:
        raise RuntimeError(f'the {task} model ({model_id}) is not on a configured model backend')
    print(f'{task}: on model backend "{client.backend.name}"', flush=True)
    return REMOTE_STAGES[task](conn, job_id, client, model_id)


def open_rgb(path: str) -> Image.Image:
    return Image.open(path).convert('RGB')


def materialize_pdf_page(conn, page, specs: dict, job_path: Path):
    """Write a PDF page out as an image and point the row at it. Idempotent, so a
    crash mid-phase re-runs safely; the real extension is only known once poppler
    has written the file, so filename is corrected here too."""
    target = Path(page['source_file'])
    if target.exists():
        return page
    spec = specs[page['source_pdf']][page['source_page']]
    written = pdf.materialize(Path(page['source_pdf']), spec, job_path / 'pages', target.stem)
    filename = Path(page['filename']).stem + written.suffix
    conn.execute('UPDATE pages SET source_file = ?, filename = ? WHERE id = ?',
                 (str(written), filename, page['id']))
    conn.commit()
    return conn.execute('SELECT * FROM pages WHERE id = ?', (page['id'],)).fetchone()


def phase_ingest(conn, job_id: str, job_path: Path):
    rend_dir = job_path / 'renditions'
    rend_dir.mkdir(parents=True, exist_ok=True)
    pages = conn.execute(
        "SELECT * FROM pages WHERE job_id = ? AND deleted = 0 AND status = 'pending' ORDER BY idx",
        (job_id,)).fetchall()
    seen = store.taken_hashes(conn, 'pages', job_id)

    done = conn.execute(
        f"SELECT COUNT(*) c FROM pages WHERE job_id = ? AND {counted_page()} AND status != 'pending'",
        (job_id,)).fetchone()['c']
    # One probe per document rather than per page.
    specs = {}
    for pdf_path in {p['source_pdf'] for p in pages if p['source_pdf']}:
        specs[pdf_path] = {s.page: s for s in pdf.probe(Path(pdf_path))}

    uncounted = False
    for page in pages:
        if page['source_pdf']:
            page = materialize_pdf_page(conn, page, specs, job_path)
        if scans.ingest_page(conn, page, job_path, seen, config.BLOBS_DIR, 'ingested') != 'ingested':
            uncounted = True
            continue
        done += 1
        store.update_counters(conn, job_id, pages_ingested=done)
        if is_cancelled(conn, job_id):
            break
    if uncounted:
        store.recount_pages(conn, job_id)


def layout_image(page) -> Image.Image:
    img = open_rgb(page['source_file'])
    if img.height > MAX_LAYOUT_HEIGHT:
        ratio = MAX_LAYOUT_HEIGHT / img.height
        img = img.resize((int(img.width * ratio), MAX_LAYOUT_HEIGHT))
    return img


def phase_layout(conn, job_id: str, stage, batch_size: int):
    pages = conn.execute(
        "SELECT * FROM pages WHERE job_id = ? AND deleted = 0 AND status = 'ingested' ORDER BY idx",
        (job_id,)).fetchall()
    done = conn.execute(
        "SELECT COUNT(*) c FROM pages WHERE job_id = ? AND deleted = 0 "
        "AND status IN ('layout_done','lines_done','done')",
        (job_id,)).fetchone()['c']
    total_elements = conn.execute(
        "SELECT COUNT(*) c FROM elements e JOIN pages p ON e.page_id = p.id "
        "WHERE p.job_id = ? AND p.deleted = 0 AND e.deleted = 0",
        (job_id,)).fetchone()['c']
    # The detector only finds boxes; in a polygon dataset each arrives as its four corners.
    outlines = conn.execute('SELECT layout_shape FROM jobs WHERE id = ?', (job_id,)).fetchone()['layout_shape'] == 'polygon'
    vocabulary = layout_templates.vocabulary(conn, job_id, registry.running_model_id('layout'))
    left_out = {}

    def insert_element(page_id, order_idx, found) -> bool:
        """Stores a detected box under the dataset's class for its label; a
        label the dataset skips, or has not decided on, leaves the box out. Returns whether
        the box landed under a class other than its label."""
        placed = vocabulary.place(found.raw_class_name)
        if placed is None:
            left_out[found.raw_class_name] = left_out.get(found.raw_class_name, 0) + 1
            return False
        # One definition of kind, shared with the API, so a model-detected element and a
        # hand-drawn one of the same class agree; kind only says whether text is read from it.
        class_name, raw, kind = vocabulary.resolve(placed)
        cur = conn.execute(
            'INSERT INTO elements (page_id, order_idx, class_name, raw_class_name, bbox, conf, kind, polygon) '
            'VALUES (?,?,?,?,?,?,?,?)',
            (page_id, order_idx, class_name, raw, json.dumps(found.bbox),
             found.confidence, kind, json.dumps(geometry.bbox_ring(found.bbox)) if outlines else None))
        store.log_element(conn, cur.lastrowid, stage.author, 'create')
        return placed != found.raw_class_name

    batch_size = max(1, min(batch_size, len(pages)))
    for start in range(0, len(pages), batch_size):
        chunk = pages[start:start + batch_size]
        images = [layout_image(p) for p in chunk]
        layouts = stage.detect(images, [p['source_file'] for p in chunk])

        for page, layout in zip(chunk, layouts):
            remapped = [insert_element(page['id'], order_idx, found) for order_idx, found in enumerate(layout.content)]
            remapped += [insert_element(page['id'], c_idx, found) for c_idx, found in enumerate(layout.containers)]
            # The detector's own order holds only for its own classes.
            if not layout.ordered or any(remapped):
                geometry.resequence_page(conn, page['id'])
            conn.execute("UPDATE pages SET status = 'layout_done' WHERE id = ?", (page['id'],))
            store.note_page_model(conn, page['id'], 'layout', registry.running_model_id('layout'))
            conn.commit()
            done += 1
            total_elements += len(layout.content)
            store.update_counters(conn, job_id, pages_layout_done=done, elements_total=total_elements)

        if is_cancelled(conn, job_id):
            break
    if left_out:
        print('layout: left out boxes whose label this dataset has no class for: '
              + ', '.join(f'{label} ({n})' for label, n in sorted(left_out.items())), flush=True)


def _element_at(boxes, cx, cy):
    """Index of the smallest content bbox (normalized) containing (cx, cy), or None."""
    best, best_area = None, None
    for i, (x0, y0, x1, y1) in enumerate(boxes):
        if x0 <= cx <= x1 and y0 <= cy <= y1:
            area = (x1 - x0) * (y1 - y0)
            if best_area is None or area < best_area:
                best, best_area = i, area
    return best


def _join_row(polys):
    """One quad spanning a row's fragments, keeping the outer corners so tilt survives."""
    if len(polys) == 1:
        return polys[0]
    ordered = sorted(polys, key=lambda p: min(pt[0] for pt in p))
    left, right = ordered[0], ordered[-1]
    if len(left) == 4 and len(right) == 4:
        return [list(left[0]), list(right[1]), list(right[2]), list(left[3])]
    xs = [pt[0] for p in polys for pt in p]
    ys = [pt[1] for p in polys for pt in p]
    return [[min(xs), min(ys)], [max(xs), min(ys)], [max(xs), max(ys)], [min(xs), max(ys)]]


def _merge_row_fragments(polys, overlap=0.5):
    """Join detections sharing a text row. Inside one element a horizontal gap does
    not start a new line, so a split row is a detector artefact. Rows are compared
    after deskewing: a tilted line's axis-aligned extent runs well over the line
    pitch and would otherwise overlap its neighbours."""
    if len(polys) < 2:
        return polys
    angles = [math.atan2(p[1][1] - p[0][1], p[1][0] - p[0][0])
              for p in polys if len(p) >= 2 and (p[1][0] != p[0][0] or p[1][1] != p[0][1])]
    theta = statistics.median(angles) if angles else 0.0
    sin, cos = math.sin(-theta), math.cos(-theta)

    def span(poly):
        ys = [pt[0] * sin + pt[1] * cos for pt in poly]
        return min(ys), max(ys)

    rows = []
    for poly in sorted(polys, key=lambda p: sum(span(p)) / 2):
        lo, hi = span(poly)
        for row in rows:
            if min(hi, row[1]) - max(lo, row[0]) > overlap * min(hi - lo, row[1] - row[0]):
                row[0], row[1] = min(lo, row[0]), max(hi, row[1])
                row[2].append(poly)
                break
        else:
            rows.append([lo, hi, [poly]])
    return [_join_row(r[2]) for r in rows]


def _outside_painted(crop: Image.Image, ring: list, origin: tuple, size: tuple) -> Image.Image:
    """An element's crop with everything outside its outline painted the page's own
    colour, so a detector cannot find the neighbouring region's text in the corners."""
    width, height = size
    points = [(x * width - origin[0], y * height - origin[1]) for x, y in ring]
    inside = Image.new('L', crop.size, 0)
    ImageDraw.Draw(inside).polygon(points, fill=255)
    fill = tuple(int(v) for v in ImageStat.Stat(crop, inside).median)
    return Image.composite(crop, Image.new('RGB', crop.size, fill), inside)


def _inside(ring: list | None, poly: list) -> bool:
    if ring is None:
        return True
    cx = sum(p[0] for p in poly) / len(poly)
    cy = sum(p[1] for p in poly) / len(poly)
    return geometry.point_in_ring(cx, cy, ring)


def _lines_per_crop(stage, img, el_boxes, skip=frozenset(), rings=None):
    """Detect lines inside each element crop. Returns (per_element_polys, orphans);
    with no elements the whole page is detected and returned as orphans. An element with
    an outline is detected on its crop painted out beyond it, and keeps only the lines
    whose centre falls inside it."""
    if not el_boxes:
        return [], stage.detect([img], 'page')[0]

    width, height = img.size
    rings = rings or [None] * len(el_boxes)
    crops, origins = [], []
    for (x0, y0, x1, y1), ring in zip(el_boxes, rings):
        ex0, ey0 = x0 * width, y0 * height
        origins.append((ex0, ey0))
        crop = img.crop((round(ex0), round(ey0), round(x1 * width), round(y1 * height)))
        if ring and crop.width > 0 and crop.height > 0:
            crop = _outside_painted(crop, ring, (round(ex0), round(ey0)), img.size)
        crops.append(crop)

    valid = [i for i, c in enumerate(crops) if c.width > 0 and c.height > 0 and i not in skip]
    detected = stage.detect([crops[i] for i in valid], 'crop') if valid else []

    per_el = [[] for _ in el_boxes]
    for i, polys in zip(valid, detected):
        ex0, ey0 = origins[i]
        cw, ch = crops[i].size
        merged = _merge_row_fragments([[[x * cw, y * ch] for x, y in poly] for poly in polys])
        on_page = [[[(pt[0] + ex0) / width, (pt[1] + ey0) / height] for pt in poly] for poly in merged]
        per_el[i] = [poly for poly in on_page if _inside(rings[i], poly)]
    return per_el, []


def _lines_per_page(stage, img, el_boxes, skip=frozenset(), rings=None):
    """Detect lines on the whole page once, route each to the tightest containing
    element - by its outline, where it has one. Returns (per_element_polys, orphans) -
    lines whose center is outside every element (or all lines when there are no
    elements) become orphans."""
    per_el = [[] for _ in el_boxes]
    orphans = []
    rings = rings or [None] * len(el_boxes)
    for norm in stage.detect([img], 'page')[0]:
        cx = sum(p[0] for p in norm) / len(norm)
        cy = sum(p[1] for p in norm) / len(norm)
        holding = [box if ring is None or geometry.point_in_ring(cx, cy, ring) else [2, 2, 2, 2]
                   for box, ring in zip(el_boxes, rings)]
        idx = _element_at(holding, cx, cy)
        if idx in skip:
            continue
        (per_el[idx] if idx is not None else orphans).append(norm)
    return per_el, orphans


def _rings(conn, job_id: str, elements) -> list | None:
    """The elements' outlines, while the dataset draws them; a box-mode dataset keeps its
    outlines on file but reads every element as its box."""
    if conn.execute('SELECT layout_shape FROM jobs WHERE id = ?', (job_id,)).fetchone()['layout_shape'] != 'polygon':
        return None
    return [json.loads(e['polygon']) if e['polygon'] else None for e in elements]


def _reading_key(poly):
    return (sum(pt[1] for pt in poly) / len(poly), sum(pt[0] for pt in poly) / len(poly))


def _full_bbox_lines(elements, el_boxes, polygons_per_element):
    full_bbox = {i for i, e in enumerate(elements) if e['class_name'] in FULL_BBOX_CLASSES}
    for i in full_bbox:
        x0, y0, x1, y1 = el_boxes[i]
        polygons_per_element[i] = [[[x0, y0], [x1, y0], [x1, y1], [x0, y1]]]


def phase_lines(conn, job_id: str, stage, line_mode: str):
    pages = conn.execute(
        "SELECT * FROM pages WHERE job_id = ? AND deleted = 0 AND status = 'layout_done' ORDER BY idx",
        (job_id,)).fetchall()
    done = conn.execute(
        "SELECT COUNT(*) c FROM elements e JOIN pages p ON e.page_id = p.id "
        "WHERE p.job_id = ? AND p.deleted = 0 AND e.deleted = 0 "
        "AND p.status IN ('lines_done','done')", (job_id,)).fetchone()['c']
    total_lines = conn.execute(
        "SELECT COUNT(*) c FROM lines l JOIN elements e ON l.element_id = e.id "
        "JOIN pages p ON e.page_id = p.id WHERE p.job_id = ? AND p.deleted = 0 AND l.deleted = 0", (job_id,)).fetchone()['c']
    total_elements = conn.execute(
        "SELECT COUNT(*) c FROM elements e JOIN pages p ON e.page_id = p.id "
        "WHERE p.job_id = ? AND p.deleted = 0 AND e.deleted = 0 AND e.kind = 'content'", (job_id,)).fetchone()['c']

    def insert_lines(element_id, polygons):
        nonlocal total_lines
        for order_idx, poly in enumerate(sorted(polygons, key=_reading_key)):
            cur = conn.execute('INSERT INTO lines (element_id, order_idx, polygon) VALUES (?,?,?)',
                               (element_id, order_idx, json.dumps(poly)))
            store.log_revision(conn, 'line', cur.lastrowid, job_id, stage.author, 'create',
                               {'id': cur.lastrowid, 'element_id': element_id, 'order_idx': order_idx,
                                'polygon': poly, 'text': None, 'corrected_text': None,
                                'confidence': None, 'checked': False})
            total_lines += 1

    for page in pages:
        img = open_rgb(page['source_file'])
        elements = conn.execute(
            "SELECT * FROM elements WHERE page_id = ? AND kind = 'content' AND deleted = 0 ORDER BY order_idx",
            (page['id'],)).fetchall()
        el_boxes = [json.loads(e['bbox']) for e in elements]

        detect = _lines_per_page if line_mode == 'per_page' else _lines_per_crop
        full_bbox = {i for i, e in enumerate(elements) if e['class_name'] in FULL_BBOX_CLASSES}
        polygons_per_element, orphans = detect(stage, img, el_boxes, skip=full_bbox, rings=_rings(conn, job_id, elements))
        _full_bbox_lines(elements, el_boxes, polygons_per_element)

        for element, polygons in zip(elements, polygons_per_element):
            insert_lines(element['id'], polygons)
            conn.execute('UPDATE elements SET lines_bbox = bbox WHERE id = ?', (element['id'],))
            done += 1

        # Lines whose center fell outside every detected element (or all lines when
        # layout found nothing) go into an invisible kind='orphan' bucket so they are
        # still OCR'd and shown in the Lines view rather than silently dropped. The page
        # then cuts them into runs, each read between the boxes it stands between.
        if orphans:
            xs = [p[0] for poly in orphans for p in poly]
            ys = [p[1] for poly in orphans for p in poly]
            bbox = [min(xs), min(ys), max(xs), max(ys)]
            cur = conn.execute(
                'INSERT INTO elements (page_id, order_idx, class_name, bbox, conf, kind) VALUES (?,?,?,?,?,?)',
                (page['id'], len(elements), 'Unassigned', json.dumps(bbox), None, 'orphan'))
            store.log_revision(conn, 'element', cur.lastrowid, job_id, stage.author, 'create',
                               {'id': cur.lastrowid, 'page_id': page['id'], 'order_idx': len(elements),
                                'class_name': 'Unassigned', 'raw_class_name': None, 'bbox': bbox,
                                'conf': None, 'kind': 'orphan', 'checked': False, 'deleted': False})
            insert_lines(cur.lastrowid, orphans)
            geometry.resequence_page(conn, page['id'])

        store.update_counters(conn, job_id, elements_lines_done=done, lines_total=total_lines,
                              elements_total=total_elements)
        conn.execute("UPDATE pages SET status = 'lines_done' WHERE id = ?", (page['id'],))
        store.note_page_model(conn, page['id'], 'lines', registry.running_model_id('lines'))
        conn.commit()
        if is_cancelled(conn, job_id):
            break


def stale_elements(conn, job_id: str):
    """Elements whose geometry has drifted from what their lines were detected against,
    plus any that never had detection - a hand-drawn box, or one relabelled from a
    container. With auto re-detection off, only those a person explicitly asked for
    (lines_bbox cleared), so hand-edited lines and incidental drift survive a re-queue."""
    auto = conn.execute('SELECT auto_redetect FROM jobs WHERE id = ?', (job_id,)).fetchone()['auto_redetect']
    if auto:
        predicate, args = layout_classes.STALE_LINES_SQL, layout_classes.STALE_LINES_ARGS
    else:
        predicate, args = layout_classes.STALE_LINES_EXPLICIT_SQL, ()
    return conn.execute(
        f'SELECT e.id, e.page_id FROM elements e JOIN pages p ON e.page_id = p.id '
        f'WHERE p.job_id = ? AND p.deleted = 0 AND {predicate} '
        f'ORDER BY e.page_id, e.order_idx',
        (job_id, *args)).fetchall()


def phase_relines(conn, job_id: str, stage, stale):
    """Re-detect lines for the stale elements. Finds no work on an untouched job, so it
    runs unconditionally as part of the normal phase list."""
    by_page = {}
    for row in stale:
        by_page.setdefault(row['page_id'], []).append(row['id'])
    print(f'redetecting lines for {len(stale)} element(s) across {len(by_page)} page(s)', flush=True)

    for page_id, element_ids in by_page.items():
        page = conn.execute('SELECT * FROM pages WHERE id = ?', (page_id,)).fetchone()
        img = open_rgb(page['source_file'])
        marks = ','.join('?' * len(element_ids))
        elements = conn.execute(
            f'SELECT * FROM elements WHERE id IN ({marks}) ORDER BY order_idx', element_ids).fetchall()
        el_boxes = [json.loads(e['bbox']) for e in elements]

        # Always per-crop here: per_page detection reassigns lines across the whole
        # page, which would disturb elements that are not stale.
        full_bbox = {i for i, e in enumerate(elements) if e['class_name'] in FULL_BBOX_CLASSES}
        polygons_per_element, _ = _lines_per_crop(stage, img, el_boxes, skip=full_bbox, rings=_rings(conn, job_id, elements))
        _full_bbox_lines(elements, el_boxes, polygons_per_element)

        for element, polygons in zip(elements, polygons_per_element):
            # Whatever was read or corrected under this element goes to the pool first;
            # rematch below gives it back to whichever new line covers the same place.
            candidates.capture_element(conn, element['id'])
            # Soft-delete: a detection that finds fewer lines than it replaced must not
            # take the corrections on them with it. Reads filter deleted rows out.
            replaced = [r['id'] for r in conn.execute(
                'SELECT id FROM lines WHERE element_id = ? AND deleted = 0', (element['id'],))]
            conn.execute('UPDATE lines SET deleted = 1 WHERE element_id = ?', (element['id'],))
            for line_id in replaced:
                store.log_line(conn, line_id, stage.author, 'delete')
            for order_idx, poly in enumerate(sorted(polygons, key=_reading_key)):
                cur = conn.execute('INSERT INTO lines (element_id, order_idx, polygon) VALUES (?,?,?)',
                                   (element['id'], order_idx, json.dumps(poly)))
                store.log_revision(conn, 'line', cur.lastrowid, job_id, stage.author, 'create',
                                   {'id': cur.lastrowid, 'element_id': element['id'], 'order_idx': order_idx,
                                    'polygon': poly, 'text': None, 'corrected_text': None,
                                    'confidence': None, 'checked': False})
            conn.execute('UPDATE elements SET lines_bbox = bbox WHERE id = ?', (element['id'],))
        counts = candidates.rematch_page(conn, page_id)
        if counts['restored']:
            print(f"page {page_id}: {counts['restored']} correction(s) re-attached, "
                  f"{counts['rechecked']} still verified", flush=True)
        # phase_ocr picks these up on text IS NULL, so no extra wiring is needed.
        conn.execute("UPDATE pages SET status = 'lines_done' WHERE id = ? AND status = 'done'", (page_id,))
        store.note_page_model(conn, page_id, 'lines', registry.running_model_id('lines'))
        conn.commit()
        if is_cancelled(conn, job_id):
            break


def phase_ocr(conn, job_id: str, stage: OcrStage, chunk_lines: int):
    ocr_phase.run(conn, job_id, stage.read, stage.author, stage.model_id, chunk_lines)
    honoured = stage.honoured()
    if honoured is not None:
        store.note_convention_read(conn, job_id, honoured)


def phase_reference(conn, job_id: str, overlap: int):
    """Cut the uploaded corpus across the pages, recording what each leaf is answerable for.

    Derived from recognition rather than stored, so it is redone on every run: a better
    OCR pass moves the anchors, and a page added in the middle shifts everything after it.
    Writes only the reference columns, so nothing a person has transcribed is at risk.
    """
    result = corpus.apply_cut(conn, job_id, overlap)
    print(f"reference: {result['placed']}/{result['pages']} pages placed from "
          f"{result['documents']} document(s), {result['unanchored']} without an anchor",
          flush=True)


def phase_align(conn, job_id: str, autocheck: bool, ordered: bool):
    """Pairs page-level ground-truth text lines with the recognized lines,
    best match first. Matched lines receive the transcription as their
    correction - except a line a person has checked or typed on, which keeps
    their text and is offered the transcription's line as a reading instead
    (align.keeps_correction decides which).

    Which of those matches may check themselves off is align.may_autocheck -
    a near-exact score always, and on an ordered transcription also a weaker pair
    that agrees with reading order.

    Only ground truth a person put there auto-checks, however confident the match.
    A PDF's own text layer and a model's diplomatic reading are both machine output,
    and marking either reviewed would put a guess into the corpus under a human's
    authority - align.gt_is_trusted is what decides which is which."""
    gt_total = gt_matched = 0
    pages = conn.execute(
        'SELECT id, gt_text, gt_source FROM pages WHERE job_id = ? AND deleted = 0 '
        'AND gt_text IS NOT NULL', (job_id,)).fetchall()
    for page in pages:
        gt_lines = [l.strip() for l in page['gt_text'].splitlines() if l.strip()]
        rows = conn.execute(
            'SELECT l.id, l.text, l.checked, l.corrected_text, l.corrected_by FROM lines l '
            'JOIN elements e ON l.element_id = e.id '
            'WHERE e.page_id = ? AND l.deleted = 0 AND e.deleted = 0 AND l.text IS NOT NULL '
            'ORDER BY e.order_idx, l.order_idx', (page['id'],)).fetchall()
        matches = align.greedy_align(gt_lines, [r['text'] for r in rows])
        confirmed = align.order_confirmed(matches) if ordered else [False] * len(matches)
        gt_total += len(gt_lines)
        gt_matched += len(matches)
        trusted = align.gt_is_trusted(page['gt_source'])
        for (gi, oi, score), by_order in zip(matches, confirmed):
            line = rows[oi]
            source = ('gt+order' if by_order else 'gt') if trusted else page['gt_source']
            author = f'align:{source}@{score:.2f}'
            if align.keeps_correction(line['checked'], line['corrected_text'], line['corrected_by']):
                candidates.add(conn, page['id'], author, gt_lines[gi], line_id=line['id'],
                               order_idx=oi, similarity=score)
                continue
            conn.execute('UPDATE lines SET corrected_text = ?, corrected_by = ? WHERE id = ?',
                         (gt_lines[gi], author, line['id']))
            store.log_line(conn, line['id'], author, 'update')
            if autocheck and trusted and align.may_autocheck(score, by_order):
                conn.execute("UPDATE lines SET checked = 1, check_source = 'align' WHERE id = ?",
                             (line['id'],))
                store.log_line(conn, line['id'], author, 'check')
        conn.commit()
    store.update_counters(conn, job_id, gt_total=gt_total, gt_matched=gt_matched)


def _with_stage(conn, job_id: str, task: str, use):
    stage = open_stage(conn, job_id, task)
    try:
        use(stage)
    finally:
        stage.close()


def run(conn, job_id: str, job_path: Path, layout_batch_size: int, ocr_chunk_lines: int):
    """Every phase of a text job in order, each stage's model opened as the phase starts
    and closed as it ends, so one card holds one model at a time."""
    job = conn.execute('SELECT line_mode, run_layout, run_lines, run_ocr, gt_autocheck, gt_ordered, '
                       'reference_overlap FROM jobs WHERE id = ?', (job_id,)).fetchone()

    def skip_layout():
        # Layout disabled: advance ingested pages so the line/OCR phases (which key on
        # 'layout_done') still run. With no elements, line detection falls back to whole-page.
        conn.execute("UPDATE pages SET status = 'layout_done' "
                     "WHERE job_id = ? AND status = 'ingested' AND deleted = 0", (job_id,))
        conn.commit()

    def relines():
        stale = stale_elements(conn, job_id)
        if stale:
            _with_stage(conn, job_id, 'lines', lambda stage: phase_relines(conn, job_id, stage, stale))

    phases = [('ingest', lambda: phase_ingest(conn, job_id, job_path))]
    phases.append(('layout', lambda: _with_stage(conn, job_id, 'layout',
                                                 lambda stage: phase_layout(conn, job_id, stage, layout_batch_size)))
                  if job['run_layout'] else ('layout', skip_layout))
    if job['run_lines']:
        phases.append(('lines', lambda: _with_stage(conn, job_id, 'lines',
                                                    lambda stage: phase_lines(conn, job_id, stage, job['line_mode']))))
        phases.append(('relines', relines))
    if job['run_ocr']:
        phases.append(('ocr', lambda: _with_stage(conn, job_id, 'ocr',
                                                  lambda stage: phase_ocr(conn, job_id, stage, ocr_chunk_lines))))
        # The cut needs recognition to anchor against, and produces the reference a
        # diplomatic reading is asked with - which is requested separately, so the ground
        # truth it yields is aligned on a later run rather than this one.
        if corpus.needs_cut(conn, job_id):
            phases.append(('reference', lambda: phase_reference(conn, job_id, job['reference_overlap'])))
        has_gt = conn.execute(
            'SELECT 1 FROM pages WHERE job_id = ? AND gt_text IS NOT NULL AND deleted = 0 LIMIT 1',
            (job_id,)).fetchone() is not None
        if has_gt:
            phases.append(('align', lambda: phase_align(conn, job_id, bool(job['gt_autocheck']),
                                                        bool(job['gt_ordered']))))

    try:
        for phase, fn in phases:
            if is_cancelled(conn, job_id):
                return
            store.set_job_state(conn, job_id, phase=phase)
            fn()
        # Whatever is still homeless gets one more chance now that every line exists and
        # has been read - this is where a page-level transcription finds its lines.
        candidates.rematch_job(conn, job_id)
        # OCR keeps the line counters as it reads; without it nothing has counted the lines
        # a dataset brought along, as an imported export does.
        if not job['run_ocr']:
            store.recount_pages(conn, job_id)
        if not is_cancelled(conn, job_id):
            store.set_job_state(conn, job_id, status='done')
        conn.execute('UPDATE jobs SET phase = NULL WHERE id = ?', (job_id,))
        conn.commit()
    except Exception as exc:
        store.set_job_state(conn, job_id, status='error', error=f'{type(exc).__name__}: {exc}')
        raise


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument('--job-id', required=True)
    parser.add_argument('--db-path', required=True)
    parser.add_argument('--job-path', required=True)
    parser.add_argument('--layout-batch-size', type=int, default=4)
    parser.add_argument('--ocr-chunk-lines', type=int, default=512)
    return parser.parse_args()


def main():
    args = parse_args()
    conn = store.connect(Path(args.db_path))
    run(conn, args.job_id, Path(args.job_path), args.layout_batch_size, args.ocr_chunk_lines)


if __name__ == '__main__':
    main()
