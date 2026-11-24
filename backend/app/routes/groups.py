from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app import layout_shapes, store
from app.deps import (REACHABLE_GROUP_IDS, VISIBLE_JOB_IDS, can_access_job, can_reach_group, current_user,
                      get_db, manages_workspace, require_role)
from app.routes.bulk import each_isolated
from app.routes.jobs import JobPatch, apply_patch

router = APIRouter(tags=['groups'])


def _group_or_404(conn, group_id: int, user: dict):
    """A workspace the caller cannot reach answers as one that does not exist, so its id
    does not confirm a project name. One they reach but do not manage is a 403."""
    if not can_reach_group(conn, group_id, user):
        raise HTTPException(404)
    return conn.execute('SELECT * FROM groups WHERE id = ?', (group_id,)).fetchone()


def _require_manager(conn, row, user: dict, sandbox_refusal: str):
    """Only a workspace's Managers change it; a Sandbox is never changed this way."""
    if row['sandbox_of'] is not None:
        raise HTTPException(409, sandbox_refusal)
    if not manages_workspace(conn, row['id'], user):
        raise HTTPException(403, 'not permitted: this takes a Manager of the workspace')


def _require_unique_name(conn, name: str, exclude_id: int | None = None):
    row = conn.execute('SELECT id FROM groups WHERE lower(name) = lower(?) AND sandbox_of IS NULL',
                       (name,)).fetchone()
    if row and row['id'] != exclude_id:
        raise HTTPException(409, f'a workspace named "{name}" already exists')



class GroupBody(BaseModel):
    name: str


@router.get('/api/groups')
def list_groups(conn=Depends(get_db), user: dict = Depends(current_user)):
    """The workspaces the caller can reach, their own Sandbox among them, with their
    members. Empty ones are included, since that is how the first dataset is moved in."""
    me = user['username']
    if user['role'] == 'admin':
        rows = conn.execute('SELECT id, name, owner, sandbox_of FROM groups').fetchall()
    else:
        rows = conn.execute(f'SELECT id, name, owner, sandbox_of FROM groups WHERE id IN ({REACHABLE_GROUP_IDS})',
                            {'me': me}).fetchall()
    members = {}
    for row in conn.execute('SELECT group_id, username FROM group_assignees ORDER BY username'):
        members.setdefault(row['group_id'], []).append(row['username'])
    # How many datasets the caller can see in each, so a list of workspaces is navigable
    # without also fetching every dataset in the deployment.
    counts = {r['group_id']: r['n'] for r in conn.execute(
        'SELECT group_id, COUNT(*) n FROM jobs WHERE group_id IS NOT NULL '
        + ('' if user['role'] == 'admin' else f'AND id IN ({VISIBLE_JOB_IDS}) ')
        + 'GROUP BY group_id', {'me': me})}
    # Where the caller made their newest dataset, which the New job wizard starts on.
    newest = conn.execute('SELECT group_id FROM jobs WHERE owner = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
                          (me,)).fetchone()
    last_used = newest['group_id'] if newest else None
    listed = [{'id': r['id'], 'name': store.workspace_name(r, me), 'owner': r['owner'], 'sandbox_of': r['sandbox_of'],
               'shared_with': members.get(r['id'], []), 'count': counts.get(r['id'], 0),
               'can_manage': r['sandbox_of'] is None and manages_workspace(conn, r['id'], user),
               'last_used': r['id'] == last_used}
              for r in rows]
    return sorted(listed, key=lambda g: g['name'].lower())


class GroupShare(BaseModel):
    usernames: list[str]


@router.put('/api/groups/{group_id}/share')
def share_group(group_id: int, body: GroupShare, conn=Depends(get_db),
                user: dict = Depends(current_user)):
    """Everyone listed here belongs to the workspace and reaches every dataset in it,
    including ones moved into it later."""
    row = _group_or_404(conn, group_id, user)
    _require_manager(conn, row, user, 'nobody is added to a Sandbox: move a dataset into a workspace to share it')
    names = sorted({n.strip() for n in body.usernames if n.strip()})
    conn.execute('DELETE FROM group_assignees WHERE group_id = ?', (group_id,))
    conn.executemany('INSERT INTO group_assignees (group_id, username) VALUES (?, ?)',
                     [(group_id, n) for n in names])
    store.forget_unreached_roles(conn)
    conn.commit()
    return {'id': group_id, 'shared_with': names}


@router.post('/api/groups')
def create_group(body: GroupBody, conn=Depends(get_db),
                 user: dict = Depends(require_role('admin', 'manager'))):
    """Create a workspace, which its creator belongs to."""
    name = body.name.strip()
    if not name:
        raise HTTPException(400, 'name must not be empty')
    _require_unique_name(conn, name)
    cur = conn.execute('INSERT INTO groups (name, owner) VALUES (?, ?)', (name, user['username']))
    conn.execute('INSERT INTO group_assignees (group_id, username) VALUES (?, ?)', (cur.lastrowid, user['username']))
    conn.commit()
    return {'id': cur.lastrowid, 'name': name, 'owner': user['username']}


@router.patch('/api/groups/{group_id}')
def rename_group(group_id: int, body: GroupBody, conn=Depends(get_db),
                 user: dict = Depends(current_user)):
    """Rename a workspace."""
    row = _group_or_404(conn, group_id, user)
    _require_manager(conn, row, user, 'a Sandbox keeps its name')
    name = body.name.strip()
    if not name:
        raise HTTPException(400, 'name must not be empty')
    _require_unique_name(conn, name, exclude_id=group_id)
    conn.execute('UPDATE groups SET name = ? WHERE id = ?', (name, group_id))
    conn.commit()
    return {'id': group_id, 'name': name, 'owner': row['owner']}


@router.delete('/api/groups/{group_id}')
def delete_group(group_id: int, conn=Depends(get_db), user: dict = Depends(current_user)):
    """Delete an empty workspace. One that holds datasets is refused, so deleting it never
    takes a dataset with it."""
    row = _group_or_404(conn, group_id, user)
    _require_manager(conn, row, user, 'a Sandbox is never deleted')
    held = conn.execute('SELECT COUNT(*) FROM jobs WHERE group_id = ?', (group_id,)).fetchone()[0]
    if held:
        raise HTTPException(409, f"move or delete its {held} dataset{'s' if held != 1 else ''} first")
    conn.execute('DELETE FROM group_assignees WHERE group_id = ?', (group_id,))
    conn.execute('DELETE FROM groups WHERE id = ?', (group_id,))
    conn.commit()
    return {'ok': True}


# A group has no one name and is not inside another group, so these two stay on the
# dataset they belong to.
NOT_BULK = ('name', 'group_id')


@router.get('/api/groups/{group_id}/layout-shape-changes')
def group_layout_shape_changes(group_id: int, shape: str, conn=Depends(get_db), user: dict = Depends(current_user)):
    """What a lower layout shape would change across every dataset of a group the caller can see."""
    _group_or_404(conn, group_id, user)
    if shape not in layout_shapes.LEVELS:
        raise HTTPException(400, f'shape must be one of {list(layout_shapes.LEVELS)}')
    job_ids = [row['id'] for row in conn.execute('SELECT id FROM jobs WHERE group_id = ?', (group_id,))
               if can_access_job(conn, row['id'], user)]
    return layout_shapes.changes(conn, job_ids, shape) if job_ids else {'polygon': 0, 'rotated': 0}


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
        raise HTTPException(400, f'{beyond[0]} belongs to one dataset, not to a workspace')
    if not fields:
        raise HTTPException(400, 'nothing to change')
    rows = [row for row in conn.execute(
        'SELECT * FROM jobs WHERE group_id = ? ORDER BY lower(name)', (group_id,))
        if can_access_job(conn, row['id'], user)]
    changed, skipped = each_isolated(
        conn, rows, lambda job: apply_patch(conn, job['id'], job, body, fields, user))
    conn.commit()
    return {'changed': changed, 'skipped': skipped}
