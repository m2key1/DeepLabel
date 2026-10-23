"""The pool of transcriptions a page has ever had, and how they find their way back onto
lines after the geometry under them changes.

Re-detection, a re-run, a split or a merge all destroy line rows and with them whatever
was read or corrected there. Everything that is about to be lost is captured here first,
with the geometry it was read from, and then re-matched against the new lines: by overlap
where the candidate carries a polygon, by text similarity where it does not (a language
model's page-level read has no geometry of its own).

Nothing here decides that a machine is right. A candidate is offered on its line, and is
only written back where there is nothing left to verify: onto geometry all but identical
to the one a person approved, or onto a line that now reads exactly what they approved.

Capture happens wherever a line's text is destroyed: phase_relines in the runner, the
re-run and redetect routes, and the line split and merge routes.
"""
import json

from app import align, consensus, geometry, registry, store

# Below this the two boxes are not the same line at all, and the text is not offered on it.
ATTACH_IOU = 0.5
# At or above this they describe the same line, so a correction is restored and the check
# that came with it carries over.
SAME_LINE_IOU = 0.9

# Sources whose text is a transcription of record rather than a machine's guess, best first.
AUTHORITATIVE = ('human', 'align')


def _kind(author: str) -> str:
    """The revision-author vocabulary this codebase already uses, reduced to who was
    speaking: a model, a language model, an aligned transcription, or a person."""
    if author.startswith('llm:'):
        return 'llm'
    if author.startswith('model:'):
        return 'ocr'
    if author.startswith('align:'):
        return 'align'
    return 'human'


def _line_authors(conn, line_id: int) -> tuple[str, str]:
    """(who last read this line, who last wrote its correction). Read off the revision
    log, which already records both and outlives the line itself."""
    machine = person = ''
    for row in conn.execute(
            "SELECT author FROM revisions WHERE target_type = 'line' AND target_id = ? "
            'ORDER BY id DESC', (line_id,)):
        author = row['author']
        if _kind(author) == 'ocr':
            machine = machine or author
        else:
            person = person or author
    return machine, person


def add(conn, page_id: int, author: str, text: str, *, line_id: int | None = None,
        polygon: str | None = None, order_idx: int = 0, checked: bool = False,
        similarity: float | None = None, llm_model_id: int | None = None) -> int | None:
    """Put one transcription in the pool, unless the identical one is already there -
    the same reader saying the same thing in the same place, which is what makes handing
    an answer out again free. The place is part of it: a heading recurs down a page, and
    each line it stands on is a reading of its own.
    Returns the row id, or None when it was already held."""
    text = text.strip()
    if not text:
        return None
    existing = conn.execute(
        'SELECT id, dismissed FROM candidates WHERE page_id = ? AND author = ? AND text = ? '
        'AND order_idx = ? AND (polygon IS ? OR polygon = ?)',
        (page_id, author, text, order_idx, polygon, polygon)).fetchone()
    if existing is not None:
        # Said again after being set aside - a re-read that still reads it this way, say -
        # so it counts once more rather than being duplicated or staying buried.
        if existing['dismissed']:
            conn.execute('UPDATE candidates SET dismissed = 0 WHERE id = ?', (existing['id'],))
        return existing['id']
    cur = conn.execute(
        'INSERT INTO candidates (page_id, line_id, source, author, text, order_idx, polygon, '
        'similarity, checked, llm_model_id) VALUES (?,?,?,?,?,?,?,?,?,?)',
        (page_id, line_id, _kind(author), author, text, order_idx, polygon, similarity,
         int(checked), llm_model_id))
    return cur.lastrowid


def capture_line(conn, line_id: int) -> int:
    """Keep whatever this line carries before it is destroyed: the machine's read and the
    human correction are different transcriptions, so both are kept. Returns how many
    entries the pool gained."""
    row = conn.execute(
        'SELECT l.*, e.page_id FROM lines l JOIN elements e ON l.element_id = e.id '
        'WHERE l.id = ?', (line_id,)).fetchone()
    if row is None:
        return 0
    machine, person = _line_authors(conn, line_id)
    kept = 0
    if row['text']:
        kept += bool(add(conn, row['page_id'], machine or 'model:ocr', row['text'],
                         polygon=row['polygon'], order_idx=row['order_idx']))
    # Approving what the machine read changes no text, and is still the only record that a
    # person read this line and agreed - which is what carries their check to the next one.
    # Consensus is left out: it settles the next line again from the readings it was made
    # of, and kept here it would be one more voice agreeing with itself.
    approver = _kind(person or 'human')
    approved = row['checked'] and approver in AUTHORITATIVE
    record = row['corrected_text'] or row['text']
    if record and approver != 'llm' and (record != row['text'] or approved):
        kept += bool(add(conn, row['page_id'], person or 'human', record,
                         polygon=row['polygon'], order_idx=row['order_idx'],
                         checked=bool(row['checked'])))
    return kept


def capture_element(conn, element_id: int) -> int:
    """Every live line under an element that is about to have its lines replaced."""
    rows = conn.execute('SELECT id FROM lines WHERE element_id = ? AND deleted = 0',
                        (element_id,)).fetchall()
    return sum(capture_line(conn, row['id']) for row in rows)


def capture_page(conn, page_id: int) -> int:
    rows = conn.execute(
        'SELECT l.id FROM lines l JOIN elements e ON l.element_id = e.id '
        'WHERE e.page_id = ? AND l.deleted = 0', (page_id,)).fetchall()
    return sum(capture_line(conn, row['id']) for row in rows)


def set_aside(conn, page_id: int) -> int:
    """Take everything the page holds out of play without forgetting it - what a detection
    pass that starts the page clean asks for. Left in the pool, the readings taken off the
    old lines would be matched onto the new ones at the next rematch, which any edit of the
    page triggers. Said again, a reading counts once more (see `add`). Returns how many
    entries were set aside."""
    return conn.execute(
        'UPDATE candidates SET dismissed = 1 WHERE page_id = ? AND dismissed = 0',
        (page_id,)).rowcount


def set_aside_readings(conn, line_ids: list[int], revision: int) -> int:
    """Take the language models' readings off lines an edit is about to destroy, without
    forgetting them - a merge, whose line reads nothing either half's reading describes.
    They come off the lines as well, or the one on the id the merge keeps would stay on
    the merged line by identity, and be live there again the moment the model said it
    again. Set aside under the edit's revision, so taking that edit back offers them
    again. A transcription that remembers its geometry is left to find its own way back.
    Returns how many were set aside."""
    marks = ','.join('?' * len(line_ids))
    return conn.execute(
        'UPDATE candidates SET dismissed = 1, line_id = NULL, similarity = NULL, set_aside_at = ? '
        f"WHERE line_id IN ({marks}) AND source = 'llm' AND dismissed = 0",
        (revision, *line_ids)).rowcount


def revert_set_aside(conn, page_id: int, from_rev: int, to_rev: int, direction: str) -> int:
    """Readings an edit in the span set aside are offered again when it is undone, and set
    aside once more when it is redone. What a re-read superseded carries no revision and
    stays where it is. Returns how many changed."""
    where = 'WHERE page_id = ? AND set_aside_at > ? AND set_aside_at <= ?'
    if direction == 'redo':
        return conn.execute(
            f'UPDATE candidates SET dismissed = 1, line_id = NULL, similarity = NULL {where}',
            (page_id, from_rev, to_rev)).rowcount
    return conn.execute(f'UPDATE candidates SET dismissed = 0 {where}',
                        (page_id, from_rev, to_rev)).rowcount


def _live_lines(conn, page_id: int) -> list:
    return conn.execute(
        'SELECT l.id, l.polygon, l.text, l.corrected_text, l.checked FROM lines l '
        'JOIN elements e ON l.element_id = e.id WHERE e.page_id = ? AND l.deleted = 0 '
        'AND e.deleted = 0 ORDER BY e.order_idx, l.order_idx', (page_id,)).fetchall()


def _release_dead_lines(conn, page_id: int) -> int:
    """Candidates whose line has since been deleted are homeless again, whoever deleted it
    and however. Doing this here rather than at each call site means the pool heals itself
    instead of depending on every future code path remembering."""
    return conn.execute(
        'UPDATE candidates SET line_id = NULL, similarity = NULL WHERE page_id = ? '
        'AND line_id IS NOT NULL AND line_id NOT IN '
        '(SELECT id FROM lines WHERE deleted = 0)', (page_id,)).rowcount


def _release_doubled(conn, page_id: int) -> int:
    """Where one reader sits twice on a line, only one of the two can be its reading of
    it - the closest to what the line says - and the rest go back to the pool to find a
    line of their own. Healing it here means the pool recovers whatever put it there."""
    rows = conn.execute(
        'SELECT id, line_id, llm_model_id, author, similarity FROM candidates '
        'WHERE page_id = ? AND polygon IS NULL AND dismissed = 0 AND line_id IS NOT NULL '
        'ORDER BY id', (page_id,)).fetchall()
    best: dict = {}
    for row in rows:
        key = (row['line_id'], _reader(row))
        held = best.get(key)
        if held is None or (row['similarity'] or 0) > (held['similarity'] or 0):
            best[key] = row
    keep = {row['id'] for row in best.values()}
    surplus = [row['id'] for row in rows if row['id'] not in keep]
    for candidate_id in surplus:
        conn.execute('UPDATE candidates SET line_id = NULL, similarity = NULL WHERE id = ?',
                     (candidate_id,))
    return len(surplus)


def _orphans(conn, page_id: int) -> list:
    return conn.execute(
        'SELECT * FROM candidates WHERE page_id = ? AND line_id IS NULL AND dismissed = 0 '
        'ORDER BY id', (page_id,)).fetchall()


def _restorable(line, group: list, score: float) -> tuple:
    """Which kept transcription to write back onto this line, and what to log it as.
    Geometry all but identical is one reason to trust it; text identical to what the line
    now reads is another, and needs no geometry - there is nothing left to verify."""
    # Newest first within a kind, so a line corrected twice comes back reading what the
    # person last said - while a correction still outranks an alignment, however old.
    held = [c for kind in AUTHORITATIVE
            for c in sorted((h for h in group if h['source'] == kind),
                            key=lambda h: h['id'], reverse=True)]
    if not held:
        return None, ''
    if score >= SAME_LINE_IOU:
        return held[0], f'realign:geom@{score:.2f}'
    reading = consensus.normalize(line['text'] or '')
    same = next((c for c in held if reading and consensus.normalize(c['text']) == reading), None)
    return (same, f'realign:text@{score:.2f}') if same else (None, '')


def _restore(conn, line, candidate, author: str) -> bool:
    """Write a kept transcription back onto a line. Only ever onto a line nobody has
    touched since, and never over a correction that is already there."""
    if line['corrected_text'] or line['checked']:
        return False
    # Whoever wrote the text still wrote it: a person's correction carried onto a
    # re-detected line stays a person's, an aligned transcription stays the machine's.
    conn.execute('UPDATE lines SET corrected_text = ?, corrected_by = ? WHERE id = ?',
                 (candidate['text'], candidate['author'], line['id']))
    store.log_line(conn, line['id'], author, 'update')
    if candidate['checked']:
        # Whoever approved this text, it is still the text: their check comes with it and
        # still names them. A machine's is logged under its own name, so the next capture
        # of this line knows it too.
        if candidate['source'] == 'human':
            store.check_line_as_person(conn, line['id'], True)
            store.log_line(conn, line['id'], author, 'check')
        else:
            conn.execute('UPDATE lines SET checked = 1, check_source = ? WHERE id = ?',
                         (candidate['source'], line['id']))
            store.log_line(conn, line['id'], candidate['author'], 'check')
    return True


def _match_by_overlap(conn, lines: list, orphans: list) -> dict:
    """Candidates that remember the box they were read from, paired with the line that now
    covers it. Best overlap first, so a confident pair cannot be stolen by a weaker one."""
    groups: dict[str, list] = {}
    for orphan in orphans:
        if orphan['polygon']:
            groups.setdefault(orphan['polygon'], []).append(orphan)
    scored = []
    for polygon, group in groups.items():
        points = json.loads(polygon)
        for line in lines:
            score = geometry.iou(points, json.loads(line['polygon']))
            if score >= ATTACH_IOU:
                scored.append((score, polygon, line['id'], group))
    scored.sort(key=lambda s: (-s[0], s[1], s[2]))

    taken_lines, taken_groups = set(), set()
    by_id = {line['id']: line for line in lines}
    counts = {'attached': 0, 'restored': 0, 'rechecked': 0}
    for score, polygon, line_id, group in scored:
        if polygon in taken_groups or line_id in taken_lines:
            continue
        taken_groups.add(polygon)
        taken_lines.add(line_id)
        for candidate in group:
            conn.execute('UPDATE candidates SET line_id = ?, similarity = ? WHERE id = ?',
                         (line_id, score, candidate['id']))
            counts['attached'] += 1
        line = by_id[line_id]
        candidate, author = _restorable(line, group, score)
        if candidate is not None and _restore(conn, line, candidate, author):
            counts['restored'] += 1
            counts['rechecked'] += bool(candidate['checked'])
    return counts


def _reader(row) -> object:
    """Whose reading it is. Keyed by the model rather than its name: two connections may
    serve the same model under the same label."""
    return row['llm_model_id'] or row['author']


def _spoken_for(conn, page_id: int) -> dict:
    """The lines each reader is already on. A page-level read is one reading per line, so
    a line where that reader is already speaking is not a home for another of its words -
    however well the text matches, which is exactly what a page that repeats itself makes
    it do."""
    taken: dict = {}
    for row in conn.execute(
            'SELECT llm_model_id, author, line_id FROM candidates WHERE page_id = ? '
            'AND dismissed = 0 AND line_id IS NOT NULL AND polygon IS NULL', (page_id,)):
        taken.setdefault(_reader(row), set()).add(row['line_id'])
    return taken


def _match_by_text(conn, page_id: int, lines: list, orphans: list) -> int:
    """Candidates with no geometry - a language model's page-level read - paired with the
    lines by text, each author's reading of the page aligned on its own."""
    # Matched against what the OCR model read, not against a human's correction: both are
    # readings of the same image, so they resemble each other, while a heavy correction can
    # look nothing like the line it fixes and would strand the reading that belongs to it.
    texts = [(line['text'] or line['corrected_text'] or '') for line in lines]
    attached = 0
    taken = _spoken_for(conn, page_id)
    by_reader: dict = {}
    for orphan in orphans:
        if not orphan['polygon']:
            by_reader.setdefault(_reader(orphan), []).append(orphan)
    for reader, group in by_reader.items():
        group.sort(key=lambda c: c['order_idx'])
        free = [i for i, line in enumerate(lines) if line['id'] not in taken.get(reader, ())]
        for gi, fi, score in align.greedy_align([c['text'] for c in group],
                                                [texts[i] for i in free]):
            conn.execute('UPDATE candidates SET line_id = ?, similarity = ? WHERE id = ?',
                         (lines[free[fi]]['id'], score, group[gi]['id']))
            attached += 1
    return attached


def assign(conn, candidate, line_id: int | None) -> None:
    """Put one reading on a line because a person said so, or take it off again.

    No similarity is recorded: a person's pairing is not a score, and a made-up one would be
    ranked against the matcher's own by _release_doubled. Whatever the same reader was
    already saying on that line goes back to the pool, which is the rule _release_doubled
    keeps for the matcher - one reader is one reading per line, however it got there.
    """
    if line_id is not None:
        for row in conn.execute(
                'SELECT id, llm_model_id, author FROM candidates WHERE page_id = ? AND line_id = ? '
                'AND dismissed = 0 AND id != ?',
                (candidate['page_id'], line_id, candidate['id'])):
            if _reader(row) == _reader(candidate):
                conn.execute('UPDATE candidates SET line_id = NULL, similarity = NULL WHERE id = ?',
                             (row['id'],))
    conn.execute('UPDATE candidates SET line_id = ?, similarity = NULL WHERE id = ?',
                 (line_id, candidate['id']))
    conn.commit()
    consensus.settle_page(conn, candidate['page_id'])


def rematch_page(conn, page_id: int) -> dict:
    """Give every homeless transcription on this page another chance at a line. Costs
    nothing but CPU - the reads themselves are already paid for and kept."""
    _release_dead_lines(conn, page_id)
    _release_doubled(conn, page_id)
    orphans = _orphans(conn, page_id)
    if not orphans:
        conn.commit()
        return {'attached': 0, 'restored': 0, 'rechecked': 0, 'orphaned': 0,
                'agreed': 0, 'filled': 0, 'checked': 0}
    lines = _live_lines(conn, page_id)
    counts = _match_by_overlap(conn, lines, orphans)
    counts['attached'] += _match_by_text(conn, page_id, lines, _orphans(conn, page_id))
    counts['orphaned'] = len(_orphans(conn, page_id))
    conn.commit()
    # Whatever moved, the agreement on this page may read differently now.
    counts.update(consensus.settle_page(conn, page_id))
    return counts


def rematch_job(conn, job_id: str) -> dict:
    """Every page of a dataset that still holds something homeless."""
    pages = conn.execute(
        'SELECT DISTINCT p.id FROM pages p JOIN candidates c ON c.page_id = p.id '
        'WHERE p.job_id = ? AND p.deleted = 0 AND c.line_id IS NULL AND c.dismissed = 0',
        (job_id,)).fetchall()
    # Summed by whatever keys a page reports, so a new count added to rematch_page never
    # has to be repeated here.
    totals: dict[str, int] = {}
    for page in pages:
        for key, value in rematch_page(conn, page['id']).items():
            totals[key] = totals.get(key, 0) + value
    return totals or dict.fromkeys(
        ('attached', 'restored', 'rechecked', 'orphaned', 'agreed', 'filled', 'checked'), 0)


def payload(row) -> dict:
    candidate = dict(row)
    candidate['checked'] = bool(candidate['checked'])
    candidate['dismissed'] = bool(candidate['dismissed'])
    candidate['polygon'] = json.loads(candidate['polygon']) if candidate['polygon'] else None
    return candidate


def _read_again(conn, page_id: int) -> set:
    """Lines carrying a reading of their own. Only the OCR pass writes lines.text, so it
    is that model's latest word on the line - and an empty one is the runner reporting
    nothing rather than a better transcription."""
    return {row['id'] for row in conn.execute(
        'SELECT l.id FROM lines l JOIN elements e ON l.element_id = e.id '
        "WHERE e.page_id = ? AND l.deleted = 0 AND l.text IS NOT NULL AND l.text != ''",
        (page_id,))}


def for_page(conn, page_id: int) -> list[dict]:
    """What is still on offer for this page. A machine reading kept from before the line
    was read again is dropped: the newer run has replaced it, and showing both puts the
    same reader's stale word beside its current one. It stays in the pool, so clearing
    the line for another run puts it back."""
    superseded = _read_again(conn, page_id)
    job = conn.execute('SELECT job_id FROM pages WHERE id = ?', (page_id,)).fetchone()
    reader = registry.job_reader(conn, job['job_id']) if job else ''
    rows = conn.execute(
        'SELECT * FROM candidates WHERE page_id = ? ORDER BY line_id IS NULL, line_id, id',
        (page_id,)).fetchall()
    return [payload(row) | {'author': registry.named_reader(row['author'], reader)}
            for row in rows
            if not (row['source'] == 'ocr' and row['line_id'] in superseded)]
