from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.deps import (REACHABLE_GROUP_IDS, can_access_job, can_reach_group, current_user, get_db,
                      require_role)
from app.routes.bulk import each_isolated
from app.routes.jobs import JobPatch, apply_patch

router = APIRouter(tags=['groups'])


def _group_or_404(conn, group_id: int, user: dict):
    """A group the caller cannot reach answers as one that does not exist, so its id does
    not confirm a project name. One they reach but do not manage is _require_manager's 403."""
    if not can_reach_group(conn, group_id, user):
        raise HTTPException(404)
    return conn.execute('SELECT * FROM groups WHERE id = ?', (group_id,)).fetchone()


def _require_manager(row, user: dict):
    if user['role'] != 'admin' and row['owner'] != user['username']:
        raise HTTPException(403, 'not permitted')


def _require_unique_name(conn, name: str, exclude_id: int | None = None):
    row = conn.execute('SELECT id FROM groups WHERE lower(name) = lower(?)', (name,)).fetchone()
    if row and row['id'] != exclude_id:
        raise HTTPException(409, f'a group named "{name}" already exists')


class GroupBody(BaseModel):
    name: str


@router.get('/api/groups')
def list_groups(conn=Depends(get_db), user: dict = Depends(current_user)):
    """Dataset groups the caller can reach, with their members. Empty ones of their own
    are included, since that is how the first dataset is moved in."""
    if user['role'] == 'admin':
        rows = conn.execute('SELECT id, name, owner FROM groups ORDER BY lower(name)').fetchall()
    else:
        rows = conn.execute(
            f'SELECT id, name, owner FROM groups WHERE id IN ({REACHABLE_GROUP_IDS}) '
            'ORDER BY lower(name)', {'me': user['username']}).fetchall()
    shared = {}
    for row in conn.execute('SELECT group_id, username FROM group_assignees ORDER BY username'):
        shared.setdefault(row['group_id'], []).append(row['username'])
    # How many datasets the caller can see in each, so a list of groups is navigable
    # without also fetching every dataset in the deployment.
    counts = {r['group_id']: r['n'] for r in conn.execute(
        'SELECT group_id, COUNT(*) n FROM jobs WHERE group_id IS NOT NULL '
        + ('' if user['role'] == 'admin' else
           'AND (owner = :me OR id IN (SELECT job_id FROM job_assignees WHERE username = :me) '
           '     OR group_id IN (SELECT group_id FROM group_assignees WHERE username = :me)) ')
        + 'GROUP BY group_id', {'me': user['username']})}
    return [{**dict(r), 'shared_with': shared.get(r['id'], []), 'count': counts.get(r['id'], 0)}
            for r in rows]


class GroupShare(BaseModel):
    usernames: list[str]


@router.put('/api/groups/{group_id}/share')
def share_group(group_id: int, body: GroupShare, conn=Depends(get_db),
                user: dict = Depends(current_user)):
    """Everyone listed here reaches every dataset in the group, including ones
    moved into it later - that is the point of sharing a group rather than
    each dataset."""
    row = _group_or_404(conn, group_id, user)
    _require_manager(row, user)
    names = sorted({n.strip() for n in body.usernames if n.strip()})
    conn.execute('DELETE FROM group_assignees WHERE group_id = ?', (group_id,))
    conn.executemany('INSERT INTO group_assignees (group_id, username) VALUES (?, ?)',
                     [(group_id, n) for n in names])
    conn.commit()
    return {'id': group_id, 'shared_with': names}


@router.post('/api/groups')
def create_group(body: GroupBody, conn=Depends(get_db),
                 user: dict = Depends(require_role('admin', 'member'))):
    """Create a dataset group."""
    name = body.name.strip()
    if not name:
        raise HTTPException(400, 'name must not be empty')
    _require_unique_name(conn, name)
    cur = conn.execute('INSERT INTO groups (name, owner) VALUES (?, ?)', (name, user['username']))
    conn.commit()
    return {'id': cur.lastrowid, 'name': name, 'owner': user['username']}


@router.patch('/api/groups/{group_id}')
def rename_group(group_id: int, body: GroupBody, conn=Depends(get_db),
                 user: dict = Depends(current_user)):
    """Rename a dataset group."""
    row = _group_or_404(conn, group_id, user)
    _require_manager(row, user)
    name = body.name.strip()
    if not name:
        raise HTTPException(400, 'name must not be empty')
    _require_unique_name(conn, name, exclude_id=group_id)
    conn.execute('UPDATE groups SET name = ? WHERE id = ?', (name, group_id))
    conn.commit()
    return {'id': group_id, 'name': name, 'owner': row['owner']}


@router.delete('/api/groups/{group_id}')
def delete_group(group_id: int, conn=Depends(get_db), user: dict = Depends(current_user)):
    """Delete a group; the datasets in it are kept."""
    row = _group_or_404(conn, group_id, user)
    _require_manager(row, user)
    # Datasets survive their group; they just fall back to ungrouped.
    conn.execute('UPDATE jobs SET group_id = NULL WHERE group_id = ?', (group_id,))
    conn.execute('DELETE FROM groups WHERE id = ?', (group_id,))
    conn.commit()
    return {'ok': True}


# A group has no one name and is not inside another group, so these two stay on the
# dataset they belong to.
NOT_BULK = ('name', 'group_id')


@router.patch('/api/groups/{group_id}/jobs')
def patch_group_jobs(group_id: int, body: JobPatch, conn=Depends(get_db),
                     user: dict = Depends(current_user)):
    """Apply one set of settings to every dataset in a group.

    Each dataset is patched exactly as it would be alone, under the same gates, so a bulk
    change grants nothing a single one would refuse. A dataset that cannot take it - one
    already running, one belonging to someone else - is named in `skipped` and the rest
    still change, since the alternative is a whole group failing over one member."""
    _group_or_404(conn, group_id, user)
    fields = body.model_fields_set
    beyond = [field for field in NOT_BULK if field in fields]
    if beyond:
        raise HTTPException(400, f'{beyond[0]} belongs to one dataset, not to a group')
    if not fields:
        raise HTTPException(400, 'nothing to change')
    rows = [row for row in conn.execute(
        'SELECT * FROM jobs WHERE group_id = ? ORDER BY lower(name)', (group_id,))
        if can_access_job(conn, row['id'], user)]
    changed, skipped = each_isolated(
        conn, rows, lambda job: apply_patch(conn, job['id'], job, body, fields, user))
    conn.commit()
    return {'changed': changed, 'skipped': skipped}
