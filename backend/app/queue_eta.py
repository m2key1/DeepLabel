import json
from datetime import datetime
from statistics import median

# How many finished runs a pace is taken from: recent enough to follow a new model or
# card, enough that one odd run does not decide it.
HISTORY = 20
# Below this much progress a running item's own pace says little yet.
MIN_FRACTION = 0.05

# With nothing to go by an estimate says so rather than guessing.
UNKNOWN = {'seconds': None, 'basis': 'unknown'}


def _when(text: str | None) -> datetime | None:
    return datetime.fromisoformat(text) if text else None


def _estimate(seconds: float, basis: str) -> dict:
    return {'seconds': max(0, round(seconds)), 'basis': basis}


def _paces(rows, amount) -> list[float]:
    paces = []
    for row in rows:
        took = (_when(row['finished_at']) - _when(row['started_at'])).total_seconds()
        if took > 0 and amount(row):
            paces.append(took / amount(row))
    return paces


def _from_progress(started: str | None, fraction: float, now: datetime) -> dict | None:
    if not started or fraction < MIN_FRACTION or fraction >= 1:
        return None
    elapsed = (now - _when(started)).total_seconds()
    return _estimate(elapsed * (1 - fraction) / fraction, 'progress')


def _dataset_fraction(job) -> float:
    """How far a running dataset has got: the mean of its phases' done shares."""
    c = json.loads(job['counters'] or '{}')
    phases = [(c.get('pages_ingested'), c.get('pages_total'))]
    if job['run_layout']:
        phases.append((c.get('pages_layout_done'), c.get('pages_total')))
    if job['run_lines']:
        phases.append((c.get('elements_lines_done'), c.get('elements_total')))
    if job['run_ocr']:
        phases.append((c.get('lines_ocr_done'), c.get('lines_total')))
    shares = [min(1, (done or 0) / total) if total else 0 for done, total in phases]
    return sum(shares) / len(shares)


def dataset(conn, job_id: str, now: datetime) -> dict:
    job = conn.execute('SELECT * FROM jobs WHERE id = ?', (job_id,)).fetchone()
    if job['status'] == 'running':
        measured = _from_progress(job['started_at'], _dataset_fraction(job), now)
        if measured:
            return measured
    pages = lambda row: conn.execute('SELECT COUNT(*) FROM pages WHERE job_id = ? AND deleted = 0',
                                     (row['id'],)).fetchone()[0]
    recent = conn.execute(
        "SELECT * FROM jobs WHERE status = 'done' AND started_at IS NOT NULL AND finished_at IS NOT NULL "
        'ORDER BY finished_at DESC LIMIT ?', (HISTORY,)).fetchall()
    paces = _paces(recent, pages)
    return _estimate(median(paces) * pages(job), 'history') if paces and pages(job) else UNKNOWN


def training(conn, training_id: int, progress: dict | None, now: datetime) -> dict:
    run = conn.execute('SELECT * FROM trainings WHERE id = ?', (training_id,)).fetchone()
    epochs = run['epochs']
    if run['status'] == 'running' and progress and progress.get('epoch') and epochs:
        measured = _from_progress(run['started_at'], progress['epoch'] / epochs, now)
        if measured:
            return measured
    recent = conn.execute(
        "SELECT * FROM trainings WHERE status = 'done' AND task = ? AND target = ? AND epochs > 0 "
        'AND started_at IS NOT NULL AND finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT ?',
        (run['task'], run['target'], HISTORY)).fetchall()
    paces = _paces(recent, lambda row: row['epochs'])
    return _estimate(median(paces) * epochs, 'history') if paces and epochs else UNKNOWN


def evaluation(conn, evaluation_id: int, now: datetime) -> dict:
    recent = conn.execute(
        "SELECT * FROM evaluations WHERE status = 'done' AND started_at IS NOT NULL AND finished_at IS NOT NULL "
        'ORDER BY finished_at DESC LIMIT ?', (HISTORY,)).fetchall()
    paces = _paces(recent, lambda row: 1)
    if not paces:
        return UNKNOWN
    took = median(paces)
    ev = conn.execute('SELECT status, started_at FROM evaluations WHERE id = ?', (evaluation_id,)).fetchone()
    if ev['status'] == 'running' and ev['started_at']:
        took -= (now - _when(ev['started_at'])).total_seconds()
    return _estimate(took, 'history')
