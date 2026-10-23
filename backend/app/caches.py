import json
import threading
import time
from pathlib import Path

from app import config, linecrop, store

_disk_cache: dict[str, tuple[float, dict[str, int]]] = {}


def job_disk_usage(job_id: str) -> dict[str, int]:
    """Bytes per top-level directory of a dataset - uploads, pages, renditions, crops -
    so the size can be shown as where it went. Loose files in the job root are 'other'."""
    cached = _disk_cache.get(job_id)
    if cached and time.time() - cached[0] < 60:
        return cached[1]
    root = config.job_dir(job_id)
    usage: dict[str, int] = {}
    for path in root.rglob('*'):
        if not path.is_file():
            continue
        parts = path.relative_to(root).parts
        area = parts[0] if len(parts) > 1 else 'other'
        usage[area] = usage.get(area, 0) + path.stat().st_size
    _disk_cache[job_id] = (time.time(), usage)
    return usage


def forget_job(job_id: str):
    _disk_cache.pop(job_id, None)


UNCOUNTED_STATUSES = ('duplicate', 'unreadable')


def counted_page(alias: str = '') -> str:
    """The one rule for which pages a count counts: live ones, of a scan uploaded twice
    only the copy that was ingested, and none that could not be read. A duplicate or an
    unreadable scan is never rendered and cannot be reviewed, so it is no work - the list
    still shows it, flagged, and nothing counts it."""
    prefix = f'{alias}.' if alias else ''
    return f"{prefix}deleted = 0 AND {prefix}status NOT IN {UNCOUNTED_STATUSES}"


_progress: dict[str, tuple[float, tuple, dict[str, dict[str, int]]]] = {}
_progress_lock = threading.Lock()
_recounting: set[str] = set()
PROGRESS_TTL = 15


def change_stamp(conn) -> tuple:
    """A change detector the list can afford to ask for on every request. The highest id
    in each table an answer depends on: three index lookups, no scan. Recognising a page
    or reading one adds lines; checking, splitting or deleting one writes a revision."""
    return tuple(conn.execute(
        'SELECT (SELECT MAX(id) FROM lines), (SELECT MAX(id) FROM pages), '
        '(SELECT MAX(id) FROM revisions)').fetchone())


def moved_jobs(conn, since: tuple, stamp: tuple) -> set[str] | None:
    """The datasets that gained a line, a page or a revision between two stamps - only the
    rows added since, so this costs what changed rather than what there is. None when an
    id went backwards, as deleting a dataset's revisions makes it: what moved can then not
    be told from the ids."""
    since = tuple(value or 0 for value in since)
    stamp = tuple(value or 0 for value in stamp)
    if any(now < before for before, now in zip(since, stamp)):
        return None
    lines, pages, revisions = since
    moved: set[str] = set()
    if stamp[0] != lines:
        moved.update(row[0] for row in conn.execute(
            'SELECT DISTINCT p.job_id FROM lines l JOIN elements e ON l.element_id = e.id '
            'JOIN pages p ON e.page_id = p.id WHERE l.id > ?', (lines,)))
    if stamp[1] != pages:
        moved.update(row[0] for row in conn.execute(
            'SELECT DISTINCT job_id FROM pages WHERE id > ?', (pages,)))
    if stamp[2] != revisions:
        moved.update(row[0] for row in conn.execute(
            'SELECT DISTINCT job_id FROM revisions WHERE id > ?', (revisions,)))
    return moved


def db_key(conn) -> str:
    """Which database this answer belongs to. A deployment has one, but the stamp above is
    a handful of small integers, and two different databases reach the same three numbers
    easily - every test fixture does. Holding the answer under the file it came from means
    a second database is a miss rather than somebody else's numbers."""
    row = conn.execute('PRAGMA database_list').fetchone()
    return str(row[2]) if row else ''


def job_progress(conn) -> dict[str, dict[str, int]]:
    """Pages and lines reviewed, per dataset, for the list. Counting them walks every line
    in the deployment - 1.7 million of them on ours, 4 s - and every open tab asks for the
    list every few seconds, so the answer is held, and when something moves only the
    datasets it moved are counted again. The TTL is the backstop for a write that changes
    a row without adding one anywhere: past it the held answer is still served and the
    full count runs aside, since a request that waited for it showed no datasets at all."""
    key = db_key(conn)
    with _progress_lock:
        stamp = change_stamp(conn)
        held = _progress.get(key)
        moved = moved_jobs(conn, held[1], stamp) if held is not None and held[1] != stamp else set()
        if held is not None and moved is not None:
            counted_at, _since, rollup = held
            if moved:
                rollup = {job_id: entry for job_id, entry in rollup.items() if job_id not in moved}
                rollup.update(_count_progress(conn, moved))
                _progress[key] = (counted_at, stamp, rollup)
            if time.time() - counted_at >= PROGRESS_TTL:
                _recount_aside(key)
            return rollup
        rollup = _count_progress(conn)
        _progress[key] = (time.time(), stamp, rollup)
        return rollup


def warm_progress(conn):
    """Counts the list once at startup, so the first visit after a deploy does not wait."""
    with _progress_lock:
        _recount_aside(db_key(conn))


def _recount_aside(key: str):
    if not key or key in _recounting:
        return
    _recounting.add(key)
    threading.Thread(target=_recount, args=(key,), daemon=True).start()


def _recount(key: str):
    try:
        conn = store.connect(Path(key))
        try:
            # One read snapshot, so the stamp describes exactly what was counted.
            conn.execute('BEGIN')
            stamp = change_stamp(conn)
            rollup = _count_progress(conn)
            conn.rollback()
        finally:
            conn.close()
        with _progress_lock:
            _progress[key] = (time.time(), stamp, rollup)
    finally:
        with _progress_lock:
            _recounting.discard(key)


def _count_progress(conn, jobs: set[str] | None = None) -> dict[str, dict[str, int]]:
    """The list's progress per dataset, for every dataset or only for `jobs`."""
    if jobs is not None and not jobs:
        return {}
    args = {} if jobs is None else {'jobs': json.dumps(sorted(jobs))}

    def only(column: str) -> str:
        return '' if jobs is None else f'AND {column} IN (SELECT value FROM json_each(:jobs)) '

    rollup: dict[str, dict[str, int]] = {}
    # A container's lines are out of the reading - no work to do, as the dataset's own
    # page counts it.
    for row in conn.execute(
            'SELECT job_id, COUNT(*) pages_total, SUM(layout_checked) layout_checked_pages '
            f"FROM pages WHERE {counted_page()} {only('job_id')}GROUP BY job_id", args):
        rollup[row['job_id']] = {
            'pages_total': row['pages_total'],
            'layout_checked_pages': row['layout_checked_pages'] or 0,
            'lines_total': 0, 'lines_done': 0}
    for row in conn.execute(
            'SELECT p.job_id job_id, COUNT(*) lines_total, SUM(l.checked) lines_done '
            'FROM lines l JOIN elements e ON l.element_id = e.id JOIN pages p ON e.page_id = p.id '
            "WHERE l.deleted = 0 AND e.deleted = 0 AND e.kind != 'container' "
            f"AND {counted_page('p')} {only('p.job_id')}GROUP BY p.job_id", args):
        entry = rollup.setdefault(row['job_id'], {
            'pages_total': 0, 'layout_checked_pages': 0, 'lines_total': 0, 'lines_done': 0})
        entry['lines_total'] = row['lines_total']
        entry['lines_done'] = row['lines_done'] or 0
    # When a person last touched it, which is what "recently worked on" means - the
    # pipeline, alignment and the LLM write revisions too, and those are not somebody
    # working. Counted in the same held pass, and the stamp above already moves with the
    # newest revision, so it cannot go stale on its own.
    for row in conn.execute(
            'SELECT job_id, MAX(created_at) last_activity FROM revisions '
            f"WHERE {store.person_author_sql()} {only('job_id')}GROUP BY job_id", args):
        entry = rollup.get(row['job_id'])
        if entry is not None:
            entry['last_activity'] = row['last_activity']
    return rollup


def forget_progress():
    """For a test that has just written behind the stamp's back."""
    _progress.clear()


def drop_element_crop(conn, element_id: int):
    row = conn.execute(
        'SELECT p.job_id FROM elements e JOIN pages p ON e.page_id = p.id WHERE e.id = ?',
        (element_id,)).fetchone()
    if row is not None:
        (config.job_dir(row['job_id']) / 'crops' / f'element_{element_id}.jpg').unlink(missing_ok=True)


def line_crop_recipe() -> str:
    """How this deployment cuts a line crop - the algorithm and the settings that change
    its pixels. A crop is only valid for the recipe that produced it, so everything that
    keeps one keys on this: the file on disk, and the URL the browser caches it under."""
    return linecrop.RECIPE + ('-masked' if config.LINE_CROP_MASK else '')


def line_crop_path(job_id: str, line_id: int) -> Path:
    return config.job_dir(job_id) / 'crops' / f'line_{line_id}_{line_crop_recipe()}.jpg'


def line_crop_files(job_id: str, line_id: int) -> list[Path]:
    """This line's crop under every recipe, so one cut by an older rule is not left behind."""
    return sorted((config.job_dir(job_id) / 'crops').glob(f'line_{line_id}_*.jpg'))


def drop_line_crop(conn, line_id: int):
    row = conn.execute(
        'SELECT p.job_id FROM lines l JOIN elements e ON l.element_id = e.id '
        'JOIN pages p ON e.page_id = p.id WHERE l.id = ?', (line_id,)).fetchone()
    if row is not None:
        for path in line_crop_files(row['job_id'], line_id):
            path.unlink(missing_ok=True)
