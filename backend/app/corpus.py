"""The transcribed corpus a dataset was uploaded with, and the cut of it onto its pages.

Documents are kept exactly as they arrived. The cut is derived, so it is redone whenever
recognition improves or a page is added, and nothing about it is destructive: it writes
only the reference columns, which no transcription of record depends on.
"""
from app import reference, store
from app.caches import counted_page


def store_documents(conn, job_id: str, texts: dict[str, str]) -> int:
    """Keep a corpus upload, in name order. Uploading a document again replaces its text,
    so a corrected file can simply be sent a second time."""
    kept = 0
    for name, text in sorted(texts.items()):
        # A nameless document cannot be listed, fetched or deleted by the routes that
        # key on its name, so it would be held and unreachable. A file called '.txt'
        # produces exactly that stem.
        if not name.strip() or not text.strip():
            continue
        conn.execute(
            'INSERT INTO job_documents (job_id, idx, name, text) VALUES (?, 0, ?, ?) '
            'ON CONFLICT (job_id, name) DO UPDATE SET text = excluded.text',
            (job_id, name, text))
        kept += 1
    _renumber(conn, job_id)
    return kept


def _renumber(conn, job_id: str) -> None:
    """Reading order is name order, which is the only order a bag of files carries."""
    rows = conn.execute('SELECT id FROM job_documents WHERE job_id = ? ORDER BY name',
                        (job_id,)).fetchall()
    for index, row in enumerate(rows):
        conn.execute('UPDATE job_documents SET idx = ? WHERE id = ?', (index, row['id']))


def documents(conn, job_id: str) -> list[reference.Document]:
    return [reference.Document(row['name'], row['text']) for row in conn.execute(
        'SELECT name, text FROM job_documents WHERE job_id = ? ORDER BY idx', (job_id,))]


def document_count(conn, job_id: str) -> int:
    return conn.execute('SELECT COUNT(*) c FROM job_documents WHERE job_id = ?',
                        (job_id,)).fetchone()['c']


def remove_document(conn, job_id: str, name: str) -> bool:
    removed = conn.execute('DELETE FROM job_documents WHERE job_id = ? AND name = ?',
                           (job_id, name)).rowcount
    if removed:
        _renumber(conn, job_id)
    return bool(removed)


def page_reads(conn, job_id: str) -> tuple[list[int], list[list[str]]]:
    """Every page in reading order, and what recognition made of it. A page with no lines
    yet still appears: the cut places it from its neighbours rather than skipping it, and
    skipping would shift every page after it onto the wrong part of the corpus."""
    order = [row['id'] for row in conn.execute(
        f'SELECT id FROM pages WHERE job_id = ? AND {counted_page()} ORDER BY idx',
        (job_id,))]
    lines: dict[int, list[str]] = {page_id: [] for page_id in order}
    for row in conn.execute(
            'SELECT e.page_id page_id, COALESCE(l.corrected_text, l.text) text '
            'FROM lines l JOIN elements e ON l.element_id = e.id '
            'JOIN pages p ON e.page_id = p.id '
            'WHERE p.job_id = ? AND p.deleted = 0 AND e.deleted = 0 AND l.deleted = 0 '
            'ORDER BY p.idx, e.order_idx, l.order_idx', (job_id,)):
        if row['page_id'] in lines and (row['text'] or '').strip():
            lines[row['page_id']].append(row['text'])
    return order, [lines[page_id] for page_id in order]


def needs_cut(conn, job_id: str) -> bool:
    """A corpus to cut, or spans left from one since deleted, which only a cut takes back."""
    return bool(document_count(conn, job_id)) or conn.execute(
        'SELECT 1 FROM pages WHERE job_id = ? AND reference_text IS NOT NULL LIMIT 1',
        (job_id,)).fetchone() is not None


def clear(conn, job_id: str) -> None:
    conn.execute('UPDATE pages SET reference_text = NULL, reference_document = NULL, '
                 'reference_anchors = 0, reference_score = 0 WHERE job_id = ?', (job_id,))


def apply_cut(conn, job_id: str, overlap: int | None = None) -> dict:
    """Cut the corpus across this dataset's pages and record what each is answerable for.

    Returns what a person needs to judge the result: how many pages were placed, and how
    many were placed without anchoring a single line of their own, which is where a cut
    goes wrong quietly.
    """
    held = documents(conn, job_id)
    order, lines = page_reads(conn, job_id)
    clear(conn, job_id)
    if overlap is None:
        overlap = reference.OVERLAP_LINES
    spans = reference.cut(held, lines, overlap=overlap) if held and order else []
    placed = unanchored = 0
    for page_id, span in zip(order, spans):
        if not span.text:
            continue
        conn.execute(
            'UPDATE pages SET reference_text = ?, reference_document = ?, '
            'reference_anchors = ?, reference_score = ? WHERE id = ?',
            (span.text, span.document, span.anchors, span.score, page_id))
        placed += 1
        unanchored += not span.anchors
    store.update_counters(conn, job_id, reference_documents=len(held), reference_placed=placed,
                          reference_unanchored=unanchored)
    conn.commit()
    return {'documents': len(held), 'pages': len(order), 'placed': placed,
            'unanchored': unanchored}
