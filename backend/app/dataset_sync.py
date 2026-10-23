import queue
import threading
import time

from app import coco, coco_lines, config, store

# Debounce window: a "mark layout complete" over many pages fires one PATCH each,
# so a burst is coalesced into a single rebuild per job.
DEBOUNCE_SECONDS = 2.0

_queue: queue.Queue = queue.Queue()


def enqueue(job_id: str) -> None:
    _queue.put(job_id)


def sync_job(conn, job_id: str) -> dict | None:
    """Rebuild both derived datasets for a job: the layout COCO (element boxes,
    gated on layout_checked) and the line-detection COCO (element crops with line
    polygons, gated on lines_checked). Each is skipped when its manifest is empty,
    so an all-unchecked or freshly-migrated state can never prune a dataset away."""
    job = store.get_job(conn, job_id)
    if job is None:
        return None
    # Only text jobs have elements/lines; map-segmentation tiles reuse layout_checked
    # as a "reviewed" flag and must never leak into the layout/line COCO datasets.
    if job.get('task', 'text') != 'text':
        return None
    dest = config.COCO_EXPORT_DIR / coco.slug(job['name'])
    layout, layout_man = coco.collect(conn, job_id)
    if layout_man['pages']:
        coco.write(layout, dest)
    lines, lines_man = coco_lines.collect(conn, job_id)
    if lines_man['pages']:
        coco_lines.write(lines, dest.with_name(dest.name + '-lines'))
    return {'layout': layout_man, 'lines': lines_man}


def backfill() -> None:
    conn = store.connect(config.DB_PATH)
    try:
        jobs = [r['job_id'] for r in conn.execute(
            'SELECT DISTINCT job_id FROM pages '
            'WHERE (layout_checked = 1 OR lines_checked = 1) AND deleted = 0')]
    finally:
        conn.close()
    for job_id in jobs:
        enqueue(job_id)


def _loop() -> None:
    try:
        backfill()
    except Exception as e:
        print(f'coco backfill failed: {e}', flush=True)
    while True:
        job_id = _queue.get()
        try:
            # Let a burst of edits accumulate, then process each affected job once.
            time.sleep(DEBOUNCE_SECONDS)
            pending = {job_id}
            while True:
                try:
                    pending.add(_queue.get_nowait())
                    _queue.task_done()
                except queue.Empty:
                    break
            conn = store.connect(config.DB_PATH)
            try:
                for jid in pending:
                    try:
                        sync_job(conn, jid)
                    except Exception as e:
                        print(f'coco sync for job {jid} failed: {e}', flush=True)
            finally:
                conn.close()
        finally:
            _queue.task_done()


def start_writer() -> None:
    threading.Thread(target=_loop, daemon=True).start()
