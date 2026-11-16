import json
import shutil
import threading
import traceback
import uuid
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path

from app import config, jobs, recognize
from app.backend_client import BackendError
from app.recognize import Refused

STAMP = '%Y-%m-%d %H:%M:%S'
UNFINISHED = ('queued', 'running')
FINISHED = ('done', 'error')
RETRY_SECONDS = 60
NOT_YOURS = 'no recognition request of yours has this id'

_sending = threading.Lock()


def _folder(request_id: str) -> Path:
    return config.RECOGNITION_DIR / request_id


def _files(request_id: str) -> Path:
    return _folder(request_id) / 'files'


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def _plan(conn, account: str, route: str, names: list[str], fields: dict):
    if route == 'pages':
        return recognize.plan_pages(conn, account, names, fields, queued=True)
    return recognize._reading(conn, fields)


def submit(conn, account: str, route: str, names: list[str], fields: dict, save: Callable[[Path], None]) -> dict:
    """Checks what an answer at once would check, then files the request to wait its turn in
    the queue. `save` writes the request's files into the folder it is given, each named by
    its place in the request."""
    recognize.check_cap(conn, account)
    _plan(conn, account, route, names, fields)
    with _sending:
        unfinished = conn.execute(f'SELECT COUNT(*) FROM recognition_requests WHERE account = ? AND status IN '
                                  f'{UNFINISHED}', (account,)).fetchone()[0]
        allowed = config.RECOGNIZE_ASYNC_PER_ACCOUNT
        if allowed and unfinished >= allowed:
            raise Refused(429, f'this account has {unfinished} async recognition requests unfinished; '
                               'send more once one has finished', RETRY_SECONDS)
        request_id = uuid.uuid4().hex[:12]
        _files(request_id).mkdir(parents=True)
        try:
            save(_files(request_id))
        except BaseException:
            shutil.rmtree(_folder(request_id), ignore_errors=True)
            raise
        conn.execute('INSERT INTO recognition_requests (id, account, route, fields, names, files) VALUES (?,?,?,?,?,?)',
                     (request_id, account, route, json.dumps(fields), json.dumps(names), len(names)))
        conn.commit()
    return _public(conn, _row(conn, request_id))


def _row(conn, request_id: str):
    return conn.execute('SELECT * FROM recognition_requests WHERE id = ?', (request_id,)).fetchone()


def _place(conn, request_id: str) -> int:
    return next(i for i, (kind, work_id) in enumerate(jobs.queued_work(conn), 1)
                if kind == 'recognition' and work_id == request_id)


def _expires(finished: str) -> str:
    return (datetime.strptime(finished, STAMP) + timedelta(hours=config.RECOGNIZE_KEEP_HOURS)).strftime(STAMP)


def _public(conn, row) -> dict:
    """Where a request stands, as its owner sees it."""
    state = {'id': row['id'], 'status': row['status']}
    if row['status'] == 'queued':
        state['place'] = _place(conn, row['id'])
    state.update(files=row['files'], done=row['files_done'], submitted_at=row['created_at'])
    if row['started_at']:
        state['started_at'] = row['started_at']
    if row['finished_at']:
        state.update(finished_at=row['finished_at'], expires_at=_expires(row['finished_at']))
    if row['status'] == 'error':
        state['error'] = row['error']
    return state


def _owned(conn, account: str, request_id: str):
    row = _row(conn, request_id)
    if row is None or row['account'] != account or row['status'] == 'cancelled':
        raise Refused(404, NOT_YOURS)
    return row


def status(conn, account: str, request_id: str) -> tuple[int, dict]:
    """202 and where it stands while it waits or reads; 200 once it finished, with the
    answer an at-once request gives, or the error that stopped it."""
    row = _owned(conn, account, request_id)
    state = _public(conn, row)
    if row['status'] == 'done':
        state.update(json.loads((_folder(request_id) / 'answer.json').read_text()))
    return (202 if row['status'] in UNFINISHED else 200), state


def listed(conn, account: str) -> list[dict]:
    """The account's async requests not yet deleted, newest first."""
    return [_public(conn, row) for row in conn.execute(
        "SELECT * FROM recognition_requests WHERE account = ? AND status != 'cancelled' "
        'ORDER BY created_at DESC, rowid DESC', (account,))]


def delete(conn, user: dict, request_id: str) -> None:
    """Its owner, or an admin, takes it off the queue - or a finished one off the disk. One
    that is reading stops after the batch it is on."""
    row = _row(conn, request_id)
    if row is None or row['status'] == 'cancelled' or (row['account'] != user['username'] and user['role'] != 'admin'):
        raise Refused(404, NOT_YOURS)
    # One statement each, so a request the worker claims meanwhile is stopped, not pulled from under it.
    if conn.execute("DELETE FROM recognition_requests WHERE id = ? AND status != 'running'", (request_id,)).rowcount:
        conn.commit()
        shutil.rmtree(_folder(request_id), ignore_errors=True)
        return
    conn.execute("UPDATE recognition_requests SET status = 'cancelled' WHERE id = ? AND status = 'running'",
                 (request_id,))
    conn.commit()


def _forget(conn, request_id: str) -> None:
    conn.execute('DELETE FROM recognition_requests WHERE id = ?', (request_id,))
    conn.commit()
    shutil.rmtree(_folder(request_id), ignore_errors=True)


def _batches(route: str, files: int) -> list[range]:
    size = (config.RECOGNIZE_MAX_PAGES if route == 'pages' else config.RECOGNIZE_MAX_LINES) or 10
    return [range(start, min(start + size, files)) for start in range(0, files, size)]


def _joined(route: str, parts: list[dict]) -> dict:
    """The answers of a request's batches as the one answer an at-once request gives."""
    answer: dict = {'models': {}, route: []}
    for part in parts:
        answer['models'].update(part['models'])
        answer[route] += part[route]
    kept = [part['kept'] for part in parts if 'kept' in part]
    if kept:
        answer['kept'] = {'dataset': next((k['dataset'] for k in kept if k['dataset']), None),
                          'name': kept[0]['name'], 'created': any(k['created'] for k in kept),
                          'pages': sum(k['pages'] for k in kept),
                          'duplicates': [name for k in kept for name in k['duplicates']]}
    return answer


def run(conn, request_id: str) -> None:
    """Reads a request in its turn, in batches of the size an answer at once may have, each
    batch's answer kept on disk as it finishes, so a request the backend stopped under goes
    on after the last finished batch."""
    claimed = conn.execute("UPDATE recognition_requests SET status = 'running', "
                           "started_at = COALESCE(started_at, datetime('now')) WHERE id = ? AND status = 'queued'",
                           (request_id,))
    conn.commit()
    if not claimed.rowcount:
        return
    row = _row(conn, request_id)
    account, route = row['account'], row['route']
    names = json.loads(row['names'])
    parts_folder = _folder(request_id) / 'batches'
    parts_folder.mkdir(exist_ok=True)
    try:
        if row['batches_done'] == 0:
            recognize.check_cap(conn, account)
        plan = _plan(conn, account, route, names, json.loads(row['fields']))
        batches = _batches(route, row['files'])
        for k in range(row['batches_done'], len(batches)):
            if _row(conn, request_id)['status'] == 'cancelled':
                _forget(conn, request_id)
                return
            uploads = [recognize.Upload(names[i], (_files(request_id) / f'{i:05d}').read_bytes()) for i in batches[k]]
            request = recognize.InFlight(request_id, account, len(uploads) if route == 'pages' else 0)
            if route == 'pages':
                part = recognize.read_pages(conn, account, plan, uploads, request, first=batches[k].start,
                                            requests=int(k == 0))
                if plan.target and plan.target.job_id is None and part['kept']['dataset']:
                    plan.target = recognize.Keeping(plan.target.name, part['kept']['dataset'])
            else:
                part = recognize.read_lines(conn, account, plan, uploads, request, first=batches[k].start,
                                            requests=int(k == 0))
            (parts_folder / f'{k:05d}.json').write_text(json.dumps(part))
            conn.execute('UPDATE recognition_requests SET batches_done = ?, files_done = ? WHERE id = ?',
                         (k + 1, batches[k].stop, request_id))
            conn.commit()
        if _row(conn, request_id)['status'] == 'cancelled':
            _forget(conn, request_id)
            return
        parts = [json.loads((parts_folder / f'{k:05d}.json').read_text()) for k in range(len(batches))]
        (_folder(request_id) / 'answer.json').write_text(json.dumps(_joined(route, parts)))
        _finish(conn, request_id, 'done')
    except Refused as refused:
        _finish(conn, request_id, 'error', refused.message)
    except BackendError as error:
        _finish(conn, request_id, 'error', f'the model backend failed: {error.message}')
    except Exception as error:  # noqa: BLE001 - one request must not stop the queue, nor keep its files
        traceback.print_exc()
        _finish(conn, request_id, 'error', f'{type(error).__name__}: {error}')


def _finish(conn, request_id: str, outcome: str, error: str | None = None) -> None:
    """Its files and batches are no longer needed once it is done or stopped; only its
    answer waits to be fetched."""
    conn.execute("UPDATE recognition_requests SET status = ?, error = ?, finished_at = datetime('now') "
                 "WHERE id = ? AND status = 'running'", (outcome, error, request_id))
    conn.commit()
    row = _row(conn, request_id)
    if row is None or row['status'] == 'cancelled':
        _forget(conn, request_id)
        return
    for folder in ('files', 'batches'):
        shutil.rmtree(_folder(request_id) / folder, ignore_errors=True)


def recover(conn) -> None:
    """On start: a request that was reading goes back to its place in the queue, to go on
    after its last finished batch; one cancelled while reading is let go, as are the files
    of one whose upload the stop cut short."""
    conn.execute("UPDATE recognition_requests SET status = 'queued' WHERE status = 'running'")
    conn.commit()
    for row in conn.execute("SELECT id FROM recognition_requests WHERE status = 'cancelled'").fetchall():
        _forget(conn, row['id'])
    known = {row['id'] for row in conn.execute('SELECT id FROM recognition_requests')}
    if config.RECOGNITION_DIR.is_dir():
        for folder in config.RECOGNITION_DIR.iterdir():
            if folder.name not in known:
                shutil.rmtree(folder, ignore_errors=True)


def sweep(conn, now: datetime | None = None) -> None:
    """Deletes what finished longer ago than results are kept."""
    cutoff = ((now or _now()) - timedelta(hours=config.RECOGNIZE_KEEP_HOURS)).strftime(STAMP)
    for row in conn.execute(f'SELECT id FROM recognition_requests WHERE status IN {FINISHED} '
                            'AND COALESCE(finished_at, started_at, created_at) < ?', (cutoff,)).fetchall():
        _forget(conn, row['id'])
