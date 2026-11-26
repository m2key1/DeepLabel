import json

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app import metadata, store
from app.deps import current_user, get_db, require_job_role

router = APIRouter(tags=['datasets'])


class Entry(BaseModel):
    key: str
    value: str


class Metadata(BaseModel):
    metadata: list[Entry] = Field(max_length=metadata.MAX_FIELDS * 2)
    # The fields as the person opened them; a save over something else is refused (#169).
    base: list[Entry] | None = None


def _kept(body: Metadata) -> list[dict]:
    try:
        return metadata.cleaned([entry.model_dump() for entry in body.metadata])
    except metadata.Refused as refused:
        raise HTTPException(400, str(refused))


def _require_unchanged(body: Metadata, stored: str) -> None:
    """Refuse a save over fields changed since they were opened, with what they hold now."""
    current = metadata.of(stored)
    if body.base is not None and [entry.model_dump() for entry in body.base] != current:
        raise HTTPException(409, {'code': 'conflict', 'message': 'Somebody changed these fields since you opened them',
                                  'current': current})


@router.put('/api/jobs/{job_id}/metadata')
def put_job_metadata(job_id: str, body: Metadata, conn=Depends(get_db), user: dict = Depends(current_user)):
    """Write the dataset's metadata, all of it: what is left out is gone."""
    require_job_role(conn, job_id, user, 'annotator')
    kept = _kept(body)
    store.write_lock(conn)
    _require_unchanged(body, conn.execute('SELECT metadata FROM jobs WHERE id = ?', (job_id,)).fetchone()['metadata'])
    conn.execute('UPDATE jobs SET metadata = ? WHERE id = ?', (json.dumps(kept), job_id))
    conn.commit()
    return {'metadata': kept}


@router.put('/api/pages/{page_id}/metadata')
def put_page_metadata(page_id: int, body: Metadata, conn=Depends(get_db), user: dict = Depends(current_user)):
    """Write a page's metadata, all of it: what is left out is gone."""
    page = conn.execute('SELECT job_id FROM pages WHERE id = ?', (page_id,)).fetchone()
    if page is None:
        raise HTTPException(404)
    require_job_role(conn, page['job_id'], user, 'annotator')
    kept = _kept(body)
    store.write_lock(conn)
    _require_unchanged(body, conn.execute('SELECT metadata FROM pages WHERE id = ?', (page_id,)).fetchone()['metadata'])
    conn.execute('UPDATE pages SET metadata = ? WHERE id = ?', (json.dumps(kept), page_id))
    conn.commit()
    return {'metadata': kept}
