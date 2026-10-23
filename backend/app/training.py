import json
import queue
import threading
import unicodedata
from pathlib import Path

from PIL import Image

from app import characters, config, linecrop, store

# DeepOCR drops crops under 8px a side at prep time, so writing them is wasted work.
MIN_SIDE = 8

_queue: queue.Queue[int] = queue.Queue()


def enqueue(line_id: int) -> None:
    if config.SAVE_OCR_DATA:
        _queue.put(line_id)


def _stem(job_id: str, line_id: int) -> str:
    return f'appcorr_{job_id[:8]}_{line_id:08d}'


def _crop_line(source: Path, polygon: list[list[float]], orientation: int = 0) -> Image.Image | None:
    """The deskewed, oriented crop OCR reads, so the saved ground truth matches inference.
    Raises if the scan is gone; returns None only for the expected too-small case."""
    if not source.exists():
        raise FileNotFoundError(source)
    with Image.open(source) as im:
        im = im.convert('RGB')
        w, h = im.size
        poly = [[x * w, y * h] for x, y in polygon]
        crop = linecrop.crop_line(im, poly, orientation, mask=config.LINE_CROP_MASK)
    if crop is None or crop.width < MIN_SIDE or crop.height < MIN_SIDE:
        return None
    return crop


def write_pair(conn, line_id: int) -> None:
    row = conn.execute(
        'SELECT l.polygon, l.orientation, l.corrected_text, l.text, l.checked, l.deleted, p.source_file, p.job_id '
        'FROM lines l JOIN elements e ON l.element_id = e.id JOIN pages p ON e.page_id = p.id '
        'WHERE l.id = ?', (line_id,)).fetchone()
    if row is None:
        return
    stem = _stem(row['job_id'], line_id)
    image_path = config.CORRECTIONS_DIR / f'{stem}.png'
    text_path = config.CORRECTIONS_DIR / f'{stem}.corrected.txt'
    # Ground truth is any checked line's verified text: the human correction if there
    # is one, otherwise the machine read the reviewer confirmed by checking it.
    text = characters.training_target((row['corrected_text'] or row['text'] or '').strip())
    if row['deleted'] or not row['checked'] or not text:
        image_path.unlink(missing_ok=True)
        text_path.unlink(missing_ok=True)
        return
    try:
        crop = _crop_line(Path(row['source_file']), json.loads(row['polygon']), row['orientation'])
    except FileNotFoundError:
        # Otherwise this fails silently on every boot, forever, while backfill keeps
        # reporting it as pending.
        print(f'training pair for line {line_id}: source gone ({row["source_file"]})', flush=True)
        return
    if crop is None:
        return
    config.CORRECTIONS_DIR.mkdir(parents=True, exist_ok=True)
    crop.save(image_path)
    # DeepOCR normalizes its targets to NFD, so a precomposed umlaut would train
    # against a decomposed target it can never match.
    text_path.write_text(unicodedata.normalize('NFD', text), encoding='utf-8')


def flush_pending(conn, page_ids: list) -> int:
    """Write every outstanding correction pair for these pages, synchronously.
    Purge unlinks the scans the crops are cut from, so this has to finish first.
    No lock against the background writer is needed: whichever runs second either
    writes identical bytes or finds the source gone and no-ops."""
    if not config.SAVE_OCR_DATA or not page_ids:
        return 0
    marks = ','.join('?' * len(page_ids))
    rows = conn.execute(
        f'SELECT l.id FROM lines l JOIN elements e ON l.element_id = e.id '
        f'WHERE e.page_id IN ({marks}) AND l.deleted = 0 AND l.checked = 1 '
        "AND trim(coalesce(l.corrected_text, l.text, '')) != ''", page_ids).fetchall()
    for row in rows:
        write_pair(conn, row['id'])
    return len(rows)


def backfill() -> None:
    """Reconcile the corrections dir against the database, for edits made while we were down."""
    if not config.SAVE_OCR_DATA:
        return
    conn = store.connect(config.DB_PATH)
    try:
        rows = conn.execute(
            'SELECT l.id, p.job_id FROM lines l JOIN elements e ON l.element_id = e.id '
            'JOIN pages p ON e.page_id = p.id '
            "WHERE l.deleted = 0 AND l.checked = 1 "
            "AND trim(coalesce(l.corrected_text, l.text, '')) != ''").fetchall()
    finally:
        conn.close()
    config.CORRECTIONS_DIR.mkdir(parents=True, exist_ok=True)
    expected = {_stem(r['job_id'], r['id']): r['id'] for r in rows}
    on_disk = {p.name.split('.')[0] for p in config.CORRECTIONS_DIR.iterdir() if p.is_file()}
    # a correction reverted (or its job deleted) while we were down would otherwise
    # keep training the model on text the reviewer took back
    for stale in on_disk - set(expected):
        for path in config.CORRECTIONS_DIR.glob(f'{stale}.*'):
            path.unlink(missing_ok=True)
    missing = [line_id for stem, line_id in expected.items() if stem not in on_disk]
    for line_id in missing:
        enqueue(line_id)
    if missing or on_disk - set(expected):
        print(f'corrections backfill: {len(missing)} to write, '
              f'{len(on_disk - set(expected))} stale removed', flush=True)


def _loop() -> None:
    try:
        backfill()
    except Exception as e:
        print(f'corrections backfill failed: {e}', flush=True)
    while True:
        line_id = _queue.get()
        try:
            conn = store.connect(config.DB_PATH)
            try:
                write_pair(conn, line_id)
            finally:
                conn.close()
        except Exception as e:
            print(f'training pair for line {line_id} failed: {e}', flush=True)
        finally:
            _queue.task_done()


def start_writer() -> None:
    if not config.SAVE_OCR_DATA:
        print('SAVE_OCR_DATA is off: not archiving OCR ground-truth pairs', flush=True)
        return
    threading.Thread(target=_loop, daemon=True).start()
