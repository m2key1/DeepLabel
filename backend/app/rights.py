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
# The free fields beside the statement, in the order they are shown and exported.
TEXT_FIELDS = (('credit', 'Credit line'), ('holder', 'Rights holder'), ('source', 'Source'), ('note', 'Note'))
FIELDS = ('status', *(field for field, _ in TEXT_FIELDS), 'transcription_licence')
MAX_TEXT = 2000

# The host in any case; the statement's own code (InC-EDU) as it is written.
_RIGHTS_STATEMENT = re.compile(r'^(?i:rightsstatements\.org)/(?:vocab|page|data)/([A-Za-z-]+)/(\d\.\d)')
_CREATIVE_COMMONS = re.compile(r'^(?i:creativecommons\.org)/(licenses/[a-z-]+|publicdomain/(?:zero|mark))/(\d\.\d)')


def canonical(uri: str | None) -> str | None:
    """The offered statement a URI names, written the way it is stored - whatever scheme, page,
    language or legal-code suffix it came with - or None when it names none of them."""
    address = re.sub(r'^https?://(www\.)?', '', (uri or '').strip(), flags=re.IGNORECASE)
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


def history(conn, job_id: str) -> list[dict]:
    rows = conn.execute('SELECT field, old_value, new_value, author, created_at FROM rights_log '
                        'WHERE job_id = ? ORDER BY id DESC', (job_id,)).fetchall()
    return [{'field': r['field'], 'old': r['old_value'], 'new': r['new_value'], 'author': r['author'],
             'at': r['created_at']} for r in rows]


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


def notice(job: dict) -> str:
    """The RIGHTS.txt an export carries: the scans' rights and the transcriptions' licence."""
    held = job.get('rights') or {}
    status = held.get('status')
    lines = ['Facsimiles (the scans)',
             f'Rights: {LABELS.get(status, "Copyright Not Evaluated") if status else "Copyright Not Evaluated"}'
             + (f' <{status}>' if status else '')]
    lines += [f'{label}: {held[field]}' for field, label in TEXT_FIELDS if held.get(field)]
    licence = job.get('transcription_licence')
    lines += ['', 'Transcriptions and annotations made in DeepLabel',
              f'Licence: {f"{LABELS[licence]} <{licence}>" if licence else "not given"}']
    return '\n'.join(lines) + '\n'
