import threading
import time

from fastapi import APIRouter, Depends

from app.caches import db_key
from app.deps import can_access_job, can_reach_group, current_user, get_db
from app.routes.contributors import (EDITS_PER_DAY, IN_WINDOW, PERSON_EDITS, REACHABLE_DATASETS,
                                     REACHABLE_GROUPS, window_start)

router = APIRouter(tags=['people'])

PROFILE_TTL = 60
YEAR = 365
RECENT_DATASETS = 8

# A person's check is a line revision of theirs that turned the line from unchecked to
# checked, which the log marks as it is written (store.checks_line).
_LINES_CHECKED = """
    SELECT COUNT(DISTINCT target_id) FROM revisions
    WHERE author = :user AND target_type = 'line' AND checks_line = 1
"""

# A page revision carries only the flags that request set, so one naming a flag as true
# is that person signing the page off.
_PAGES_SIGNED_OFF = f"""
    SELECT COUNT(DISTINCT target_id) FROM revisions
    WHERE {PERSON_EDITS} AND target_type = 'page'
      AND (json_extract(snapshot, '$.layout_checked') = 1 OR json_extract(snapshot, '$.lines_checked') = 1)
"""

_REGIONS_DRAWN = """
    SELECT COUNT(DISTINCT target_id) FROM revisions
    WHERE author = :user AND target_type = 'region' AND action = 'create'
"""

_TRAININGS = """
    SELECT COUNT(*) AS started, COALESCE(SUM(status = 'done'), 0) AS done,
           COALESCE(SUM(status = 'error'), 0) AS failed, COUNT(DISTINCT model_id) AS models
    FROM trainings WHERE owner = :user
"""

_BEST_CER = """
    SELECT MIN(cer) FROM evaluations
    WHERE status = 'done' AND model_id IN (
        SELECT model_id FROM trainings WHERE owner = :user AND model_id IS NOT NULL)
"""

_LAST_ACTIVE = f'SELECT created_at FROM revisions WHERE {PERSON_EDITS} ORDER BY id DESC LIMIT 1'

_RECENT_DATASETS = f"""
    SELECT edited.id, j.name, edited.last_edit
    FROM (SELECT job_id AS id, MAX(created_at) AS last_edit FROM revisions
          WHERE {PERSON_EDITS} AND {IN_WINDOW} GROUP BY job_id) edited
    JOIN jobs j ON j.id = edited.id
    ORDER BY edited.last_edit DESC
"""

# The queries that read the year of the log, which must start at the window's first id.
WINDOWED_QUERIES = (EDITS_PER_DAY, _RECENT_DATASETS)

_profiles: dict[tuple[str, str], tuple[float, dict]] = {}
_profiles_lock = threading.Lock()


def _scalar(conn, sql: str, args: dict):
    return conn.execute(sql, args).fetchone()[0]


def _count_profile(conn, username: str) -> dict:
    """Everything a profile counts, for every viewer alike; what a viewer may see of it
    is filtered by the route. Definitions:

    - lines_corrected: live lines whose current correction is theirs (lines.corrected_by)
    - lines_checked: distinct lines they turned from unchecked to checked, per the log
    - pages_signed_off: distinct pages they marked layout-checked or lines-checked
    - regions_drawn: distinct map regions they created
    - datasets_owned / datasets_shared: datasets they own, and those shared with them
      directly or through a group
    - groups: groups they own or that are shared with them
    - trainings: runs they started, of which finished and failed; models_trained the
      models those runs produced; evaluations the evaluations they ran
    - best_cer: the lowest CER any finished evaluation scored for a model they trained
    - last_active: their newest revision
    - activity: their revisions per day over the last year, days with none left out
    - recent_datasets: datasets they edited in the last year, newest edit first

    Origin revisions only record how a row stood before its first edit, and never count.
    """
    args = {'user': username}
    reach = conn.execute(REACHABLE_DATASETS, args).fetchall()
    trainings = conn.execute(_TRAININGS, args).fetchone()
    year = {**args, **window_start(conn, YEAR)}
    return {
        'stats': {
            'lines_corrected': _scalar(conn, 'SELECT COUNT(*) FROM lines WHERE corrected_by = :user AND deleted = 0',
                                       args),
            'lines_checked': _scalar(conn, _LINES_CHECKED, args),
            'pages_signed_off': _scalar(conn, _PAGES_SIGNED_OFF, args),
            'regions_drawn': _scalar(conn, _REGIONS_DRAWN, args),
            'datasets_owned': sum(1 for row in reach if row['owned']),
            'datasets_shared': sum(1 for row in reach if not row['owned']),
            'groups': [{'id': row['id'], 'name': row['name']} for row in conn.execute(REACHABLE_GROUPS, args)],
            'trainings': {'started': trainings['started'], 'done': trainings['done'],
                          'failed': trainings['failed']},
            'models_trained': trainings['models'],
            'evaluations': _scalar(conn, 'SELECT COUNT(*) FROM evaluations WHERE owner = :user', args),
            'best_cer': _scalar(conn, _BEST_CER, args),
            'last_active': (conn.execute(_LAST_ACTIVE, args).fetchone() or [None])[0],
        },
        'recent_datasets': [dict(row) for row in conn.execute(_RECENT_DATASETS, year)],
        'activity': [{'day': row['day'], 'edits': row['revisions']} for row in conn.execute(EDITS_PER_DAY, year)],
    }


def person_profile(conn, username: str) -> dict:
    """A person's profile counts, held for a short while: a profile is opened far more
    often than its numbers move, and the line counts read a person's whole history."""
    key = (db_key(conn), username)
    with _profiles_lock:
        held = _profiles.get(key)
        if held is not None and time.time() - held[0] < PROFILE_TTL:
            return held[1]
        counted = _count_profile(conn, username)
        _profiles[key] = (time.time(), counted)
        return counted


@router.get('/api/people/{username}/profile')
def get_profile(username: str, conn=Depends(get_db), viewer: dict = Depends(current_user)):
    """What a person has done, for anyone signed in. The numbers count everything; the
    groups and datasets named are only those the viewer may open themselves, so a
    profile never reveals a dataset's name to someone it is not shared with."""
    counted = person_profile(conn, username)
    stats = {**counted['stats'],
             'groups': [g for g in counted['stats']['groups'] if can_reach_group(conn, g['id'], viewer)]}
    recent = [d for d in counted['recent_datasets'] if can_access_job(conn, d['id'], viewer)]
    return {'stats': stats, 'recent_datasets': recent[:RECENT_DATASETS], 'activity': counted['activity']}
