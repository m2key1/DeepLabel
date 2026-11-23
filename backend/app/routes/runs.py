import json

from fastapi import APIRouter, Depends, HTTPException

from app import revert, store
from app.deps import current_user, get_db, require_job_access, role_on_job
from app.routes.pipeline import require_idle, require_rerun_manager

router = APIRouter(tags=['runs'])

ENDED = ('done', 'error', 'cancelled')


@router.get('/api/jobs/{job_id}/runs')
def job_runs(job_id: str, conn=Depends(get_db), user: dict = Depends(current_user)):
    """The dataset's runs, newest first, each with what it wrote to and whether it can be
    taken back. The first run of a dataset is the one its making queued."""
    require_job_access(conn, job_id, user)
    job = store.get_job(conn, job_id)
    if job is None:
        raise HTTPException(404)
    changed: dict[int, dict] = {}
    for row in conn.execute(
            "SELECT r.run_id, r.target_type, COUNT(DISTINCT r.target_id) n FROM revisions r "
            "JOIN runs ru ON ru.id = r.run_id WHERE ru.job_id = ? AND r.action != 'origin' "
            "AND r.target_type IN ('line', 'element') GROUP BY r.run_id, r.target_type", (job_id,)):
        changed.setdefault(row['run_id'], {'lines': 0, 'boxes': 0})[revert.RUN_ROWS[row['target_type']]] = row['n']
    runs = conn.execute('SELECT * FROM runs WHERE job_id = ? ORDER BY id DESC', (job_id,)).fetchall()
    first = runs[-1]['id'] if runs else None

    def entry(run) -> dict:
        counts = changed.get(run['id'], {'lines': 0, 'boxes': 0})
        return {'id': run['id'], 'reason': run['reason'] or ('new' if run['id'] == first else None),
                'started_by': run['started_by'] or (job['owner'] if run['id'] == first else None),
                'phases': json.loads(run['phases']), 'status': run['status'],
                'queued_at': run['queued_at'], 'started_at': run['started_at'], 'finished_at': run['finished_at'],
                'changed': counts, 'reverted_at': run['reverted_at'], 'reverted_by': run['reverted_by'],
                'revertable': run['status'] in ENDED and run['reverted_at'] is None and any(counts.values())}

    return {'job': {'id': job['id'], 'name': job['name'], 'status': job['status'],
                    'my_role': role_on_job(conn, job_id, user)},
            'runs': [entry(run) for run in runs]}


def _run_of(conn, job_id: str, run_id: int, user: dict) -> dict:
    require_job_access(conn, job_id, user)
    job = store.get_job(conn, job_id)
    run = conn.execute('SELECT status FROM runs WHERE id = ? AND job_id = ?', (run_id, job_id)).fetchone()
    if job is None or run is None:
        raise HTTPException(404)
    if run['status'] not in ENDED:
        raise HTTPException(409, 'the run is still going')
    return job


@router.get('/api/jobs/{job_id}/runs/{run_id}/revert')
def run_revert_preview(job_id: str, run_id: int, conn=Depends(get_db), user: dict = Depends(current_user)):
    """What reverting the run would put back, take off and leave, or why it cannot be."""
    _run_of(conn, job_id, run_id, user)
    return revert.plan_run_revert(conn, run_id, user['username'])[0]


@router.post('/api/jobs/{job_id}/runs/{run_id}/revert')
def revert_run(job_id: str, run_id: int, conn=Depends(get_db), user: dict = Depends(current_user)):
    """Put back what the run replaced. A Manager's call, like running it, and refused while
    the dataset is busy, whose runner would write over it."""
    job = _run_of(conn, job_id, run_id, user)
    require_rerun_manager(conn, job, user)
    require_idle(job)
    try:
        return revert.revert_run(conn, job_id, run_id, user['username'])
    except revert.Conflict as exc:
        raise HTTPException(409, exc.detail['message']) from None
