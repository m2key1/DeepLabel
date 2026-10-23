from fastapi import APIRouter, Depends, HTTPException

from app.deps import get_db, require_role

router = APIRouter(tags=['contributors'])

# A contributor is a username as the backend knows it: the owner of datasets and groups,
# an assignee, or the author of revisions. Accounts themselves live in the auth service.

REACHABLE_DATASETS = """
    WITH reach AS (
        SELECT j.id, j.name, j.task,
               j.owner = :user AS owned,
               j.id IN (SELECT job_id FROM job_assignees WHERE username = :user) AS assigned,
               j.group_id IN (SELECT group_id FROM group_assignees WHERE username = :user) AS via_group
        FROM jobs j)
    SELECT * FROM reach WHERE owned OR assigned OR via_group ORDER BY name COLLATE NOCASE
"""

REACHABLE_GROUPS = """
    WITH reach AS (
        SELECT g.id, g.name,
               g.owner = :user AS owned,
               g.id IN (SELECT group_id FROM group_assignees WHERE username = :user) AS assigned
        FROM groups g)
    SELECT * FROM reach WHERE owned OR assigned ORDER BY name COLLATE NOCASE
"""


def _access_label(row) -> str:
    if row['owned']:
        return 'owner'
    if row['assigned']:
        return 'shared'
    return 'group'


@router.get('/api/contributors/{username}/access')
def contributor_access(username: str, conn=Depends(get_db), _admin=Depends(require_role('admin'))):
    """Every dataset and group one person can open, and why: owned, shared directly, or
    reached through a shared group. Admins are not listed - they reach everything."""
    args = {'user': username}
    datasets = [{'id': r['id'], 'name': r['name'], 'task': r['task'], 'access': _access_label(r)}
                for r in conn.execute(REACHABLE_DATASETS, args)]
    groups = [{'id': r['id'], 'name': r['name'], 'access': _access_label(r)}
              for r in conn.execute(REACHABLE_GROUPS, args)]
    return {'datasets': datasets, 'groups': groups}


def first_revision_since(conn, cutoff: str) -> int:
    """The id of the first revision logged at or after `cutoff`, found by bisecting the
    ids rather than reading created_at, which is not indexed. Ids grow with time, so
    everything from here on is the window, and the author index (author, id) can start
    there instead of walking a person's whole history."""
    low = 1
    high = (conn.execute('SELECT MAX(id) FROM revisions').fetchone()[0] or 0) + 1
    while low < high:
        middle = (low + high) // 2
        row = conn.execute('SELECT id, created_at FROM revisions WHERE id >= ? ORDER BY id LIMIT 1',
                           (middle,)).fetchone()
        if row is None or row['created_at'] >= cutoff:
            high = middle
        else:
            low = row['id'] + 1
    return low


def window_start(conn, days: int) -> dict:
    """The bounds of the last `days` days, as the named parameters a windowed query takes."""
    cutoff = conn.execute("SELECT datetime('now', ?)", (f'-{days} days',)).fetchone()[0]
    return {'cutoff': cutoff, 'since': first_revision_since(conn, cutoff)}


# An origin records how a row stood before its first edit; it is not work anyone did.
PERSON_EDITS = "author = :user AND action != 'origin'"
IN_WINDOW = 'id >= :since AND created_at >= :cutoff'

EDITS_PER_DAY = (
    'SELECT date(created_at) AS day, COUNT(*) AS revisions FROM revisions '
    f'WHERE {PERSON_EDITS} AND {IN_WINDOW} GROUP BY day ORDER BY day')


def edits_per_day(conn, username: str, days: int) -> list[dict]:
    """How many revisions a person logged on each of the last `days` days; a day with
    none is left out."""
    args = {'user': username, **window_start(conn, days)}
    return [dict(row) for row in conn.execute(EDITS_PER_DAY, args)]


_TARGET_KINDS = ('line', 'element', 'region')

_DISTINCT_TARGETS = ', '.join(
    f"COUNT(DISTINCT CASE WHEN target_type = '{kind}' THEN target_id END) AS {kind}s"
    for kind in _TARGET_KINDS)


@router.get('/api/contributors/{username}/activity')
def contributor_activity(username: str, days: int = 30, conn=Depends(get_db),
                         _admin=Depends(require_role('admin'))):
    """What one person has edited, from the revision log: distinct lines, elements and
    regions touched overall and per dataset, plus a daily count over the last `days`."""
    if days < 1:
        raise HTTPException(400, 'days must be at least 1')
    totals = conn.execute(
        f'SELECT {_DISTINCT_TARGETS}, COUNT(*) AS revisions, MIN(created_at) AS first_at, '
        "MAX(created_at) AS last_at FROM revisions WHERE author = ? AND action != 'origin'",
        (username,)).fetchone()
    daily = edits_per_day(conn, username, days)
    datasets = conn.execute(
        f'SELECT r.job_id AS id, j.name, {_DISTINCT_TARGETS}, MAX(r.created_at) AS last_at '
        'FROM revisions r LEFT JOIN jobs j ON j.id = r.job_id '
        "WHERE r.author = ? AND r.action != 'origin' "
        'GROUP BY r.job_id ORDER BY last_at DESC', (username,)).fetchall()
    return {
        'days': days,
        'totals': dict(totals),
        'daily': daily,
        # A deleted dataset leaves its revisions behind with no name to join.
        'datasets': [dict(d) for d in datasets],
    }
