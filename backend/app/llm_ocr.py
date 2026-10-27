"""Reading whole pages with language models: what a run would cost, the queue it becomes,
the worker that drains it, and what happens to an answer once it arrives.

A reading is keyed by the scan's content hash rather than by the page, so the same scan in
a second dataset reuses what was already paid for, and the raw answer is kept for good -
re-matching it against re-detected lines is then free. The rows themselves are the queue:
one per (scan, model), drained oldest first, and cancelling withdraws a dataset's request
for the pending ones.

None of this touches the GPU queue. A page image needs no layout or line detection to be
read, so these run alongside the pipeline rather than behind it.
"""
import json
from io import BytesIO
from pathlib import Path

from PIL import Image

from app import candidates, config, consensus, llm, llm_client, llm_queue
from app.caches import counted_page

# What the cached page rendition is written at; asking for no more than this costs no
# rendering at all.
SCREEN_EDGE = 1600


def page_image(page, max_edge: int) -> bytes:
    """The page as JPEG, no larger than the model was configured for."""
    rendition = config.job_dir(page['job_id']) / 'renditions' / f"{page['id']}_screen.jpg"
    source = rendition if max_edge <= SCREEN_EDGE and rendition.exists() else Path(page['source_file'])
    with Image.open(source) as image:
        image = image.convert('RGB')
        if max(image.size) > max_edge:
            image.thumbnail((max_edge, max_edge))
        buffer = BytesIO()
        image.save(buffer, 'JPEG', quality=88)
    return buffer.getvalue()


def job_prompt(conn, job_id: str | None) -> str:
    """A dataset's own wording, which replaces the model's entirely."""
    if not job_id:
        return ''
    row = conn.execute('SELECT llm_prompt FROM jobs WHERE id = ?', (job_id,)).fetchone()
    return (row['llm_prompt'] if row else '') or ''


def _readable_pages(conn, job_id: str, page_ids: list[int] | None = None) -> list:
    """Pages with an image to send. A page still waiting to be ingested has no content
    hash yet, so it cannot be read - or reused - and is left for the next run. Given page
    ids narrow it to a selection; an unreadable one among them is skipped like any other
    rather than failing the run."""
    if page_ids is not None and not page_ids:
        return []
    query = ('SELECT id, job_id, content_hash, source_file FROM pages WHERE job_id = ? '
             f'AND {counted_page()} AND content_hash IS NOT NULL')
    args: list = [job_id]
    if page_ids is not None:
        query += f" AND id IN ({','.join('?' * len(page_ids))})"
        args.extend(page_ids)
    return conn.execute(query, args).fetchall()


def selected_models(conn, job_id: str) -> list[int]:
    row = conn.execute('SELECT llm_model_ids FROM jobs WHERE id = ?', (job_id,)).fetchone()
    return json.loads(row['llm_model_ids']) if row else []


def _models(conn, model_ids: list[int], user: dict) -> list[dict]:
    """The chosen models, restricted to what this person may actually use."""
    usable = {model['id']: model for model in llm.usable_models(conn, user)}
    return [usable[model_id] for model_id in model_ids if model_id in usable]


def expected_digest(conn, model: dict, username: str, job_id: str) -> str:
    """The digest a reading taken now would carry for this dataset, model and person: the
    wording and whatever the model would be shown before the page."""
    return llm.ask_digest(llm.effective_prompt(conn, model, username, job_prompt(conn, job_id)),
                          llm.references(conn, username, job_id))


def _stale_reads(conn, job_id: str, model: dict, username: str, hashes: list) -> list:
    """Readings of these scans taken under wording other than what would be used now.
    They are never re-fetched on their own - a prompt edit costs nothing until asked."""
    if not hashes:
        return []
    return conn.execute(
        "SELECT id, content_hash FROM llm_reads WHERE llm_model_id = ? AND status = 'done' "
        f"AND content_hash IN ({','.join('?' * len(hashes))}) "
        'AND (prompt_hash IS NULL OR prompt_hash != ?)',
        (model['id'], *hashes, expected_digest(conn, model, username, job_id))).fetchall()


def preview(conn, job_id: str, model_ids: list[int], user: dict,
            page_ids: list[int] | None = None) -> dict:
    """What a run would cost, per model: the pages it would read, and the ones already
    read - by this dataset or any other holding the same scan - which cost nothing."""
    pages = _readable_pages(conn, job_id, page_ids)
    hashes = {page['content_hash'] for page in pages}
    models = []
    calls = 0
    stale_hashes = set()
    for model in _models(conn, model_ids, user):
        done = {row['content_hash'] for row in conn.execute(
            "SELECT content_hash FROM llm_reads WHERE llm_model_id = ? AND status = 'done'",
            (model['id'],))}
        to_read = len(hashes - done)
        calls += to_read
        stale = _stale_reads(conn, job_id, model, user['username'], list(hashes))
        stale_hashes.update(row['content_hash'] for row in stale)
        models.append({'id': model['id'], 'label': model['label'],
                       'calls': to_read, 'reused': len(hashes & done), 'stale_prompt': len(stale)})
    return {'pages': len(pages), 'models': models, 'calls': calls,
            # Readings taken under other wording. Asking for them again is a separate,
            # explicit choice - and one the dialog can then offer with a price on it: the
            # readings are what it costs, the pages are what it covers.
            'stale_prompt': sum(m['stale_prompt'] for m in models),
            'stale_pages': sum(page['content_hash'] in stale_hashes for page in pages)}


def enqueue(conn, job_id: str, model_ids: list[int], user: dict, refresh: bool = False,
            page_ids: list[int] | None = None) -> dict:
    """Queue what is missing and hand over what is not. A reading that failed before is
    retried; one that succeeded is never paid for twice, unless `refresh` asks for the ones
    taken under wording this dataset has since changed. Given page ids read only those,
    while what is already on file still lands on every page of the dataset holding it."""
    pages = _readable_pages(conn, job_id, page_ids)
    models = _models(conn, model_ids, user)
    queued = reused = refreshed = 0
    for model in models:
        if refresh:
            stale = _stale_reads(conn, job_id, model, user['username'],
                                 [p['content_hash'] for p in pages])
            for read in stale:
                conn.execute(
                    "UPDATE llm_reads SET status = 'pending', error = NULL, job_id = ?, "
                    'requested_by = ? WHERE id = ?', (job_id, user['username'], read['id']))
            refreshed += len(stale)
        for page in pages:
            conn.execute(
                'INSERT OR IGNORE INTO llm_reads (content_hash, llm_model_id, model, label, '
                'job_id, requested_by) VALUES (?,?,?,?,?,?)',
                (page['content_hash'], model['id'], model['model'], model['label'],
                 job_id, user['username']))
            # Whoever asked, so an answer still out reaches every dataset waiting on it and
            # no others. The read row keeps only the first asker's job_id.
            conn.execute(
                'INSERT OR IGNORE INTO llm_read_jobs (read_id, job_id) '
                'SELECT id, ? FROM llm_reads WHERE content_hash = ? AND llm_model_id = ?',
                (job_id, page['content_hash'], model['id']))
            # A failed reading is worth another try; a finished one is not.
            conn.execute(
                "UPDATE llm_reads SET status = 'pending', error = NULL "
                "WHERE content_hash = ? AND llm_model_id = ? AND status = 'error'",
                (page['content_hash'], model['id']))
        rows = conn.execute(
            'SELECT status, COUNT(*) c FROM llm_reads WHERE llm_model_id = ? AND content_hash IN '
            f"({','.join('?' * len(pages))}) GROUP BY status",
            (model['id'], *[p['content_hash'] for p in pages])).fetchall() if pages else []
        for row in rows:
            if row['status'] == 'done':
                reused += row['c']
            elif row['status'] in ('pending', 'running'):
                queued += row['c']
    conn.execute('UPDATE jobs SET llm_model_ids = ? WHERE id = ?',
                 (json.dumps([m['id'] for m in models]), job_id))
    conn.commit()
    # Anything already read is put on this dataset's lines right away, without a call -
    # and only the readings of the scans this dataset holds, not every one the model has
    # ever taken across the instance.
    hashes = [page['content_hash'] for page in pages]
    if hashes:
        for model in models:
            for row in conn.execute(
                    "SELECT * FROM llm_reads WHERE llm_model_id = ? AND status = 'done' "
                    f"AND content_hash IN ({','.join('?' * len(hashes))})", (model['id'], *hashes)):
                distribute(conn, row, job_id=job_id)
    return {'queued': queued, 'reused': reused, 'refreshed': refreshed,
            'models': [{'id': m['id'], 'label': m['label']} for m in models]}


def status(conn, job_id: str, page_ids: list[int] | None = None) -> dict:
    """Progress of every reading this dataset is waiting on, and what it has. Given page
    ids narrow it to those pages, which is what somebody looking at one page needs: a run
    still working through the rest of the dataset is not this page being read."""
    pages = _readable_pages(conn, job_id, page_ids)
    hashes = [page['content_hash'] for page in pages]
    model_ids = selected_models(conn, job_id)
    counts = {'pending': 0, 'running': 0, 'done': 0, 'error': 0}
    per_model = []
    for model_id in model_ids:
        row_counts = {'pending': 0, 'running': 0, 'done': 0, 'error': 0}
        label = ''
        if hashes:
            for row in conn.execute(
                    'SELECT status, label, COUNT(*) c FROM llm_reads WHERE llm_model_id = ? '
                    f"AND content_hash IN ({','.join('?' * len(hashes))}) GROUP BY status",
                    (model_id, *hashes)):
                row_counts[row['status']] = row['c']
                label = label or row['label']
        for key, value in row_counts.items():
            counts[key] += value
        per_model.append({'id': model_id, 'label': label, **row_counts})
    # Scoped to the dataset's own models, like the counts above: another dataset's failed
    # reading of the same scan is not this dataset's problem to report.
    errors = [dict(row) for row in conn.execute(
        "SELECT label, error, COUNT(*) c FROM llm_reads WHERE status = 'error' "
        f"AND content_hash IN ({','.join('?' * len(hashes))}) "
        f"AND llm_model_id IN ({','.join('?' * len(model_ids))}) "
        'GROUP BY label, error LIMIT 5',
        (*hashes, *model_ids))] if hashes and model_ids else []
    return {'pages': len(pages), 'models': per_model, 'errors': errors,
            # Whether the dataset is still waiting on anything, next to the counts that
            # say what it is waiting on.
            'active': counts['pending'] + counts['running'] > 0, **counts}


def cancel(conn, job_id: str, page_ids: list[int] | None = None, in_flight: bool = False) -> int:
    """Withdraw what this dataset asked for, on all its pages or only `page_ids`. A reading
    is shared by every dataset holding the scan, so one another dataset still waits on
    stays for it, and a re-read goes back to the answer already on file rather than
    losing it. A reading not sent yet is always withdrawn; one in flight only with
    `in_flight`, which is what stopping a page's reading means - its answer, already paid
    for, is then thrown away when it arrives rather than put on the page."""
    hashes = [page['content_hash'] for page in _readable_pages(conn, job_id, page_ids)]
    if not hashes:
        return 0
    statuses = ('pending', 'running') if in_flight else ('pending',)
    # A first reading is this dataset's to withdraw if it is among those that asked - or,
    # for one queued before askers were recorded, the one that queued it. A re-read is only
    # the re-reading dataset's: the others already hold the answer it would replace. A
    # re-read in flight holds that answer in previous_text.
    withdrawn = conn.execute(
        f"SELECT id, COALESCE(raw_text, previous_text) kept FROM llm_reads r "
        f"WHERE status IN ({','.join('?' * len(statuses))}) "
        f"AND content_hash IN ({','.join('?' * len(hashes))}) AND CASE "
        'WHEN COALESCE(raw_text, previous_text) IS NOT NULL THEN job_id = ? '
        'ELSE EXISTS (SELECT 1 FROM llm_read_jobs a WHERE a.read_id = r.id AND a.job_id = ?) '
        '  OR (job_id = ? AND NOT EXISTS (SELECT 1 FROM llm_read_jobs a WHERE a.read_id = r.id)) '
        'END', (*statuses, *hashes, job_id, job_id, job_id)).fetchall()
    for read in withdrawn:
        if read['kept'] is not None:
            conn.execute("UPDATE llm_reads SET status = 'done', raw_text = ? WHERE id = ?",
                         (read['kept'], read['id']))
            continue
        conn.execute('DELETE FROM llm_read_jobs WHERE read_id = ? AND job_id = ?',
                     (read['id'], job_id))
        conn.execute('DELETE FROM llm_reads WHERE id = ? AND NOT EXISTS '
                     '(SELECT 1 FROM llm_read_jobs WHERE read_id = ?)', (read['id'], read['id']))
    conn.commit()
    return len(withdrawn)


class CannotRemove(ValueError):
    """A reading that is not this call's to remove, with the sentence to say so."""


# A checked line keeps the reading behind it, whoever checked it: removing readings never
# takes back a line that was checked on their word.
# COALESCE, because a reading sitting on no line has a NULL line_id, and NOT of a NULL
# test is NULL rather than true - it would never be removed.
ON_A_CHECKED_LINE = 'COALESCE(line_id IN (SELECT l.id FROM lines l WHERE l.checked = 1 AND l.deleted = 0), 0)'


def _scans(conn, job_id: str, page_id: int | None = None) -> list[str]:
    """The scans of a dataset's pages, or of the one page named."""
    one_page = '' if page_id is None else ' AND id = ?'
    return [row['content_hash'] for row in conn.execute(
        'SELECT DISTINCT content_hash FROM pages WHERE job_id = ? AND deleted = 0 AND content_hash IS NOT NULL'
        f'{one_page}', (job_id, *(() if page_id is None else (page_id,))))]


def removable(conn, job_id: str, page_id: int | None = None) -> list[dict]:
    """The models with readings of this dataset's scans - or of one page's: how many, and
    how many other datasets holding those scans would lose them along with this one."""
    hashes = _scans(conn, job_id, page_id)
    if not hashes:
        return []
    marks = ','.join('?' * len(hashes))
    return [dict(row) for row in conn.execute(
        f'SELECT r.llm_model_id id, MAX(r.label) label, COUNT(*) readings, '
        f'(SELECT COUNT(DISTINCT p.job_id) FROM pages p JOIN candidates c ON c.page_id = p.id '
        f" WHERE p.content_hash IN ({marks}) AND p.job_id != ? AND p.deleted = 0 AND c.source = 'llm' "
        f'   AND c.llm_model_id = r.llm_model_id) other_datasets '
        f'FROM llm_reads r WHERE r.content_hash IN ({marks}) GROUP BY r.llm_model_id ORDER BY r.llm_model_id',
        (*hashes, job_id, *hashes))]


def remove(conn, job_id: str, model_id: int | None = None, page_id: int | None = None) -> dict:
    """Delete the readings of this dataset's scans, or one page's - every model's, or one's - wherever
    they landed: the stored answers, so asking again calls the provider again, and the
    candidates on every page holding those scans. A reading still out is dropped with
    them and its answer discarded when it lands. Each page is then settled again, so a
    fill-in the agreement no longer carries goes back to the OCR text."""
    hashes = _scans(conn, job_id, page_id)
    if not hashes:
        return {'readings': 0}
    marks = ','.join('?' * len(hashes))
    only_model = '' if model_id is None else ' AND llm_model_id = ?'
    model_args = () if model_id is None else (model_id,)
    reads = conn.execute(f'SELECT id FROM llm_reads WHERE content_hash IN ({marks}){only_model}',
                         (*hashes, *model_args)).fetchall()
    for read in reads:
        conn.execute('DELETE FROM llm_read_jobs WHERE read_id = ?', (read['id'],))
        conn.execute('DELETE FROM llm_reads WHERE id = ?', (read['id'],))
    pages = [row['id'] for row in conn.execute(
        f'SELECT id FROM pages WHERE content_hash IN ({marks}) AND deleted = 0', hashes)]
    if pages:
        conn.execute(
            f"DELETE FROM candidates WHERE source = 'llm' AND page_id IN ({','.join('?' * len(pages))})"
            f'{only_model} AND NOT ({ON_A_CHECKED_LINE})', (*pages, *model_args))
    conn.commit()
    for page_id in pages:
        consensus.settle_page(conn, page_id)
    return {'readings': len(reads)}


def remove_candidate(conn, candidate_id: int) -> int:
    """Delete one line's reading by a language model, and settle its page again. The
    stored answer stays: it is the whole page's, and only asking again replaces it.
    Returns the page it was on."""
    row = conn.execute('SELECT * FROM candidates WHERE id = ?', (candidate_id,)).fetchone()
    if row is None or row['source'] != 'llm':
        raise CannotRemove('only a language model\'s reading can be removed')
    if conn.execute(f'SELECT 1 FROM candidates WHERE id = ? AND {ON_A_CHECKED_LINE}',
                    (candidate_id,)).fetchone():
        raise CannotRemove('this reading is behind a checked line, which keeps it')
    conn.execute('DELETE FROM candidates WHERE id = ?', (candidate_id,))
    conn.commit()
    consensus.settle_page(conn, row['page_id'])
    return row['page_id']


def _already_on(conn, page_id: int, model_id: int, lines: list[str]) -> bool:
    """Whether this page already carries exactly what this model said. Handing an answer
    out again is meant to cost nothing, and re-matching a page that has not changed is not
    nothing - it would pull a reading somebody attached by hand back off its line."""
    wanted = [(i, text.strip()) for i, text in enumerate(lines) if text.strip()]
    held = {(row['order_idx'], row['text']) for row in conn.execute(
        "SELECT order_idx, text FROM candidates WHERE page_id = ? AND llm_model_id = ? "
        "AND source = 'llm' AND dismissed = 0", (page_id, model_id))}
    return bool(wanted) and all(item in held for item in wanted)


def distribute(conn, read, job_id: str | None = None) -> int:
    """Turn one answer into candidates on every page that holds this scan - or only on one
    dataset's pages when a job is named. A page that already holds this answer is left
    exactly as it is."""
    lines = llm_client.parse_lines(read['raw_text'] or '')
    if not lines:
        return 0
    query = 'SELECT id FROM pages WHERE content_hash = ? AND deleted = 0'
    args = [read['content_hash']]
    if job_id is not None:
        query += ' AND job_id = ?'
        args.append(job_id)
    author = f"llm:{read['label']}"
    touched = 0
    for page in conn.execute(query, args).fetchall():
        if _already_on(conn, page['id'], read['llm_model_id'], lines):
            continue
        # What this model said here before is set aside rather than deleted: a line it no
        # longer reads that way stops counting towards agreement, but is still on record.
        conn.execute('UPDATE candidates SET dismissed = 1 WHERE page_id = ? AND llm_model_id = ?',
                     (page['id'], read['llm_model_id']))
        for order_idx, text in enumerate(lines):
            candidates.add(conn, page['id'], author, text, order_idx=order_idx,
                           llm_model_id=read['llm_model_id'])
        conn.commit()
        candidates.rematch_page(conn, page['id'])
        consensus.settle_page(conn, page['id'])
        touched += 1
    return touched


def _prepare(conn, read) -> dict:
    """Everything one call needs, gathered on the worker's own thread: the image, the
    endpoint and the key. Anything missing becomes the failure, without a call."""
    page = conn.execute(
        'SELECT id, job_id, source_file FROM pages WHERE content_hash = ? AND deleted = 0 LIMIT 1',
        (read['content_hash'],)).fetchone()
    if page is None:
        return {'error': 'the page this reading was queued for is gone'}
    try:
        model, connection, key = llm.credentials(conn, read['llm_model_id'])
    except (LookupError, llm.SecretUnavailable) as exc:
        return {'error': str(exc)}
    try:
        image = page_image(page, model['max_image_edge'])
    except (OSError, ValueError) as exc:
        return {'error': f'the page image could not be read: {exc}'}
    prompt = llm.effective_prompt(conn, model, read['requested_by'],
                                  job_prompt(conn, read['job_id']))
    shown = llm.references(conn, read['requested_by'], read['job_id'])
    return {'base_url': connection['base_url'], 'key': key, 'model': model['model'],
            'prompt': llm.with_references(prompt, len(shown)),
            'prompt_hash': llm.ask_digest(prompt, shown), 'image': image,
            'temperature': model['temperature'], 'max_tokens': model['max_tokens'],
            'extra': llm.extra_body(model),
            'references': [(row['mime'], row['bytes']) for row in shown]}


def _finish(conn, read, result: dict) -> None:
    if 'error' in result:
        # A failed re-read keeps the answer it was meant to replace.
        conn.execute("UPDATE llm_reads SET status = 'error', error = ?, raw_text = ?, "
                     "finished_at = datetime('now') WHERE id = ? AND status = 'running'",
                     (result['error'], read['raw_text'], read['id']))
        conn.commit()
        return
    # The answer is stored first and only then called done, so nothing can observe a
    # finished reading whose text has not reached the pages yet. A crash in between leaves
    # a running row that already has its text, which the worker completes rather than
    # re-fetches on the next start - an answer is never paid for twice.
    conn.execute(
        'UPDATE llm_reads SET raw_text = ?, error = NULL, prompt_tokens = ?, completion_tokens = ?, '
        "prompt_hash = ? WHERE id = ? AND status = 'running'",
        (result['text'], result.get('prompt_tokens'), result.get('completion_tokens'),
         result.get('prompt_hash'), read['id']))
    conn.commit()
    stored = conn.execute("SELECT * FROM llm_reads WHERE id = ? AND status = 'running'", (read['id'],)).fetchone()
    if stored is None:
        # Withdrawn while it was out: the answer is not wanted any more.
        return
    asked = [row['job_id'] for row in conn.execute(
        'SELECT job_id FROM llm_read_jobs WHERE read_id = ?', (read['id'],))]
    for job_id in asked or [stored['job_id']]:
        distribute(conn, stored, job_id=job_id)
    conn.execute("UPDATE llm_reads SET status = 'done', finished_at = datetime('now') WHERE id = ?",
                 (read['id'],))
    conn.commit()


QUEUE = llm_queue.Queue('llm_reads', _prepare, _finish, distribute)


def drain_once(conn) -> int:
    """This queue alone, for callers that have no interest in the other one."""
    return llm_queue.drain_once(conn, [QUEUE])


def recover(conn) -> None:
    return llm_queue.recover(conn, [QUEUE])
