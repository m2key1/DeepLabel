import json

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app import iiif, rights
from app.deps import current_user, get_db, require_job_access, require_job_role

router = APIRouter(tags=['datasets'])


@router.get('/api/rights/statements')
def rights_statements(_user: dict = Depends(current_user)):
    """The rights statements a scan or a transcription may carry, Not Evaluated first."""
    return {'statements': [{'uri': uri, 'label': label} for uri, label in rights.STATEMENTS]}


def _held(conn, job_id: str) -> dict:
    """The dataset's rights fields, which an import filled, every change to them newest first,
    and whether training on its material waits for its owner's confirmation."""
    row = conn.execute('SELECT rights, transcription_licence FROM jobs WHERE id = ?', (job_id,)).fetchone()
    if row is None:
        raise HTTPException(404)
    return {**rights.of_job(row), 'history': rights.history(conn, job_id),
            'training': {'restrictive': rights.restrictive_statement(conn, job_id) is not None,
                         'permitted': rights.training_permitted(conn, job_id)}}


@router.get('/api/jobs/{job_id}/rights')
def job_rights(job_id: str, conn=Depends(get_db), user: dict = Depends(current_user)):
    """The dataset's rights fields, which an import filled, every change to them, and whether
    training on its material waits for its owner's confirmation."""
    require_job_access(conn, job_id, user)
    return _held(conn, job_id)


class RightsPatch(BaseModel):
    status: str | None = None
    credit: str | None = Field(default=None, max_length=rights.MAX_TEXT)
    holder: str | None = Field(default=None, max_length=rights.MAX_TEXT)
    source: str | None = Field(default=None, max_length=rights.MAX_TEXT)
    note: str | None = Field(default=None, max_length=rights.MAX_TEXT)
    transcription_licence: str | None = None


def statement(uri: str) -> str:
    """The offered statement `uri` names, as stored; a 400 for anything else."""
    found = rights.canonical(uri)
    if found is None:
        raise HTTPException(400, f'{uri} is not one of the rights statements on offer')
    return found


@router.put('/api/jobs/{job_id}/rights')
def put_job_rights(job_id: str, body: RightsPatch, conn=Depends(get_db), user: dict = Depends(current_user)):
    """Change the fields given, each change logged; a field set by hand is no longer marked imported."""
    require_job_role(conn, job_id, user, 'annotator')
    changes = {field: value.strip() for field, value in body.model_dump(exclude_unset=True).items()
               if value is not None}
    for field in ('status', 'transcription_licence'):
        if field in changes:
            changes[field] = statement(changes[field])
    rights.write(conn, job_id, changes, user['username'])
    conn.commit()
    return _held(conn, job_id)


@router.post('/api/jobs/{job_id}/rights/refresh')
def refresh_job_rights(job_id: str, conn=Depends(get_db), user: dict = Depends(current_user)):
    """Read the dataset's IIIF manifest again: what it says now fills the fields still empty,
    marked imported, so nothing corrected by hand is taken back."""
    require_job_role(conn, job_id, user, 'annotator')
    source = conn.execute('SELECT iiif_source FROM jobs WHERE id = ?', (job_id,)).fetchone()['iiif_source']
    if not source:
        raise HTTPException(400, 'This dataset was not made from a IIIF manifest')
    try:
        manifest = iiif.read(json.loads(source)['manifest'])
    except iiif.IiifError as error:
        raise HTTPException(502, str(error)) from None
    rights.write(conn, job_id, rights.from_iiif(manifest), 'import', imported=True)
    conn.commit()
    return _held(conn, job_id)


@router.post('/api/jobs/{job_id}/rights/training-permitted')
def permit_training(job_id: str, conn=Depends(get_db), user: dict = Depends(current_user)):
    """The owner's word, logged, that training on the dataset's restricted material is
    permitted - a research exception or a contract. It covers the restrictive statements on
    the material now, while they own it: a stricter one, or a new owner, asks again."""
    require_job_access(conn, job_id, user)
    job = conn.execute('SELECT name, owner FROM jobs WHERE id = ?', (job_id,)).fetchone()
    if job['owner'] != user['username']:
        raise HTTPException(403, f'Only the owner of "{job["name"]}" can confirm that training on it is permitted')
    statements = rights.restrictive_statements(conn, job_id)
    if not statements:
        raise HTTPException(409, f'No rights statement on "{job["name"]}" restricts training')
    if rights.training_permitted(conn, job_id) is None:
        conn.execute('INSERT INTO rights_log (job_id, field, old_value, new_value, author) VALUES (?, ?, NULL, ?, ?)',
                     (job_id, rights.TRAINING_PERMITTED, json.dumps(statements), user['username']))
        conn.commit()
    return _held(conn, job_id)


@router.get('/api/jobs/{job_id}/pages/{page_id}/rights')
def page_rights(job_id: str, page_id: int, conn=Depends(get_db), user: dict = Depends(current_user)):
    """A page's own rights, None where it follows its dataset's, the dataset's beside them,
    and every change to the page's, newest first."""
    require_job_access(conn, job_id, user)
    page = conn.execute('SELECT rights FROM pages WHERE id = ? AND job_id = ?', (page_id, job_id)).fetchone()
    if page is None:
        raise HTTPException(404)
    job = conn.execute('SELECT rights, transcription_licence FROM jobs WHERE id = ?', (job_id,)).fetchone()
    return {'own': rights.of_page(page['rights']), 'imported': rights.imported_of_page(page['rights']),
            'dataset': rights.scans_of_job(job), 'history': rights.history(conn, job_id, page_id)}


class PageRightsFields(BaseModel):
    status: str | None = None
    credit: str = Field(default='', max_length=rights.MAX_TEXT)
    holder: str = Field(default='', max_length=rights.MAX_TEXT)
    source: str = Field(default='', max_length=rights.MAX_TEXT)
    note: str = Field(default='', max_length=rights.MAX_TEXT)


class PagesRights(BaseModel):
    page_ids: list[int] = Field(min_length=1)
    # None puts the pages back to their dataset's rights.
    rights: PageRightsFields | None


@router.put('/api/jobs/{job_id}/page-rights')
def put_pages_rights(job_id: str, body: PagesRights, conn=Depends(get_db), user: dict = Depends(current_user)):
    """Give pages of a dataset rights of their own, every field at once, or put them back to
    the dataset's. Each change is logged for its page."""
    require_job_role(conn, job_id, user, 'annotator')
    ours = {row['id'] for row in conn.execute('SELECT id FROM pages WHERE job_id = ? AND deleted = 0', (job_id,))}
    for page_id in body.page_ids:
        if page_id not in ours:
            raise HTTPException(400, f'page {page_id} is not a page of this dataset')
    held = None
    if body.rights is not None:
        if not body.rights.status:
            raise HTTPException(400, "a page's own rights need a rights statement")
        held = {field: value.strip() for field, value in body.rights.model_dump().items()}
        held['status'] = statement(held['status'])
    pages = list(dict.fromkeys(body.page_ids))
    rights.write_pages(conn, job_id, pages, held, user['username'])
    conn.commit()
    return {'pages': len(pages)}
