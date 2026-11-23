STEPS = ('layout', 'lines', 'ocr')
TEXT = 1
BLANK = 3
# Every text dataset gets its own copy as it is made, to rename and switch as it likes: the
# id, the name, and the steps it switches off for its pages. A page with no type is text.
DEFAULTS = (
    (TEXT, 'Text', ()),
    (2, 'Cover', ('ocr',)),
    (BLANK, 'Blank', ('ocr',)),
    (4, 'Table', ()),
    (5, 'Image', ()),
)

COLUMNS = 'job_id, type_id, name, run_layout, run_lines, run_ocr'
# The defaults as SQL rows, for the store to copy into a dataset: (type_id, name, run_layout, ...).
DEFAULT_ROWS = ', '.join(f"({type_id}, '{name}', " + ', '.join('0' if step in off else '1' for step in STEPS) + ')'
                         for type_id, name, off in DEFAULTS)


def runs(step: str, pages: str = 'pages') -> str:
    """SQL that holds for a page of `pages` whose type leaves `step` on, as an unset page's does."""
    return (f'NOT EXISTS (SELECT 1 FROM job_page_types t WHERE t.job_id = {pages}.job_id '
            f'AND t.type_id = COALESCE({pages}.page_type, {TEXT}) AND t.run_{step} = 0)')


def listed(conn, job_id: str) -> list[dict]:
    rows = conn.execute('SELECT * FROM job_page_types WHERE job_id = ? ORDER BY type_id', (job_id,)).fetchall()
    return [{'id': row['type_id'], 'name': row['name'], **{f'run_{step}': bool(row[f'run_{step}']) for step in STEPS}}
            for row in rows]


def switched_off(conn, page_id: int, step: str) -> str | None:
    """The name of the page's type when that type switches `step` off, else None."""
    if step not in STEPS:
        return None
    row = conn.execute(f'SELECT t.name FROM pages JOIN job_page_types t ON t.job_id = pages.job_id '
                       f'AND t.type_id = COALESCE(pages.page_type, {TEXT}) WHERE pages.id = ? AND t.run_{step} = 0',
                       (page_id,)).fetchone()
    return row['name'] if row else None


def name_clash(conn, job_id: str, type_id: int, name: str) -> bool:
    return conn.execute('SELECT 1 FROM job_page_types WHERE job_id = ? AND type_id != ? AND LOWER(name) = LOWER(?)',
                        (job_id, type_id, name)).fetchone() is not None


def exists(conn, job_id: str, type_id: int) -> bool:
    return conn.execute('SELECT 1 FROM job_page_types WHERE job_id = ? AND type_id = ?',
                        (job_id, type_id)).fetchone() is not None
