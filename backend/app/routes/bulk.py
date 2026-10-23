"""Running an action over many datasets at once.

A group is a project, so what can be asked of one dataset has to be askable of all of
them. Rather than a second implementation per action, each route resolves the selection
and then calls the same per-dataset function the single-dataset route calls, one savepoint
at a time: a dataset that refuses is reported and rolled back on its own, and the rest of
the selection still runs. Nothing here decides what an action means.
"""
import sqlite3

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app import store
from app.deps import can_access_job, check_capability, current_user, get_db
from app.routes import pipeline
from app.routes.jobs import JobPatch, apply_patch

router = APIRouter(tags=['bulk'])

MAX_SELECTION = 1000


class Selection(BaseModel):
    job_ids: list[str] = Field(min_length=1)


class BulkRerun(Selection):
    from_phase: str
    force: bool = False
    # The same two choices a single dataset offers, so a group discards exactly what
    # each of them would have discarded on its own.
    keep_checked: bool = True
    keep_text: bool = True


class BulkReocr(Selection):
    scope: str = 'pending'


class BulkPatch(Selection):
    patch: JobPatch


def _selected(conn, job_ids: list[str], user: dict) -> list[dict]:
    """The datasets named, in the order given, once. A name the caller cannot reach is a
    404 for the whole request rather than a silent omission - a selection that quietly
    shrinks is how somebody re-runs half a group and believes they ran all of it."""
    if len(job_ids) > MAX_SELECTION:
        raise HTTPException(400, f'at most {MAX_SELECTION} datasets in one request')
    seen: set[str] = set()
    jobs = []
    for job_id in job_ids:
        if job_id in seen:
            continue
        seen.add(job_id)
        job = store.get_job(conn, job_id)
        if job is None or not can_access_job(conn, job_id, user):
            raise HTTPException(404, f'dataset {job_id} not found')
        jobs.append(job)
    return jobs


def _close_savepoint(conn, undo: bool) -> None:
    """A dataset that commits partway through - re-running does, through
    store.update_counters - releases every savepoint with it. There is then nothing left
    to undo, and what it wrote is exactly what the single-dataset route would have left
    behind, so the selection carries on rather than failing on the bookkeeping."""
    try:
        if undo:
            conn.execute('ROLLBACK TO bulk_item')
        conn.execute('RELEASE bulk_item')
    except sqlite3.OperationalError:
        pass


def each_isolated(conn, jobs: list, run) -> tuple[list[dict], list[dict]]:
    """Run over the datasets one savepoint at a time, so one that refuses is undone in
    full - a dataset that refuses the third setting must not be left wearing the first
    two - and the rest still run. Answers what was done and what was skipped, and why."""
    done, skipped = [], []
    for job in jobs:
        named = {'id': job['id'], 'name': job['name']}
        # Write intent from the start: a transaction that reads first and writes later is
        # refused at once ("database is locked") if a running job commits in between,
        # where taking the lock up front makes either side wait for the other.
        if not conn.in_transaction:
            conn.execute('BEGIN IMMEDIATE')
        conn.execute('SAVEPOINT bulk_item')
        try:
            result = run(job)
        except HTTPException as refusal:
            _close_savepoint(conn, undo=True)
            skipped.append({**named, 'reason': refusal.detail})
        else:
            _close_savepoint(conn, undo=False)
            done.append({**named, **(result or {})})
    return done, skipped


def _each(conn, jobs: list[dict], run) -> dict:
    """Run over the selection, isolating each dataset. A refusal is that dataset's answer,
    not the request's: re-reading a group where three datasets are already queued should
    still re-read the rest and say which three it left alone."""
    done, skipped = each_isolated(conn, jobs, run)
    if not done:
        # Nothing was changed, so nothing is committed; answer with the first reason
        # rather than a success that did nothing.
        raise HTTPException(400, skipped[0]['reason'] if skipped else 'nothing to do')
    conn.commit()
    return {'ok': True, 'changed': done, 'skipped': skipped}


@router.post('/api/bulk/rerun')
def bulk_rerun(body: BulkRerun, conn=Depends(get_db), user: dict = Depends(current_user)):
    """Re-run the pipeline from a phase over a selection of datasets."""
    # The same permissions one dataset asks for; a selection is not a way around them.
    pipeline.require_phase(user, pipeline.Rerun(
        from_phase=body.from_phase, force=body.force,
        keep_checked=body.keep_checked, keep_text=body.keep_text))
    jobs = _selected(conn, body.job_ids, user)
    for job in jobs:
        pipeline.require_rerun_owner(job, user)
    if body.from_phase not in pipeline.RERUN_FROM:
        raise HTTPException(400, f'from_phase must be one of {sorted(pipeline.RERUN_FROM)}')
    return _each(conn, jobs, lambda job: pipeline.rerun_one(
        conn, job['id'], body.from_phase, body.force, user['username'],
        keep_checked=body.keep_checked, keep_text=body.keep_text))


@router.post('/api/bulk/reocr')
def bulk_reocr(body: BulkReocr, conn=Depends(get_db), user: dict = Depends(current_user)):
    """Re-read lines over a selection of datasets."""
    check_capability(user, 'pipeline.ocr')
    if body.scope not in ('pending', 'unchecked'):
        raise HTTPException(400, 'scope must be pending or unchecked')
    jobs = _selected(conn, body.job_ids, user)
    return _each(conn, jobs, lambda job: pipeline.reocr_one(conn, job['id'], body.scope, user))


@router.post('/api/bulk/redetect')
def bulk_redetect(body: Selection, conn=Depends(get_db), user: dict = Depends(current_user)):
    """Re-detect lines over a selection of datasets."""
    check_capability(user, 'pipeline.lines')
    jobs = _selected(conn, body.job_ids, user)
    return _each(conn, jobs, lambda job: pipeline.redetect_one(conn, job['id']))


@router.patch('/api/bulk/settings')
def bulk_settings(body: BulkPatch, conn=Depends(get_db), user: dict = Depends(current_user)):
    """Models, decoding, which phases run - the settings the group dialog already writes,
    over an arbitrary selection instead of a whole group."""
    fields = body.patch.model_fields_set
    beyond = [f for f in ('name', 'group_id') if f in fields]
    if beyond:
        raise HTTPException(400, f'{beyond[0]} belongs to one dataset, not to a selection')
    if not fields:
        raise HTTPException(400, 'nothing to change')
    jobs = _selected(conn, body.job_ids, user)
    return _each(conn, jobs, lambda job: apply_patch(
        conn, job['id'], job, body.patch, fields, user) or None)


class BulkMove(Selection):
    group_id: int | None = None


@router.patch('/api/bulk/group')
def bulk_move(body: BulkMove, conn=Depends(get_db), user: dict = Depends(current_user)):
    """Filing a selection under a group, or out of one with a null. Separate from the
    settings route because group_id is refused there - moving is what a selection is for,
    while a group has no group of its own."""
    jobs = _selected(conn, body.job_ids, user)
    patch = JobPatch(group_id=body.group_id)
    fields = {'group_id'}
    return _each(conn, jobs, lambda job: apply_patch(
        conn, job['id'], job, patch, fields, user) or None)


def _refuse_rerun(conn, job, body, user) -> None:
    pipeline.require_rerun_owner(job, user)
    pipeline.require_rerun(conn, job, body.from_phase, body.force)


# Per action: what it would cost one dataset, and the action's own refusal of it. The
# dialog re-reads unchecked lines, so that is the re-read asked about.
PREVIEWS = {
    'rerun': (lambda conn, job, body: pipeline.rerun_discards(conn, job['id'], body.from_phase),
              _refuse_rerun),
    'redetect': (lambda conn, job, body: pipeline._stale_lines(conn, job['id']),
                 lambda conn, job, body, user: pipeline.redetect_cost(conn, job)),
    'reocr': (lambda conn, job, body: pipeline.reocr_counts(conn, job['id']),
              lambda conn, job, body, user: pipeline.require_reocr_work(conn, job, 'unchecked')),
}

# Checked lines are left alone whether or not the dataset runs, so a refused one still
# counts them; everything else it would have cost, it no longer does.
LEFT_ALONE = {'checked'}


class BulkPreview(Selection):
    action: str
    # A re-run costs what its phase discards, and is refused for what it would refuse.
    from_phase: str | None = None
    force: bool = False


@router.post('/api/bulk/preview')
def bulk_preview(body: BulkPreview, conn=Depends(get_db), user: dict = Depends(current_user)):
    """What the action would cost over the whole selection, before anything is queued.
    The per-dataset previews are counts, so they sum; `blocked` is what the action would
    refuse, asked of the action itself so the dialog can say 41 of 44 rather than
    claiming all 44."""
    if body.action not in PREVIEWS:
        raise HTTPException(400, f'action must be one of {sorted(PREVIEWS)}')
    if body.action == 'rerun' and body.from_phase not in pipeline.RERUN_FROM:
        raise HTTPException(400, f'from_phase must be one of {sorted(pipeline.RERUN_FROM)}')
    jobs = _selected(conn, body.job_ids, user)
    count, refuse = PREVIEWS[body.action]
    totals: dict[str, int] = {}
    blocked = []
    for job in jobs:
        runs = True
        try:
            refuse(conn, job, body, user)
        except HTTPException as refusal:
            runs = False
            blocked.append({'id': job['id'], 'name': job['name'], 'reason': refusal.detail})
        for key, value in count(conn, job, body).items():
            totals[key] = totals.get(key, 0) + (value if runs or key in LEFT_ALONE else 0)
    return {'action': body.action, 'datasets': len(jobs) - len(blocked),
            'blocked': blocked, 'totals': totals}
