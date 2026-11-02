import json
from datetime import datetime
from statistics import median

# How many finished runs a pace is taken from: recent enough to follow a new model or
# card, enough that one odd run does not decide it.
HISTORY = 20
# How far back a dataset's own kind of run is looked for before falling back to all of them.
LOOKBACK = 200
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


def _pages(conn, job_id: str) -> int:
    return conn.execute('SELECT COUNT(*) FROM pages WHERE job_id = ? AND deleted = 0', (job_id,)).fetchone()[0]


def _default_ocr(conn) -> int | None:
    row = conn.execute("SELECT id FROM models WHERE task = 'ocr' AND is_default = 1 AND archived = 0").fetchone()
    return row['id'] if row else None


def _read_by(conn, job_id: str) -> int | None:
    """The OCR model that read a finished dataset, from its lines: the dataset's own column
    may have changed since, or be empty for whatever the default was then."""
    row = conn.execute('SELECT l.ocr_model_id FROM pages p JOIN elements e ON e.page_id = p.id '
                       'JOIN lines l ON l.element_id = e.id WHERE p.job_id = ? AND l.ocr_model_id IS NOT NULL '
                       'LIMIT 1', (job_id,)).fetchone()
    return row[0] if row else None


def _kind(job, ocr_model: int | None) -> tuple:
    """What a dataset's run does, as far as its pace goes."""
    if job['task'] != 'text':
        return ('tiles', job['task'])
    return ('ocr', ocr_model) if job['run_ocr'] else ('no_ocr',)


def dataset_history(conn) -> list[tuple[tuple, float]]:
    """Recent finished datasets, newest first, as the kind of run and its seconds per page.
    Read once for a whole queue rather than once for each dataset in it."""
    recent = conn.execute(
        "SELECT * FROM jobs WHERE status = 'done' AND started_at IS NOT NULL AND finished_at IS NOT NULL "
        'ORDER BY finished_at DESC LIMIT ?', (LOOKBACK,)).fetchall()
    default = _default_ocr(conn)
    history = []
    for job in recent:
        paces = _paces([job], lambda row: _pages(conn, row['id']))
        if paces:
            ocr_model = _read_by(conn, job['id']) or job['model_ocr_id'] or default
            history.append((_kind(job, ocr_model), paces[0]))
    return history


def dataset(conn, job_id: str, now: datetime, history: list[tuple[tuple, float]] | None = None) -> dict:
    job = conn.execute('SELECT * FROM jobs WHERE id = ?', (job_id,)).fetchone()
    if job['status'] == 'running':
        measured = _from_progress(job['started_at'], _dataset_fraction(job), now)
        if measured:
            return measured
    history = dataset_history(conn) if history is None else history
    kind = _kind(job, job['model_ocr_id'] or _default_ocr(conn))
    paces = [pace for k, pace in history if k == kind][:HISTORY] or [pace for _, pace in history][:HISTORY]
    pages = _pages(conn, job_id)
    return _estimate(median(paces) * pages, 'history') if paces and pages else UNKNOWN


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
