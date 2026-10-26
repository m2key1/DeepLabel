import json
import threading
from collections import OrderedDict
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from app import config
from app import decode as decode_modes
from app import caches, eval_lines, eval_metrics, evaluator, preflight, registry, store, trainer
from app.deps import can_access_job, current_user, get_db, require_job_access, require_role

router = APIRouter(tags=['evaluations'])


def _source_label(conn, source: dict, user: dict) -> str:
    """What an evaluation scored against, named for the card - dataset names a user
    cannot access stay redacted, like everywhere else."""
    if 'snapshot' in source:
        row = conn.execute('SELECT name FROM trainings WHERE id = ?',
                           (source['snapshot'],)).fetchone()
        return f"valid split of {row['name']}" if row else 'a valid split'
    names = []
    for job_id in source.get('jobs', []):
        row = conn.execute('SELECT name FROM jobs WHERE id = ?', (job_id,)).fetchone()
        if row is not None:
            names.append(row['name'] if can_access_job(conn, job_id, user) else 'another dataset')
    label = ', '.join(names) or 'datasets'
    return f'test pages of {label}' if source.get('test_pages') else label


@router.get('/api/evaluations')
def list_evaluations(conn=Depends(get_db), user: dict = Depends(current_user)):
    """Every model evaluation, newest first, each naming what it scored against."""
    rows = conn.execute('SELECT * FROM evaluations ORDER BY created_at DESC, id DESC').fetchall()
    evaluations = []
    for row in rows:
        ev = evaluator.payload(row)
        ev['source_label'] = _source_label(conn, ev['source'], user)
        if ev['breakdown']:
            per_dataset = []
            for job_id, scores in sorted(ev['breakdown'].items()):
                row_job = conn.execute('SELECT name FROM jobs WHERE id = ?', (job_id,)).fetchone()
                accessible = row_job is not None and can_access_job(conn, job_id, user)
                per_dataset.append({'job_id': job_id,
                                    'name': row_job['name'] if accessible else 'another dataset',
                                    **scores})
            ev['breakdown'] = per_dataset
        evaluations.append(ev)
    return {'evaluations': evaluations}


class EvaluationCreate(BaseModel):
    model_id: int
    job_ids: list[str]
    decode: str = decode_modes.DEFAULT_DECODE
    # 'test' scores the test pages only, 'all' every page; left out, the test pages when
    # any of the datasets has some.
    pages: Literal['test', 'all'] | None = None


@router.post('/api/evaluations')
def create_evaluation(body: EvaluationCreate, conn=Depends(get_db),
                      user: dict = Depends(require_role('admin', 'member'))):
    """Score a model against a dataset's reviewed lines or a training's frozen split."""
    model = registry.get_model(conn, body.model_id)
    if model is None:
        raise HTTPException(404, 'model not found')
    if model['task'] != 'ocr':
        raise HTTPException(400, 'only OCR models can be evaluated for now')
    if body.decode not in decode_modes.OCR_DECODES:
        raise HTTPException(400, f'decode must be one of {", ".join(decode_modes.OCR_DECODES)}')
    if not body.job_ids:
        raise HTTPException(400, 'select at least one dataset')
    for job_id in body.job_ids:
        require_job_access(conn, job_id, user)
        if store.get_job(conn, job_id) is None:
            raise HTTPException(404, f'dataset {job_id} not found')
    test_pages = body.pages == 'test' or (body.pages is None and _have_test_pages(conn, body.job_ids))
    if test_pages:
        counts = trainer.eligible_counts(conn, 'ocr', body.job_ids, pages='test')
        if sum(counts.values()) == 0:
            raise HTTPException(400, 'the test pages of the selected datasets contain no checked lines')
    elif sum(trainer.eligible_counts(conn, 'ocr', body.job_ids, pages='all').values()) == 0:
        raise HTTPException(400, 'the selected datasets contain no checked lines')
    source = {'jobs': body.job_ids, **({'test_pages': True} if test_pages else {})}
    eval_id = evaluator.create(conn, body.model_id, source, body.decode, user['username'])
    return evaluator.payload(
        conn.execute('SELECT * FROM evaluations WHERE id = ?', (eval_id,)).fetchone())


def _have_test_pages(conn, job_ids: list[str]) -> bool:
    marks = ', '.join('?' * len(job_ids))
    return conn.execute(f'SELECT 1 FROM pages WHERE job_id IN ({marks}) AND is_test = 1 AND deleted = 0 LIMIT 1',
                        job_ids).fetchone() is not None


@router.post('/api/evaluations/{eval_id}/retry')
def retry_evaluation(eval_id: int, conn=Depends(get_db), user: dict = Depends(current_user)):
    """Queue a failed evaluation again, in place. What kills one is usually the machine
    around it rather than the material, so the row is reused instead of piling a second
    one up beside it."""
    evaluation = evaluator.get_evaluation(conn, eval_id)
    if evaluation is None:
        raise HTTPException(404)
    if user['role'] != 'admin' and evaluation['owner'] != user['username']:
        raise HTTPException(403, 'not permitted')
    if evaluation['status'] not in ('error', 'cancelled'):
        raise HTTPException(409, 'only a failed or cancelled evaluation can be retried')
    snapshot = json.loads(evaluation['source'] or '{}').get('snapshot')
    if snapshot is not None and not (config.training_dir(snapshot) / 'snapshot' / 'valid').is_dir():
        raise HTTPException(409, 'the frozen split it scored on is gone')
    evaluator.set_state(conn, eval_id, status='queued', error=None, pid=None)
    return evaluator.payload(
        conn.execute('SELECT * FROM evaluations WHERE id = ?', (eval_id,)).fetchone())


@router.post('/api/evaluations/{eval_id}/cancel')
def cancel_evaluation(eval_id: int, conn=Depends(get_db), user: dict = Depends(current_user)):
    """Stop a queued or running evaluation. Its row stays, without scores, for a retry."""
    evaluation = _evaluation_or_404(conn, eval_id)
    if user['role'] != 'admin' and evaluation['owner'] != user['username']:
        raise HTTPException(403, 'not permitted')
    if not evaluator.cancel(conn, eval_id):
        raise HTTPException(409, f'this evaluation is already {evaluation["status"]} - '
                                 'only a queued or running one can be cancelled')
    return {'ok': True}


def _evaluation_or_404(conn, eval_id: int) -> dict:
    evaluation = evaluator.get_evaluation(conn, eval_id)
    if evaluation is None:
        raise HTTPException(404)
    return evaluation


def _visible_jobs(conn, eval_id: int, user: dict) -> list[str] | None:
    """The datasets whose lines this viewer may read (None: every line, for an admin, even
    of a dataset deleted since). The rest stay out of every figure."""
    if user['role'] == 'admin':
        return None
    return [job_id for job_id in eval_lines.job_ids(conn, eval_id)
            if can_access_job(conn, job_id, user)]


def _job_names(conn, job_ids) -> dict[str, str]:
    return {r['id']: r['name'] for r in conn.execute(
        f'SELECT id, name FROM jobs WHERE id IN ({", ".join("?" * len(job_ids))})', list(job_ids))}


@router.get('/api/evaluations/{eval_id}')
def get_evaluation(eval_id: int, conn=Depends(get_db), user: dict = Depends(current_user)):
    """One evaluation for its page: what was scored, by which model, the other decodes the
    same model was scored with on the same material, and how many of its lines this viewer
    may see."""
    ev = evaluator.payload(_evaluation_or_404(conn, eval_id))
    ev['source_label'] = _source_label(conn, ev['source'], user)
    model = registry.get_model(conn, ev['model_id'])
    ev['model_name'] = model['name'] if model else None
    training = conn.execute('SELECT name FROM trainings WHERE id = ?',
                            (ev['training_id'],)).fetchone() if ev['training_id'] else None
    ev['training_name'] = training['name'] if training else None
    siblings = conn.execute(
        "SELECT id, decode FROM evaluations WHERE model_id = ? AND source = ? "
        "AND training_id IS ? AND (status = 'done' OR id = ?) ORDER BY id DESC",
        (ev['model_id'], json.dumps(ev['source']), ev['training_id'], eval_id)).fetchall()
    newest = {}
    for row in siblings:
        newest.setdefault(row['decode'], row['id'])
    newest[ev['decode']] = eval_id
    ev['decodes'] = [{'decode': mode, 'evaluation_id': newest[mode]}
                     for mode in decode_modes.OCR_DECODES if mode in newest]
    jobs = _visible_jobs(conn, eval_id, user)
    scored = eval_lines.job_ids(conn, eval_id) if jobs is None else jobs
    names = _job_names(conn, scored)
    ev['datasets'] = [{'job_id': job_id, 'name': names[job_id]}
                      for job_id in scored if job_id in names]
    ev['line_rows'] = eval_lines.count(conn, eval_id, jobs)
    ev['hidden_lines'] = eval_lines.count(conn, eval_id) - ev['line_rows']
    ev.pop('breakdown', None)
    return ev


# Keyed by the newest row id and the import generation, so nothing stale is served.
SUMMARY_CACHE_SIZE = 8
_summaries: OrderedDict[tuple, dict] = OrderedDict()
_summaries_lock = threading.Lock()


def _line_figures(conn, evaluation: dict, jobs: list[str] | None) -> dict:
    eval_id = evaluation['id']
    stamp = conn.execute('SELECT MAX(rowid) FROM eval_lines WHERE evaluation_id = ?',
                         (eval_id,)).fetchone()[0]
    key = (caches.db_key(conn), eval_id, None if jobs is None else tuple(jobs), stamp,
           eval_lines.generation(eval_id))
    with _summaries_lock:
        held = _summaries.get(key)
        if held is not None:
            _summaries.move_to_end(key)
            return held
    rows = eval_lines.scored_rows(conn, eval_id, jobs)
    train = preflight.train_counts(conn, evaluation['model_id'])
    figures = {
        'headline': eval_metrics.headline(rows),
        'confusions': eval_metrics.confusions(rows),
        'characters': eval_metrics.characters(rows),
        'by_length': eval_metrics.by_length(rows),
        'by_dataset': eval_metrics.grouped(rows, 'job_id'),
        'by_page': eval_metrics.grouped(rows, 'page_id'),
        'calibration': eval_metrics.calibration(rows),
        'train_known': train is not None,
        'frequency': eval_metrics.frequency(rows, train),
    }
    with _summaries_lock:
        _summaries[key] = figures
        while len(_summaries) > SUMMARY_CACHE_SIZE:
            _summaries.popitem(last=False)
    return figures


@router.get('/api/evaluations/{eval_id}/summary')
def evaluation_summary(eval_id: int, conn=Depends(get_db), user: dict = Depends(current_user)):
    """Every figure on the evaluation page beyond the lines themselves, computed from the
    lines this viewer may see."""
    evaluation = _evaluation_or_404(conn, eval_id)
    jobs = _visible_jobs(conn, eval_id, user)
    figures = _line_figures(conn, evaluation, jobs)
    names = _job_names(conn, [g['key'] for g in figures['by_dataset']])
    pages = {r['id']: dict(r) for r in conn.execute(
        'SELECT id, filename, idx, job_id FROM pages WHERE id IN '
        '(SELECT DISTINCT page_id FROM eval_lines WHERE evaluation_id = ?)', (eval_id,))}
    return {
        **figures,
        'by_dataset': [{**g, 'name': names.get(g['key'], 'another dataset')}
                       for g in figures['by_dataset']],
        'by_page': [{**g, 'filename': pages.get(g['key'], {}).get('filename'),
                     'page_idx': pages.get(g['key'], {}).get('idx'),
                     'job_id': pages.get(g['key'], {}).get('job_id')}
                    for g in figures['by_page']],
    }


def _line_filter(cer_min: float | None = None, cer_max: float | None = None,
                 job_id: str | None = None, q: str | None = None) -> eval_lines.LineFilter:
    return eval_lines.LineFilter(cer_min=cer_min, cer_max=cer_max, job_id=job_id or None,
                                 q=q or None)


@router.get('/api/evaluations/{eval_id}/lines')
def evaluation_lines(eval_id: int, sort: Literal['cer', 'confidence', 'length', 'line'] = 'cer',
                     order: Literal['asc', 'desc'] = 'desc', offset: int = Query(0, ge=0),
                     limit: int = Query(50, ge=1, le=500),
                     flt: eval_lines.LineFilter = Depends(_line_filter),
                     conn=Depends(get_db), user: dict = Depends(current_user)):
    """The scored lines a page at a time, sorted, filtered and searched on the server."""
    _evaluation_or_404(conn, eval_id)
    return eval_lines.page(conn, eval_id, _visible_jobs(conn, eval_id, user), flt,
                           sort, order, offset, limit)


class ReviewFilter(BaseModel):
    cer_min: float | None = None
    cer_max: float | None = None
    job_id: str | None = None
    q: str | None = None


@router.post('/api/evaluations/{eval_id}/review')
def send_to_review(eval_id: int, body: ReviewFilter, conn=Depends(get_db),
                   user: dict = Depends(require_role('admin', 'member'))):
    """Flag every line in the filter for its dataset's review queue."""
    _evaluation_or_404(conn, eval_id)
    flagged = eval_lines.flag_for_review(
        conn, eval_id, _visible_jobs(conn, eval_id, user), _line_filter(**body.model_dump()),
        user['username'])
    per_job: dict[str, dict] = {}
    for line in flagged:
        entry = per_job.setdefault(line['job_id'], {'job_id': line['job_id'], 'lines': 0,
                                                    'page_id': line['page_id']})
        entry['lines'] += 1
    names = _job_names(conn, per_job)
    return {'flagged': len(flagged),
            'jobs': [{'job_id': j['job_id'], 'name': names.get(j['job_id']), 'lines': j['lines'],
                      'page_id': j['page_id']} for j in per_job.values()]}
