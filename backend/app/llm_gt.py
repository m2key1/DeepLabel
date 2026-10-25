"""Reading a page against the corpus cut onto it, for ground truth.

The corpus span tells the model what this leaf is believed to say; the scan tells it what
the leaf actually says. What comes back is the page's transcription of record, which the
alignment phase then matches line by line against recognition - unless a person already
wrote one, which is never overwritten: the answer is offered on its lines instead.

Every answer here is machine-made, which is the whole reason `gt_source` exists: alignment
will hand these lines to the pages as corrections and will never check one off. A person
reads them, or they stay candidates.

Unlike a line-reading, a diplomatic reading is keyed by the page rather than by the scan.
The same scan in another dataset is cut from another corpus, so its answer would be to a
different question and is not reusable.
"""
import json

from app import align, candidates, llm, llm_client, llm_ocr, llm_queue
from app.caches import counted_page

GT_SOURCE = 'llm'
OFFER_AUTHOR = f'align:{GT_SOURCE}'


def offer_author(label: str) -> str:
    """Who offers a diplomatic reading: the model, named as its line readings name it, so
    several models' readings of one page stand side by side. Still an `align:` author, so
    agreement never counts it as a vote."""
    return f'{OFFER_AUTHOR}:{label}'


def job_prompt(conn, job_id: str) -> str:
    row = conn.execute('SELECT gt_prompt FROM jobs WHERE id = ?', (job_id,)).fetchone()
    return (row['gt_prompt'] if row else '') or ''


def page_variables(page) -> dict[str, str]:
    """What a dataset's wording may ask this page to fill in."""
    return {'reference': page['reference_text'] or ''}


def rendered_prompt(conn, job_id: str, page) -> str:
    return llm.render(llm.effective_gt_prompt(job_prompt(conn, job_id)), page_variables(page))


def _readable(job_id: str, page_ids: list[int] | None) -> tuple[str, list]:
    """Pages that can be read against the corpus: ingested, and carrying a span. A page the
    cut could not place is left alone rather than read with an empty reference, which would
    be an ordinary transcription filed as though it had a source."""
    where = (f"FROM pages WHERE job_id = ? AND {counted_page()} "
             "AND content_hash IS NOT NULL AND COALESCE(reference_text, '') != ''")
    args: list = [job_id]
    if page_ids is not None:
        where += f" AND id IN ({','.join('?' * len(page_ids))})"
        args.extend(page_ids)
    return where, args


def _pages(conn, job_id: str, page_ids: list[int] | None = None) -> list:
    if page_ids is not None and not page_ids:
        return []
    where, args = _readable(job_id, page_ids)
    return conn.execute(f'SELECT * {where} ORDER BY idx', args).fetchall()


def _count_pages(conn, job_id: str, page_ids: list[int] | None = None) -> int:
    if page_ids is not None and not page_ids:
        return 0
    where, args = _readable(job_id, page_ids)
    return conn.execute(f'SELECT COUNT(*) c {where}', args).fetchone()['c']


def carries_persons_transcription(page) -> bool:
    """Whether a person already wrote this page down. Their text wins over any answer, so
    reading it again is a comparison someone has to ask for, not a default."""
    return bool((page['gt_text'] or '').strip()) and align.gt_is_trusted(page['gt_source'])


def _split(pages: list, include_transcribed: bool) -> tuple[list, int]:
    """(the pages to read, how many a person transcribed). Those are left out unless asked."""
    transcribed = [page for page in pages if carries_persons_transcription(page)]
    if include_transcribed:
        return pages, len(transcribed)
    return [page for page in pages if not carries_persons_transcription(page)], len(transcribed)


def _digests(conn, job_id: str, pages: list, username: str) -> dict[int, str]:
    """The digest a reading taken now would carry, per page. The wording and the pictures
    are the dataset's and read once; only the reference filled in differs from page to page."""
    wording = llm.effective_gt_prompt(job_prompt(conn, job_id))
    shown = llm.references(conn, username, job_id)
    return {page['id']: llm.ask_digest(llm.render(wording, page_variables(page)), shown)
            for page in pages}


def _held(conn, job_id: str, model_id: int) -> dict:
    """This model's readings of the dataset's pages, by page."""
    return {row['page_id']: row for row in conn.execute(
        'SELECT page_id, status, prompt_hash FROM gt_reads WHERE llm_model_id = ? '
        'AND page_id IN (SELECT id FROM pages WHERE job_id = ?)', (model_id, job_id))}


def preview(conn, job_id: str, model_ids: list[int], user: dict,
            page_ids: list[int] | None = None, include_transcribed: bool = False) -> dict:
    """What a run would cost: the pages that would be read, the ones already read under
    wording and a reference that have not moved since, and how many a person transcribed."""
    pages, transcribed = _split(_pages(conn, job_id, page_ids), include_transcribed)
    digests = _digests(conn, job_id, pages, user['username'])
    models = []
    calls = 0
    for model in llm_ocr._models(conn, model_ids, user):
        held = _held(conn, job_id, model['id'])
        fresh = sum(page['id'] in held and held[page['id']]['status'] == 'done'
                    and held[page['id']]['prompt_hash'] == digests[page['id']]
                    for page in pages)
        to_read = len(pages) - fresh
        calls += to_read
        models.append({'id': model['id'], 'label': model['label'],
                       'calls': to_read, 'reused': fresh})
    return {'pages': len(pages), 'models': models, 'calls': calls, 'transcribed': transcribed}


def enqueue(conn, job_id: str, model_ids: list[int], user: dict, refresh: bool = False,
            page_ids: list[int] | None = None, include_transcribed: bool = False) -> dict:
    """Queue a diplomatic reading per page. A page already read under the same wording and
    the same reference is left as it is unless `refresh` asks for it again; a page whose
    wording or span has moved is read again regardless, since its question has changed.
    A page a person transcribed is skipped unless `include_transcribed` asks for it."""
    pages, transcribed = _split(_pages(conn, job_id, page_ids), include_transcribed)
    digests = _digests(conn, job_id, pages, user['username'])
    queued = reused = 0
    models = llm_ocr._models(conn, model_ids, user)
    for model in models:
        held_by_page = _held(conn, job_id, model['id'])
        for page in pages:
            held = held_by_page.get(page['id'])
            if held and held['status'] in ('pending', 'running'):
                continue
            if held and held['status'] == 'done' and held['prompt_hash'] == digests[page['id']] \
                    and not refresh:
                reused += 1
                continue
            # A re-read keeps the answer it is replacing until it is sent, so withdrawing
            # it before then costs nothing; the worker clears the text when the call goes out.
            conn.execute(
                'INSERT INTO gt_reads (page_id, job_id, llm_model_id, model, label, '
                "status, requested_by) VALUES (?,?,?,?,?,'pending',?) "
                'ON CONFLICT (page_id, llm_model_id) DO UPDATE SET '
                "status = 'pending', error = NULL, "
                'job_id = excluded.job_id, requested_by = excluded.requested_by',
                (page['id'], job_id, model['id'], model['model'], model['label'],
                 user['username']))
            queued += 1
    conn.execute('UPDATE jobs SET gt_model_ids = ? WHERE id = ?',
                 (json.dumps([model['id'] for model in models]), job_id))
    conn.commit()
    return {'queued': queued, 'reused': reused, 'pages': len(pages),
            'skipped': 0 if include_transcribed else transcribed}


def default_models(conn, job_id: str) -> list[int]:
    """What a diplomatic reading is asked with when nobody says: the models the last one
    used, else the ones the dataset's lines are read with."""
    row = conn.execute('SELECT gt_model_ids, llm_model_ids FROM jobs WHERE id = ?',
                       (job_id,)).fetchone()
    if row is None:
        return []
    return json.loads(row['gt_model_ids']) or json.loads(row['llm_model_ids'])


def status(conn, job_id: str, page_ids: list[int] | None = None) -> dict:
    rows = conn.execute(
        'SELECT status, COUNT(*) c FROM gt_reads WHERE job_id = ? GROUP BY status',
        (job_id,)).fetchall()
    counts = {row['status']: row['c'] for row in rows}
    errors = [dict(row) for row in conn.execute(
        "SELECT page_id, label, error FROM gt_reads WHERE job_id = ? AND status = 'error' "
        'ORDER BY page_id LIMIT 20', (job_id,))]
    return {'pending': counts.get('pending', 0), 'running': counts.get('running', 0),
            'done': counts.get('done', 0), 'error': counts.get('error', 0),
            'errors': errors, 'pages': _count_pages(conn, job_id, page_ids)}


def cancel(conn, job_id: str) -> int:
    """Withdraw what has not been sent yet. A re-read goes back to the answer already on
    file rather than losing it; a first reading is dropped. Anything in flight is already
    paid for, so it is left to finish and be kept."""
    pending = conn.execute(
        "SELECT id, raw_text FROM gt_reads WHERE job_id = ? AND status = 'pending'",
        (job_id,)).fetchall()
    for read in pending:
        if read['raw_text'] is not None:
            conn.execute("UPDATE gt_reads SET status = 'done' WHERE id = ?", (read['id'],))
        else:
            conn.execute('DELETE FROM gt_reads WHERE id = ?', (read['id'],))
    conn.commit()
    return len(pending)


def apply_answer(conn, read) -> bool:
    """One answer becomes the page's ground truth. Recorded as machine-made, so alignment
    offers these lines as corrections and never checks one off. A page carrying a person's
    transcription keeps it, and is offered the answer as a reading instead."""
    lines = llm_client.parse_lines(read['raw_text'] or '')
    text = '\n'.join(lines)
    if not text.strip():
        return False
    page = conn.execute('SELECT id, gt_text, gt_source FROM pages WHERE id = ? AND deleted = 0',
                        (read['page_id'],)).fetchone()
    if page is None:
        return False
    if carries_persons_transcription(page):
        _offer(conn, page['id'], offer_author(read['label']), lines)
        return True
    conn.execute('UPDATE pages SET gt_text = ?, gt_source = ? WHERE id = ?',
                 (text, GT_SOURCE, page['id']))
    conn.commit()
    return True


def _offer(conn, page_id: int, author: str, lines: list[str]) -> None:
    """The answer as one more reading on the page's lines, matched by text. Whatever this
    model offered here before is set aside, as its re-read replaces it; other models'
    readings stay to be compared."""
    conn.execute('UPDATE candidates SET dismissed = 1 WHERE page_id = ? AND author = ?',
                 (page_id, author))
    for order_idx, line in enumerate(lines):
        candidates.add(conn, page_id, author, line, order_idx=order_idx)
    conn.commit()
    candidates.rematch_page(conn, page_id)


def _outstanding(conn, job_id: str) -> int:
    return conn.execute("SELECT COUNT(*) c FROM gt_reads WHERE job_id = ? "
                        "AND status IN ('pending','running')", (job_id,)).fetchone()['c']


def _realign(conn, job_id: str) -> None:
    """With the last answer in, the dataset is queued for alignment alone. Pages keep their
    status, so the earlier phases find no work and only the new ground truth is matched."""
    job = conn.execute('SELECT status FROM jobs WHERE id = ?', (job_id,)).fetchone()
    if job is None or job['status'] in ('queued', 'running', 'uploading'):
        return
    conn.execute("UPDATE jobs SET status = 'queued', phase = NULL, error = NULL WHERE id = ?",
                 (job_id,))
    conn.commit()


def _prepare(conn, read) -> dict:
    page = conn.execute('SELECT * FROM pages WHERE id = ? AND deleted = 0',
                        (read['page_id'],)).fetchone()
    if page is None:
        return {'error': 'the page this reading was queued for is gone'}
    try:
        model, connection, key = llm.credentials(conn, read['llm_model_id'])
    except (LookupError, llm.SecretUnavailable) as exc:
        return {'error': str(exc)}
    try:
        image = llm_ocr.page_image(page, model['max_image_edge'])
    except (OSError, ValueError) as exc:
        return {'error': f'the page image could not be read: {exc}'}
    prompt = rendered_prompt(conn, read['job_id'], page)
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
        conn.execute("UPDATE gt_reads SET status = 'error', error = ?, raw_text = ?, "
                     "finished_at = datetime('now') WHERE id = ?",
                     (result['error'], read['raw_text'], read['id']))
        conn.commit()
        _settle(conn, read['job_id'])
        return
    # The answer is stored before the row is called done, so nothing can observe a finished
    # reading whose text has not reached the page yet. A crash in between leaves a running
    # row that already holds its text, which the worker completes rather than re-fetches.
    conn.execute(
        'UPDATE gt_reads SET raw_text = ?, error = NULL, prompt_tokens = ?, '
        'completion_tokens = ?, prompt_hash = ? WHERE id = ?',
        (result['text'], result.get('prompt_tokens'), result.get('completion_tokens'),
         result.get('prompt_hash'), read['id']))
    conn.commit()
    stored = conn.execute('SELECT * FROM gt_reads WHERE id = ?', (read['id'],)).fetchone()
    if stored is None:
        # The dataset went while the call was out, and its readings with it.
        return
    apply_answer(conn, stored)
    conn.execute("UPDATE gt_reads SET status = 'done', finished_at = datetime('now') "
                 'WHERE id = ?', (read['id'],))
    conn.commit()
    _settle(conn, read['job_id'])


def _settle(conn, job_id: str) -> None:
    if not _outstanding(conn, job_id):
        _realign(conn, job_id)


QUEUE = llm_queue.Queue('gt_reads', _prepare, _finish, apply_answer)


def drain_once(conn) -> int:
    """This queue alone, for callers that have no interest in the other one."""
    return llm_queue.drain_once(conn, [QUEUE])


def recover(conn) -> None:
    return llm_queue.recover(conn, [QUEUE])
