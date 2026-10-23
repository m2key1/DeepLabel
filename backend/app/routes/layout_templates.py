import sqlite3
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app import dataset_sync, geometry, layout_templates, store
from app.deps import current_user, get_db, get_user, require_job_access, require_role

router = APIRouter(tags=['layout templates'])


class TemplateClass(BaseModel):
    # Kept when an edited template already has the class; a new class is given the next id.
    id: int | None = None
    name: str
    role: Literal['content', 'container'] = 'content'
    reads: Literal['down', 'across'] | None = None
    color: str | None = None


OutsideOrder = Literal['top_to_bottom', 'from_page']


class TemplateBody(BaseModel):
    name: str
    classes: list[TemplateClass] | None = None
    # "Save as template": the classes of this dataset instead of a list.
    from_job_id: str | None = None
    outside_order: OutsideOrder = 'from_page'


class TemplatePatch(BaseModel):
    name: str | None = None
    classes: list[TemplateClass] | None = None
    outside_order: OutsideOrder | None = None


def _payload(conn, row) -> dict:
    return {'id': row['id'], 'name': row['name'], 'owner': row['owner'], 'is_default': bool(row['is_default']),
            'builtin': row['rules'] == layout_templates.SCHEMATISMUS_RULES, 'outside_order': row['outside_order'],
            'classes': layout_templates.template_classes(conn, row['id'])}


def _template(conn, template_id: int):
    row = conn.execute('SELECT * FROM layout_templates WHERE id = ?', (template_id,)).fetchone()
    if row is None:
        raise HTTPException(404)
    return row


def _require_editor(row, auth: dict) -> None:
    """Owners edit their own templates and admins every one; the built-in Schematismus
    template stays as its checkpoints know it."""
    if row['rules'] == layout_templates.SCHEMATISMUS_RULES:
        raise HTTPException(409, 'the Schematismus template cannot be changed; save a copy of it instead')
    if auth['role'] != 'admin' and row['owner'] != auth['username']:
        raise HTTPException(403, 'only its owner or an admin can change this template')


def _valid_classes(classes: list[TemplateClass], before: list[dict] | None = None) -> list[dict]:
    """The classes as stored: names unique, a container reading down or across, ids kept
    for classes the template already had and the next free ones for the rest."""
    if not classes:
        raise HTTPException(400, 'a template needs at least one class')
    names = [c.name.strip() for c in classes]
    if any(not n for n in names):
        raise HTTPException(400, 'every class needs a name')
    if len(set(names)) != len(names):
        raise HTTPException(400, 'class names must be unique')
    known = {c['id'] for c in before or []}
    next_id = max(known | {c.id or 0 for c in classes} | {0}) + 1
    stored = []
    for position, (c, name) in enumerate(zip(classes, names)):
        if c.role == 'container' and c.reads is None:
            raise HTTPException(400, f'container class {name} must read down or across')
        if c.id is not None and c.id not in known:
            raise HTTPException(400, f'class id {c.id} is not one of this template\'s')
        class_id = c.id if c.id is not None else next_id
        next_id += class_id == next_id
        stored.append({'id': class_id, 'name': name, 'role': c.role,
                       'reads': c.reads if c.role == 'container' else None, 'color': c.color, 'position': position})
    return stored


def _write_classes(conn, template_id: int, classes: list[dict]) -> None:
    conn.execute('DELETE FROM layout_template_classes WHERE template_id = ?', (template_id,))
    layout_templates.insert_classes(conn, 'layout_template_classes', 'template_id', template_id, classes)


@router.get('/api/layout-templates')
def list_templates(conn=Depends(get_db), _auth: dict = Depends(current_user)):
    """Every layout template with its classes, the default first."""
    layout_templates.ensure_schematismus(conn)
    rows = conn.execute('SELECT * FROM layout_templates ORDER BY is_default DESC, name').fetchall()
    return {'templates': [_payload(conn, row) for row in rows]}


@router.post('/api/layout-templates', status_code=201)
def create_template(body: TemplateBody, conn=Depends(get_db), auth: dict = Depends(current_user)):
    """A new template from a list of classes, or from a dataset's own ("save as template").
    Any user may create one."""
    if (body.classes is None) == (body.from_job_id is None):
        raise HTTPException(400, 'pass exactly one of classes, from_job_id')
    if body.from_job_id is not None:
        require_job_access(conn, body.from_job_id, auth)
        copied = layout_templates.job_classes(conn, body.from_job_id)
        classes = [{**c, 'position': i} for i, c in enumerate(copied)]
    else:
        classes = _valid_classes(body.classes)
    try:
        template_id = conn.execute('INSERT INTO layout_templates (name, owner, outside_order) VALUES (?, ?, ?)',
                                   (body.name.strip(), auth['username'], body.outside_order)).lastrowid
    except sqlite3.IntegrityError:
        raise HTTPException(409, f'a template named {body.name.strip()} exists')
    _write_classes(conn, template_id, classes)
    conn.commit()
    return _payload(conn, _template(conn, template_id))


@router.patch('/api/layout-templates/{template_id}')
def patch_template(template_id: int, body: TemplatePatch, conn=Depends(get_db),
                   auth: dict = Depends(current_user)):
    """Rename a template or replace its classes. Datasets made from it keep their own copy."""
    row = _template(conn, template_id)
    _require_editor(row, auth)
    if body.name is not None:
        try:
            conn.execute('UPDATE layout_templates SET name = ? WHERE id = ?', (body.name.strip(), template_id))
        except sqlite3.IntegrityError:
            raise HTTPException(409, f'a template named {body.name.strip()} exists')
    if body.classes is not None:
        _write_classes(conn, template_id,
                       _valid_classes(body.classes, layout_templates.template_classes(conn, template_id)))
    if body.outside_order is not None:
        conn.execute('UPDATE layout_templates SET outside_order = ? WHERE id = ?', (body.outside_order, template_id))
    conn.commit()
    return _payload(conn, _template(conn, template_id))


@router.delete('/api/layout-templates/{template_id}', status_code=204)
def delete_template(template_id: int, conn=Depends(get_db), auth: dict = Depends(current_user)):
    """Delete a template. Datasets made from it keep their classes."""
    row = _template(conn, template_id)
    _require_editor(row, auth)
    if row['is_default']:
        raise HTTPException(409, 'the default template cannot be deleted; make another the default first')
    model = conn.execute('SELECT name FROM models WHERE layout_template_id = ?', (template_id,)).fetchone()
    if model is not None:
        raise HTTPException(409, f'the layout model "{model["name"]}" belongs to this template; '
                                 'give it another before deleting this one')
    conn.execute('DELETE FROM layout_template_classes WHERE template_id = ?', (template_id,))
    conn.execute('DELETE FROM layout_templates WHERE id = ?', (template_id,))
    conn.commit()


@router.put('/api/layout-templates/{template_id}/default')
def make_default(template_id: int, conn=Depends(get_db), _admin=Depends(require_role('admin'))):
    """The template a new dataset gets when it names none. Admins only."""
    _template(conn, template_id)
    conn.execute('UPDATE layout_templates SET is_default = (id = ?)', (template_id,))
    conn.commit()
    return _payload(conn, _template(conn, template_id))


@router.get('/api/jobs/{job_id}/layout-classes')
def job_layout_classes(job_id: str, conn=Depends(get_db), auth: dict = Depends(current_user)):
    """A dataset's own layout classes, how many elements each has, which are Schematismus
    classes it cannot change, and the template they were copied from."""
    require_job_access(conn, job_id, auth)
    row = conn.execute('SELECT layout_template_id, layout_rules FROM jobs WHERE id = ?', (job_id,)).fetchone()
    counts = layout_templates.element_counts(conn, job_id)
    vocabulary = layout_templates.vocabulary(conn, job_id)
    return {'template_id': row['layout_template_id'], 'schematismus': vocabulary.schematismus,
            'classes': [{**c, 'elements': counts.get(c['name'], 0), 'stored_as': vocabulary.resolve(c['name'])[0],
                         'builtin': layout_templates.is_builtin(conn, job_id, c)}
                        for c in vocabulary.classes]}


def _editing(conn, job_id: str, auth: dict) -> None:
    require_job_access(conn, job_id, auth)
    if auth['role'] not in ('admin', 'member'):
        raise HTTPException(403, 'viewers cannot change a dataset\'s classes')


def _apply(conn, job_id: str, change) -> list[int]:
    """One class edit as one undoable span: the edit, then the reading order of every page
    whose elements it changed."""
    mark = store.begin_span(conn)
    try:
        touched = change()
    except layout_templates.ClassError as error:
        conn.rollback()
        raise HTTPException(error.status, error.detail)
    if touched:
        pages = {r['page_id'] for r in conn.execute(
            f"SELECT DISTINCT page_id FROM elements WHERE id IN ({','.join('?' * len(touched))})", touched)}
        for page_id in pages:
            geometry.resequence_page(conn, page_id)
    store.end_span(conn, mark)
    conn.commit()
    if touched:
        dataset_sync.enqueue(job_id)
    return touched


class DatasetClass(BaseModel):
    name: str
    role: Literal['content', 'container'] = 'content'
    reads: Literal['down', 'across'] | None = None
    color: str | None = None


class DatasetClassPatch(BaseModel):
    name: str | None = None
    role: Literal['content', 'container'] | None = None
    reads: Literal['down', 'across'] | None = None
    color: str | None = None


class ClassOrder(BaseModel):
    order: list[int]


@router.post('/api/jobs/{job_id}/layout-classes', status_code=201)
def add_dataset_class(job_id: str, body: DatasetClass, conn=Depends(get_db), auth: dict = Depends(current_user)):
    """Add a layout class to a dataset, at an id it never used."""
    _editing(conn, job_id, auth)
    created = []
    _apply(conn, job_id, lambda: created.append(
        layout_templates.add_class(conn, job_id, body.name, body.role, body.reads, body.color)) or [])
    return next(c for c in job_layout_classes(job_id, conn, auth)['classes'] if c['id'] == created[0])


@router.patch('/api/jobs/{job_id}/layout-classes/{class_id}')
def change_dataset_class(job_id: str, class_id: int, body: DatasetClassPatch, conn=Depends(get_db),
                         auth: dict = Depends(current_user), user: str = Depends(get_user)):
    """Rename, retype or recolour a dataset's class; its elements follow."""
    _editing(conn, job_id, auth)
    touched = _apply(conn, job_id, lambda: layout_templates.change_class(
        conn, job_id, class_id, user, body.name, body.role, body.reads, body.color,
        recolour='color' in body.model_fields_set))
    found = next(c for c in job_layout_classes(job_id, conn, auth)['classes'] if c['id'] == class_id)
    return {**found, 'elements_changed': len(touched)}


@router.delete('/api/jobs/{job_id}/layout-classes/{class_id}')
def remove_dataset_class(job_id: str, class_id: int, into: int | None = None, conn=Depends(get_db),
                         auth: dict = Depends(current_user), user: str = Depends(get_user)):
    """Remove a dataset's class: its elements are deleted, or merged `into` another class."""
    _editing(conn, job_id, auth)
    touched = _apply(conn, job_id, lambda: layout_templates.remove_class(conn, job_id, class_id, user, into))
    return {'removed': class_id, 'into': into, 'elements_affected': len(touched)}


@router.put('/api/jobs/{job_id}/layout-classes/order')
def reorder_dataset_classes(job_id: str, body: ClassOrder, conn=Depends(get_db), auth: dict = Depends(current_user)):
    """The order a dataset's classes are listed in; ids stay."""
    _editing(conn, job_id, auth)
    _apply(conn, job_id, lambda: layout_templates.reorder(conn, job_id, body.order) or [])
    return job_layout_classes(job_id, conn, auth)


class LabelChoice(BaseModel):
    label: str
    # The dataset class the label's boxes become; null leaves them out.
    class_id: int | None = None


class LabelChoices(BaseModel):
    model_id: int
    choices: list[LabelChoice]


def _labels_payload(conn, job_id: str, model_id: int | None) -> dict:
    if model_id is None:
        return {'model_id': None, 'labels': []}
    try:
        labels = layout_templates.model_labels(conn, model_id)
    except Exception as error:  # an unreachable backend says so rather than failing the dialog
        return {'model_id': model_id, 'labels': [], 'error': f'the model\'s labels could not be read: {error}'}
    return {'model_id': model_id, 'labels': layout_templates.label_plan(conn, job_id, model_id, labels)}


@router.get('/api/jobs/{job_id}/layout-labels')
def job_layout_labels(job_id: str, model_id: int | None = None, conn=Depends(get_db),
                      auth: dict = Depends(current_user)):
    """A layout model's labels and which class of this dataset each becomes - the dataset's
    layout model unless another is named. A label the dataset has no class of that name for
    is 'undecided' until mapped or skipped, and a run leaves its boxes out until then."""
    require_job_access(conn, job_id, auth)
    return _labels_payload(conn, job_id, model_id or layout_templates.layout_model_id(conn, job_id))


@router.put('/api/jobs/{job_id}/layout-labels')
def decide_job_layout_labels(job_id: str, body: LabelChoices, conn=Depends(get_db),
                             auth: dict = Depends(current_user)):
    """Decide what this dataset does with some of a layout model's labels: the class their
    boxes become, or null to leave them out. Remembered per dataset and model."""
    _editing(conn, job_id, auth)
    try:
        layout_templates.decide_labels(conn, job_id, body.model_id, {c.label: c.class_id for c in body.choices})
    except layout_templates.ClassError as error:
        raise HTTPException(error.status, error.detail)
    conn.commit()
    return _labels_payload(conn, job_id, body.model_id)
