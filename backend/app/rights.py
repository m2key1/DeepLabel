import json
import re

# The statements a scan or a transcription may carry, as IIIF and Europeana name them: their
# canonical http:// URIs and the short labels people choose by. Not Evaluated comes first, for
# anyone who does not know yet.
STATEMENTS = (
    ('http://rightsstatements.org/vocab/CNE/1.0/', 'Copyright Not Evaluated'),
    ('http://rightsstatements.org/vocab/UND/1.0/', 'Copyright Undetermined'),
    ('http://creativecommons.org/publicdomain/mark/1.0/', 'Public Domain Mark'),
    ('http://creativecommons.org/publicdomain/zero/1.0/', 'CC0 1.0'),
    ('http://creativecommons.org/licenses/by/4.0/', 'CC BY 4.0'),
    ('http://creativecommons.org/licenses/by-sa/4.0/', 'CC BY-SA 4.0'),
    ('http://creativecommons.org/licenses/by-nd/4.0/', 'CC BY-ND 4.0'),
    ('http://creativecommons.org/licenses/by-nc/4.0/', 'CC BY-NC 4.0'),
    ('http://creativecommons.org/licenses/by-nc-sa/4.0/', 'CC BY-NC-SA 4.0'),
    ('http://creativecommons.org/licenses/by-nc-nd/4.0/', 'CC BY-NC-ND 4.0'),
    ('http://rightsstatements.org/vocab/NoC-CR/1.0/', 'No Copyright - Contractual Restrictions'),
    ('http://rightsstatements.org/vocab/NoC-NC/1.0/', 'No Copyright - Non-Commercial Use Only'),
    ('http://rightsstatements.org/vocab/NoC-OKLR/1.0/', 'No Copyright - Other Known Legal Restrictions'),
    ('http://rightsstatements.org/vocab/NoC-US/1.0/', 'No Copyright - United States'),
    ('http://rightsstatements.org/vocab/NKC/1.0/', 'No Known Copyright'),
    ('http://rightsstatements.org/vocab/InC/1.0/', 'In Copyright'),
    ('http://rightsstatements.org/vocab/InC-EDU/1.0/', 'In Copyright - Educational Use Permitted'),
    ('http://rightsstatements.org/vocab/InC-NC/1.0/', 'In Copyright - Non-Commercial Use Permitted'),
    ('http://rightsstatements.org/vocab/InC-OW-EU/1.0/', 'In Copyright - EU Orphan Work'),
    ('http://rightsstatements.org/vocab/InC-RUU/1.0/', 'In Copyright - Rights-holder(s) Unlocatable or Unidentifiable'),
)
LABELS = dict(STATEMENTS)
NOT_EVALUATED = STATEMENTS[0][0]
# Training on material under these needs its owner's word that it is permitted: a research
# exception or a contract may allow it, and only the owner knows which applies.
RESTRICTIVE = frozenset(uri for uri, _ in STATEMENTS if '/InC' in uri or uri.endswith(('/NoC-CR/1.0/', '/NoC-OKLR/1.0/')))
# The free fields beside the statement, in the order they are shown and exported.
TEXT_FIELDS = (('credit', 'Credit line'), ('holder', 'Rights holder'), ('source', 'Source'), ('note', 'Note'))
# What a page may hold of its own: the transcription licence is the dataset's alone.
PAGE_FIELDS = ('status', *(field for field, _ in TEXT_FIELDS))
FIELDS = (*PAGE_FIELDS, 'transcription_licence')
MAX_TEXT = 2000
TRAINING_PERMITTED = 'training'

# The host in any case; the statement's own code (InC-EDU) as it is written.
_RIGHTS_STATEMENT = re.compile(r'^(?i:rightsstatements\.org)/(?:vocab|page|data)/([A-Za-z-]+)/(\d\.\d)')
_CREATIVE_COMMONS = re.compile(r'^(?i:creativecommons\.org)/(licenses/[a-z-]+|publicdomain/(?:zero|mark))/(\d\.\d)')


def canonical(uri: str | None) -> str | None:
    """The offered statement a URI names, written the way it is stored - whatever scheme, page,
    language or legal-code suffix it came with - or None when it names none of them."""
    if not isinstance(uri, str):
        return None
    address = re.sub(r'^https?://(www\.)?', '', uri.strip(), flags=re.IGNORECASE)
    for pattern, path in ((_RIGHTS_STATEMENT, 'rightsstatements.org/vocab'), (_CREATIVE_COMMONS, 'creativecommons.org')):
        found = pattern.match(address)
        if found:
            candidate = f'http://{path}/{found[1]}/{found[2]}/'
            return candidate if candidate in LABELS else None
    return None


def of_job(row) -> dict:
    """A dataset's rights as stored: every field present, the imported ones named."""
    held = json.loads(row['rights'] or '{}')
    return {'status': held.get('status'), **{field: held.get(field, '') for field, _ in TEXT_FIELDS},
            'transcription_licence': row['transcription_licence'], 'imported': held.get('imported', [])}


def not_evaluated(status: str | None) -> bool:
    return status in (None, NOT_EVALUATED)


def in_order(statuses) -> list[str]:
    return [uri for uri, _ in STATEMENTS if uri in statuses]


def scans_of_job(row) -> dict:
    held = of_job(row)
    return {field: held[field] for field in PAGE_FIELDS}


def of_page(raw: str | None) -> dict | None:
    """A page's own rights, every field present, or None where it follows its dataset's."""
    if raw is None:
        return None
    held = json.loads(raw)
    return {'status': held.get('status'), **{field: held.get(field, '') for field, _ in TEXT_FIELDS}}


def imported_of_page(raw: str | None) -> list[str]:
    return json.loads(raw).get('imported', []) if raw else []


def write(conn, job_id: str, changes: dict, author: str, imported: bool = False) -> list[str]:
    """Set some of a dataset's rights fields, logging each one that changes. A field set by
    hand stops being marked imported; an import fills only the fields still empty, and marks
    them, so reading a source again never takes back a correction. Returns what changed."""
    row = conn.execute('SELECT rights, transcription_licence FROM jobs WHERE id = ?', (job_id,)).fetchone()
    now = of_job(row)
    marked = set(now['imported'])
    changed = []
    for field, value in changes.items():
        if value == now[field] or (imported and now[field]):
            continue
        conn.execute('INSERT INTO rights_log (job_id, field, old_value, new_value, author) VALUES (?, ?, ?, ?, ?)',
                     (job_id, field, now[field], value, author))
        now[field] = value
        (marked.add if imported else marked.discard)(field)
        changed.append(field)
    stored = {field: now[field] for field in ('status', *(f for f, _ in TEXT_FIELDS))}
    conn.execute('UPDATE jobs SET rights = ?, transcription_licence = ? WHERE id = ?',
                 (json.dumps({**stored, 'imported': sorted(marked)}), now['transcription_licence'], job_id))
    return changed


def write_pages(conn, job_id: str, page_ids: list[int], held: dict | None, author: str,
                imported: bool = False) -> None:
    """Give pages rights of their own - every field, those not given empty - or, with None,
    put them back to their dataset's. Each field that changes is logged for its page; one set
    by hand stops being marked imported."""
    given = None if held is None else {'status': held.get('status'), **{f: held.get(f) or '' for f, _ in TEXT_FIELDS}}
    for page_id in page_ids:
        raw = conn.execute('SELECT rights FROM pages WHERE id = ?', (page_id,)).fetchone()['rights']
        before, after = of_page(raw) or {}, given or {}
        changed = [field for field in PAGE_FIELDS if (before.get(field) or None) != (after.get(field) or None)]
        for field in changed:
            conn.execute('INSERT INTO rights_log (job_id, page_id, field, old_value, new_value, author) '
                         'VALUES (?, ?, ?, ?, ?, ?)',
                         (job_id, page_id, field, before.get(field) or None, after.get(field) or None, author))
        marked = ([field for field in PAGE_FIELDS if after.get(field)] if imported
                  else [field for field in imported_of_page(raw) if field not in changed])
        conn.execute('UPDATE pages SET rights = ? WHERE id = ?',
                     (None if given is None else json.dumps({**given, 'imported': marked}), page_id))


def history(conn, job_id: str, page_id: int | None = None) -> list[dict]:
    """Every change to a dataset's own rights, or to one page's, newest first."""
    rows = conn.execute('SELECT field, old_value, new_value, author, created_at FROM rights_log '
                        'WHERE job_id = ? AND page_id IS ? ORDER BY id DESC', (job_id, page_id)).fetchall()
    return [{'field': r['field'], 'old': r['old_value'], 'new': r['new_value'], 'author': r['author'],
             'at': r['created_at']} for r in rows]


def _confirmations(conn, job_id: str) -> list:
    """The dataset's present owner's word that training is permitted, each time they gave it,
    oldest first: a previous owner's does not pass to them (decision 369)."""
    return conn.execute('SELECT l.author, l.created_at, l.new_value FROM rights_log l JOIN jobs j ON j.id = l.job_id '
                        'WHERE l.job_id = ? AND l.page_id IS NULL AND l.field = ? AND l.author = j.owner '
                        'ORDER BY l.id', (job_id, TRAINING_PERMITTED)).fetchall()


def _covered(confirmations) -> set[str]:
    """The restrictive statements the owner's word was given for, each time together."""
    covered = set()
    for row in confirmations:
        try:
            given = json.loads(row['new_value'])
        except (TypeError, ValueError):
            continue
        covered |= {s for s in given if isinstance(s, str)} if isinstance(given, list) else set()
    return covered


def unconfirmed_statement(conn, job_id: str) -> str | None:
    """The first restrictive statement on the dataset's material its owner has not confirmed
    training under, or None when there is none."""
    covered = _covered(_confirmations(conn, job_id))
    return next((s for s in restrictive_statements(conn, job_id) if s not in covered), None)


def training_permitted(conn, job_id: str) -> dict | None:
    """Who confirmed that training on a dataset's material is permitted, and when - while that
    holds: given by its present owner, for every restrictive statement on it now."""
    confirmations = _confirmations(conn, job_id)
    if not confirmations or unconfirmed_statement(conn, job_id):
        return None
    return {'by': confirmations[-1]['author'], 'at': confirmations[-1]['created_at']}


def restrictive_statements(conn, job_id: str) -> list[str]:
    """The restrictive statements a dataset's material is under: its own first, then those its
    live pages carry."""
    row = conn.execute('SELECT rights FROM jobs WHERE id = ?', (job_id,)).fetchone()
    own = json.loads(row['rights'] or '{}').get('status') if row else None
    pages = {r[0] for r in conn.execute("SELECT DISTINCT json_extract(rights, '$.status') FROM pages "
                                        'WHERE job_id = ? AND rights IS NOT NULL AND deleted = 0', (job_id,))}
    held = [own] if own in RESTRICTIVE else []
    return held + [s for s in in_order(pages & RESTRICTIVE) if s != own]


def restrictive_statement(conn, job_id: str) -> str | None:
    """The restrictive statement a dataset's material is under - its own, else the first its
    pages carry - or None when nothing in it restricts training."""
    return next(iter(restrictive_statements(conn, job_id)), None)


def training_refusal(conn, job_ids) -> str | None:
    """Why these datasets may not be trained on yet: material under a restrictive statement
    whose owner has not confirmed that training on it is permitted. None when all may."""
    reasons = []
    for row in conn.execute(f'SELECT id, name FROM jobs WHERE id IN ({",".join("?" * len(job_ids))}) ORDER BY name',
                            list(job_ids)):
        statement = unconfirmed_statement(conn, row['id'])
        if statement:
            reasons.append(f'"{row["name"]}" holds material under {LABELS[statement]} - '
                           'its owner has not yet confirmed that training on it is permitted')
    return '; '.join(reasons) or None


def from_iiif(manifest: dict) -> dict:
    """What a manifest says about its rights, as fields: a statement only when it is one of
    those offered, and otherwise the address it gave, kept in the note."""
    status = canonical(manifest.get('rights'))
    fields = {'credit': manifest.get('attribution') or '',
              'source': ' - '.join(part for part in (manifest.get('label'), manifest.get('url')) if part)}
    if status:
        fields['status'] = status
    elif manifest.get('rights'):
        fields['note'] = f'Rights as the source gives them: {manifest["rights"]}'
    return {field: value for field, value in fields.items() if value}


def notice(job: dict, pages=()) -> str:
    """The RIGHTS.txt an export carries: the scans' rights, the pages that have their own,
    and the transcriptions' licence."""
    held = job.get('rights') or {}
    status = held.get('status')
    lines = ['Facsimiles (the scans)',
             f'Rights: {LABELS.get(status, "Copyright Not Evaluated") if status else "Copyright Not Evaluated"}'
             + (f' <{status}>' if status else '')]
    lines += [f'{label}: {held[field]}' for field, label in TEXT_FIELDS if held.get(field)]
    own = [page for page in pages if page.get('rights')]
    if own:
        lines += ['', 'Pages with rights of their own']
    for page in own:
        status = page['rights'].get('status')
        lines.append(f'{page["filename"]}: {LABELS.get(status, "Copyright Not Evaluated")} <{status}>')
        lines += [f'  {label}: {page["rights"][field]}' for field, label in TEXT_FIELDS if page['rights'].get(field)]
    licence = job.get('transcription_licence')
    lines += ['', 'Transcriptions and annotations made in DeepLabel',
              f'Licence: {f"{LABELS[licence]} <{licence}>" if licence else "not given"}']
    return '\n'.join(lines) + '\n'
