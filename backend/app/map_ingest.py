"""In-process, torch-free ingest for map-segmentation jobs. Map tiles are already-cut
images, so there is no PDF branch and no downstream layout/line/OCR phases: a tile is 'done' once it is
hashed, deduplicated, sized, and has its renditions. Runs in the queue worker thread
(app/jobs.py), so it never needs the CUDA venv or the model repos.
"""

from pathlib import Path

from PIL import Image

from app import scans, store
from app.caches import counted_page

Image.MAX_IMAGE_PIXELS = None


def _is_cancelled(conn, job_id: str) -> bool:
    row = conn.execute('SELECT status FROM jobs WHERE id = ?', (job_id,)).fetchone()
    return row is None or row['status'] == 'cancelled'


def ingest_map_job(conn, job_id: str, job_path: Path, final_status: str = 'done',
                   blobs_dir: Path | None = None):
    """Ingest pending tiles. `final_status` is the status a successfully ingested tile
    reaches: 'done' for annotation-only jobs (no later phase), or 'ingested' when a
    prediction phase follows and will advance the tile to 'done' itself."""
    rend_dir = job_path / 'renditions'
    rend_dir.mkdir(parents=True, exist_ok=True)
    pages = conn.execute(
        "SELECT * FROM pages WHERE job_id = ? AND deleted = 0 AND status = 'pending' ORDER BY idx",
        (job_id,)).fetchall()
    seen = store.taken_hashes(conn, 'pages', job_id)
    done = conn.execute(
        f"SELECT COUNT(*) c FROM pages WHERE job_id = ? AND {counted_page()} AND status != 'pending'",
        (job_id,)).fetchone()['c']

    uncounted = False
    for page in pages:
        outcome = scans.ingest_page(conn, page, job_path, seen, blobs_dir, final_status)
        if outcome != final_status:
            uncounted = True
            continue
        done += 1
        store.update_counters(conn, job_id, pages_ingested=done)
        if _is_cancelled(conn, job_id):
            break
    if uncounted:
        store.recount_pages(conn, job_id)
