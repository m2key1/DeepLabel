from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app import config, registry, schemas, weights
from app.deps import get_db, has_capability, require_role

router = APIRouter(tags=['models'])


@router.get('/api/models', responses={200: {'model': schemas.ModelList}})
def list_models(include_archived: bool = False, conn=Depends(get_db)):
    """Registered models per task, with defaults, ownership and archive state."""
    where = '' if include_archived else 'WHERE archived = 0'
    rows = conn.execute(
        'SELECT models.*, trainings.owner AS owner FROM models '
        f'LEFT JOIN trainings ON trainings.model_id = models.id {where} '
        'ORDER BY task, models.created_at').fetchall()
    files = weights.files_by_model(conn)
    return {'models': [registry.model_payload(r) | {'files': files.get(r['id'], []),
                                                    'runs_on': weights.serving_backend(r)}
                       for r in rows if r['task'] in registry.TASKS]}


class ModelPatch(BaseModel):
    name: str | None = None
    notes: str | None = None
    is_default: bool | None = None
    archived: bool | None = None
    lm_path: str | None = None
    lm_dict_path: str | None = None
    # A family's own name, held on its root model. Empty takes the root's name again.
    family_name: str | None = None
    # The model backend that serves it; null hands it back to its task's default backend.
    backend: str | None = None
    # A layout model's template, whose reading order its datasets follow.
    layout_template_id: int | None = None


# The default model silently changes what every new dataset uses, so choosing it is part
# of managing the registry, as is naming a family everyone's fine-tunes sit in. The LM
# paths point into the backend filesystem and which model backend serves a model decides
# where its weights go, so both stay with admins whatever else they grant.
REGISTRY_FIELDS = {'is_default', 'family_name', 'layout_template_id'}
ADMIN_ONLY_FIELDS = {'lm_path', 'lm_dict_path', 'backend'}


@router.patch('/api/models/{model_id}')
def patch_model(model_id: int, body: ModelPatch, conn=Depends(get_db),
                user: dict = Depends(require_role('admin', 'member'))):
    """Rename a model, archive it, or make it the default for its task. Anyone may tidy up
    the models their own trainings produced; the rest of the registry is `models.manage`."""
    row = registry.get_model(conn, model_id)
    if row is None:
        raise HTTPException(404)
    fields = body.model_fields_set
    if not has_capability(user, 'models.manage'):
        producer = conn.execute(
            'SELECT owner FROM trainings WHERE model_id = ?', (model_id,)).fetchone()
        if producer is None or producer['owner'] != user['username']:
            raise HTTPException(403, 'not permitted')
        if fields & REGISTRY_FIELDS:
            raise HTTPException(403, 'not permitted: models.manage')
    if fields & ADMIN_ONLY_FIELDS and user['role'] != 'admin':
        raise HTTPException(403, 'not permitted')
    promoting = bool(body.is_default)
    # Judged on the state the request leaves behind, so a task is never without a live default.
    archived = bool(row['archived'] if body.archived is None else body.archived)
    if archived and promoting:
        raise HTTPException(409, 'an archived model cannot be the default')
    if body.archived and row['is_default']:
        raise HTTPException(409, 'the default model cannot be archived - promote another first')
    if 'name' in fields and body.name is not None:
        name = body.name.strip()
        if not name:
            raise HTTPException(400, 'name must not be empty')
        clash = registry.name_clash(conn, row['task'], name, model_id)
        if clash:
            raise HTTPException(409, clash)
        conn.execute('UPDATE models SET name = ? WHERE id = ?', (name, model_id))
    if 'backend' in fields:
        if body.backend is not None and body.backend not in config.MODEL_BACKENDS:
            raise HTTPException(400, f'no model backend named "{body.backend}" is configured')
        conn.execute('UPDATE models SET backend = ? WHERE id = ?', (body.backend, model_id))
    if 'family_name' in fields:
        if row['trained_from'] is not None and registry.get_model(conn, row['trained_from']) is not None:
            raise HTTPException(400, 'a family is named on its root model')
        conn.execute('UPDATE models SET family_name = ? WHERE id = ?',
                     ((body.family_name or '').strip() or None, model_id))
    if 'layout_template_id' in fields:
        if row['task'] != 'layout':
            raise HTTPException(400, 'only a layout model belongs to a layout template')
        if body.layout_template_id is not None and not conn.execute(
                'SELECT 1 FROM layout_templates WHERE id = ?', (body.layout_template_id,)).fetchone():
            raise HTTPException(400, f'no layout template {body.layout_template_id}')
        conn.execute('UPDATE models SET layout_template_id = ? WHERE id = ?', (body.layout_template_id, model_id))
    if 'notes' in fields:
        conn.execute('UPDATE models SET notes = ? WHERE id = ?',
                     ((body.notes or '').strip() or None, model_id))
    for lm_field in ('lm_path', 'lm_dict_path'):
        if lm_field not in fields:
            continue
        if row['task'] != 'ocr':
            raise HTTPException(400, 'only OCR models carry a beam LM')
        value = (getattr(body, lm_field) or '').strip() or None
        if value == row[lm_field]:
            continue
        if value is not None and not Path(value).is_file():
            raise HTTPException(400, f'{lm_field} does not exist on the backend: {value}')
        conn.execute(f'UPDATE models SET {lm_field} = ? WHERE id = ?', (value, model_id))
    if promoting:
        conn.execute('UPDATE models SET is_default = 0 WHERE task = ?', (row['task'],))
        conn.execute('UPDATE models SET is_default = 1 WHERE id = ?', (model_id,))
    if 'archived' in fields and body.archived is not None:
        conn.execute('UPDATE models SET archived = ? WHERE id = ?', (int(body.archived), model_id))
    conn.commit()
    updated = conn.execute(
        'SELECT models.*, trainings.owner AS owner FROM models '
        'LEFT JOIN trainings ON trainings.model_id = models.id WHERE models.id = ?',
        (model_id,)).fetchone()
    return registry.model_payload(updated) | {'runs_on': weights.serving_backend(updated)}


@router.get('/api/models/{model_id}/usage')
def model_usage(model_id: int, conn=Depends(get_db)):
    """How many datasets read with this model: those pinned to it, and for the task's
    default those that follow the default."""
    row = registry.get_model(conn, model_id)
    if row is None:
        raise HTTPException(404)
    column = registry.JOB_MODEL_COLUMNS[row['task']]
    pinned = conn.execute(f"SELECT COUNT(*) FROM jobs WHERE task = 'text' AND {column} = ?",
                          (model_id,)).fetchone()[0]
    following = conn.execute(f"SELECT COUNT(*) FROM jobs WHERE task = 'text' AND {column} IS NULL").fetchone()[0] \
        if row['is_default'] else 0
    return {'datasets': pinned + following, 'pinned': pinned, 'by_default': following}
