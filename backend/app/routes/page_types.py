from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app import caches, page_rows, page_types
from app.deps import current_user, get_db, require_job_access, require_job_manager

router = APIRouter(tags=['datasets'])


@router.get('/api/jobs/{job_id}/page-types')
def list_page_types(job_id: str, conn=Depends(get_db), user: dict = Depends(current_user)):
    """The dataset's page types, the steps each leaves on, and how many pages each has."""
    require_job_access(conn, job_id, user)
    counts = dict(conn.execute(
        f'SELECT COALESCE(page_type, {page_types.TEXT}), COUNT(*) FROM pages WHERE job_id = ? '
        f'AND {caches.counted_page()} GROUP BY 1', (job_id,)).fetchall())
    return {'types': [kind | {'pages': counts.get(kind['id'], 0)} for kind in page_types.listed(conn, job_id)]}


class PageTypePatch(BaseModel):
    name: str | None = Field(default=None, max_length=80)
    run_layout: bool | None = None
    run_lines: bool | None = None
    run_ocr: bool | None = None


@router.patch('/api/jobs/{job_id}/page-types/{type_id}')
def patch_page_type(job_id: str, type_id: int, body: PageTypePatch, conn=Depends(get_db),
                    user: dict = Depends(current_user)):
    """Rename a page type, or switch a step on or off for its pages from the next run on."""
    require_job_manager(conn, job_id, user)
    if not page_types.exists(conn, job_id, type_id):
        raise HTTPException(404)
    if body.name is not None:
        name = body.name.strip()
        if not name:
            raise HTTPException(400, 'a page type needs a name')
        if page_types.name_clash(conn, job_id, type_id, name):
            raise HTTPException(409, f'this dataset already has a page type "{name}"')
        conn.execute('UPDATE job_page_types SET name = ? WHERE job_id = ? AND type_id = ?', (name, job_id, type_id))
    for step in page_types.STEPS:
        switched = getattr(body, f'run_{step}')
        if switched is not None:
            conn.execute(f'UPDATE job_page_types SET run_{step} = ? WHERE job_id = ? AND type_id = ?',
                         (int(switched), job_id, type_id))
    # Reading reads the lines found, as a dataset's own switches have it (ingest.coherent_phases).
    conn.execute('UPDATE job_page_types SET run_ocr = 0 WHERE job_id = ? AND type_id = ? AND run_lines = 0',
                 (job_id, type_id))
    conn.commit()
    return next(kind for kind in page_types.listed(conn, job_id) if kind['id'] == type_id)


class PagesType(BaseModel):
    page_ids: list[int]
    # None makes the pages text again, as they were before anyone said otherwise.
    type_id: int | None


@router.post('/api/jobs/{job_id}/pages/type')
def set_pages_type(job_id: str, body: PagesType, conn=Depends(get_db), user: dict = Depends(current_user)):
    """Give pages of the dataset a type, the steps it switches off passing them by from then on."""
    require_job_manager(conn, job_id, user)
    if body.type_id is not None and not page_types.exists(conn, job_id, body.type_id):
        raise HTTPException(400, f'this dataset has no page type {body.type_id}')
    changed = sum(conn.execute('UPDATE pages SET page_type = ? WHERE id = ? AND job_id = ?',
                               (body.type_id, page_id, job_id)).rowcount for page_id in body.page_ids)
    conn.commit()
    page_rows.forget_counts(conn, job_id)
    return {'pages': changed}
