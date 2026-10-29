from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel

from app import config, consensus, data_use, llm, llm_client, llm_ocr, store
from app.deps import current_user, get_db, require_job_access, require_job_owner, require_page_access
from app.routes.selection import selected_pages

router = APIRouter(tags=['llm'])


def require_enabled() -> None:
    """Reads stay open so the UI can explain itself; writing is what a deployment that
    switched the feature off must refuse."""
    if not config.ENABLE_LLM_OCR:
        raise HTTPException(403, 'LLM pre-annotation is disabled on this deployment')


def _clean_name(name: str) -> str:
    name = name.strip()
    if not name:
        raise HTTPException(400, 'name must not be empty')
    if len(name) > llm.MAX_NAME_LENGTH:
        raise HTTPException(400, f'name must be at most {llm.MAX_NAME_LENGTH} characters')
    return name


def _clean_url(url: str) -> str:
    try:
        return llm.normalize_base_url(url)
    except ValueError as exc:
        raise HTTPException(400, str(exc))


def _clean_prompt(prompt: str) -> str:
    if len(prompt) > llm.MAX_PROMPT_LENGTH:
        raise HTTPException(400, f'the prompt must be at most {llm.MAX_PROMPT_LENGTH} characters')
    return prompt.strip()


def _clean_extra(text: str) -> str:
    try:
        llm.valid_extra_body(text)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    return (text or '').strip() or '{}'


def _clean_tokens(tokens: int | None) -> int | None:
    if tokens is not None and not 1 <= tokens <= 200_000:
        raise HTTPException(400, 'the token ceiling must be between 1 and 200000')
    return tokens


def _clean_edge(edge: int) -> int:
    if not llm.MIN_IMAGE_EDGE <= edge <= llm.MAX_IMAGE_EDGE:
        raise HTTPException(400, f'the image edge must be between {llm.MIN_IMAGE_EDGE} '
                                 f'and {llm.MAX_IMAGE_EDGE} pixels')
    return edge


def _owned(conn, connection_id: int, user: dict) -> dict:
    """404 for what the caller cannot see, 403 for what they can see but not change."""
    connection = llm.get_connection(conn, connection_id)
    if connection is None or not llm.visible_to(connection, user):
        raise HTTPException(404)
    if not llm.editable_by(connection, user):
        raise HTTPException(403, 'only the owner can change this connection')
    return connection


@router.get('/api/llm/connections')
def list_connections(conn=Depends(get_db), user: dict = Depends(current_user)):
    """The caller's own connections plus the published ones, with their models. Carries
    the deployment's state too, so the Settings page can say why a key cannot be saved."""
    return {
        'enabled': config.ENABLE_LLM_OCR,
        'secret_configured': llm.fernet() is not None,
        'default_prompt': llm.DEFAULT_PROMPT,
        'connections': llm.list_connections(conn, user),
    }


class PromptBody(BaseModel):
    prompt: str


@router.get('/api/llm/prompt')
def get_prompt(conn=Depends(get_db), user: dict = Depends(current_user)):
    """The caller's own default wording, and the shipped one it falls back to."""
    return {'prompt': llm.user_prompt(conn, user['username']), 'default': llm.DEFAULT_PROMPT}


@router.put('/api/llm/prompt')
def put_prompt(body: PromptBody, conn=Depends(get_db), user: dict = Depends(current_user),
               _on=Depends(require_enabled)):
    """Set the caller's own default. Every model they have not given words of its own
    follows it from the next run onwards; readings already taken are left alone."""
    return {'prompt': llm.set_user_prompt(conn, user['username'], _clean_prompt(body.prompt)),
            'default': llm.DEFAULT_PROMPT}


def _reference_scope(conn, job_id: str | None, user: dict, writing: bool) -> str | None:
    """Which set is being worked on, and whether this caller may. A dataset's charts are
    the dataset's: anyone who can see it sees them, and whoever may edit it may change
    them. Without a dataset it is the caller's own set, which is nobody else's business."""
    if not job_id:
        return None
    require_job_access(conn, job_id, user)
    job = store.get_job(conn, job_id)
    if job is None:
        raise HTTPException(404)
    if writing and job['owner'] != user['username'] and user['role'] != 'admin':
        raise HTTPException(403, 'not permitted')
    return job_id


@router.get('/api/llm/references')
def list_references(job_id: str | None = Query(default=None), conn=Depends(get_db),
                    user: dict = Depends(current_user)):
    """What the models would be shown before the page, in the order they are sent, and
    whether it is this dataset's own set or the caller's default standing in for it."""
    scope = _reference_scope(conn, job_id, user, writing=False)
    rows = llm.references(conn, user['username'], scope)
    return {'references': [llm.reference_payload(row) for row in rows],
            'inherited': bool(scope) and all(row['job_id'] is None for row in rows),
            'limit': llm.MAX_REFERENCES, 'max_bytes': llm.MAX_REFERENCE_BYTES}


@router.post('/api/llm/references')
async def add_reference(file: UploadFile = File(...), job_id: str | None = Form(default=None),
                        conn=Depends(get_db), user: dict = Depends(current_user),
                        _on=Depends(require_enabled)):
    """Show the models one more picture. The identical one already there is kept once."""
    scope = _reference_scope(conn, job_id, user, writing=True)
    # One byte past the limit is enough to refuse it, and the rest is never held.
    data = await file.read(llm.MAX_REFERENCE_BYTES + 1)
    try:
        reference_id = llm.add_reference(conn, user['username'], scope, file.filename or '',
                                         file.content_type or '', data)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    row = conn.execute('SELECT * FROM llm_references WHERE id = ?', (reference_id,)).fetchone()
    return llm.reference_payload(row)


def _own_reference(conn, reference_id: int, user: dict, writing: bool):
    row = conn.execute('SELECT * FROM llm_references WHERE id = ?', (reference_id,)).fetchone()
    if row is None:
        raise HTTPException(404)
    if row['job_id']:
        _reference_scope(conn, row['job_id'], user, writing)
    elif row['owner'] != user['username']:
        raise HTTPException(404)
    return row


@router.get('/api/llm/references/{reference_id}/image')
def reference_image(reference_id: int, conn=Depends(get_db), user: dict = Depends(current_user)):
    """The picture itself, so a person can see what their models are being shown."""
    row = _own_reference(conn, reference_id, user, writing=False)
    return Response(content=row['bytes'], media_type=row['mime'])


@router.delete('/api/llm/references/{reference_id}')
def delete_reference(reference_id: int, conn=Depends(get_db),
                     user: dict = Depends(current_user), _on=Depends(require_enabled)):
    """Stop showing it. Readings already taken keep the digest they were taken under, so
    they show as stale rather than silently counting as current."""
    _own_reference(conn, reference_id, user, writing=True)
    llm.delete_reference(conn, reference_id)
    return {'ok': True}


@router.get('/api/llm/models')
def list_usable_models(conn=Depends(get_db), user: dict = Depends(current_user)):
    """Every enabled model the caller may read a page with - what a dataset picker offers."""
    return {'models': llm.usable_models(conn, user)}


class ConnectionCreate(BaseModel):
    name: str
    base_url: str
    api_key: str | None = None


@router.post('/api/llm/connections', status_code=201)
def create_connection(body: ConnectionCreate, conn=Depends(get_db),
                      user: dict = Depends(current_user), _on=Depends(require_enabled)):
    """Register an OpenAI-compatible endpoint. The key, if any, is encrypted at rest."""
    name = _clean_name(body.name)
    base_url = _clean_url(body.base_url)
    if llm.name_taken(conn, user['username'], name):
        raise HTTPException(409, 'you already have a connection with that name')
    token = hint = None
    if body.api_key:
        try:
            token, hint = llm.encrypt_key(body.api_key), llm.key_hint(body.api_key)
        except llm.SecretUnavailable as exc:
            raise HTTPException(503, str(exc))
    cur = conn.execute(
        'INSERT INTO llm_connections (owner, name, base_url, api_key, api_key_hint) VALUES (?,?,?,?,?)',
        (user['username'], name, base_url, token, hint))
    conn.commit()
    row = conn.execute('SELECT * FROM llm_connections WHERE id = ?', (cur.lastrowid,)).fetchone()
    return llm.connection_payload(conn, row, user)


class ConnectionPatch(BaseModel):
    name: str | None = None
    base_url: str | None = None
    # Omitted leaves the stored key alone; null clears it; a string replaces it.
    api_key: str | None = None
    shared: bool | None = None
    self_hosted: bool | None = None


@router.patch('/api/llm/connections/{connection_id}')
def patch_connection(connection_id: int, body: ConnectionPatch, conn=Depends(get_db),
                     user: dict = Depends(current_user), _on=Depends(require_enabled)):
    """Rename an endpoint, repoint it, replace or clear its key, publish it, or - an admin, on
    any connection they can see - mark it self-hosted."""
    fields = body.model_fields_set
    if fields == {'self_hosted'} and user['role'] == 'admin':
        connection = llm.get_connection(conn, connection_id)
        if connection is None or not llm.visible_to(connection, user):
            raise HTTPException(404)
    else:
        _owned(conn, connection_id, user)
    if 'name' in fields and body.name is not None:
        name = _clean_name(body.name)
        if llm.name_taken(conn, user['username'], name, except_id=connection_id):
            raise HTTPException(409, 'you already have a connection with that name')
        conn.execute('UPDATE llm_connections SET name = ? WHERE id = ?', (name, connection_id))
    if 'base_url' in fields and body.base_url is not None:
        conn.execute('UPDATE llm_connections SET base_url = ? WHERE id = ?',
                     (_clean_url(body.base_url), connection_id))
    if 'api_key' in fields:
        if body.api_key:
            try:
                token, hint = llm.encrypt_key(body.api_key), llm.key_hint(body.api_key)
            except llm.SecretUnavailable as exc:
                raise HTTPException(503, str(exc))
        else:
            token = hint = None
        conn.execute('UPDATE llm_connections SET api_key = ?, api_key_hint = ? WHERE id = ?',
                     (token, hint, connection_id))
    if 'self_hosted' in fields and body.self_hosted is not None:
        # Datasets that keep their pages in the house trust this mark, so it is an admin's.
        if user['role'] != 'admin':
            raise HTTPException(403, 'only an admin can mark a connection self-hosted')
        conn.execute('UPDATE llm_connections SET self_hosted = ? WHERE id = ?',
                     (int(body.self_hosted), connection_id))
    if 'shared' in fields and body.shared is not None:
        # Publishing puts this endpoint - and whatever it is billed to - in front of
        # everyone, so it is an admin's call even on their own connection.
        if user['role'] != 'admin':
            raise HTTPException(403, 'only an admin can publish a connection')
        conn.execute('UPDATE llm_connections SET shared = ? WHERE id = ?',
                     (int(body.shared), connection_id))
    conn.commit()
    row = conn.execute('SELECT * FROM llm_connections WHERE id = ?', (connection_id,)).fetchone()
    return llm.connection_payload(conn, row, user)


@router.delete('/api/llm/connections/{connection_id}')
def delete_connection(connection_id: int, conn=Depends(get_db),
                      user: dict = Depends(current_user), _on=Depends(require_enabled)):
    """Delete an endpoint and every model registered against it."""
    _owned(conn, connection_id, user)
    conn.execute('DELETE FROM llm_connections WHERE id = ?', (connection_id,))
    conn.commit()
    return {'ok': True}


@router.post('/api/llm/connections/{connection_id}/probe')
def probe_connection(connection_id: int, conn=Depends(get_db),
                     user: dict = Depends(current_user), _on=Depends(require_enabled)):
    """Ask the endpoint what it offers. Also the connection test - a reachable endpoint
    that accepts the key answers with its model list."""
    connection = llm.get_connection(conn, connection_id)
    if connection is None or not llm.visible_to(connection, user):
        raise HTTPException(404)
    try:
        key = llm.decrypt_key(connection['api_key']) if connection['api_key'] else None
    except llm.SecretUnavailable as exc:
        raise HTTPException(503, str(exc))
    try:
        return {'models': llm_client.list_models(connection['base_url'], key)}
    except llm_client.LlmError as exc:
        raise HTTPException(502, str(exc))


class ModelCreate(BaseModel):
    model: str
    label: str | None = None
    prompt: str | None = None
    temperature: float = 0.0
    max_image_edge: int = 1600
    max_tokens: int | None = None
    # Extra request fields as JSON, where a provider's own switches live.
    extra_body: str | None = None


@router.post('/api/llm/connections/{connection_id}/models', status_code=201)
def create_model(connection_id: int, body: ModelCreate, conn=Depends(get_db),
                 user: dict = Depends(current_user), _on=Depends(require_enabled)):
    """Register one model this endpoint serves, with the prompt it is to be asked with."""
    _owned(conn, connection_id, user)
    model = body.model.strip()
    if not model:
        raise HTTPException(400, 'model must not be empty')
    label = _clean_name(body.label or model)
    cur = conn.execute(
        'INSERT INTO llm_models (connection_id, model, label, prompt, temperature, '
        'max_image_edge, max_tokens, extra_body) VALUES (?,?,?,?,?,?,?,?)',
        # No prompt of its own by default: it then follows whoever runs it, and editing a
        # personal default reaches every such model rather than none of them.
        (connection_id, model, label, _clean_prompt(body.prompt or ''),
         body.temperature, _clean_edge(body.max_image_edge), _clean_tokens(body.max_tokens),
         _clean_extra(body.extra_body or '')))
    conn.commit()
    return llm.model_payload(conn.execute('SELECT * FROM llm_models WHERE id = ?',
                                          (cur.lastrowid,)).fetchone())


def _clean_concurrency(value: int | None) -> int | None:
    """How many of the worker's slots one model may hold. None hands it back to the global
    ceiling; a number below one would queue a model that never runs."""
    if value is None:
        return None
    if value < 1 or value > 64:
        raise HTTPException(400, 'max_concurrency must be between 1 and 64')
    return value


class ModelPatch(BaseModel):
    model: str | None = None
    label: str | None = None
    prompt: str | None = None
    temperature: float | None = None
    max_image_edge: int | None = None
    max_tokens: int | None = None
    extra_body: str | None = None
    max_concurrency: int | None = None
    enabled: bool | None = None


@router.patch('/api/llm/models/{model_id}')
def patch_model(model_id: int, body: ModelPatch, conn=Depends(get_db),
                user: dict = Depends(current_user), _on=Depends(require_enabled)):
    """Retune a model: its prompt, image size, temperature, or whether it is offered."""
    model = llm.get_model(conn, model_id)
    if model is None:
        raise HTTPException(404)
    _owned(conn, model['connection_id'], user)
    updates = {}
    fields = body.model_fields_set
    if 'model' in fields and body.model is not None:
        if not body.model.strip():
            raise HTTPException(400, 'model must not be empty')
        updates['model'] = body.model.strip()
    if 'label' in fields and body.label is not None:
        updates['label'] = _clean_name(body.label)
    if 'prompt' in fields and body.prompt is not None:
        updates['prompt'] = _clean_prompt(body.prompt)
    if 'temperature' in fields and body.temperature is not None:
        updates['temperature'] = body.temperature
    if 'max_image_edge' in fields and body.max_image_edge is not None:
        updates['max_image_edge'] = _clean_edge(body.max_image_edge)
    if 'max_tokens' in fields:
        # Null clears it, which hands the ceiling back to the endpoint's own default.
        updates['max_tokens'] = _clean_tokens(body.max_tokens)
    if 'extra_body' in fields and body.extra_body is not None:
        updates['extra_body'] = _clean_extra(body.extra_body)
    if 'max_concurrency' in fields:
        # Null clears it, which puts the model back under the global ceiling alone.
        updates['max_concurrency'] = _clean_concurrency(body.max_concurrency)
    if 'enabled' in fields and body.enabled is not None:
        updates['enabled'] = int(body.enabled)
    if updates:
        assignments = ', '.join(f'{column} = ?' for column in updates)
        conn.execute(f'UPDATE llm_models SET {assignments} WHERE id = ?', (*updates.values(), model_id))
        conn.commit()
    return llm.model_payload(conn.execute('SELECT * FROM llm_models WHERE id = ?', (model_id,)).fetchone())


@router.delete('/api/llm/models/{model_id}')
def delete_model(model_id: int, conn=Depends(get_db),
                 user: dict = Depends(current_user), _on=Depends(require_enabled)):
    """Remove a model. Datasets set to read with it stop using it."""
    model = llm.get_model(conn, model_id)
    if model is None:
        raise HTTPException(404)
    _owned(conn, model['connection_id'], user)
    conn.execute('DELETE FROM llm_models WHERE id = ?', (model_id,))
    conn.commit()
    return {'ok': True}


class ReadRequest(BaseModel):
    # Which registered models to read with. Empty keeps whatever the dataset already uses.
    model_ids: list[int] | None = None
    # Also take again the readings made under wording this dataset has since changed. Off
    # by default: editing a prompt should not quietly re-bill a whole volume.
    refresh: bool = False
    # Read only these pages. Absent reads the dataset; a page of another dataset is refused
    # rather than ignored, so a selection can never quietly read something else.
    page_ids: list[int] | None = None


def _job_models(conn, job_id: str, body: ReadRequest | None) -> list[int]:
    if body is not None and body.model_ids is not None:
        return body.model_ids
    return llm_ocr.selected_models(conn, job_id)


@router.get('/api/jobs/{job_id}/llm/preview')
def read_preview(job_id: str, model_ids: list[int] = Query(default=[]),
                 page_ids: list[int] | None = Query(default=None), conn=Depends(get_db),
                 user: dict = Depends(current_user)):
    """What reading this dataset would cost: calls per model, and the pages already read -
    here or in any other dataset holding the same scan - which cost nothing. Page ids price
    a selection, so what the dialog promises is what the run bills."""
    require_job_access(conn, job_id, user)
    if store.get_job(conn, job_id) is None:
        raise HTTPException(404)
    chosen = model_ids or llm_ocr.selected_models(conn, job_id)
    return llm_ocr.preview(conn, job_id, chosen, user, selected_pages(conn, job_id, page_ids))


@router.post('/api/jobs/{job_id}/llm/read')
def read_dataset(job_id: str, body: ReadRequest | None = None, conn=Depends(get_db),
                 user: dict = Depends(current_user), _on=Depends(require_enabled)):
    """Queue a language-model reading of every page. Runs beside the GPU pipeline rather
    than behind it, and is billed to whoever asked - it uses their own credentials."""
    require_job_access(conn, job_id, user)
    if store.get_job(conn, job_id) is None:
        raise HTTPException(404)
    chosen = _job_models(conn, job_id, body)
    if not chosen:
        raise HTTPException(400, 'choose at least one model to read with')
    data_use.require_llm(conn, job_id, chosen)
    result = llm_ocr.enqueue(conn, job_id, chosen, user,
                             refresh=bool(body and body.refresh),
                             page_ids=selected_pages(conn, job_id, body.page_ids if body else None))
    if not result['models']:
        raise HTTPException(400, 'none of those models are available to you')
    return result


@router.get('/api/jobs/{job_id}/llm/status')
def read_status(job_id: str, page_ids: list[int] | None = Query(default=None),
                conn=Depends(get_db), user: dict = Depends(current_user)):
    """How far the dataset's readings have got, per model, with the first few failures.
    Narrowed to a selection of pages where one is given."""
    require_job_access(conn, job_id, user)
    if store.get_job(conn, job_id) is None:
        raise HTTPException(404)
    return llm_ocr.status(conn, job_id, selected_pages(conn, job_id, page_ids))


class CancelRequest(BaseModel):
    page_ids: list[int] | None = None
    in_flight: bool = False


@router.post('/api/jobs/{job_id}/llm/cancel')
def cancel_reads(job_id: str, body: CancelRequest | None = None, conn=Depends(get_db),
                 user: dict = Depends(current_user), _on=Depends(require_enabled)):
    """Drop the readings not yet sent, on the whole dataset or the pages given. With
    `in_flight`, a reading already sent is dropped too and its answer discarded when it
    lands - what stopping one page's reading from its chip does."""
    require_job_access(conn, job_id, user)
    page_ids = selected_pages(conn, job_id, body.page_ids if body else None)
    return {'cancelled': llm_ocr.cancel(conn, job_id, page_ids, in_flight=bool(body and body.in_flight))}


@router.post('/api/jobs/{job_id}/llm/retry')
def retry_reads(job_id: str, conn=Depends(get_db), user: dict = Depends(current_user),
                _on=Depends(require_enabled)):
    """Ask again for this dataset's failed readings only, billed to whoever asks."""
    require_job_access(conn, job_id, user)
    if store.get_job(conn, job_id) is None:
        raise HTTPException(404)
    return llm_ocr.retry_failed(conn, job_id, user)


@router.get('/api/jobs/{job_id}/llm/readings')
def readings_on_file(job_id: str, conn=Depends(get_db), user: dict = Depends(current_user)):
    """The models with readings of this dataset's scans, and how many other datasets would
    lose them along with this one."""
    require_job_access(conn, job_id, user)
    return {'models': llm_ocr.removable(conn, job_id)}


@router.delete('/api/jobs/{job_id}/llm/readings')
def remove_readings(job_id: str, model_id: int | None = None, conn=Depends(get_db),
                    user: dict = Depends(current_user)):
    """Delete the readings of this dataset's scans - every model's, or `model_id`'s -
    wherever they landed. Asking again pays again; a checked line keeps its reading."""
    require_job_owner(conn, job_id, user)
    return llm_ocr.remove(conn, job_id, model_id)


@router.get('/api/pages/{page_id}/llm/readings')
def page_readings_on_file(page_id: int, conn=Depends(get_db), user: dict = Depends(current_user)):
    """The models with readings of this page's scan, as the dataset's are counted."""
    require_page_access(conn, page_id, user)
    page = _live_page(conn, page_id)
    return {'models': llm_ocr.removable(conn, page['job_id'], page_id)}


@router.delete('/api/pages/{page_id}/llm/readings')
def remove_page_readings(page_id: int, model_id: int | None = None, conn=Depends(get_db),
                         user: dict = Depends(current_user)):
    """Delete this page's readings - every model's, or `model_id`'s - by the dataset's rules.
    Anyone who may edit the page may, as they may remove one line's reading."""
    require_page_access(conn, page_id, user)
    page = _live_page(conn, page_id)
    return llm_ocr.remove(conn, page['job_id'], model_id, page_id)


def _live_page(conn, page_id: int):
    page = conn.execute('SELECT job_id FROM pages WHERE id = ? AND deleted = 0', (page_id,)).fetchone()
    if page is None:
        raise HTTPException(404)
    return page


@router.get('/api/jobs/{job_id}/llm/settle')
def settle_preview(job_id: str, conn=Depends(get_db), user: dict = Depends(current_user)):
    """How many lines already read the current agreement settings would settle or un-settle.
    The owner's question, like the settings it is about: an assignee cannot change them."""
    require_job_owner(conn, job_id, user)
    return consensus.settle_preview(conn, job_id)


@router.post('/api/jobs/{job_id}/llm/settle')
def settle_again(job_id: str, conn=Depends(get_db), user: dict = Depends(current_user),
                 _on=Depends(require_enabled)):
    """Apply the agreement settings to the lines already read, from the readings on file.
    Saving a setting never does this by itself; no model is asked."""
    require_job_owner(conn, job_id, user)
    return consensus.settle_job(conn, job_id)
