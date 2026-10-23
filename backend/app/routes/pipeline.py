import shutil
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app import candidates, characters, config, ingest, layout_classes, registry, store
from app.deps import (check_capability, current_user, get_db, get_user, require_capability,
                      require_job_access, require_page_access, require_role)

router = APIRouter(tags=['pipeline'])


def _stale_lines(conn, job_id: str) -> dict:
    """Elements whose lines no longer match their geometry, and what re-detecting
    them would cost. Corrections are destroyed by re-detection - the line rows go,
    and training.backfill prunes their pairs on the next start - so they are counted
    up front, the same way the re-run preview does it."""
    where = (f'FROM elements e JOIN pages p ON e.page_id = p.id '
             f'WHERE p.job_id = ? AND p.deleted = 0 AND {layout_classes.STALE_LINES_SQL}')
    args = (job_id, *layout_classes.STALE_LINES_ARGS)
    elements = conn.execute(f'SELECT COUNT(*) c {where}', args).fetchone()['c']
    corrected = conn.execute(
        f"SELECT COUNT(*) c FROM lines l WHERE l.deleted = 0 AND l.corrected_text IS NOT NULL "
        f"AND trim(l.corrected_text) != '' AND l.element_id IN (SELECT e.id {where})", args).fetchone()['c']
    pages = conn.execute(f'SELECT COUNT(DISTINCT e.page_id) c {where}', args).fetchone()['c']
    # Lines under stale elements that a human drew or reshaped - re-detection replaces them.
    hand_edited = conn.execute(
        f"SELECT COUNT(DISTINCT r.target_id) c FROM revisions r JOIN lines l ON l.id = r.target_id "
        f"WHERE r.target_type = 'line' AND {store.person_author_sql('r.author')} "
        f"AND l.deleted = 0 AND l.element_id IN (SELECT e.id {where})", args).fetchone()['c']
    return {'elements': elements, 'pages': pages, 'corrected': corrected, 'hand_edited': hand_edited}


@router.get('/api/jobs/{job_id}/redetect')
def redetect_preview(job_id: str, conn=Depends(get_db), user: dict = Depends(current_user)):
    """Elements whose lines no longer match their geometry, and what re-detection costs."""
    require_job_access(conn, job_id, user)
    if store.get_job(conn, job_id) is None:
        raise HTTPException(404)
    return _stale_lines(conn, job_id)


class Redetect(BaseModel):
    page_id: int | None = None


def require_idle(job: dict) -> None:
    if job['status'] in ('queued', 'running'):
        raise HTTPException(409, 'job is already queued or running')


def redetect_cost(conn, job: dict) -> dict:
    """What re-detecting this dataset would cost, or the reason it would be refused."""
    require_idle(job)
    stale = _stale_lines(conn, job['id'])
    if not stale['elements']:
        raise HTTPException(400, 'no elements need line re-detection')
    return stale


def redetect_one(conn, job_id: str) -> dict:
    """One dataset's line re-detection, short of the commit, so a run over a whole group
    reaches the same code as a run over one dataset rather than a copy of it."""
    job = store.get_job(conn, job_id)
    if job is None:
        raise HTTPException(404)
    stale = redetect_cost(conn, job)
    # Clear lines_bbox on the currently-stale elements so this explicit request is
    # honoured even when auto_redetect is off (phase_relines then keys on NULL).
    conn.execute(
        f"UPDATE elements SET lines_bbox = NULL WHERE id IN "
        f"(SELECT e.id FROM elements e JOIN pages p ON e.page_id = p.id "
        f"WHERE p.job_id = ? AND p.deleted = 0 AND {layout_classes.STALE_LINES_SQL})",
        (job_id, *layout_classes.STALE_LINES_ARGS))
    _queue(conn, job_id)
    return {'ok': True, **stale}


@router.post('/api/jobs/{job_id}/redetect')
def redetect_lines(job_id: str, body: Redetect | None = None, conn=Depends(get_db),
                   me: dict = Depends(current_user),
                   _may=Depends(require_capability('pipeline.lines'))):
    """Queue the job so the runner's stale pass picks the work up. Every other phase
    selects its own work by status and finds none on a finished job, so nothing else
    is redone."""
    require_job_access(conn, job_id, me)
    user = me['username']
    job = store.get_job(conn, job_id)
    if job is None:
        raise HTTPException(404)
    if job['status'] in ('queued', 'running'):
        raise HTTPException(409, 'job is already queued or running')
    if body is not None and body.page_id is not None:
        # Explicit page-level redo: forget what the lines were detected against, so
        # every content element on the page qualifies regardless of drift.
        page = conn.execute('SELECT id FROM pages WHERE id = ? AND job_id = ?',
                            (body.page_id, job_id)).fetchone()
        if page is None:
            raise HTTPException(404, 'page not in job')
        conn.execute("UPDATE elements SET lines_bbox = NULL "
                     "WHERE page_id = ? AND kind = 'content' AND deleted = 0", (body.page_id,))
    result = redetect_one(conn, job_id)
    conn.commit()
    return result


_LIVE_LINES = ('FROM lines l JOIN elements e ON l.element_id = e.id '
               'JOIN pages p ON e.page_id = p.id WHERE p.job_id = ? AND p.deleted = 0 '
               "AND e.deleted = 0 AND e.kind != 'container' AND l.deleted = 0")


def _pending_reocr(conn, job_id: str) -> int:
    return conn.execute(
        f'SELECT COUNT(*) c {_LIVE_LINES} AND l.text IS NULL', (job_id,)).fetchone()['c']


def _ocr_authors(conn, job_id: str) -> list[dict]:
    """Which model wrote each line's current text: the latest model:ocr revision
    per live line, grouped - more than one entry means a mixed-provenance dataset."""
    rows = conn.execute(
        'SELECT r.author, COUNT(*) lines FROM revisions r JOIN ('
        f'SELECT MAX(r2.id) mid FROM revisions r2 JOIN lines l ON l.id = r2.target_id '
        'JOIN elements e ON l.element_id = e.id JOIN pages p ON e.page_id = p.id '
        "WHERE r2.job_id = ? AND r2.target_type = 'line' AND r2.author LIKE 'model:ocr@%' "
        "AND p.deleted = 0 AND e.deleted = 0 AND l.deleted = 0 "
        'GROUP BY r2.target_id) latest ON latest.mid = r.id '
        'GROUP BY r.author ORDER BY lines DESC', (job_id,)).fetchall()
    reader = registry.job_reader(conn, job_id)
    # Naming the unnamed makes rows from before and after that change the same reader,
    # so they are summed rather than listed twice under one name.
    counts: dict[str, int] = {}
    for row in rows:
        author = registry.named_reader(row['author'], reader)
        counts[author] = counts.get(author, 0) + row['lines']
    return [{'author': author, 'lines': lines}
            for author, lines in sorted(counts.items(), key=lambda kv: -kv[1])]


@router.get('/api/jobs/{job_id}/characters')
def job_characters(job_id: str, conn=Depends(get_db), user: dict = Depends(current_user)):
    """What this dataset writes that a keyboard cannot: the palette a person gets when
    they let it fill itself instead of picking the keys by hand."""
    require_job_access(conn, job_id, user)
    if store.get_job(conn, job_id) is None:
        raise HTTPException(404)
    return {'characters': characters.in_job(conn, job_id)}


def reocr_counts(conn, job_id: str) -> dict:
    lines = f'SELECT COUNT(*) c {_LIVE_LINES}'
    return {
        'lines': _pending_reocr(conn, job_id),
        'unchecked': conn.execute(f'{lines} AND l.checked = 0', (job_id,)).fetchone()['c'],
        'checked': conn.execute(f'{lines} AND l.checked = 1', (job_id,)).fetchone()['c'],
    }


@router.get('/api/jobs/{job_id}/reocr')
def reocr_preview(job_id: str, conn=Depends(get_db), user: dict = Depends(current_user)):
    """How many lines a re-read covers, and which models wrote the current text."""
    require_job_access(conn, job_id, user)
    if store.get_job(conn, job_id) is None:
        raise HTTPException(404)
    return {**reocr_counts(conn, job_id), 'authors': _ocr_authors(conn, job_id)}


class Reocr(BaseModel):
    # 'pending' re-reads only lines without text (edited/added); 'unchecked'
    # re-reads everything a human has not verified - used after a model or
    # decode switch. Checked lines are never touched by either.
    scope: str = 'pending'


def require_reocr_work(conn, job: dict, scope: str) -> None:
    """Refuse a re-read that would find nothing to read, or a dataset already busy."""
    require_idle(job)
    if scope == 'unchecked':
        if not reocr_counts(conn, job['id'])['unchecked']:
            raise HTTPException(400, 'no unchecked lines to re-read')
    elif not _pending_reocr(conn, job['id']):
        raise HTTPException(400, 'no edited lines to re-read')


def reocr_one(conn, job_id: str, scope: str, user: dict) -> dict:
    """One dataset's re-read, short of the commit. Shared with the bulk route so a group
    is refused for the same reasons, and in the same words, as a single dataset."""
    require_job_access(conn, job_id, user)
    job = store.get_job(conn, job_id)
    if job is None:
        raise HTTPException(404)
    check_capability(user, 'pipeline.ocr')
    if scope not in ('pending', 'unchecked'):
        raise HTTPException(400, 'scope must be pending or unchecked')
    require_reocr_work(conn, job, scope)
    if scope == 'unchecked':
        conn.execute(
            'UPDATE lines SET needs_ocr = 1 WHERE checked = 0 AND deleted = 0 AND element_id IN ('
            'SELECT e.id FROM elements e JOIN pages p ON e.page_id = p.id '
            "WHERE p.job_id = ? AND p.deleted = 0 AND e.deleted = 0 AND e.kind != 'container')",
            (job_id,))
    store.enable_ocr_phase(conn, job_id)  # asking for a re-read is asking for the phase
    _queue(conn, job_id)
    return {'ok': True, 'lines': _pending_reocr(conn, job_id)}


@router.post('/api/jobs/{job_id}/reocr')
def reocr(job_id: str, body: Reocr = Reocr(), conn=Depends(get_db),
          user: dict = Depends(current_user)):
    """Re-read lines with the dataset's current model and decode settings.
    phase_ocr selects text IS NULL or needs_ocr = 1 on done pages, so queueing
    the job is enough - no phase re-detects anything."""
    result = reocr_one(conn, job_id, body.scope, user)
    conn.commit()
    return result


RERUN_FROM = {
    'layout': ('ingested', "status IN ('layout_done','lines_done','done')"),
    # From the start under the dataset's own settings: the boxes go as for a layout re-run,
    # but layout is left as it is set, so with it off the lines are found on the whole page.
    'start': ('ingested', "status IN ('layout_done','lines_done','done')"),
    'lines': ('layout_done', "status IN ('lines_done','done')"),
    'ocr': ('lines_done', "status = 'done'"),
    # Alignment reads what OCR already produced, so the pages keep their status and
    # nothing is thrown away - the earlier phases simply find no work to redo.
    'align': ('done', "status = 'done'"),
    # The cut reads what OCR produced too, and writes only the reference columns. Re-run
    # it after uploading a corrected corpus, or once recognition has improved.
    'reference': ('done', "status = 'done'"),
}


def _layout_checked_pages(conn, job_id: str) -> int:
    return conn.execute(
        'SELECT COUNT(*) c FROM pages WHERE job_id = ? AND layout_checked = 1 AND deleted = 0',
        (job_id,)).fetchone()['c']


def _rerun_counts(conn, job_id: str) -> dict:
    q = ('SELECT COUNT(*) c FROM lines l JOIN elements e ON l.element_id = e.id '
         'JOIN pages p ON e.page_id = p.id WHERE p.job_id = ? AND p.deleted = 0 AND e.deleted = 0 AND l.deleted = 0')
    one = lambda extra='': conn.execute(q + extra, (job_id,)).fetchone()['c']
    layout_checked = _layout_checked_pages(conn, job_id)
    edited = conn.execute(
        'SELECT COUNT(DISTINCT r.target_id) c FROM revisions r JOIN elements e ON e.id = r.target_id '
        'JOIN pages p ON e.page_id = p.id '
        "WHERE p.job_id = ? AND p.deleted = 0 AND r.target_type = 'element' "
        f"AND {store.person_author_sql('r.author')}",
        (job_id,)).fetchone()['c']
    return {'lines': one(), 'corrected': one(' AND l.corrected_text IS NOT NULL'),
            'checked': one(' AND l.checked = 1'),
            'layout_checked': layout_checked, 'elements_edited': edited}


# Re-matching reads what OCR already produced: no correction, sign-off or box is lost.
REMATCH_PHASES = ('align', 'reference')
# Both start the pages over and take the boxes with them.
BOX_PHASES = ('layout', 'start')


def rerun_discards(conn, job_id: str, from_phase: str) -> dict:
    """What re-running from this phase throws away, in the re-run preview's terms."""
    counts = _rerun_counts(conn, job_id)
    if from_phase in REMATCH_PHASES:
        return {**counts, 'corrected': 0, 'layout_checked': 0, 'elements_edited': 0}
    return counts


def require_rerun(conn, job: dict, from_phase: str, force: bool) -> None:
    """Refuse a re-run of a busy dataset, or one that would retire a layout sign-off
    without force - asked by the re-run itself and by the preview of one."""
    require_idle(job)
    if from_phase in BOX_PHASES and not force:
        signed_off = _layout_checked_pages(conn, job['id'])
        if signed_off:
            raise HTTPException(409, f'{signed_off} page(s) are marked layout complete; '
                                     'pass force to re-run anyway')


@router.get('/api/jobs/{job_id}/rerun')
def rerun_preview(job_id: str, conn=Depends(get_db), user: dict = Depends(current_user)):
    """What a re-run would discard, so the UI can confirm with real numbers."""
    require_job_access(conn, job_id, user)
    if store.get_job(conn, job_id) is None:
        raise HTTPException(404)
    return _rerun_counts(conn, job_id)


class Rerun(BaseModel):
    from_phase: str
    force: bool = False
    # A line somebody checked is the one thing on a page that is settled. A re-read
    # leaves it alone unless this is explicitly turned off, which is what "re-read
    # everything, checked too" means and costs those readings.
    keep_checked: bool = True
    # Detection replaces the lines; their text goes to the pool first and is re-offered
    # on whatever is found this time. Off starts the page clean instead.
    keep_text: bool = True


@router.post('/api/jobs/{job_id}/rerun')
def rerun_job(job_id: str, body: Rerun, conn=Depends(get_db), me: dict = Depends(current_user)):
    """Re-run the pipeline from a phase, discarding what that phase produced -
    except alignment, which only re-matches transcriptions against the text on hand."""
    require_job_access(conn, job_id, me)
    require_phase(me, body)
    job = store.get_job(conn, job_id)
    if job is not None:
        require_rerun_owner(job, me)
    user = me['username']
    result = rerun_one(conn, job_id, body.from_phase, body.force, user,
                       keep_checked=body.keep_checked, keep_text=body.keep_text)
    conn.commit()
    return result


# Which capability each phase asks for. Alignment re-matches what is already there and
# destroys nothing, so anyone who can open the dataset may run it.
PHASE_CAPABILITY = {
    'layout': 'pipeline.layout',
    'start': 'pipeline.layout',
    'lines': 'pipeline.lines',
    'ocr': 'pipeline.ocr',
}


def require_phase(user: dict, body: 'Rerun') -> None:
    """Running a phase again and throwing away what somebody checked are two different
    permissions: the second is what turns a re-run into a loss."""
    needed = PHASE_CAPABILITY.get(body.from_phase)
    if needed:
        check_capability(user, needed)
    if body.force or not body.keep_checked or not body.keep_text:
        check_capability(user, 'pipeline.discard')


def require_rerun_owner(job: dict, user: dict) -> None:
    """Re-running a whole dataset is its owner's call, as running a phase on one of its
    pages is: being given a dataset carries re-reading it, not re-running it."""
    if job['owner'] != user['username'] and user['role'] != 'admin':
        raise HTTPException(403, f"only the owner or an admin may re-run {job['name']}")


def switch_on_phase(conn, job: dict, phase: str) -> None:
    """Switch on the phase asked for and what it cannot run without, and nothing else - a
    switched-off phase would have its output cleared and never be redone, but a dataset
    built without reading stays unread after its lines are re-detected.

    Layout drops every line with the boxes, so it needs line detection, and so does
    starting over - which leaves layout as it is set. Alignment and the
    reference cut run only inside the reading pass. A map dataset has no text phases."""
    if ingest.is_tile_task(job['task']):
        return
    if phase in ('layout', 'start', 'lines'):
        store.enable_phases(conn, job['id'], layout=phase == 'layout', lines=True)
    else:
        store.enable_ocr_phase(conn, job['id'])


def rerun_one(conn, job_id: str, from_phase: str, force: bool, user: str,
              keep_checked: bool = True, keep_text: bool = True) -> dict:
    """One dataset's re-run, short of the commit. Shared with the bulk route, so a group
    discards exactly what the same request over each dataset would have discarded."""
    body = Rerun(from_phase=from_phase, force=force, keep_checked=keep_checked, keep_text=keep_text)
    job = store.get_job(conn, job_id)
    if job is None:
        raise HTTPException(404)
    if body.from_phase not in RERUN_FROM:
        raise HTTPException(400, f"from_phase must be one of {sorted(RERUN_FROM)}")
    require_rerun(conn, job, body.from_phase, body.force)

    reset_to, match = RERUN_FROM[body.from_phase]
    discarded = rerun_discards(conn, job_id, body.from_phase)
    # Deleted pages must never be handed back to the runner.
    pages = f"SELECT id FROM pages WHERE job_id = ? AND deleted = 0 AND {match}"
    realign = body.from_phase in ('align', 'reference')
    if not realign and body.keep_text:
        # Everything the re-run is about to overwrite goes to the pool first, so a person's
        # corrections are re-offered on whatever the pipeline detects this time.
        for page in conn.execute(pages, (job_id,)).fetchall():
            candidates.capture_page(conn, page['id'])
    if body.from_phase == 'ocr':
        # A checked line is somebody's settled reading; clearing it is the explicit case,
        # not the default one.
        spare = ' AND checked = 0' if body.keep_checked else ''
        conn.execute('UPDATE lines SET text = NULL, confidence = NULL, conf_profile = NULL, '
                     'corrected_text = NULL, corrected_by = NULL, checked = 0 WHERE element_id IN '
                     f'(SELECT id FROM elements WHERE page_id IN ({pages})){spare}', (job_id,))
    elif not realign:
        # Soft-delete rather than DELETE, for the same reason the boxes are: detection
        # that finds fewer lines than it replaced would otherwise take every correction
        # on them with it, past recovery.
        scope = f'element_id IN (SELECT id FROM elements WHERE page_id IN ({pages}))'
        stale = [r['id'] for r in conn.execute(
            f'SELECT id FROM lines WHERE deleted = 0 AND {scope}', (job_id,))]
        conn.execute(f'UPDATE lines SET deleted = 1 WHERE {scope}', (job_id,))
        for line_id in stale:
            store.log_line(conn, line_id, f'system:rerun@{user}', 'delete')
        reset_pages = [page['id'] for page in conn.execute(pages, (job_id,)).fetchall()]
        if not body.keep_text:
            # Starting clean is a promise about the pool too: left there, what it holds for
            # these lines would come back onto the new ones at the next rematch, which any
            # edit of the page triggers.
            for page_id in reset_pages:
                candidates.set_aside(conn, page_id)
        if body.from_phase == 'lines':
            # Detection files the lines outside every box into a fresh orphan bucket, so
            # the old one would stand empty beside it.
            for page_id in reset_pages:
                _drop_orphan_buckets(conn, page_id, f'system:rerun@{user}')
    if body.from_phase in BOX_PHASES:
        # Soft-delete rather than DELETE: fresh detection has no correspondence to the
        # old boxes, so it inserts new rows while these keep their history.
        stale = [r['id'] for r in conn.execute(
            f'SELECT id FROM elements WHERE deleted = 0 AND page_id IN ({pages})', (job_id,))]
        conn.execute(f'UPDATE elements SET deleted = 1 WHERE page_id IN ({pages})', (job_id,))
        for element_id in stale:
            store.log_element(conn, element_id, f'system:rerun@{user}', 'delete')
        conn.execute(f'UPDATE pages SET layout_checked = 0 WHERE job_id = ? AND deleted = 0 AND {match}',
                     (job_id,))
        # Element ids change, so every cached crop becomes garbage.
        shutil.rmtree(config.job_dir(job_id) / 'crops', ignore_errors=True)
    conn.execute(f'UPDATE pages SET status = ? WHERE job_id = ? AND deleted = 0 AND {match}',
                 (reset_to, job_id))
    switch_on_phase(conn, job, body.from_phase)
    _queue(conn, job_id)
    # The counters still describe the discarded work, so the bars would read against
    # stale totals (e.g. 76/75) until the re-run happens to overwrite each one.
    store.recount_pages(conn, job_id)
    return {'ok': True, 'from_phase': body.from_phase, 'discarded': discarded}


def _line_tally(conn, page_id: int, holders: str):
    """How many live lines the page's elements matching `holders` hold, how many of those a
    person has corrected, and how many are checked."""
    return conn.execute(
        'SELECT COUNT(*) lines, '
        "COALESCE(SUM(l.corrected_text IS NOT NULL AND trim(l.corrected_text) != ''), 0) corrections, "
        'COALESCE(SUM(l.checked = 1), 0) checked '
        'FROM lines l JOIN elements e ON l.element_id = e.id '
        f'WHERE e.page_id = ? AND e.deleted = 0 AND l.deleted = 0 AND {holders}',
        (page_id,)).fetchone()


def _page_costs(conn, page_id: int) -> dict:
    """What running each phase on this page would replace, so the menu can say it before
    anything is queued rather than after. Each count covers exactly what `_stage_page_run`
    hands that phase: layout drops every element, line detection re-detects inside the
    content boxes (or, where there are none, the orphan bucket), and OCR reads every line
    outside a container."""
    boxes = dict(conn.execute(
        'SELECT kind, COUNT(*) FROM elements WHERE page_id = ? AND deleted = 0 GROUP BY kind',
        (page_id,)).fetchall())
    everything = _line_tally(conn, page_id, '1')
    redetected = _line_tally(conn, page_id, "e.kind = 'content'" if boxes.get('content')
                             else "e.kind = 'orphan'")
    readable = _line_tally(conn, page_id, "e.kind != 'container'")
    return {
        'layout': {'elements': boxes.get('content', 0) + boxes.get('container', 0),
                   'lines': everything['lines'], 'corrections': everything['corrections']},
        'lines': {'lines': redetected['lines'], 'corrections': redetected['corrections']},
        # A verified line is the corpus; re-reading never touches one.
        'ocr': {'unchecked': readable['lines'] - readable['checked'],
                'checked': readable['checked']},
    }


@router.get('/api/pages/{page_id}/run')
def run_costs(page_id: int, conn=Depends(get_db), user: dict = Depends(current_user)):
    """What each phase would replace on this page."""
    require_page_access(conn, page_id, user)
    if conn.execute('SELECT 1 FROM pages WHERE id = ? AND deleted = 0', (page_id,)).fetchone() is None:
        raise HTTPException(404)
    return _page_costs(conn, page_id)


class RunPhase(BaseModel):
    phase: str


class RunPages(BaseModel):
    phase: str
    page_ids: list[int]


PHASES = ('layout', 'lines', 'ocr')


class NotRunnable(Exception):
    """This page cannot take this phase. `status` is what a request for that one page
    answers with; in a batch the reason is reported beside the page instead."""

    def __init__(self, status: int, reason: str):
        super().__init__(reason)
        self.status = status
        self.reason = reason


def _valid_phase(phase: str, user: dict) -> str:
    """A phase this deployment runs, and one this person may run - the same capability a
    whole-dataset re-run from that phase asks for."""
    if phase not in PHASES:
        raise HTTPException(400, f'phase must be {", ".join(PHASES[:-1])} or {PHASES[-1]}')
    check_capability(user, PHASE_CAPABILITY[phase])
    return phase


def _runnable_job(conn, job_id: str, user: dict) -> dict:
    """The dataset, if this caller may run phases on it and nothing is running already."""
    job = store.get_job(conn, job_id)
    if job is None:
        raise HTTPException(404)
    require_rerun_owner(job, user)
    if job['status'] in ('queued', 'running'):
        raise HTTPException(409, 'the dataset is already queued or running')
    return job


def _drop_orphan_buckets(conn, page_id: int, author: str) -> None:
    """The invisible element a page's lines live in when layout found nothing. Soft-deleted
    like any other, so its history stays and the next detection inserts a fresh one rather
    than adding a second set of lines beside the old."""
    stale = [r['id'] for r in conn.execute(
        "SELECT id FROM elements WHERE page_id = ? AND kind = 'orphan' AND deleted = 0",
        (page_id,))]
    conn.execute("UPDATE elements SET deleted = 1 WHERE page_id = ? AND kind = 'orphan' "
                 'AND deleted = 0', (page_id,))
    for element_id in stale:
        store.log_element(conn, element_id, author, 'delete')


def _stage_page_run(conn, page, phase: str, username: str) -> None:
    """Put one page back to the state `phase` selects, keeping whatever that phase is about
    to overwrite. Every reason to refuse is checked before the first write, so a page that
    cannot run leaves nothing behind - which is what lets a batch skip it and carry on.

    The dataset is not queued here: the caller does that once, for however many pages it
    staged."""
    page_id = page['id']
    if page['status'] == 'pending':
        raise NotRunnable(409, 'this page has not been ingested yet')
    # Every phase opens the scan. Refusing here keeps the page as it is; queueing would
    # empty it, load a model, and fail in the runner.
    if not Path(page['source_file']).exists():
        raise NotRunnable(409, 'the image for this page is missing on disk')
    if phase == 'ocr':
        readable = _page_costs(conn, page_id)['ocr']
        if not readable['unchecked']:
            raise NotRunnable(400, 'every line on this page is already checked'
                              if readable['checked'] else 'there are no lines on this page')

    candidates.capture_page(conn, page_id)
    is_map = ingest.is_tile_task(store.get_job(conn, page['job_id'])['task'])
    if not is_map:
        # Unlike a dataset re-run, a page run gives the page everything after the phase:
        # fresh boxes need lines, fresh lines need reading, and a page left half-detected
        # is not a state worth offering.
        store.enable_phases(conn, page['job_id'], layout=phase == 'layout',
                            lines=phase in ('layout', 'lines'), ocr=True)

    if phase == 'layout':
        stale = [r['id'] for r in conn.execute(
            "SELECT id FROM elements WHERE page_id = ? AND deleted = 0", (page_id,))]
        conn.execute('UPDATE elements SET deleted = 1 WHERE page_id = ?', (page_id,))
        for element_id in stale:
            store.log_element(conn, element_id, f'system:run@{username}', 'delete')
        conn.execute("UPDATE pages SET status = 'ingested', layout_checked = 0 WHERE id = ?",
                     (page_id,))
    elif phase == 'lines':
        # Forgetting what the lines were detected against is how phase_relines is asked for
        # an element; it replaces the lines of exactly the elements it is pointed at.
        pointed_at = conn.execute("UPDATE elements SET lines_bbox = NULL WHERE page_id = ? "
                                  "AND kind = 'content' AND deleted = 0", (page_id,)).rowcount
        if not pointed_at:
            # Layout found no box here, so there is nothing for phase_relines to re-detect
            # inside and it would pass the page by. Its lines sit in one orphan bucket
            # instead: drop that and send the page back to the line phase, which detects
            # across the whole scan when there are no boxes. What they said is already in
            # the pool, and comes back onto whatever is found this time.
            _drop_orphan_buckets(conn, page_id, f'system:run@{username}')
            conn.execute("UPDATE pages SET status = 'layout_done' WHERE id = ?", (page_id,))
    else:
        conn.execute(
            'UPDATE lines SET needs_ocr = 1 WHERE checked = 0 AND deleted = 0 AND element_id IN '
            "(SELECT id FROM elements WHERE page_id = ? AND deleted = 0 AND kind != 'container')",
            (page_id,))
        if not is_map:
            store.enable_ocr_phase(conn, page['job_id'])
        if page['status'] not in ('lines_done', 'done'):
            conn.execute("UPDATE pages SET status = 'lines_done' WHERE id = ?", (page_id,))


def _queue(conn, job_id: str) -> None:
    conn.execute("UPDATE jobs SET status = 'queued', phase = NULL, error = NULL WHERE id = ?",
                 (job_id,))


@router.post('/api/pages/{page_id}/run')
def run_page(page_id: int, body: RunPhase, conn=Depends(get_db),
             user: dict = Depends(current_user)):
    """Run one phase on one page, whether or not it has run there before.

    Each phase already selects its own work by status, so this puts the page back to what
    that phase reads and queues the dataset. Whatever the phase is about to overwrite goes
    to the page's pool first, so corrections come back onto whatever is detected this time
    instead of being lost."""
    require_page_access(conn, page_id, user)
    page = conn.execute(
        'SELECT id, job_id, status, source_file FROM pages WHERE id = ? AND deleted = 0',
        (page_id,)).fetchone()
    if page is None:
        raise HTTPException(404)
    _valid_phase(body.phase, user)
    _runnable_job(conn, page['job_id'], user)
    costs = _page_costs(conn, page_id)
    try:
        _stage_page_run(conn, page, body.phase, user['username'])
    except NotRunnable as exc:
        raise HTTPException(exc.status, exc.reason)
    _queue(conn, page['job_id'])
    conn.commit()
    return {'ok': True, 'phase': body.phase, **costs[body.phase]}


@router.post('/api/jobs/{job_id}/pages/run')
def run_pages(job_id: str, body: RunPages, conn=Depends(get_db),
              user: dict = Depends(current_user)):
    """Run one phase on a set of the dataset's pages, queueing the dataset once.

    A page the phase has nothing to do on is reported rather than failing the batch - asking
    for a re-read of forty pages should not be refused because one of them is finished. A
    page id from another dataset is a mistake worth reporting, so that is still a 404."""
    require_job_access(conn, job_id, user)
    _valid_phase(body.phase, user)
    _runnable_job(conn, job_id, user)
    if not body.page_ids:
        raise HTTPException(400, 'no pages given')
    held = {row['id']: row for row in conn.execute(
        'SELECT id, job_id, status, source_file FROM pages WHERE job_id = ? AND deleted = 0',
        (job_id,))}
    # The whole selection is resolved before any of it is staged, so a stray id refuses the
    # batch instead of half-running it.
    chosen = []
    for page_id in dict.fromkeys(body.page_ids):
        if page_id not in held:
            raise HTTPException(404, f'no such page in this dataset: {page_id}')
        chosen.append(held[page_id])
    staged, skipped = [], []
    for page in chosen:
        try:
            _stage_page_run(conn, page, body.phase, user['username'])
        except NotRunnable as exc:
            skipped.append({'page_id': page['id'], 'reason': exc.reason})
            continue
        staged.append(page['id'])
    if not staged:
        # Nothing was written - the connection closes without a commit - so the batch is
        # refused with the reason rather than reported as a run that did nothing.
        raise HTTPException(400, skipped[0]['reason'])
    _queue(conn, job_id)
    conn.commit()
    return {'ok': True, 'phase': body.phase, 'pages': len(staged), 'skipped': skipped}
