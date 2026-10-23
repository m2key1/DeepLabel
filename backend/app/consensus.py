"""What it means for language models to agree on a line, and what that agreement is
allowed to do.

Agreement is exact equality after normalisation - unified Unicode composition, collapsed
whitespace, one shape of quote and dash. Anything looser would need a rule for which
variant to keep, and a corpus is no place for a coin toss.

Two things it deliberately does not do. By default it does not count the local OCR model
as a voice: that model is usually the one being trained, so letting it confirm its own
targets would approve exactly the mistakes it already makes. A dataset read with a
checkpoint that has nothing to do with what it is training turns that off per dataset, and
then the recognition is one more reader - but only where a language model has read the line
too, so the setting can never fill a whole volume with the recognition it already had. And
it never writes over a line a person has touched - a correction or a check already there is
the last word.
"""
import re
import unicodedata

from app import store

# Quotation marks and dashes a model may render differently from the page without meaning
# anything different by it.
QUOTES = {'‘': "'", '’': "'", '‚': "'", '“': '"', '”': '"', '„': '"'}
DASHES = {'‐': '-', '‑': '-', '‒': '-', '–': '-', '—': '-', '−': '-'}
_SUBSTITUTIONS = {ord(k): v for k, v in {**QUOTES, **DASHES}.items()}


def normalize(text: str) -> str:
    """The form two readings are compared in. Not what gets stored - the winning
    candidate's own text is - only what decides whether they said the same thing."""
    text = unicodedata.normalize('NFC', text).translate(_SUBSTITUTIONS)
    return re.sub(r'\s+', ' ', text).strip()


# Whose vote the recognition casts when a dataset lets it vote. One key, so a line read the
# same way by the model and by three others is still only one voice for the model.
OCR_VOICE = 'ocr'


def _settings(conn, job_id: str) -> tuple[int, bool, bool] | None:
    row = conn.execute(
        'SELECT llm_consensus_min, llm_autocheck, llm_consensus_with_ocr FROM jobs WHERE id = ?',
        (job_id,)).fetchone()
    if row is None:
        return None
    return (max(1, row['llm_consensus_min']), bool(row['llm_autocheck']),
            bool(row['llm_consensus_with_ocr']))


def _job_settings(conn, page_id: int) -> tuple[int, bool, bool] | None:
    row = conn.execute('SELECT job_id FROM pages WHERE id = ?', (page_id,)).fetchone()
    return None if row is None else _settings(conn, row['job_id'])


# How a fill-in made by agreement signs itself, followed by how many readers agreed. The
# prefix is what tells it apart from a correction a person typed.
SETTLED_BY = 'llm:consensus@'


def agreement(candidates: list, ocr_text: str | None = None) -> tuple[str, int]:
    """The reading most models share, and how many of them share it. Models are counted,
    not candidate rows: one model saying a thing twice is still one voice.

    `ocr_text` is the line's own recognition, passed only by a dataset that lets it vote.
    It joins the count where a language model has read the line, and never on its own."""
    by_text: dict[str, dict] = {}

    def voice(text: str, reader) -> None:
        group = by_text.setdefault(normalize(text), {'models': set(), 'text': text})
        group['models'].add(reader)

    for candidate in candidates:
        voice(candidate['text'], candidate['llm_model_id'] or candidate['author'])
    if not by_text:
        return '', 0
    if ocr_text:
        voice(ocr_text, OCR_VOICE)
    best = max(by_text.values(), key=lambda g: (len(g['models']), g['text']))
    return best['text'], len(best['models'])


def _scored_lines(conn, page_id: int, with_ocr: bool) -> list[tuple]:
    """Every live line on the page with the reading most models share and how many do."""
    lines = conn.execute(
        'SELECT l.* FROM lines l JOIN elements e ON l.element_id = e.id '
        'WHERE e.page_id = ? AND l.deleted = 0 AND e.deleted = 0', (page_id,)).fetchall()
    readings: dict[int, list] = {}
    for reading in conn.execute(
            'SELECT c.* FROM candidates c JOIN lines l ON c.line_id = l.id '
            'JOIN elements e ON l.element_id = e.id '
            "WHERE e.page_id = ? AND c.source = 'llm' AND c.dismissed = 0 ORDER BY c.id",
            (page_id,)):
        readings.setdefault(reading['line_id'], []).append(reading)
    scored = []
    for line in lines:
        text, agreed = agreement(readings.get(line['id'], []), line['text'] if with_ocr else None)
        scored.append((line, text, agreed))
    return scored


def _verdict(line, agreed: int, minimum: int) -> str | None:
    """What the agreement may do to the line now: 'fill' in the reading enough models share,
    'clear' a fill-in of its own that the readings left on the line no longer carry, or
    nothing. A line a person checked or typed is never touched either way - and a fill-in
    signed by the agreement is the one kind of correction nobody typed, as a tick autocheck
    put on it is the one kind of check nobody made."""
    settled = (line['corrected_by'] or '').startswith(SETTLED_BY)
    if line['checked'] and not (settled and line['check_source'] == 'llm'):
        return None
    if agreed >= minimum:
        return None if line['corrected_text'] else 'fill'
    if settled:
        return 'clear'
    return None


def _live_pages(conn, job_id: str) -> list[int]:
    return [row['id'] for row in conn.execute(
        'SELECT id FROM pages WHERE job_id = ? AND deleted = 0 ORDER BY idx', (job_id,))]


def settle_page(conn, page_id: int) -> dict:
    """Score every line on the page against what the language models said: fill in the ones
    they agree on, and put back to the OCR text the ones an agreement since withdrawn had
    filled in. Returns what changed, for the caller to report."""
    counts = _no_changes()
    settings = _job_settings(conn, page_id)
    if settings is None:
        return counts
    minimum, autocheck, with_ocr = settings
    agreed, changes = _plan(conn, page_id, minimum, with_ocr)
    counts['agreed'] = agreed
    _write(conn, changes, autocheck, counts)
    conn.commit()
    return counts


def _no_changes() -> dict:
    return {'agreed': 0, 'filled': 0, 'cleared': 0, 'checked': 0}


# What a planned change was decided on. A line that no longer reads this way was moved by
# someone else in the meantime - a person, whose word stands, or a reading, which settles
# the page again itself - and is left to them.
DECIDED_ON = ('corrected_text', 'corrected_by', 'checked', 'check_source', 'llm_agree_count', 'deleted')


def _plan(conn, page_id: int, minimum: int, with_ocr: bool) -> tuple[int, list[dict]]:
    """How many lines on the page the models agree on, and what settling it would write.
    Only reads, so a whole dataset can be planned without holding up anyone's save."""
    agreed_lines, changes = 0, []
    for line, text, agreed in _scored_lines(conn, page_id, with_ocr):
        if agreed >= minimum:
            agreed_lines += 1
        verdict = _verdict(line, agreed, minimum)
        if verdict is not None or line['llm_agree_count'] != agreed:
            changes.append({'line_id': line['id'], 'seen': tuple(line[f] for f in DECIDED_ON),
                            'agreed': agreed, 'verdict': verdict, 'text': text})
    return agreed_lines, changes


def _write(conn, changes: list[dict], autocheck: bool, counts: dict) -> None:
    for change in changes:
        line_id, agreed, verdict = change['line_id'], change['agreed'], change['verdict']
        now = conn.execute(f'SELECT {", ".join(DECIDED_ON)} FROM lines WHERE id = ?', (line_id,)).fetchone()
        if now is None or tuple(now) != change['seen']:
            continue
        if now['llm_agree_count'] != agreed:
            conn.execute('UPDATE lines SET llm_agree_count = ? WHERE id = ?', (agreed, line_id))
        if verdict is None:
            continue
        # Both ways the agreement signs with its strength: on a fill-in, how many carried it;
        # on a withdrawal, how many were left - which is why the fill-in went.
        author = f'{SETTLED_BY}{agreed}'
        if verdict == 'fill':
            conn.execute('UPDATE lines SET corrected_text = ?, corrected_by = ? WHERE id = ?',
                         (change['text'], author, line_id))
            store.log_line(conn, line_id, author, 'update')
            counts['filled'] += 1
            if autocheck:
                conn.execute("UPDATE lines SET checked = 1, check_source = 'llm' WHERE id = ?", (line_id,))
                store.log_line(conn, line_id, author, 'check')
                counts['checked'] += 1
        else:
            conn.execute('UPDATE lines SET corrected_text = NULL, corrected_by = NULL, checked = 0, '
                         'check_source = NULL WHERE id = ?', (line_id,))
            store.log_line(conn, line_id, author, 'update')
            counts['cleared'] += 1


def settle_preview(conn, job_id: str) -> dict:
    """How many lines settling the dataset again would touch under its current settings,
    and which way. Nothing is written: this is the number the person is asked to confirm."""
    counts = {'lines': 0, 'fill': 0, 'clear': 0}
    settings = _settings(conn, job_id)
    if settings is None:
        return counts
    minimum, _autocheck, with_ocr = settings
    for page_id in _live_pages(conn, job_id):
        for line, _text, agreed in _scored_lines(conn, page_id, with_ocr):
            verdict = _verdict(line, agreed, minimum)
            if verdict is not None:
                counts[verdict] += 1
                counts['lines'] += 1
    return counts


def settle_job(conn, job_id: str) -> dict:
    """Settle every live page of the dataset from the readings already on file. No model is
    asked - this is the agreement settings being applied, not a read. Every page is scored
    first and the result written in one short change, so a failure part-way leaves it as
    it was rather than half settled, and nobody's save waits on the scoring."""
    counts = _no_changes()
    settings = _settings(conn, job_id)
    if settings is None:
        return counts
    minimum, autocheck, with_ocr = settings
    plans = [_plan(conn, page_id, minimum, with_ocr) for page_id in _live_pages(conn, job_id)]
    store.write_lock(conn)
    for agreed, changes in plans:
        counts['agreed'] += agreed
        _write(conn, changes, autocheck, counts)
    conn.commit()
    return counts


def page_summary(conn, page_id: int) -> dict:
    """How the page stands: lines the models agree on, and how many of those the local
    model reads differently - the ones worth a person's time first."""
    row = conn.execute(
        'SELECT COUNT(*) total, '
        '  SUM(CASE WHEN l.llm_agree_count >= j.llm_consensus_min THEN 1 ELSE 0 END) agreed, '
        '  SUM(CASE WHEN l.llm_agree_count >= j.llm_consensus_min '
        '           AND l.text IS NOT NULL AND l.corrected_text IS NOT NULL '
        '           AND l.text != l.corrected_text THEN 1 ELSE 0 END) disputed '
        'FROM lines l JOIN elements e ON l.element_id = e.id JOIN pages p ON e.page_id = p.id '
        'JOIN jobs j ON j.id = p.job_id '
        'WHERE p.id = ? AND l.deleted = 0 AND e.deleted = 0', (page_id,)).fetchone()
    return {'lines': row['total'] or 0, 'agreed': row['agreed'] or 0, 'disputed': row['disputed'] or 0}
