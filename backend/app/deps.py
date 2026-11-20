import unicodedata
from collections.abc import Callable
from urllib.parse import quote

from fastapi import Depends, HTTPException, Request

from app import config, store

# Renditions and crops are keyed by page/element id and written once, so they
# never change under a given URL. A bare FileResponse sets an ETag but does not
# answer conditional requests, so without this every thumbnail is refetched in
# full on every visit.
IMMUTABLE_CACHE = {'Cache-Control': 'private, max-age=31536000, immutable'}


def attachment(filename: str) -> dict:
    """The download header for a file of this name. Headers travel as Latin-1, so a name
    beyond printable ASCII goes in filename* (RFC 6266), with an ASCII stand-in for
    clients that do not read it."""
    filename = filename.replace('"', '')
    unaccented = ''.join(c for c in unicodedata.normalize('NFKD', filename) if not unicodedata.combining(c))
    fallback = ''.join(c if ' ' <= c <= '~' and c != '\\' else '_' for c in unaccented)
    if fallback == filename:
        return {'Content-Disposition': f'attachment; filename="{filename}"'}
    return {'Content-Disposition':
            f"attachment; filename=\"{fallback}\"; filename*=UTF-8''{quote(filename, safe='')}"}


def get_db():
    conn = store.connect(config.DB_PATH)
    try:
        yield conn
    finally:
        conn.close()


def current_user(request: Request) -> dict:
    """The logged-in user row (dict), set by the auth middleware. Present on every gated route."""
    user = getattr(request.state, 'user', None)
    if user is None:
        raise HTTPException(401, 'not authenticated')
    return user


def get_user(user: dict = Depends(current_user)) -> str:
    """Username string for attribution - keeps every existing store.log_* call site."""
    return user['username']


def require_role(*roles: str):
    def dep(user: dict = Depends(current_user)):
        if user['role'] not in roles:
            raise HTTPException(403, 'not permitted')
        return user
    return dep


# Each role may do everything the one before it may.
ROLES = ('viewer', 'annotator', 'reviewer', 'manager', 'admin')
WRITERS = ROLES[1:]
ROLE_NAMES = {'viewer': 'Viewer', 'annotator': 'Annotator', 'reviewer': 'Reviewer', 'manager': 'Manager',
              'admin': 'Admin'}
# An account the auth service has not moved to these roles yet keeps what it could do.
LEGACY_ROLES = {'member': 'manager'}


def role_reaches(role: str, least: str) -> bool:
    return role in ROLES and ROLES.index(role) >= ROLES.index(least)


def has_capability(user: dict, capability: str) -> bool:
    """An admin may do everything, whatever the header says - that is what the role is.
    Everyone else carries the set the auth service resolved for them."""
    return user['role'] == 'admin' or capability in user.get('caps', ())


def require_capability(capability: str):
    """A gate on what a person may ask for, as opposed to which datasets they may see -
    that is `require_job_access`, and both apply."""
    def dep(user: dict = Depends(current_user)):
        check_capability(user, capability)
        return user
    return dep


def check_capability(user: dict, capability: str) -> None:
    if not has_capability(user, capability):
        raise HTTPException(403, f'not permitted: {capability}')


# The datasets someone other than an admin opens: those they created, those they were
# given, every one in a workspace they belong to - now and later - and those in their
# Sandbox. One statement for a dataset, a list and a count alike, so they cannot disagree.
VISIBLE_JOB_IDS = (
    'SELECT id FROM jobs WHERE owner = :me '
    'OR id IN (SELECT job_id FROM job_assignees WHERE username = :me) '
    'OR group_id IN (SELECT group_id FROM group_assignees WHERE username = :me '
    '                UNION SELECT id FROM groups WHERE sandbox_of = :me)')

# The workspaces someone other than an admin sees: those they belong to and their Sandbox.
# Being given one dataset is not being let into the workspace holding it, not even its name.
REACHABLE_GROUP_IDS = (
    'SELECT group_id AS id FROM group_assignees WHERE username = :me '
    'UNION SELECT id FROM groups WHERE sandbox_of = :me')


def can_access_job(conn, job_id: str, user: dict) -> bool:
    if user['role'] == 'admin':
        return conn.execute('SELECT 1 FROM jobs WHERE id = ?', (job_id,)).fetchone() is not None
    return conn.execute(f'SELECT 1 FROM ({VISIBLE_JOB_IDS}) WHERE id = :id',
                        {'me': user['username'], 'id': job_id}).fetchone() is not None


def reachable_group_ids(conn, user: dict) -> set[int] | None:
    """The workspaces someone sees, or None for an admin, who sees them all."""
    if user['role'] == 'admin':
        return None
    return {r[0] for r in conn.execute(REACHABLE_GROUP_IDS, {'me': user['username']})}


def shown_group_id(group_id: int | None, reachable: set[int] | None) -> int | None:
    """A dataset's workspace as its viewer may know it: none, if they do not belong to it."""
    return group_id if reachable is None or group_id in reachable else None


def can_reach_group(conn, group_id: int, user: dict) -> bool:
    if user['role'] == 'admin':
        return conn.execute('SELECT 1 FROM groups WHERE id = ?', (group_id,)).fetchone() is not None
    return conn.execute(f'SELECT 1 FROM ({REACHABLE_GROUP_IDS}) WHERE id = :id',
                        {'me': user['username'], 'id': group_id}).fetchone() is not None


def belongs_to_workspace(conn, group_id: int, user: dict) -> bool:
    """Whether someone may put a dataset there: a workspace they belong to - any, for an
    admin - or their own Sandbox. Never anyone else's Sandbox."""
    row = conn.execute('SELECT sandbox_of FROM groups WHERE id = ?', (group_id,)).fetchone()
    if row is None:
        return False
    if row['sandbox_of'] is not None:
        return row['sandbox_of'] == user['username']
    return user['role'] == 'admin' or conn.execute(
        'SELECT 1 FROM group_assignees WHERE group_id = ? AND username = ?',
        (group_id, user['username'])).fetchone() is not None


def manages_workspace(conn, group_id: int, user: dict) -> bool:
    """A workspace's Managers are the Managers who belong to it; admins manage every one."""
    return user['role'] == 'admin' or (role_reaches(user['role'], 'manager')
                                       and belongs_to_workspace(conn, group_id, user))


def require_job_access(conn, job_id: str, user: dict) -> None:
    """404 rather than 403: an unassigned dataset should not reveal that it exists."""
    if not can_access_job(conn, job_id, user):
        raise HTTPException(404)


def accessible_job(conn, job_id: str, user: dict) -> dict:
    """The dataset, once the caller has been shown to be allowed at it."""
    require_job_access(conn, job_id, user)
    job = store.get_job(conn, job_id)
    if job is None:
        raise HTTPException(404)
    return job


# The two roles that may be swapped for each other on a single dataset.
SWAPPABLE = ('annotator', 'reviewer')


def role_given(owner: str, user: dict, swapped: str | None = None) -> str:
    """The role someone acts with on a dataset they can open: their account's, except that
    whoever created a dataset manages it, whatever their account role, and an Annotator or
    Reviewer can be given the other role on it (`swapped`)."""
    if user['role'] in ('admin', 'viewer'):
        return user['role']
    if owner == user['username']:
        return 'manager'
    if swapped in SWAPPABLE and user['role'] in SWAPPABLE:
        return swapped
    return user['role']


def role_on_job(conn, job_id: str, user: dict) -> str | None:
    """The role someone acts with on a dataset, or None when they cannot open it."""
    if not can_access_job(conn, job_id, user):
        return None
    owner = conn.execute('SELECT owner FROM jobs WHERE id = ?', (job_id,)).fetchone()['owner']
    swapped = conn.execute('SELECT role FROM job_assignees WHERE job_id = ? AND username = ?',
                           (job_id, user['username'])).fetchone()
    return role_given(owner, user, swapped['role'] if swapped else None)


def require_job_role(conn, job_id: str, user: dict, least: str) -> None:
    """404 for a dataset the caller cannot open, 403 where their role falls short."""
    role = role_on_job(conn, job_id, user)
    if role is None:
        raise HTTPException(404)
    if not role_reaches(role, least):
        raise HTTPException(403, f'not permitted: this takes a {ROLE_NAMES[least]}')


def require_job_manager(conn, job_id: str, user: dict) -> None:
    require_job_role(conn, job_id, user, 'manager')


_JOB_OF = {
    'page': 'SELECT job_id FROM pages WHERE id = ?',
    'element': 'SELECT p.job_id FROM elements e JOIN pages p ON e.page_id = p.id WHERE e.id = ?',
    'region': 'SELECT p.job_id FROM regions r JOIN pages p ON r.page_id = p.id WHERE r.id = ?',
    'line': 'SELECT p.job_id FROM lines l JOIN elements e ON l.element_id = e.id '
            'JOIN pages p ON e.page_id = p.id WHERE l.id = ?',
}


def job_of(conn, kind: str, target_id: int) -> str:
    """The dataset a page, element, region or line belongs to; 404 when there is none."""
    row = conn.execute(_JOB_OF[kind], (target_id,)).fetchone()
    if row is None:
        raise HTTPException(404)
    return row[0]


def require_role_on(conn, kind: str, target_id: int, user: dict, least: str) -> None:
    require_job_role(conn, job_of(conn, kind, target_id), user, least)


def draws_checked(conn, page_id: int, user: dict) -> bool:
    """Whether what this person draws on a page counts as checked: a Reviewer's does,
    while an Annotator's waits for one to look."""
    return role_reaches(role_on_job(conn, job_of(conn, 'page', page_id), user), 'reviewer')


def _require_access_to(conn, kind: str, target_id: int, user: dict) -> None:
    if user['role'] == 'admin':
        return
    require_job_access(conn, job_of(conn, kind, target_id), user)


def require_page_access(conn, page_id: int, user: dict) -> None:
    _require_access_to(conn, 'page', page_id, user)


def require_element_access(conn, element_id: int, user: dict) -> None:
    _require_access_to(conn, 'element', element_id, user)


def require_region_access(conn, region_id: int, user: dict) -> None:
    _require_access_to(conn, 'region', region_id, user)


def conflict_detail(conn, revision_id: int | None, message: str | None = None,
                    current: Callable[[], dict] | None = None) -> dict:
    """The body of a 409: who changed what, when, and - when `current` is given - the
    row as it stands so the client can show both versions."""
    head = conn.execute('SELECT author, created_at FROM revisions WHERE id = ?',
                        (revision_id,)).fetchone() if revision_id else None
    author = head['author'] if head else None
    if message is None:
        message = f'changed by {author} since you loaded it' if author else 'changed since you loaded it'
    detail = {'code': 'conflict', 'message': message, 'author': author,
              'changed_at': head['created_at'] if head else None, 'revision': revision_id}
    if current is not None:
        detail['current'] = current()
    return detail


def require_unchanged(conn, target_type: str, target_id: int, expected: int | None,
                      current: Callable[[], dict] | None = None) -> None:
    """Optimistic concurrency for edits. A client that says which revision it loaded is
    refused with 409 once someone else has saved a newer one - the response names them
    and carries the row as it stands. Only a person's revision counts: the system's
    renumbering and a model's reading never refuse anyone. A client that sends no
    revision keeps the old last-write-wins."""
    if expected is None:
        return
    latest = store.latest_person_revision(conn, target_type, target_id)
    if latest <= expected:
        return
    raise HTTPException(409, conflict_detail(conn, latest, current=current))


def require_line_access(conn, line_id: int, user: dict) -> None:
    _require_access_to(conn, 'line', line_id, user)
