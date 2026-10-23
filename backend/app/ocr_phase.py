import json
from collections.abc import Callable

from PIL import Image

from app import config, linecrop, store

# Reads line crops: the images, and what DeepLabel knows about each beside its pixels, in;
# texts, confidences and per-character profiles out, in the same order.
Read = Callable[[list[Image.Image], list[dict]], tuple[list[str], list[float], list]]


# A line this many times taller than wide on the page is vertical text. Its crop
# runs along its length either way, so it is read both ways - top to bottom (0) and bottom to
# top (180) - and keeps the more confident reading.
VERTICAL_RATIO = 2.0


def _orientations(line, width: int, height: int) -> tuple[int, ...]:
    """The orientations a line is read at: its own, and for an unturned vertical line also
    the opposite direction. An orientation a person set is never second-guessed."""
    if line['orientation']:
        return (line['orientation'],)
    points = json.loads(line['polygon'])
    xs, ys = [p[0] * width for p in points], [p[1] * height for p in points]
    tall = (max(ys) - min(ys)) >= VERTICAL_RATIO * max(1.0, max(xs) - min(xs))
    return (0, 180) if tall else (0,)


def is_cancelled(conn, job_id: str) -> bool:
    row = conn.execute('SELECT status FROM jobs WHERE id = ?', (job_id,)).fetchone()
    return row is None or row['status'] == 'cancelled'


def run(conn, job_id: str, read: Read, author: str, model_id: int | None, chunk_lines: int) -> None:
    """Read every line of a dataset that has no text yet or is queued for a re-read, page by
    page, whichever model does the reading - in this process or on a model backend."""
    # Lines queued for re-OCR still carry their old text - they must not sit in
    # the seed AND get counted again on rewrite, or done overshoots total.
    done = conn.execute(
        "SELECT COUNT(*) c FROM lines l JOIN elements e ON l.element_id = e.id "
        "JOIN pages p ON e.page_id = p.id WHERE p.job_id = ? AND p.deleted = 0 AND l.deleted = 0 "
        "AND l.text IS NOT NULL AND l.needs_ocr = 0", (job_id,)).fetchone()['c']

    def flush(batch):
        nonlocal done
        if not batch:
            return
        batch.sort(key=lambda item: item[1].width)
        texts, confs, profiles = read([img for _, img, _, _ in batch], [context for _, _, context, _ in batch])
        best = {}
        for (line_id, _, _, orientation), text, conf, profile in zip(batch, texts, confs, profiles):
            if line_id not in best or (conf or 0) > (best[line_id][1] or 0):
                best[line_id] = (text, conf, profile, orientation)
        for line_id, (text, conf, profile, orientation) in best.items():
            conn.execute('UPDATE lines SET text = ?, confidence = ?, conf_profile = ?, orientation = ?, needs_ocr = 0, '
                         "ocr_model_id = ?, ocr_run_at = datetime('now') WHERE id = ?",
                         (text.strip(), conf, json.dumps(profile) if profile else None, orientation, model_id,
                          line_id))
            store.log_line(conn, line_id, author, 'update')
        conn.commit()
        done += len(best)
        store.update_counters(conn, job_id, lines_ocr_done=done)

    pages = conn.execute(
        "SELECT DISTINCT p.* FROM pages p JOIN elements e ON e.page_id = p.id "
        "JOIN lines l ON l.element_id = e.id "
        "WHERE p.job_id = ? AND p.deleted = 0 AND l.deleted = 0 AND p.status IN ('lines_done', 'done') "
        "AND (l.text IS NULL OR l.needs_ocr = 1) "
        "ORDER BY p.idx", (job_id,)).fetchall()

    pending = []
    for page in pages:
        img = Image.open(page['source_file']).convert('RGB')
        width, height = img.size
        elements = conn.execute(
            "SELECT * FROM elements WHERE page_id = ? AND kind != 'container' AND deleted = 0 ORDER BY order_idx",
            (page['id'],)).fetchall()

        for element in elements:
            bbox = json.loads(element['bbox'])
            ex0, ey0 = round(bbox[0] * width), round(bbox[1] * height)
            crop = img.crop((ex0, ey0, round(bbox[2] * width), round(bbox[3] * height)))
            if crop.width == 0 or crop.height == 0:
                continue

            lines = conn.execute(
                'SELECT * FROM lines WHERE element_id = ? AND deleted = 0 '
                'AND (text IS NULL OR needs_ocr = 1) ORDER BY order_idx',
                (element['id'],)).fetchall()
            for line in lines:
                poly = [[pt[0] * width - ex0, pt[1] * height - ey0] for pt in json.loads(line['polygon'])]
                context = {'element_class': element['class_name'], 'line_index': line['order_idx']}
                crops = [(orientation, linecrop.crop_line(crop, poly, orientation, mask=config.LINE_CROP_MASK))
                         for orientation in _orientations(line, width, height)]
                if crops[0][1] is None:
                    conn.execute("UPDATE lines SET text = '', needs_ocr = 0, ocr_model_id = ?, "
                                 "ocr_run_at = datetime('now') WHERE id = ?", (model_id, line['id']))
                    store.log_line(conn, line['id'], author, 'update')
                    continue
                pending.extend((line['id'], line_img, context, orientation) for orientation, line_img in crops
                               if line_img is not None)
                if len(pending) >= chunk_lines:
                    flush(pending)
                    pending = []

        conn.execute("UPDATE pages SET status = 'done' WHERE id = ?", (page['id'],))
        conn.commit()
        if is_cancelled(conn, job_id):
            break

    flush(pending)
