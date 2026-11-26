from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app import layout_shapes, page_rows, store
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
    folders = {}
    for row in conn.execute('SELECT id, group_id, name, parent_id FROM folders'):
        folders.setdefault(row['group_id'], []).append({'id': row['id'], 'name': row['name'],
                                                        'parent_id': row['parent_id']})
    listed = [{'id': r['id'], 'name': store.workspace_name(r, me), 'owner': r['owner'], 'sandbox_of': r['sandbox_of'],
               'shared_with': members.get(r['id'], []), 'count': counts.get(r['id'], 0),
               'can_manage': r['sandbox_of'] is None and manages_workspace(conn, r['id'], user),
               'last_used': r['id'] == last_used,
               'folders': sorted(folders.get(r['id'], []), key=lambda f: f['name'].casefold())}
              for r in rows]
    return sorted(listed, key=lambda g: g['name'].lower())


class GroupShare(BaseModel):
    usernames: list[str]


@router.put('/api/groups/{group_id}/share')
def share_group(group_id: int, body: GroupShare, conn=Depends(get_db),
                user: dict = Depends(current_user)):
    """Everyone listed here belongs to the workspace and reaches every dataset in it,
    including ones moved into it later. Its owner stays: they reach it only as a member."""
    row = _group_or_404(conn, group_id, user)
    _require_manager(conn, row, user, 'nobody is added to a Sandbox: move a dataset into a workspace to share it')
    names = sorted({n.strip() for n in body.usernames if n.strip()})
    if row['owner'] not in names:
        raise HTTPException(409, f'{row["owner"]} owns "{row["name"]}" and stays in it - '
                                 'transfer it to someone else first')
    conn.execute('DELETE FROM group_assignees WHERE group_id = ?', (group_id,))
    conn.executemany('INSERT INTO group_assignees (group_id, username) VALUES (?, ?)',
                     [(group_id, n) for n in names])
    store.forget_unreached(conn)
    conn.commit()
    page_rows.forget_counts()
    return {'id': group_id, 'shared_with': names}


class Workspaces(BaseModel):
    group_ids: list[int]


@router.post('/api/people/{username}/workspaces')
def add_to_workspaces(username: str, body: Workspaces, conn=Depends(get_db),
                      _admin: dict = Depends(require_role('admin'))):
    """An admin puts someone into workspaces at once (#134): an account the invitation has just
    made, before its first sign-in, or one whose sign-up the admin approves. A workspace gone
    meanwhile, or a Sandbox, is skipped and named back."""
    added, missing = [], []
    for group_id in body.group_ids:
        row = conn.execute('SELECT name FROM groups WHERE id = ? AND sandbox_of IS NULL', (group_id,)).fetchone()
        if row is None:
            missing.append(group_id)
            continue
        conn.execute('INSERT OR IGNORE INTO group_assignees (group_id, username) VALUES (?, ?)', (group_id, username))
        added.append(row['name'])
    conn.commit()
    page_rows.forget_counts()
    return {'added': added, 'missing': missing}


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


class FolderBody(BaseModel):
    name: str
    parent_id: int | None = None


class FolderPatch(BaseModel):
    name: str | None = None
    parent_id: int | None = None


SANDBOX_HAS_NO_FOLDERS = 'A Sandbox has no folders'


def _folder_name(name: str) -> str:
    name = name.strip()
    if not name:
        raise HTTPException(400, 'A folder needs a name')
    return name


def _name_taken(conn, group_id: int, parent_id: int | None, name: str, besides: int) -> bool:
    """Whether a folder beside the one named `besides` already goes by this name, whatever its case.
    Compared here rather than in SQL, whose lower() leaves an umlaut as it is."""
    return any(row['id'] != besides and row['name'].casefold() == name.casefold()
               for row in conn.execute('SELECT id, name FROM folders WHERE group_id = ? AND parent_id IS ?',
                                       (group_id, parent_id)))


def _require_free_name(conn, group_id: int, parent_id: int | None, name: str, besides: int = 0):
    # Held until the folder is written, so two folders cannot both take the name at once.
    store.write_lock(conn)
    if _name_taken(conn, group_id, parent_id, name, besides):
        raise HTTPException(409, f'A folder named "{name}" is there already')


def _folder_or_404(conn, folder_id: int, user: dict):
    """A folder, and the workspace it is in once the caller is shown to manage it."""
    folder = conn.execute('SELECT * FROM folders WHERE id = ?', (folder_id,)).fetchone()
    if folder is None:
        raise HTTPException(404)
    group = _group_or_404(conn, folder['group_id'], user)
    _require_manager(conn, group, user, SANDBOX_HAS_NO_FOLDERS)
    return folder


def _parent_or_404(conn, parent_id: int, user: dict):
    parent = conn.execute('SELECT id, group_id FROM folders WHERE id = ?', (parent_id,)).fetchone()
    if parent is None or not can_reach_group(conn, parent['group_id'], user):
        raise HTTPException(404, 'folder not found')
    return parent


def _itself_and_below(conn, folder_id: int) -> set[int]:
    return {row[0] for row in conn.execute(
        'WITH RECURSIVE below(id) AS (SELECT ? UNION ALL '
        'SELECT f.id FROM folders f JOIN below b ON f.parent_id = b.id) SELECT id FROM below', (folder_id,))}


def _folder_payload(conn, folder_id: int) -> dict:
    row = conn.execute('SELECT id, name, parent_id FROM folders WHERE id = ?', (folder_id,)).fetchone()
    return {'id': row['id'], 'name': row['name'], 'parent_id': row['parent_id']}


@router.post('/api/groups/{group_id}/folders')
def create_folder(group_id: int, body: FolderBody, conn=Depends(get_db), user: dict = Depends(current_user)):
    """A folder at the top of a workspace or inside one of its folders (#133). Folders only sort
    datasets, so making one changes nobody's access."""
    group = _group_or_404(conn, group_id, user)
    _require_manager(conn, group, user, SANDBOX_HAS_NO_FOLDERS)
    if body.parent_id is not None and _parent_or_404(conn, body.parent_id, user)['group_id'] != group_id:
        raise HTTPException(404, 'folder not found')
    name = _folder_name(body.name)
    _require_free_name(conn, group_id, body.parent_id, name)
    cur = conn.execute('INSERT INTO folders (group_id, parent_id, name) VALUES (?, ?, ?)',
                       (group_id, body.parent_id, name))
    conn.commit()
    return _folder_payload(conn, cur.lastrowid)


@router.patch('/api/folders/{folder_id}')
def change_folder(folder_id: int, body: FolderPatch, conn=Depends(get_db), user: dict = Depends(current_user)):
    """Rename a folder, or move it to the top of its workspace or into another of its folders."""
    folder = _folder_or_404(conn, folder_id, user)
    fields = body.model_fields_set
    if not fields:
        raise HTTPException(400, 'nothing to change')
    name = _folder_name(body.name) if 'name' in fields and body.name is not None else folder['name']
    parent_id = body.parent_id if 'parent_id' in fields else folder['parent_id']
    if parent_id is not None:
        if _parent_or_404(conn, parent_id, user)['group_id'] != folder['group_id']:
            raise HTTPException(409, 'A folder stays in its workspace')
        if parent_id in _itself_and_below(conn, folder_id):
            raise HTTPException(409, 'A folder cannot go inside itself')
    _require_free_name(conn, folder['group_id'], parent_id, name, besides=folder_id)
    conn.execute('UPDATE folders SET name = ?, parent_id = ? WHERE id = ?', (name, parent_id, folder_id))
    conn.commit()
    return _folder_payload(conn, folder_id)


@router.delete('/api/folders/{folder_id}')
def delete_folder(folder_id: int, conn=Depends(get_db), user: dict = Depends(current_user)):
    """Delete a folder. What it held moves up to the folder that held it, or to the top of the
    workspace, so deleting one never takes a dataset with it."""
    folder = _folder_or_404(conn, folder_id, user)
    store.write_lock(conn)
    above = folder['parent_id']
    inside = conn.execute('SELECT name FROM folders WHERE parent_id = ?', (folder_id,)).fetchall()
    for child in inside:
        if _name_taken(conn, folder['group_id'], above, child['name'], besides=folder_id):
            raise HTTPException(409, f'A folder named "{child["name"]}" is there already: rename one of them first')
    datasets = conn.execute('UPDATE jobs SET folder_id = ? WHERE folder_id = ?', (above, folder_id)).rowcount
    conn.execute('UPDATE folders SET parent_id = ? WHERE parent_id = ?', (above, folder_id))
    conn.execute('DELETE FROM folders WHERE id = ?', (folder_id,))
    conn.commit()
    return {'datasets': datasets, 'folders': len(inside)}


# A group has no one name and is not inside another group, and its datasets are filed one
# by one, so these stay on the dataset they belong to.
NOT_BULK = ('name', 'group_id', 'folder_id')


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
