import os
import subprocess
import sys
import threading
import time
import traceback
from pathlib import Path

from app import config, ingest, store

# A new dataset's pages are rendered here, beside the GPU queue rather than inside it: a
# large PDF otherwise held the GPU while only the CPU worked, and everyone waited behind it.
INGESTING = 'ingesting'
# How many datasets ingest at once across the server; rendering a PDF takes the CPU.
AT_ONCE = 2
TICK_SECONDS = 1

BACKEND_DIR = Path(__file__).resolve().parents[1]


def has_pending(conn, job_id: str) -> bool:
    return conn.execute("SELECT 1 FROM pages WHERE job_id = ? AND status = 'pending' AND deleted = 0 LIMIT 1",
                        (job_id,)).fetchone() is not None


def waiting_status(conn, job_id: str) -> str:
    """Where a dataset waits once its pages are in: the ingester while a text dataset has
    pages still to render, else the GPU queue. Map datasets tile in their own runner."""
    job = store.get_job(conn, job_id)
    if job is not None and not ingest.is_tile_task(job['task']) and has_pending(conn, job_id):
        return INGESTING
    return 'queued'


def spawn(job_id: str) -> subprocess.Popen:
    env = {**os.environ, 'PYTHONPATH': str(BACKEND_DIR)}
    with open(config.job_dir(job_id) / 'ingest.log', 'a') as log:
        return subprocess.Popen(
            [sys.executable, '-m', 'app.ingest_job', '--job-id', job_id, '--db-path', str(config.DB_PATH),
             '--job-path', str(config.job_dir(job_id))],
            cwd=BACKEND_DIR, env=env, stdout=log, stderr=subprocess.STDOUT)


class Ingester:
    """Runs the ingest of the oldest ingesting datasets, AT_ONCE at a time, each in a process
    of its own, and hands each to the GPU queue as its process ends."""

    def __init__(self, spawn=spawn):
        self.spawn = spawn
        self.running: dict[str, object] = {}

    def tick(self, conn) -> None:
        for job_id, process in list(self.running.items()):
            code = process.poll()
            if code is None:
                continue
            del self.running[job_id]
            self._finished(conn, job_id, code)
        waiting = conn.execute(
            'SELECT id FROM jobs WHERE status = ? ORDER BY created_at, rowid', (INGESTING,)).fetchall()
        for row in waiting:
            if len(self.running) >= AT_ONCE:
                break
            if row['id'] in self.running:
                continue
            process = self.spawn(row['id'])
            self.running[row['id']] = process
            conn.execute("UPDATE jobs SET pid = ?, phase = 'ingest' WHERE id = ?", (process.pid, row['id']))
            conn.commit()

    def _finished(self, conn, job_id: str, code: int) -> None:
        conn.execute('UPDATE jobs SET pid = NULL WHERE id = ?', (job_id,))
        conn.commit()
        job = store.get_job(conn, job_id)
        if job is None or job['status'] != INGESTING:
            return
        if code != 0:
            conn.execute("UPDATE jobs SET status = 'error', phase = NULL, error = ? WHERE id = ?",
                         (f'Ingesting the pages stopped with exit code {code}; see ingest.log', job_id))
        else:
            # Even with a page it could not move: the run's own ingest tries that one again,
            # where another round here would take it up every second for good.
            conn.execute("UPDATE jobs SET status = 'queued', phase = NULL WHERE id = ?", (job_id,))
        conn.commit()


def _loop() -> None:
    conn = store.connect(config.DB_PATH)
    ingester = Ingester()
    while True:
        try:
            ingester.tick(conn)
        except Exception:
            traceback.print_exc()
            conn.rollback()
        time.sleep(TICK_SECONDS)


def start_ingester() -> None:
    threading.Thread(target=_loop, daemon=True).start()
