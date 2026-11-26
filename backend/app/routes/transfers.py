from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app import data_use, page_rows, store
from app.deps import can_access_job, can_reach_group, current_user, get_db, require_job_access

router = APIRouter(tags=['datasets'])


class Handover(BaseModel):
    to: str
    # A workspace's only: the datasets its previous owner made in it go along.
    datasets: bool = True


def _recipient(body: Handover, owner: str) -> str:
    to = body.to.strip()
    if not to:
        raise HTTPException(400, 'Name the person to hand it to')
    if to == owner:
        raise HTTPException(400, f'{to} owns it already')
    return to


def _hand_over(conn, job_id: str, owner: str, to: str, by: str) -> None:
    """The dataset is the recipient's, who opens it as its owner. Whoever reached it only as its
    owner is given it alone, so handing it over never locks its maker out."""
    conn.execute('UPDATE jobs SET owner = ? WHERE id = ?', (to, job_id))
    if not can_access_job(conn, job_id, {'username': owner, 'role': 'annotator'}):
        conn.execute('INSERT OR IGNORE INTO job_assignees (job_id, username) VALUES (?, ?)', (job_id, owner))
    data_use.log(conn, job_id, by, 'transfer', {'from': owner, 'to': to}, commit=False)


@router.post('/api/jobs/{job_id}/transfer')
def transfer_job(job_id: str, body: Handover, conn=Depends(get_db), user: dict = Depends(current_user)):
    """Hand a dataset over to someone else (#79): its owner or an admin may. A Sandbox dataset is
    moved into a workspace first, where the people it is handed to can work on it."""
    require_job_access(conn, job_id, user)
    # Read and handed over under one lock, so two hand-overs at once cannot both pass the owner check.
    store.write_lock(conn)
    job = store.get_job(conn, job_id)
    if job['owner'] != user['username'] and user['role'] != 'admin':
        raise HTTPException(403, "Only the dataset's owner or an admin hands it over")
    if store.is_sandbox(conn, job['group_id']):
        raise HTTPException(409, 'A dataset in a Sandbox is moved into a workspace before it is handed over')
    to = _recipient(body, job['owner'])
    _hand_over(conn, job_id, job['owner'], to, user['username'])
    conn.commit()
    page_rows.forget_counts(conn, job_id)
    return {'id': job_id, 'owner': to}


@router.post('/api/groups/{group_id}/transfer')
def transfer_group(group_id: int, body: Handover, conn=Depends(get_db), user: dict = Depends(current_user)):
    """Hand a workspace over to someone else (#79), who joins it: its owner or an admin may. The
    datasets the previous owner made in it go along, unless the request says otherwise. Managing
    it still takes a Manager's role."""
    if not can_reach_group(conn, group_id, user):
        raise HTTPException(404)
    # The workspace and its datasets change hands together, under one lock and one commit.
    store.write_lock(conn)
    group = conn.execute('SELECT owner, sandbox_of FROM groups WHERE id = ?', (group_id,)).fetchone()
    if group['sandbox_of'] is not None:
        raise HTTPException(409, 'A Sandbox stays with the person it belongs to')
    if group['owner'] != user['username'] and user['role'] != 'admin':
        raise HTTPException(403, "Only the workspace's owner or an admin hands it over")
    to = _recipient(body, group['owner'])
    conn.execute('UPDATE groups SET owner = ? WHERE id = ?', (to, group_id))
    conn.execute('INSERT OR IGNORE INTO group_assignees (group_id, username) VALUES (?, ?)', (group_id, to))
    moved = [row[0] for row in conn.execute('SELECT id FROM jobs WHERE group_id = ? AND owner = ? ORDER BY id',
                                            (group_id, group['owner']))] if body.datasets else []
    for job_id in moved:
        _hand_over(conn, job_id, group['owner'], to, user['username'])
    conn.commit()
    page_rows.forget_counts()
    return {'id': group_id, 'owner': to, 'datasets': len(moved)}
