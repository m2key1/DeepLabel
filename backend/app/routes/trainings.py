import json
import threading

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app import (augmentations, backend_client, config, line_shapes, preflight, registry, remote_training,
                 slurm_session, store, trainer, tunables)
from app.deps import can_access_job, current_user, get_db, require_job_access, require_role

router = APIRouter(tags=['training'])


def _is_admin(user: dict) -> bool:
    return user.get('role') == 'admin'


def _can_cluster(user: dict) -> bool:
    """Admins always may; everyone else needs the grant an admin sets per person."""
    return _is_admin(user) or bool(user.get('train_cluster'))


def _can_train_local(user: dict) -> bool:
    """The local GPU is one card the whole instance shares, so using it is a grant of its
    own - independent of the cluster, which costs an allocation instead of everyone's queue."""
    return _is_admin(user) or bool(user.get('train_local'))


def _require_training_grant(user: dict, target: str) -> None:
    """Asked again on every retry, not only at creation: a grant an admin takes away
    must keep a failed run off the GPU or the cluster too."""
    if target == 'slurm' and not _can_cluster(user):
        raise HTTPException(403, 'you do not have cluster access - ask an admin to grant it')
    if target == 'local' and not _can_train_local(user):
        raise HTTPException(403, 'you may not train on the local GPU - ask an admin to grant it')


@router.get('/api/slurm/accounts')
def cluster_accounts(_admin: dict = Depends(require_role('admin'))):
    """The accounts the cluster login may charge to, for the Admin page's picker. Empty
    when the cluster is unconfigured or locked, which the page shows as a free-text field."""
    return {'accounts': trainer.cluster_accounts()}


@router.get('/api/slurm/session')
def cluster_session(user: dict = Depends(current_user)):
    """Whether the shared cluster ssh session is currently open."""
    if not _can_cluster(user):
        raise HTTPException(403, 'not permitted')
    return slurm_session.status()


@router.post('/api/slurm/session')
def open_cluster_session(_admin: dict = Depends(require_role('admin'))):
    """Start the unlock. Returns the cluster's own prompt for the UI to relay, or
    reports the session connected when no second factor was asked for."""
    try:
        return slurm_session.start()
    except slurm_session.SessionError as e:
        raise HTTPException(400, str(e))


class ClusterCode(BaseModel):
    session_id: str
    code: str


@router.post('/api/slurm/session/answer')
def answer_cluster_session(body: ClusterCode, _admin: dict = Depends(require_role('admin'))):
    """Answer the cluster's second-factor prompt to finish the login."""
    try:
        return slurm_session.answer(body.session_id, body.code)
    except slurm_session.SessionError as e:
        raise HTTPException(400, str(e))


@router.delete('/api/slurm/session')
def close_cluster_session(_admin: dict = Depends(require_role('admin'))):
    """Close the shared cluster ssh session."""
    return {'closed': slurm_session.disconnect()}


@router.get('/api/trainings')
def list_trainings(conn=Depends(get_db), user: dict = Depends(current_user)):
    """Training runs, the targets this caller may use, and cluster reachability."""
    rows = conn.execute('SELECT * FROM trainings ORDER BY created_at DESC').fetchall()
    return {'trainings': [trainer.training_payload(r) for r in rows],
            # The cluster is a shared, admin-owned resource: its jobs run under one
            # account, spend one allocation, and share the unlocked ssh session.
            'targets': {'local': _can_train_local(user),
                        'slurm': trainer.slurm_available() and _can_cluster(user)},
            # Only meaningful to whoever can act on it. Granted users see the state so a
            # refused submit explains itself; opening the session stays admin-only, because
            # answering the cluster's second factor needs the admin's own code.
            'cluster': ({'reachable': trainer.cluster_reachable()}
                        if trainer.slurm_available() and _can_cluster(user) else None),
            'gpu_types': trainer.GPU_TYPES,
            'trainable_tasks': list(trainer.TRAINABLE_TASKS)}


class PreviewRequest(BaseModel):
    task: str
    job_ids: list[str] = []
    test_job_ids: list[str] = []


# A read, but a POST: the dialog opens by previewing every dataset there is, and past
# 626 of them that many ids no longer fit in a request line a proxy will accept.
@router.post('/api/trainings/preview')
def preview(body: PreviewRequest, conn=Depends(get_db), user: dict = Depends(current_user)):
    """How much reviewed material the chosen datasets would contribute to a training,
    and - when a test dataset is named - how many of its pages also sit in the
    training selection, which would inflate its score."""
    task = body.task
    if task not in registry.TASKS:
        raise HTTPException(400, f'task must be one of {registry.TASKS}')
    ids, test_ids = body.job_ids, body.test_job_ids
    for job_id in ids + test_ids:
        require_job_access(conn, job_id, user)
    # Besides the totals, what language models settled among themselves - a run may leave
    # it out and train only on what a person verified.
    payload = trainer.preview_counts(conn, task, ids)
    if test_ids and ids:
        marks_test = ','.join('?' * len(test_ids))
        marks_train = ','.join('?' * len(ids))
        payload['test_overlap_pages'] = conn.execute(
            'SELECT COUNT(DISTINCT a.content_hash) n FROM pages a '
            'JOIN pages b ON a.content_hash = b.content_hash '
            f'WHERE a.job_id IN ({marks_test}) AND b.job_id IN ({marks_train}) '
            'AND a.deleted = 0 AND b.deleted = 0 AND a.content_hash IS NOT NULL',
            (*test_ids, *ids)).fetchone()['n']
    return payload


def _trained_on(conn, task: str, base_model_id: int | None):
    """(client, its train declaration) of the model backend a run would train on. A run
    no backend can train answers 400 with why."""
    try:
        client = remote_training.training_backend(conn, {'task': task, 'base_model_id': base_model_id})
    except remote_training.CannotTrain as error:
        raise HTTPException(400, str(error)) from None
    except backend_client.BackendError as error:
        raise HTTPException(502, error.message) from None
    return client, client.info()['train']


@router.get('/api/trainings/options')
def training_options(task: str, base_model_id: int | None = None, conn=Depends(get_db),
                     _user: dict = Depends(current_user)):
    """The knobs a run of this task may tune on the model backend it would train on, each
    with the default that backend declares, so the dialog's placeholders are what an
    untuned run actually uses."""
    if task not in trainer.TRAINABLE_TASKS:
        raise HTTPException(400, f'task must be one of {", ".join(trainer.TRAINABLE_TASKS)}')
    client, train = _trained_on(conn, task, base_model_id)

    def batch(target: str, gpu: str | None = None) -> int:
        return trainer.run_scaling(conn, task, target, gpu, 1, base_model_id, None)['batch_size']

    resources = train.get('resources') or {}
    # The cheapest card that holds the model, which the form starts on; one the cluster
    # does not offer is no default.
    preferred = resources.get('preferred_gpu')
    return {**tunables.declared_options(train, client.backend.name), 'backend': client.backend.name,
            'builds_lm': task == 'ocr' and _builds_lm(train),
            'line_shape': trainer.line_shape_for(conn, task, base_model_id),
            'batch': {'local': batch('local'), 'cluster': {gpu: batch('slurm', gpu) for gpu in trainer.GPU_TYPES}},
            'effective_batch': resources.get('effective_batch'),
            'preferred_gpu': preferred if preferred in trainer.GPU_TYPES else None}


def _builds_lm(train: dict) -> bool:
    return 'lm' in (train.get('outputs') or [])


class TrainingCreate(BaseModel):
    task: str
    name: str
    dataset_job_ids: list[str]
    base_model_id: int | None = None
    target: str = 'local'
    description: str | None = None
    epochs: int | None = None
    batch_size: int | None = None
    gpu_type: str | None = None
    gpu_count: int | None = None
    hyperparams: dict[str, bool | int | float | str] = {}
    val_fraction: float = 0.1
    split_strategy: str = 'uniform'
    valid_job_ids: list[str] = []
    test_job_ids: list[str] = []
    # Fit a KenLM to this run's own ground truth instead of inheriting the base's.
    build_lm: bool = False
    # Leave out lines that language models settled among themselves, training only on what
    # a person verified.
    human_checked_only: bool = False
    # The augmentation stack to train with, either by naming a pipeline the caller can
    # see or as a spec built for this run. Neither leaves the train module on its own
    # stack; a spec with no steps trains on clean crops.
    augmentation_pipeline_id: int | None = None
    augmentation: dict | None = None
    # The pre-flight the form showed. Kept with the run when it was computed for these
    # very settings; otherwise the run gets one of its own.
    preflight_id: int | None = None
    # What a lines run trains each line as; unset takes the model's default (line_shapes).
    line_shape: str | None = None


class PreflightCreate(TrainingCreate):
    name: str = ''


def _preflight_request(body: TrainingCreate) -> dict:
    """The settings a pre-flight is computed for: the whole training body, less what
    only labels the run."""
    return body.model_dump(exclude={'name', 'description', 'preflight_id'})


def _dataset_names(conn, job_ids, user: dict) -> tuple[dict[str, str], set[str]]:
    """Each dataset's name, and which of them the caller cannot open - named only as
    another dataset, so a run's material does not hand over what its reader may not see."""
    names, hidden = {}, set()
    for job_id in sorted(set(job_ids)):
        row = conn.execute('SELECT name FROM jobs WHERE id = ?', (job_id,)).fetchone()
        if row is not None and can_access_job(conn, job_id, user):
            names[job_id] = row['name']
        else:
            names[job_id] = 'another dataset'
            hidden.add(job_id)
    return names, hidden


def _preflight_payload(conn, found: dict, user: dict) -> dict:
    """A pre-flight as its reader may see it: dataset names resolved, and redacted - with
    the lines it points at - for datasets the caller cannot open."""
    result = found['result']
    names, hidden = _dataset_names(conn, preflight.job_order(found['request']), user)
    if result is not None:
        for section in (result.get('crops') or {}, result.get('text') or {}):
            for entry in section.values():
                if not isinstance(entry, dict):
                    continue
                for listed in (entry, *entry.get('bins', [])):
                    if 'examples' in listed:
                        listed['examples'] = [e for e in listed['examples'] if e['job_id'] not in hidden]
        for duplicate in result['split']['duplicates']:
            duplicate['pages'] = [p for p in duplicate['pages'] if p['job_id'] not in hidden]
    return {'id': found['id'], 'status': found['status'], 'error': found['error'],
            'created_at': found['created_at'], 'result': result, 'datasets': names}


@router.post('/api/trainings/preflights')
def create_preflight(body: PreflightCreate, conn=Depends(get_db),
                     user: dict = Depends(require_role('admin', 'member'))):
    """Start reviewing the material a training with these settings would be cut from.
    Answers at once; the review is computed in the background and polled."""
    _validate_settings(conn, body, user)
    preflight_id = preflight.begin(conn, user['username'], _preflight_request(body))
    return {'id': preflight_id, 'status': 'running'}


@router.get('/api/trainings/preflights/{preflight_id}')
def get_preflight(preflight_id: int, conn=Depends(get_db), user: dict = Depends(current_user)):
    """A pre-flight its requester polls until it is done."""
    found = preflight.get(conn, preflight_id)
    if found is None or (found['owner'] != user['username'] and not _is_admin(user)):
        raise HTTPException(404)
    return _preflight_payload(conn, found, user)


@router.get('/api/trainings/{training_id}/preflight')
def training_preflight(training_id: int, conn=Depends(get_db), user: dict = Depends(current_user)):
    """The pre-flight a run was started with, for its page."""
    training = trainer.get_training(conn, training_id)
    if training is None or training.get('preflight_id') is None:
        raise HTTPException(404)
    found = preflight.get(conn, training['preflight_id'])
    if found is None:
        raise HTTPException(404)
    return _preflight_payload(conn, found, user)


def _augmentation_for(conn, body: 'TrainingCreate', user: dict) -> tuple[dict | None, str]:
    """The stack a run will train with, frozen now: the named pipeline's steps as they
    stand today, or the spec built for this run alone. Returns (None, '') for a run that
    leaves the train module on its own stack."""
    if body.augmentation_pipeline_id is not None and body.augmentation is not None:
        raise HTTPException(400, 'name a pipeline or give a stack, not both')
    if body.augmentation_pipeline_id is not None:
        pipeline = augmentations.get_pipeline(conn, body.augmentation_pipeline_id)
        if pipeline is None or not augmentations.visible_to(pipeline, user):
            raise HTTPException(404, 'augmentation pipeline not found')
        if pipeline['task'] != body.task:
            raise HTTPException(400, 'the augmentation pipeline belongs to another task')
        return json.loads(pipeline['spec']), pipeline['name']
    if body.augmentation is None:
        return None, ''
    try:
        error = augmentations.check_spec(body.augmentation, body.task)
    except augmentations.NoTrainer as exc:
        raise HTTPException(503, f'the augmentation stack could not be checked: {exc}')
    if error:
        raise HTTPException(400, error)
    return body.augmentation, ''


def _refuse_archived_base(base: dict | None) -> None:
    if base is not None and base['archived']:
        raise HTTPException(409, f"base model {base['name']} is archived - unarchive it first")


def _validate_settings(conn, body: TrainingCreate, user: dict) -> dict:
    """Everything a run's settings must satisfy before material is cut or reviewed for
    them, shared by the submit and its pre-flight. Returns the validated hyperparameters."""
    if body.task not in registry.TASKS:
        raise HTTPException(400, f'task must be one of {registry.TASKS}')
    if body.task not in trainer.TRAINABLE_TASKS:
        raise HTTPException(400, f'{body.task} training is coming soon - only '
                                 f'{", ".join(trainer.TRAINABLE_TASKS)} can be trained for now')
    if not body.dataset_job_ids:
        raise HTTPException(400, 'select at least one dataset')
    for job_id in body.dataset_job_ids:
        require_job_access(conn, job_id, user)
        if store.get_job(conn, job_id) is None:
            raise HTTPException(404, f'dataset {job_id} not found')
    if body.base_model_id is not None:
        base = registry.get_model(conn, body.base_model_id)
        if base is None or base['task'] != body.task:
            raise HTTPException(400, 'base model must be an existing model of the same task')
        _refuse_archived_base(base)
    if body.target not in ('local', 'slurm'):
        raise HTTPException(400, 'target must be local or slurm')
    _require_training_grant(user, body.target)
    if body.target == 'slurm' and not trainer.slurm_available():
        raise HTTPException(409, 'no SLURM cluster is configured')
    if body.epochs is not None and body.epochs < 1:
        raise HTTPException(400, 'epochs must be at least 1')
    if body.batch_size is not None and body.batch_size < 1:
        raise HTTPException(400, 'batch_size must be at least 1')
    if body.gpu_type is not None:
        if body.target != 'slurm':
            raise HTTPException(400, 'gpu_type only applies to SLURM trainings')
        if body.gpu_type not in trainer.GPU_TYPES:
            raise HTTPException(400, f'gpu_type must be one of {sorted(trainer.GPU_TYPES)}')
        limit = trainer.gpu_limit(body.task, body.gpu_type)
        if body.gpu_count is None or not 1 <= body.gpu_count <= limit:
            reason = (f' for {body.gpu_type}' if body.task in trainer.MULTI_GPU_TASKS
                      else f': {body.task} training runs on one card')
            raise HTTPException(400, f'gpu_count must be between 1 and {limit}{reason}')
    elif body.gpu_count is not None:
        raise HTTPException(400, 'gpu_count needs a gpu_type')
    client, train = _trained_on(conn, body.task, body.base_model_id)
    if body.line_shape is not None:
        if body.task != 'lines':
            raise HTTPException(400, 'line_shape only applies to a lines run')
        if body.line_shape not in line_shapes.LINE_SHAPES:
            raise HTTPException(400, f'line_shape must be one of {", ".join(line_shapes.LINE_SHAPES)}')
    if body.build_lm and body.task != 'ocr':
        raise HTTPException(400, 'a language model is only fitted for an OCR run')
    if body.build_lm and not _builds_lm(train):
        raise HTTPException(400, f'model backend "{client.backend.name}" builds no language model')
    try:
        hyperparams = tunables.validate(body.hyperparams, tunables.declared(train))
    except tunables.TunableError as e:
        raise HTTPException(400, str(e))
    if body.split_strategy not in ('uniform', 'stratified', 'holdout'):
        raise HTTPException(400, 'split_strategy must be uniform, stratified, or holdout')
    if body.split_strategy == 'holdout':
        if not body.valid_job_ids:
            raise HTTPException(400, 'holdout needs at least one validation dataset')
        overlap = set(body.valid_job_ids) & set(body.dataset_job_ids)
        if overlap:
            raise HTTPException(400, 'validation datasets must not also be training datasets')
        for job_id in body.valid_job_ids:
            require_job_access(conn, job_id, user)
            if store.get_job(conn, job_id) is None:
                raise HTTPException(404, f'dataset {job_id} not found')
        valid_counts = trainer.eligible_counts(conn, body.task, body.valid_job_ids,
                                               body.human_checked_only)
        if sum(valid_counts.values()) == 0:
            raise HTTPException(400, 'the validation datasets contain no checked material for this task')
    else:
        if body.valid_job_ids:
            raise HTTPException(400, 'valid_job_ids only applies to the holdout strategy')
        if not 0.0 < body.val_fraction <= 0.5:
            raise HTTPException(400, 'val_fraction must be between 0 and 0.5')
    if set(body.test_job_ids) & set(body.dataset_job_ids):
        raise HTTPException(400, 'test datasets must not also be training datasets')
    for job_id in body.test_job_ids:
        require_job_access(conn, job_id, user)
        if store.get_job(conn, job_id) is None:
            raise HTTPException(404, f'dataset {job_id} not found')
    if body.test_job_ids:
        test_counts = trainer.eligible_counts(conn, body.task, body.test_job_ids,
                                              body.human_checked_only)
        if sum(test_counts.values()) == 0:
            raise HTTPException(400, 'the test datasets contain no checked material for this task')
    counts = trainer.eligible_counts(conn, body.task, body.dataset_job_ids,
                                     body.human_checked_only)
    if sum(counts.values()) == 0:
        raise HTTPException(400, 'the selected datasets contain no checked material for this task')
    return hyperparams


@router.post('/api/trainings')
def create_training(body: TrainingCreate, conn=Depends(get_db),
                    user: dict = Depends(require_role('admin', 'member'))):
    """Start a training run on the local GPU or the cluster."""
    hyperparams = _validate_settings(conn, body, user)
    name = body.name.strip()
    if not name:
        raise HTTPException(400, 'name must not be empty')
    clash = registry.name_clash(conn, body.task, name)
    if clash:
        raise HTTPException(409, clash)
    scaling = trainer.run_scaling(conn, body.task, body.target, body.gpu_type, body.gpu_count,
                                  body.base_model_id, body.batch_size, body.hyperparams)
    augmentation, augmentation_name = _augmentation_for(conn, body, user)
    settings = _preflight_request(body)
    preflight_id = (preflight.adopt(conn, body.preflight_id, user['username'], settings)
                    or preflight.begin(conn, user['username'], settings, kept=True))

    cur = conn.execute(
        'INSERT INTO trainings (task, name, owner, base_model_id, target, dataset_job_ids, '
        'description, epochs, batch_size, gpu_type, gpu_count, hyperparams, val_fraction, '
        'split_strategy, valid_job_ids, test_job_ids, build_lm, human_checked_only, '
        'slurm_account, augmentation, augmentation_name, preflight_id, grad_accum_steps, lr_scale, line_shape) '
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        (body.task, name, user['username'], body.base_model_id, body.target,
         json.dumps(body.dataset_job_ids), (body.description or '').strip() or None,
         body.epochs, scaling['batch_size'], body.gpu_type, body.gpu_count,
         json.dumps(hyperparams), body.val_fraction,
         body.split_strategy, json.dumps(body.valid_job_ids), json.dumps(body.test_job_ids),
         int(body.build_lm), int(body.human_checked_only), user.get('slurm_account') or '',
         json.dumps(augmentation) if augmentation is not None else None, augmentation_name,
         preflight_id, scaling['grad_accum_steps'], scaling['lr_scale'],
         trainer.line_shape_for(conn, body.task, body.base_model_id, body.line_shape)))
    conn.commit()
    training_id = cur.lastrowid
    # Local runs wait in the shared GPU queue; SLURM submissions leave immediately.
    if body.target == 'slurm':
        threading.Thread(target=_submit_slurm_bg, args=(training_id,), daemon=True).start()
    return trainer.training_payload(
        conn.execute('SELECT * FROM trainings WHERE id = ?', (training_id,)).fetchone())


def _submit_slurm_bg(training_id: int, attempt: int | None = None):
    conn = store.connect(config.DB_PATH)
    try:
        trainer.submit_slurm(conn, training_id, attempt)
    finally:
        conn.close()


@router.get('/api/trainings/{training_id}/progress')
def training_progress(training_id: int, conn=Depends(get_db), user: dict = Depends(current_user)):
    """Loss and CER points plus the tail of the run's log. Points may carry a
    cer_by_dataset map keyed by job id; `datasets` resolves those ids to names,
    redacted for datasets the caller cannot open. The log itself is the owner's: it
    carries those same names and the paths under them, which redacting the map beside
    it would otherwise hand over anyway."""
    training = trainer.get_training(conn, training_id)
    if training is None:
        raise HTTPException(404)
    progress_file = config.training_dir(training_id) / 'output' / trainer.PROGRESS_NAME
    points = trainer.parse_progress(progress_file)
    # File mtime, so the chart can say how fresh the last point is even when the
    # trainer emits no timestamps of its own.
    updated_at = progress_file.stat().st_mtime if progress_file.is_file() else None
    ids = [job_id for field in ('dataset_job_ids', 'valid_job_ids', 'test_job_ids')
           for job_id in json.loads(training.get(field) or '[]')]
    datasets, _hidden = _dataset_names(conn, ids, user)
    mine = user['role'] == 'admin' or training['owner'] == user['username']
    return {'points': points, 'log_tail': trainer.read_log_tail(training) if mine else '',
            'updated_at': updated_at, 'datasets': datasets}


@router.delete('/api/trainings/{training_id}')
def delete_training(training_id: int, conn=Depends(get_db), user: dict = Depends(current_user)):
    """Delete a finished training and its artefacts."""
    training = trainer.get_training(conn, training_id)
    if training is None:
        raise HTTPException(404)
    if user['role'] != 'admin' and training['owner'] != user['username']:
        raise HTTPException(403, 'not permitted')
    if training['status'] not in ('done', 'error', 'cancelled'):
        raise HTTPException(409, 'cancel the training before deleting it')
    if training.get('model_id'):
        model = registry.get_model(conn, training['model_id'])
        if model and not model['archived']:
            raise HTTPException(409, 'archive the model first - its checkpoint lives in this training')
    trainer.delete(conn, training)
    return {'ok': True}


@router.post('/api/trainings/{training_id}/retry')
def retry_training(training_id: int, conn=Depends(get_db), user: dict = Depends(current_user)):
    """Submit a failed run again. A cluster submit dies on a closed session before the
    job exists, and the snapshot it already cut is frozen material worth keeping - so
    the run resumes from where it stopped instead of being recreated from scratch."""
    training = trainer.get_training(conn, training_id)
    if training is None:
        raise HTTPException(404)
    if user['role'] != 'admin' and training['owner'] != user['username']:
        raise HTTPException(403, 'not permitted')
    _require_training_grant(user, training['target'])
    if training['status'] != 'error':
        raise HTTPException(409, 'only a failed training can be retried')
    # Failing freed the name; a model registered under it since would be joined by a
    # second one when this run finishes, the pair a new run under the name is refused for.
    clash = registry.name_clash(conn, training['task'], training['name'])
    if clash:
        current = trainer.get_training(conn, training_id)
        if current is None:
            raise HTTPException(404)
        still_failed = current['status'] == 'error'
        # A run queued under the name may be this one, taken by a concurrent retry's claim.
        if still_failed:
            raise HTTPException(409, clash)
    if training['base_model_id'] is not None:
        _refuse_archived_base(registry.get_model(conn, training['base_model_id']))
    if training['target'] == 'slurm' and not trainer.slurm_available():
        raise HTTPException(409, 'no cluster is configured')
    # Claimed rather than simply set: two retries arriving together would otherwise each
    # start a transfer of the same snapshot to the same place.
    attempt = trainer.claim_retry(conn, training_id)
    if attempt is None:
        raise HTTPException(409, 'this run is already being retried')
    if training['target'] == 'slurm':
        threading.Thread(target=_submit_slurm_bg, args=(training_id, attempt), daemon=True).start()
    return trainer.training_payload(
        conn.execute('SELECT * FROM trainings WHERE id = ?', (training_id,)).fetchone())


@router.post('/api/trainings/{training_id}/cancel')
def cancel_training(training_id: int, conn=Depends(get_db), user: dict = Depends(current_user)):
    """Cancel a queued or running training."""
    training = trainer.get_training(conn, training_id)
    if training is None:
        raise HTTPException(404)
    if user['role'] != 'admin' and training['owner'] != user['username']:
        raise HTTPException(403, 'not permitted')
    if not trainer.cancel(conn, training_id):
        raise HTTPException(409, f'this training is already {training["status"]} - '
                                 'only a queued or running one can be cancelled')
    return {'ok': True}
