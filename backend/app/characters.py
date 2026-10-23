import re
import unicodedata

# Everything a keyboard types without help. What a corpus holds beyond this is what a
# palette is for, whatever the layout in front of the person - a US keyboard reaches no
# further than this either, so the line is drawn once rather than per person.
PLAIN = 128

# The diplomatic reading's marks for what the hand struck out and what it added. Line
# alignment cuts a page's reading at line breaks, so a deletion may arrive opened on one
# line and closed on the next - whole deletions go first, then the halves left over.
STRUCK = [re.compile(r'<del>.*?</del>', re.DOTALL), re.compile(r'^.*?</del>', re.DOTALL),
          re.compile(r'<del>.*$', re.DOTALL)]
ADDED = re.compile(r'</?add>')


def clusters(text: str):
    """Characters as they are read and inserted: a base with the marks that belong to it.
    The corpus stores accents decomposed, so splitting on code points alone would offer a
    bare combining mark as a key and paste it onto whatever letter came before."""
    held = ''
    for char in text:
        if unicodedata.combining(char) and held:
            held += char
            continue
        if held:
            yield held
        held = char
    if held:
        yield held


def beyond_plain(texts) -> list[str]:
    """Every cluster in these texts that a keyboard cannot type directly, in the order they
    were first met - the caller decides how to arrange them. Decomposed, because the corpus
    holds both forms of the same letter and they are one key: it is also the form the line
    editor inserts, so what is offered is what gets written."""
    found: dict[str, None] = {}
    for text in texts:
        if not text:
            continue
        for cluster in clusters(unicodedata.normalize('NFD', text)):
            if any(ord(char) >= PLAIN for char in cluster):
                found.setdefault(cluster)
    return list(found)


# Held against the dataset's newest revision: gathering them reads every line, which is a
# second of work on a volume, and every write that could change the answer logs one. Keyed
# by the database too, so a test's own file cannot answer for another's.
_held: dict[tuple[str, str], tuple[int, list[str]]] = {}


def _database(conn) -> str:
    row = conn.execute('PRAGMA database_list').fetchone()
    return row['file'] if row else ''


def _newest_revision(conn, job_id: str) -> int:
    row = conn.execute('SELECT MAX(id) newest FROM revisions WHERE job_id = ?', (job_id,)).fetchone()
    return row['newest'] or 0


def in_job(conn, job_id: str) -> list[str]:
    """What this dataset has been read as, and corrected to, beyond plain ASCII. A write
    that changes a line's text without logging a revision is invisible here until one is
    logged - which no path in this codebase does, and the runner logs one per line it
    reads."""
    key = (_database(conn), job_id)
    revision = _newest_revision(conn, job_id)
    cached = _held.get(key)
    if cached is not None and cached[0] == revision:
        return cached[1]
    rows = conn.execute(
        'SELECT l.text, l.corrected_text FROM lines l JOIN elements e ON l.element_id = e.id '
        'JOIN pages p ON e.page_id = p.id WHERE p.job_id = ? AND p.deleted = 0 '
        'AND e.deleted = 0 AND l.deleted = 0', (job_id,)).fetchall()
    found = beyond_plain(value for row in rows for value in (row['text'], row['corrected_text']))
    _held[key] = (revision, found)
    return found


def training_target(text: str) -> str:
    """What a recognizer should learn to read off this line: the text as it now stands,
    without the marks a diplomatic reading records. Struck text goes, added text stays."""
    plain = text
    for struck in STRUCK:
        plain = struck.sub('', plain)
    plain = ADDED.sub('', plain)
    return text if plain == text else ' '.join(plain.split())
