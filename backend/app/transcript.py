import unicodedata

from app import export, keying, layout_shapes
from app.caches import counted_page
from app.text_search import matcher


def index(conn, job_id: str, username: str) -> list[dict]:
    """Every page the reader can turn to, with how many lines it holds and how many carry
    text (a page of empty lines is skipped), reviewed or not. Lines inside tables and other
    containers are not the page's text and are not counted. A page the reader keys blind is
    not theirs to read here."""
    return [dict(row) for row in conn.execute(f"""
        SELECT p.id, p.idx, p.filename, p.width, p.height, p.rotation,
               COUNT(l.id) lines,
               COALESCE(SUM(l.checked), 0) checked,
               COALESCE(SUM(COALESCE(l.corrected_text, l.text, '') != ''), 0) with_text,
               COALESCE(SUM(l.checked AND COALESCE(l.corrected_text, l.text, '') != ''), 0) checked_with_text
          FROM pages p
          LEFT JOIN elements e ON e.page_id = p.id AND e.deleted = 0 AND e.kind != 'container'
          LEFT JOIN lines l ON l.element_id = e.id AND l.deleted = 0
         WHERE p.job_id = :job AND {counted_page('p')} AND {keying.not_blind('p')}
         GROUP BY p.id ORDER BY p.idx""", {'job': job_id, 'me': username})]


def page(conn, job_id: str, idx: int, username: str) -> dict | None:
    row = conn.execute(f'SELECT * FROM pages p WHERE job_id = :job AND idx = :idx AND {counted_page("p")} '
                       f'AND {keying.not_blind("p")}', {'job': job_id, 'idx': idx, 'me': username}).fetchone()
    if row is None:
        return None
    shape = conn.execute('SELECT layout_shape FROM jobs WHERE id = ?', (job_id,)).fetchone()
    return export.page_entry(conn, row, outlines=shape is not None and layout_shapes.outlines(shape['layout_shape']))


def search(conn, job_id: str, username: str, query: str, mode: str, reviewed_only: bool) -> dict:
    """The lines that answer the query, in reading order, each with the words to mark. A
    pattern not finished yet is not usable rather than an error: half-typing a bracket is
    not a mistake to shout about."""
    if not query.strip():
        return {'usable': True, 'hits': []}
    test = matcher(query, mode)
    if test is None:
        return {'usable': False, 'hits': []}
    hits = []
    for line in conn.execute(f"""
            SELECT p.idx, l.id, COALESCE(l.corrected_text, l.text, '') text
              FROM pages p
              JOIN elements e ON e.page_id = p.id AND e.deleted = 0 AND e.kind != 'container'
              JOIN lines l ON l.element_id = e.id AND l.deleted = 0
             WHERE p.job_id = :job AND {counted_page('p')} AND COALESCE(l.corrected_text, l.text, '') != ''
                   AND {keying.not_blind('p')} {'AND l.checked = 1' if reviewed_only else ''}
             ORDER BY p.idx, e.order_idx, l.order_idx""", {'job': job_id, 'me': username}):
        # Composed, as the reader shows it: the words handed back are marked in that form.
        hit = test(unicodedata.normalize('NFC', line['text']))
        if hit:
            hits.append({'idx': line['idx'], 'line': line['id'], 'words': hit.words})
    return {'usable': True, 'hits': hits}
