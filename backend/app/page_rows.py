import sqlite3
import time

from app import caches, ingest

# One row per live page with everything the table shows. The counts are correlated
# subqueries rather than joins: a join would multiply the page row by its lines and need a
# GROUP BY over the lot, which is what makes this expensive on a large volume.
_ROWS = """
SELECT p.id, p.idx, p.filename, p.width, p.height, p.status,
       p.layout_checked, p.lines_checked, p.deleted, p.rotation, p.is_test,
       (SELECT COUNT(*) FROM elements e
         WHERE e.page_id = p.id AND e.deleted = 0 AND e.kind = 'content'
           AND e.class_name != 'Divider') elements_total,
       (SELECT COUNT(*) FROM elements e
         WHERE e.page_id = p.id AND e.deleted = 0 AND e.kind = 'content'
           AND e.class_name != 'Divider'
           AND (e.checked = 1 OR (
                (SELECT COUNT(*) FROM lines l WHERE l.element_id = e.id AND l.deleted = 0) > 0
            AND (SELECT COUNT(*) FROM lines l
                  WHERE l.element_id = e.id AND l.deleted = 0 AND l.checked = 0) = 0))) elements_checked,
       (SELECT COUNT(*) FROM lines l JOIN elements e ON l.element_id = e.id
         WHERE e.page_id = p.id AND e.deleted = 0 AND l.deleted = 0
           AND e.kind != 'container') lines_total,
       (SELECT COUNT(*) FROM lines l JOIN elements e ON l.element_id = e.id
         WHERE e.page_id = p.id AND e.deleted = 0 AND l.deleted = 0
           AND e.kind != 'container' AND l.checked = 1) lines_reviewed,
       (SELECT MIN(l.confidence) FROM lines l JOIN elements e ON l.element_id = e.id
         WHERE e.page_id = p.id AND e.deleted = 0 AND l.deleted = 0
           AND l.confidence IS NOT NULL) min_confidence,
       (SELECT AVG(l.confidence) FROM lines l JOIN elements e ON l.element_id = e.id
         WHERE e.page_id = p.id AND e.deleted = 0 AND l.deleted = 0
           AND l.confidence IS NOT NULL) avg_confidence,
       (SELECT COUNT(DISTINCT c.llm_model_id) FROM candidates c
         WHERE c.page_id = p.id AND c.source = 'llm' AND c.dismissed = 0
           AND c.llm_model_id IS NOT NULL) llm_models,
       -- A map dataset annotates regions rather than lines; its table counts those
       -- instead, and a traced line counts like a polygon.
       (SELECT COUNT(*) FROM regions r
         WHERE r.page_id = p.id AND r.deleted = 0) regions_total,
       (SELECT COUNT(*) FROM regions r
         WHERE r.page_id = p.id AND r.deleted = 0 AND r.checked = 1) regions_checked
FROM pages p WHERE p.job_id = :job_id
"""

# What each chip on the table means, as a condition over the row above. 'all' lists every
# live page, a duplicate upload among them so it can be seen flagged; every other chip is
# about work, which a duplicate never is, and 'deleted' is the only one that looks at
# deleted pages. Written against the names the subquery projects, not against `p.` -
# outside it the alias is gone and only the column names survive.
_WORK = caches.counted_page()
FILTERS = {
    'all': 'deleted = 0',
    'lines-reviewed': f'{_WORK} AND lines_total > 0 AND lines_reviewed = lines_total',
    'layout-reviewed': f'{_WORK} AND layout_checked = 1',
    'unreviewed-lines': f'{_WORK} AND lines_reviewed < lines_total',
    'layout-unchecked': f'{_WORK} AND layout_checked = 0',
    'no-layout': f'{_WORK} AND elements_total = 0',
    'test-pages': f'{_WORK} AND is_test = 1',
    'deleted': 'deleted = 1',
}

# A tile has no boxes and no lines: the Reviewed toggle in the tile editor writes
# layout_checked, and that flag alone is its review.
TILE_FILTERS = {
    'all': FILTERS['all'],
    'reviewed': f'{_WORK} AND layout_checked = 1',
    'layout-unchecked': FILTERS['layout-unchecked'],
    'deleted': FILTERS['deleted'],
}

# What a chip's count counts, where that differs from the rows it lists: the duplicates
# 'all' lists are no pages of work.
COUNTED = {'all': _WORK}

SORTS = {
    'idx': 'idx',
    'filename': 'filename',
    'dimensions': 'width * height',
    'status': 'status',
    'layout': 'layout_checked',
    'checked': 'CAST(lines_reviewed AS REAL) / NULLIF(lines_total, 0)',
    'confidence': 'min_confidence',
    'llm': 'llm_models',
    'test': 'is_test',
    'regions': 'CAST(regions_checked AS REAL) / NULLIF(regions_total, 0)',
    # A line job's ratio is always 1, so its column sorts by how many were traced.
    'regions-total': 'regions_total',
}

MAX_LIMIT = 500


class BadQuery(Exception):
    """A filter or sort the table does not offer, named so the route can refuse it."""


def fetch(conn: sqlite3.Connection, job_id: str, *, task: str, page_filter: str = 'all',
          sort: str = 'idx', descending: bool = False,
          offset: int = 0, limit: int = 100) -> dict:
    """One screenful of a dataset's page table, and how many the filter matched in total,
    so the table can say where it is - the detail endpoint's every-page answer is 10 MB of
    JSON on the largest volume here. Filtered and ordered in SQL before the slice: applied
    after it, asking for the first fifty unreviewed pages of a volume whose first fifty are
    reviewed would answer with nothing. `task` is the dataset's, which decides what
    reviewed means on it."""
    filters = _filters(task)
    if page_filter not in filters:
        raise BadQuery(f'filter must be one of {sorted(filters)}')
    if sort not in SORTS:
        raise BadQuery(f'sort must be one of {sorted(SORTS)}')
    limit = max(1, min(limit, MAX_LIMIT))
    offset = max(0, offset)

    where = filters[page_filter]
    # A page with nothing to measure goes last whichever way the sort runs. SQLite puts
    # NULL first ascending, which would open a confidence sort on the pages that have no
    # reading at all - "not read yet" is not "read worst", and the point of that sort is
    # to bring the worst reading to the top. idx breaks every remaining tie, so two rows
    # that sort equally keep a stable order between requests; without it a page can
    # appear on two screens or on neither.
    column = SORTS[sort]
    order = (f'({column}) IS NULL ASC, {column} {"DESC" if descending else "ASC"}, idx ASC')
    args = {'job_id': job_id, 'limit': limit, 'offset': offset}

    # The chips count every filter already, and hold the answer; only 'all' counts fewer
    # pages than it lists.
    if page_filter in COUNTED:
        matched = conn.execute(
            f'SELECT COUNT(*) c FROM ({_ROWS}) WHERE {where}', {'job_id': job_id}).fetchone()['c']
    else:
        matched = counts(conn, job_id, task=task)[page_filter]
    rows = conn.execute(
        f'SELECT * FROM ({_ROWS}) WHERE {where} ORDER BY {order} LIMIT :limit OFFSET :offset',
        args).fetchall()
    return {
        'rows': [_as_page(r) for r in rows],
        'matched': matched,
        'offset': offset,
        'limit': limit,
    }


_counts: dict[tuple[str, str], tuple[float, tuple, dict[str, int]]] = {}
COUNTS_TTL = 15


def counts(conn: sqlite3.Connection, job_id: str, *, task: str) -> dict[str, int]:
    """How many pages each chip would show, so the table can label them without asking
    once per chip.

    Held between requests, because this is the one part of opening a dataset that has to
    look at every page whatever the caller asked for: on the largest volume here it is
    600 ms against the 7 ms the first screenful costs. Keyed the same way the list's
    progress is - the database it came from, and the highest ids it depends on - and
    counted again only when those moved for this dataset, so checking a line shows up
    immediately, work elsewhere costs nothing, and the TTL only covers writes that add no
    row.
    """
    key = (caches.db_key(conn), job_id)
    stamp = caches.change_stamp(conn)
    held = _counts.get(key)
    if held is not None and time.time() - held[0] < COUNTS_TTL:
        if held[1] != stamp:
            moved = caches.moved_jobs(conn, held[1], stamp)
            if moved is None or job_id in moved:
                held = None
            else:
                _counts[key] = held = (held[0], stamp, held[2])
        if held is not None:
            return held[2]
    filters = _filters(task)
    selects = ', '.join(
        f'SUM(CASE WHEN {COUNTED.get(name, clause)} THEN 1 ELSE 0 END) "{name}"'
        for name, clause in filters.items())
    row = conn.execute(f'SELECT {selects} FROM ({_ROWS})', {'job_id': job_id}).fetchone()
    answer = {name: row[name] or 0 for name in filters}
    _counts[key] = (time.time(), stamp, answer)
    return answer


def forget_counts(conn: sqlite3.Connection | None = None, job_id: str | None = None) -> None:
    """For a write behind the stamp's back: one dataset's, or every held answer."""
    if job_id is None:
        _counts.clear()
    else:
        _counts.pop((caches.db_key(conn), job_id), None)


def _filters(task: str) -> dict[str, str]:
    """What the chips mean on a dataset of this task: a tile is reviewed by its flag, a
    page by what was checked on it."""
    return TILE_FILTERS if ingest.is_tile_task(task) else FILTERS


def _as_page(row: sqlite3.Row) -> dict:
    page = dict(row)
    for flag in ('layout_checked', 'lines_checked', 'deleted', 'is_test'):
        page[flag] = bool(page[flag])
    return page
