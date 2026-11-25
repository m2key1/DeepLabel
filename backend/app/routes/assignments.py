from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app import caches, ingest, page_rows, store
from app.deps import current_user, get_db, require_job_manager

router = APIRouter(tags=['datasets'])


@router.get('/api/jobs/{job_id}/assignments')
def job_assignments(job_id: str, conn=Depends(get_db), user: dict = Depends(current_user)):
    """Who has which of the dataset's pages, by page number, for the Manager handing them out."""
    require_job_manager(conn, job_id, user)
    return store.assignments(conn, job_id)


class Assignment(BaseModel):
    # None takes the pages back: nobody has them.
    assignee: str | None
    page_ids: list[int] | None = None
    # The numbers the page table shows, as a range like "1-40" names them.
    numbers: list[int] | None = None


@router.put('/api/jobs/{job_id}/assignments')
def assign_pages(job_id: str, body: Assignment, conn=Depends(get_db), user: dict = Depends(current_user)):
    """Hand pages to one person of the dataset, taking them from whoever had them (#137). A page
    that is no work - deleted, a duplicate, unreadable - is passed by, so a range can run over it;
    taking pages back takes those too."""
    require_job_manager(conn, job_id, user)
    if ingest.is_tile_task(store.get_job(conn, job_id)['task']):
        raise HTTPException(400, "A map dataset's tiles are not handed out")
    if (body.page_ids is None) == (body.numbers is None):
        raise HTTPException(400, 'Name the pages by page_ids or by numbers')
    if body.assignee is not None and body.assignee not in store.people_of_job(conn, job_id):
        raise HTTPException(400, f'{body.assignee} cannot open this dataset')
    pages = _pages_named(conn, job_id, body, work_only=body.assignee is not None)
    conn.executemany('DELETE FROM page_assignees WHERE page_id = ?', [(page_id,) for page_id in pages])
    # A send-back was said to whoever had the page (#36).
    conn.executemany("DELETE FROM page_reviews WHERE page_id = ? AND state = 'sent_back'",
                     [(page_id,) for page_id in pages])
    if body.assignee is not None:
        conn.executemany('INSERT INTO page_assignees (page_id, username) VALUES (?, ?)',
                         [(page_id, body.assignee) for page_id in pages])
    conn.commit()
    page_rows.forget_counts(conn, job_id)
    return store.assignments(conn, job_id)


def _pages_named(conn, job_id: str, body: Assignment, work_only: bool) -> list[int]:
    """The ids of the pages the request names, or of those among them that are work; 400 for
    one the dataset never had."""
    rows = conn.execute(f'SELECT id, idx, {caches.counted_page()} work FROM pages WHERE job_id = ?',
                        (job_id,)).fetchall()
    if body.numbers is not None:
        by_number = {row['idx'] + 1: row for row in rows}
        if missing := [n for n in body.numbers if n not in by_number]:
            raise HTTPException(400, f'There is no page {missing[0]} in this dataset')
        named = [by_number[n] for n in body.numbers]
    else:
        by_id = {row['id']: row for row in rows}
        if missing := [page_id for page_id in body.page_ids if page_id not in by_id]:
            raise HTTPException(400, f'Page {missing[0]} is not in this dataset')
        named = [by_id[page_id] for page_id in body.page_ids]
    return sorted({row['id'] for row in named if row['work'] or not work_only})
