"""Double-keying (#37, decision 364): in a dataset that asks for it, two people type each page,
neither seeing the other's text, and the page is compared once both have handed it in.

What a keyer types is kept apart from the line, in `keyings`, and shown to them alone in place
of the line's correction - until the page is signed off, so that neither learns the other's
version from the line it was settled on. Comparing writes the lines: where both keyings agree,
the text is stored and checked; elsewhere the version handed in first goes on the line unchecked,
both are offered as readings, and the Reviewer settles it. A keyer types and does nothing else:
the boxes and lines are fixed for them, so the two keyings always describe the same lines."""
import re
import unicodedata

from fastapi import HTTPException

from app import candidates, store

KEYING_ONLY = 'You are keying this page: type its text only'
KEYED = 'Both keyings are in: the page is with the Reviewer'
# How a line two keyers agreed on is checked: a person's check for training, told apart from a
# Reviewer's.
CHECK_SOURCE = 'keyed'


def _spaced(text: str) -> str:
    return re.sub(r'\s+', ' ', text).strip()


def agree(first: str, second: str) -> bool:
    """Whether two keyings say the same. Only spacing and Unicode form may differ: case, quotes
    and dashes count, as nothing would say which of two variants is right."""
    return _spaced(unicodedata.normalize('NFC', first)) == _spaced(unicodedata.normalize('NFC', second))


def _job(conn, page_id: int):
    return conn.execute('SELECT j.double_keying, j.keying_from_empty FROM pages p JOIN jobs j ON j.id = p.job_id '
                        'WHERE p.id = ?', (page_id,)).fetchone()


def _keyers(conn, page_id: int) -> list:
    """The page's keyers, whoever handed it in first leading."""
    return conn.execute('SELECT username, handed_in_at FROM page_assignees WHERE page_id = ? '
                        'ORDER BY handed_in_at IS NULL, handed_in_at, username', (page_id,)).fetchall()


def _open(keyers: list) -> bool:
    """Being keyed: it has a keyer, and not yet two of them handed in."""
    return bool(keyers) and (len(keyers) < 2 or any(k['handed_in_at'] is None for k in keyers))


def state(conn, page_id: int) -> dict | None:
    """What the page viewer is told of the page's keying; None where the dataset keys pages once."""
    job = _job(conn, page_id)
    if job is None or not job['double_keying']:
        return None
    keyers = _keyers(conn, page_id)
    return {'keyers': sorted(k['username'] for k in keyers),
            'handed_in': sorted(k['username'] for k in keyers if k['handed_in_at']),
            'from_empty': bool(job['keying_from_empty']), 'open': _open(keyers)}


def role(conn, page_id: int, username: str) -> str | None:
    """'keying' while this person keys the page, 'keyed' once both keyers are in, else None."""
    job = _job(conn, page_id)
    if job is None or not job['double_keying']:
        return None
    keyers = _keyers(conn, page_id)
    if username not in {k['username'] for k in keyers}:
        return None
    return 'keying' if _open(keyers) else 'keyed'


def page_of(conn, kind: str, target_id: int) -> int | None:
    query = {'page': 'SELECT id FROM pages WHERE id = ?',
             'element': 'SELECT page_id FROM elements WHERE id = ?',
             'line': 'SELECT e.page_id FROM lines l JOIN elements e ON e.id = l.element_id WHERE l.id = ?',
             'candidate': 'SELECT page_id FROM candidates WHERE id = ?'}[kind]
    row = conn.execute(query, (target_id,)).fetchone()
    return row[0] if row else None


def refuse(conn, kind: str, target_id: int, user: dict) -> None:
    """Every write but typing a line's text is refused a keyer of the page, and that too once both
    keyings are in."""
    page_id = page_of(conn, kind, target_id)
    keying = None if page_id is None else role(conn, page_id, user['username'])
    if keying == 'keying':
        raise HTTPException(403, KEYING_ONLY)
    if keying == 'keyed':
        raise HTTPException(403, KEYED)


def type_text(conn, line_id: int, username: str, text: str | None) -> None:
    """A keyer's text for a line; None takes it back to what they started from."""
    if text is None:
        conn.execute('DELETE FROM keyings WHERE line_id = ? AND username = ?', (line_id, username))
        return
    conn.execute("INSERT INTO keyings (line_id, username, text, at) VALUES (?, ?, ?, datetime('now')) "
                 'ON CONFLICT (line_id, username) DO UPDATE SET text = excluded.text, at = excluded.at',
                 (line_id, username, text))


def blind(conn, page_id: int, username: str) -> bool:
    """Whether this person sees the page through their own keying: a keyer does until it is
    signed off."""
    keying = role(conn, page_id, username)
    return keying == 'keying' or (keying == 'keyed' and store.page_review(conn, page_id)['state'] != 'signed_off')


def not_blind(pages: str = 'p') -> str:
    """SQL that holds for a page of `pages` the person `:me` does not see through their own
    keying (blind, as SQL): reading the dataset's text elsewhere - Search, the transcript -
    must not show them the page their keying is to be compared on."""
    return (f'NOT EXISTS (SELECT 1 FROM page_assignees a JOIN jobs kj ON kj.id = {pages}.job_id '
            f'WHERE a.page_id = {pages}.id AND a.username = :me AND kj.double_keying = 1 '
            f"AND NOT EXISTS (SELECT 1 FROM page_reviews r WHERE r.page_id = {pages}.id AND r.state = 'signed_off'))")


def lens(conn, page_id: int, username: str):
    """How a keyer is shown the page's lines, as a function over a line's payload; None for
    anyone who sees them as they are. Keying from empty lines, nothing of the recognition shows."""
    if not blind(conn, page_id, username):
        return None
    from_empty = bool(_job(conn, page_id)['keying_from_empty'])
    typed = dict(conn.execute(
        'SELECT k.line_id, k.text FROM keyings k JOIN lines l ON l.id = k.line_id '
        'JOIN elements e ON e.id = l.element_id WHERE e.page_id = ? AND k.username = ?', (page_id, username)).fetchall())

    def through(line: dict) -> dict:
        seen = {**line, 'llm_agree_count': 0}
        if from_empty:
            seen.update(text='', confidence=None, conf_profile=None, text_author='', corrected_text=None)
        if line['id'] in typed:
            seen['corrected_text'] = typed[line['id']]
        return seen
    return through


def compare(conn, page_id: int, second: str) -> list[int]:
    """Both keyers are in, `second` last: decide every line of the page's text. Keyings that agree
    are stored and checked; otherwise the version handed in first goes on the line unchecked and
    both are offered as readings. A line a keyer never typed carries what they started from, and
    that is kept as their keying, so that each goes on seeing their own version. Written under the
    first keyer, whose version it is. Returns the lines it changed."""
    first, first_in = next((k['username'], k['handed_in_at']) for k in _keyers(conn, page_id) if k['username'] != second)
    from_empty = bool(_job(conn, page_id)['keying_from_empty'])
    # A line made after the first keyer handed the page in is one they never saw (#169).
    lines = conn.execute(
        'SELECT l.id, l.text, l.corrected_text, l.corrected_by, l.checked, l.check_source, l.polygon, l.order_idx, '
        "(SELECT MIN(r.created_at) FROM revisions r WHERE r.target_type = 'line' AND r.target_id = l.id) > ? unseen "
        "FROM lines l JOIN elements e ON e.id = l.element_id "
        "WHERE e.page_id = ? AND e.deleted = 0 AND e.kind != 'container' AND l.deleted = 0",
        (first_in, page_id)).fetchall()
    typed = {(row['line_id'], row['username']): row['text'] for row in conn.execute(
        'SELECT k.line_id, k.username, k.text FROM keyings k JOIN lines l ON l.id = k.line_id '
        'JOIN elements e ON e.id = l.element_id WHERE e.page_id = ?', (page_id,))}
    changed = []
    for line in lines:
        shown = line['corrected_text'] if line['corrected_text'] is not None else line['text'] or ''
        start = '' if from_empty else shown
        versions = {keyer: typed.get((line['id'], keyer), start) for keyer in (first, second)}
        for keyer, text in versions.items():
            if (line['id'], keyer) not in typed:
                type_text(conn, line['id'], keyer, text)
        alike = agree(versions[first], versions[second])
        # Alike only because neither touched a line one of them never saw: the Reviewer's.
        nobodys = line['unseen'] and not any((line['id'], keyer) in typed for keyer in (first, second))
        agreed = alike and not nobodys
        if not alike:
            for keyer, version in versions.items():
                candidates.add(conn, page_id, keyer, version, line_id=line['id'], polygon=line['polygon'],
                               order_idx=line['order_idx'])
        text = _spaced(versions[first]) if agreed else versions[first]
        retyped = text != shown
        decided = ((text, first) if retyped else (line['corrected_text'], line['corrected_by'])) + (
            (1, CHECK_SOURCE) if agreed else (0, None))
        if decided == (line['corrected_text'], line['corrected_by'], line['checked'], line['check_source']):
            continue
        store.ensure_origin(conn, 'line', line['id'], first)
        conn.execute('UPDATE lines SET corrected_text = ?, corrected_by = ?, checked = ?, check_source = ? '
                     'WHERE id = ?', (*decided, line['id']))
        if retyped:
            conn.execute('UPDATE lines SET needs_ocr = 0 WHERE id = ?', (line['id'],))
        if agreed:
            conn.execute('DELETE FROM review_flags WHERE line_id = ?', (line['id'],))
        store.log_line(conn, line['id'], first, 'update')
        changed.append(line['id'])
    return changed


def being_typed(conn, job_id: str) -> int:
    """How many of the dataset's pages are being keyed with something typed on them: what turning
    double-keying off would set aside, and bring back stale were it turned on again."""
    pages = conn.execute('SELECT DISTINCT e.page_id FROM keyings k JOIN lines l ON l.id = k.line_id '
                         'JOIN elements e ON e.id = l.element_id JOIN pages p ON p.id = e.page_id '
                         'WHERE p.job_id = ?', (job_id,)).fetchall()
    return sum(_open(_keyers(conn, row[0])) for row in pages)


def drop(conn, page_id: int, usernames: list[str]) -> None:
    """Forget what people no longer keying the page typed on it."""
    conn.executemany('DELETE FROM keyings WHERE username = ? AND line_id IN (SELECT l.id FROM lines l '
                     'JOIN elements e ON e.id = l.element_id WHERE e.page_id = ?)',
                     [(username, page_id) for username in usernames])

