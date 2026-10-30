import json

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app import augmentations, registry, trainer
from app.deps import current_user, get_db, require_job_access, require_role

router = APIRouter(tags=['augmentations'])


@router.get('/api/augmentations/catalog')
def augmentation_catalog(task: str = 'ocr', _user: dict = Depends(current_user)):
    """Every transform the task's trainer offers, with its parameters classified for the
    builder, plus the group types a pipeline may nest."""
    if task not in registry.TASKS:
        raise HTTPException(400, f'task must be one of {registry.TASKS}')
    return augmentations.catalog(task).payload()


@router.get('/api/augmentations/pipelines')
def list_pipelines(task: str, conn=Depends(get_db), user: dict = Depends(current_user)):
    """The caller's own pipelines for a task plus the task's default, and the stack the
    train module falls back to when no pipeline is chosen."""
    if task not in registry.TASKS:
        raise HTTPException(400, f'task must be one of {registry.TASKS}')
    return {'pipelines': augmentations.list_pipelines(conn, task, user),
            'builtin': augmentations.builtin_spec(task)}


class PipelineCreate(BaseModel):
    task: str
    name: str
    spec: dict


def _clean_name(name: str) -> str:
    name = name.strip()
    if not name:
        raise HTTPException(400, 'name must not be empty')
    if len(name) > augmentations.MAX_NAME_LENGTH:
        raise HTTPException(400, f'name must be at most {augmentations.MAX_NAME_LENGTH} characters')
    return name


def _checked_spec(spec: dict, task: str) -> dict:
    try:
        error = augmentations.check_spec(spec, task)
    except augmentations.NoTrainer as exc:
        raise HTTPException(503, f'the pipeline could not be checked: {exc}')
    if error:
        raise HTTPException(400, error)
    return spec


def _owned(conn, pipeline_id: int, user: dict) -> dict:
    """404 for what the caller cannot see, 403 for what they can see but not touch."""
    pipeline = augmentations.get_pipeline(conn, pipeline_id)
    if pipeline is None or not augmentations.visible_to(pipeline, user):
        raise HTTPException(404)
    if pipeline['owner'] != user['username']:
        raise HTTPException(403, 'only the owner can change this pipeline')
    return pipeline


def _row(conn, pipeline_id: int, user: dict) -> dict:
    return augmentations.pipeline_payload(
        conn.execute('SELECT * FROM augmentation_pipelines WHERE id = ?', (pipeline_id,)).fetchone(), user)


@router.post('/api/augmentations/pipelines')
def create_pipeline(body: PipelineCreate, conn=Depends(get_db),
                    user: dict = Depends(require_role('admin', 'member'))):
    """Save a pipeline, private to the caller. The spec is built for real by the
    model venv before it is stored, so a saved pipeline always loads."""
    if body.task not in registry.TASKS:
        raise HTTPException(400, f'task must be one of {registry.TASKS}')
    name = _clean_name(body.name)
    if augmentations.name_taken(conn, body.task, user['username'], name):
        raise HTTPException(409, f'you already have a {body.task} pipeline named "{name}"')
    spec = _checked_spec(body.spec, body.task)
    cur = conn.execute(
        'INSERT INTO augmentation_pipelines (task, name, owner, spec) VALUES (?, ?, ?, ?)',
        (body.task, name, user['username'], json.dumps(spec)))
    conn.commit()
    return _row(conn, cur.lastrowid, user)


class PipelineUpdate(BaseModel):
    name: str | None = None
    spec: dict | None = None


@router.patch('/api/augmentations/pipelines/{pipeline_id}')
def update_pipeline(pipeline_id: int, body: PipelineUpdate, conn=Depends(get_db),
                    user: dict = Depends(require_role('admin', 'member'))):
    """Rename a pipeline or replace its steps. Runs that used it keep the copy they
    froze at submit, so editing never rewrites history."""
    pipeline = _owned(conn, pipeline_id, user)
    fields = {}
    if body.name is not None:
        name = _clean_name(body.name)
        if augmentations.name_taken(conn, pipeline['task'], user['username'], name, except_id=pipeline_id):
            raise HTTPException(409, f'you already have a {pipeline["task"]} pipeline named "{name}"')
        fields['name'] = name
    if body.spec is not None:
        fields['spec'] = json.dumps(_checked_spec(body.spec, pipeline['task']))
    if fields:
        sets = ', '.join(f'{key} = ?' for key in fields)
        conn.execute(f"UPDATE augmentation_pipelines SET {sets}, updated_at = datetime('now') WHERE id = ?",
                     (*fields.values(), pipeline_id))
        conn.commit()
    return _row(conn, pipeline_id, user)


@router.delete('/api/augmentations/pipelines/{pipeline_id}')
def delete_pipeline(pipeline_id: int, conn=Depends(get_db),
                    user: dict = Depends(require_role('admin', 'member'))):
    """Delete a pipeline. Deleting the task default leaves the task on the train
    module's built-in stack; runs keep their frozen copies."""
    _owned(conn, pipeline_id, user)
    conn.execute('DELETE FROM augmentation_pipelines WHERE id = ?', (pipeline_id,))
    conn.commit()
    return {'ok': True}


class DefaultFlag(BaseModel):
    default: bool


@router.post('/api/augmentations/pipelines/{pipeline_id}/default')
def set_default(pipeline_id: int, body: DefaultFlag, conn=Depends(get_db),
                user: dict = Depends(require_role('admin'))):
    """Make one of the admin's own pipelines what "Default" means for its task in the
    training dialog - visible to everyone, read-only for everyone else - or unmark it."""
    pipeline = _owned(conn, pipeline_id, user)
    if body.default:
        conn.execute('UPDATE augmentation_pipelines SET is_default = 0 WHERE task = ?', (pipeline['task'],))
    conn.execute('UPDATE augmentation_pipelines SET is_default = ? WHERE id = ?', (int(body.default), pipeline_id))
    conn.commit()
    return _row(conn, pipeline_id, user)


def _copy_name(name: str, label: str) -> str:
    """The name with its copy label, shortening the name rather than the label so the
    result fits the field and copies of a long name stay apart."""
    label = f' ({label})'
    return name[:augmentations.MAX_NAME_LENGTH - len(label)] + label


@router.post('/api/augmentations/pipelines/{pipeline_id}/duplicate')
def duplicate_pipeline(pipeline_id: int, conn=Depends(get_db),
                       user: dict = Depends(require_role('admin', 'member'))):
    """Copy a pipeline the caller can see into their own list, to tweak from there."""
    pipeline = augmentations.get_pipeline(conn, pipeline_id)
    if pipeline is None or not augmentations.visible_to(pipeline, user):
        raise HTTPException(404)
    name = _copy_name(pipeline['name'], 'copy')
    suffix = 2
    while augmentations.name_taken(conn, pipeline['task'], user['username'], name):
        name = _copy_name(pipeline['name'], f'copy {suffix}')
        suffix += 1
    cur = conn.execute(
        'INSERT INTO augmentation_pipelines (task, name, owner, spec) VALUES (?, ?, ?, ?)',
        (pipeline['task'], name, user['username'], pipeline['spec']))
    conn.commit()
    return _row(conn, cur.lastrowid, user)


class PreviewBody(BaseModel):
    task: str
    spec: dict
    job_ids: list[str]
    # Which lines are shown, and the roll the stack makes on them.
    line_seed: int = 0
    render_seed: int = 0


@router.post('/api/augmentations/preview')
def preview_pipeline(body: PreviewBody, conn=Depends(get_db), user: dict = Depends(current_user)):
    """Apply a stack to a few checked lines of the chosen datasets and return each crop
    before and after. A spec the runner refuses comes back as ok=false with the step
    named; only a runner that cannot run at all is an error."""
    if body.task not in trainer.TRAINABLE_TASKS:
        raise HTTPException(400, f'task must be one of {", ".join(trainer.TRAINABLE_TASKS)}')
    for job_id in body.job_ids:
        require_job_access(conn, job_id, user)
    try:
        return augmentations.preview(conn, body.task, body.spec, body.job_ids, body.line_seed,
                                     body.render_seed)
    except augmentations.NoTrainer as exc:
        raise HTTPException(503, str(exc))
