from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app import rights
from app.deps import current_user, get_db, require_job_access, require_job_role

router = APIRouter(tags=['datasets'])


@router.get('/api/rights/statements')
def rights_statements(_user: dict = Depends(current_user)):
    """The rights statements a scan or a transcription may carry, Not Evaluated first."""
    return {'statements': [{'uri': uri, 'label': label} for uri, label in rights.STATEMENTS]}


@router.get('/api/jobs/{job_id}/rights')
def job_rights(job_id: str, conn=Depends(get_db), user: dict = Depends(current_user)):
    """The dataset's rights fields, which an import filled, and every change to them, newest first."""
    require_job_access(conn, job_id, user)
    row = conn.execute('SELECT rights, transcription_licence FROM jobs WHERE id = ?', (job_id,)).fetchone()
    if row is None:
        raise HTTPException(404)
    return {**rights.of_job(row), 'history': rights.history(conn, job_id)}


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
    row = conn.execute('SELECT rights, transcription_licence FROM jobs WHERE id = ?', (job_id,)).fetchone()
    return {**rights.of_job(row), 'history': rights.history(conn, job_id)}
