import unicodedata
from collections import defaultdict

from app import caches, keying, rights, store
from app.caches import counted_page
from app.folding import search_form
from app.text_search import matcher

# The fewest letters the trigram index can look up.
SHORTEST = 3
# How many lines the index hands the matching proper for a fuzzy query, best first: a
# common trigram is in a fair share of the corpus, and the lines sharing most of the
# query's trigrams are the ones that can answer it.
CANDIDATES = 5000
PAGE = 50


def _quoted(text: str) -> str:
    return '"' + text.replace('"', '""') + '"'


def index_query(query: str, mode: str) -> str | None:
    """What to look the query up by in the index - every term's trigrams, any of which will
    do, for fuzzy; the folded query itself for exact - or None where the index cannot help:
    a term too short, or a pattern, which is read against every line."""
    if mode == 'fuzzy':
        terms = [term for term in search_form(query).split() if len(term) >= SHORTEST]
        if not terms:
            return None
        return ' AND '.join(
            '(' + ' OR '.join(_quoted(gram) for gram in sorted({term[i:i + 3] for i in range(len(term) - 2)})) + ')'
            for term in terms)
    folded = search_form(query)
    return _quoted(folded) if len(folded) >= SHORTEST else None


def search(conn, user: dict, visible_jobs: str, query: str, mode: str, checked_only: bool,
           group_id: int | None, job_id: str | None, offset: int, limit: int, statement: str | None = None) -> dict:
    """The lines of every dataset `visible_jobs` names that answer the query, grouped by
    dataset - the dataset whose lines answer best and most first - and a screenful of them."""
    empty = {'usable': True, 'too_short': False, 'total': 0, 'datasets': [], 'hits': []}
    if not query.strip():
        return empty
    test = matcher(query, mode)
    if test is None:
        return {**empty, 'usable': False}
    lookup = None if mode == 'regex' else index_query(query, mode)
    if mode != 'regex' and lookup is None:
        return {**empty, 'too_short': True}

    where = [f'p.job_id IN ({visible_jobs})', keying.not_blind('p')]
    params: dict = {'me': user['username']}
    if group_id is not None:
        where.append('j.group_id = :group')
        params['group'] = group_id
    if job_id is not None:
        where.append('j.id = :job')
        params['job'] = job_id
    if checked_only:
        where.append('l.checked = 1')
    if statement is not None:
        # A page's own rights, else its dataset's, else nobody has evaluated them.
        where.append("COALESCE(json_extract(p.rights, '$.status'), json_extract(j.rights, '$.status'), "
                     ':not_evaluated) = :statement')
        params.update(statement=statement, not_evaluated=rights.NOT_EVALUATED)
    if lookup is not None:
        where.append('line_search MATCH :lookup')
        params['lookup'] = lookup
    rows = conn.execute(f"""
        SELECT l.id line_id, COALESCE(l.corrected_text, l.text, '') text, p.id page_id, p.idx page_idx,
               j.id job_id, j.name job_name, e.order_idx element_order, l.order_idx line_order
          FROM {'line_search s JOIN lines l ON l.id = s.rowid' if lookup else 'lines l'}
          JOIN elements e ON e.id = l.element_id AND e.deleted = 0 AND e.kind != 'container'
          JOIN pages p ON p.id = e.page_id AND {counted_page('p')}
          JOIN jobs j ON j.id = p.job_id
         WHERE l.deleted = 0 AND {' AND '.join(where)}
         {f'ORDER BY s.rank LIMIT {CANDIDATES}' if mode == 'fuzzy' else ''}""", params)

    hits = []
    for row in rows:
        if not row['text']:
            continue
        hit = test(unicodedata.normalize('NFC', row['text']))
        if hit:
            hits.append((hit.score, dict(row), hit.words))

    standing = defaultdict(float)
    count = defaultdict(int)
    names = {}
    for score, row, _ in hits:
        standing[row['job_id']] += score
        count[row['job_id']] += 1
        names[row['job_id']] = row['job_name']
    datasets = sorted(standing, key=lambda job: (-standing[job], names[job], job))
    rank = {job: i for i, job in enumerate(datasets)}
    hits.sort(key=lambda h: (rank[h[1]['job_id']], -h[0], h[1]['page_idx'], h[1]['element_order'], h[1]['line_order']))

    recipe = caches.line_crop_recipe()
    shown = [{'job_id': row['job_id'], 'job_name': row['job_name'], 'page_id': row['page_id'],
              'page_idx': row['page_idx'], 'line_id': row['line_id'], 'text': row['text'], 'words': words,
              'score': round(score, 3),
              'crop': f"/api/lines/{row['line_id']}/crop?b={recipe}_{store.latest_revision(conn, 'line', row['line_id'])}"}
             for score, row, words in hits[offset:offset + limit]]
    return {'usable': True, 'too_short': False, 'total': len(hits),
            'datasets': [{'id': job, 'name': names[job], 'hits': count[job]} for job in datasets],
            'hits': shown}
