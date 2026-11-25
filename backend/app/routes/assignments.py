from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app import caches, ingest, keying, page_rows, store
from app.deps import current_user, get_db, require_job_manager

router = APIRouter(tags=['datasets'])


@router.get('/api/jobs/{job_id}/assignments')
def job_assignments(job_id: str, conn=Depends(get_db), user: dict = Depends(current_user)):
    """Who has which of the dataset's pages, by page number, for the Manager handing them out."""
    require_job_manager(conn, job_id, user)
    return store.assignments(conn, job_id)


class Keying(BaseModel):
    double_keying: bool
    # Keyers start from empty lines rather than from the text the lines carry.
    from_empty: bool


@router.put('/api/jobs/{job_id}/keying')
def set_keying(job_id: str, body: Keying, conn=Depends(get_db), user: dict = Depends(current_user)):
    """Have two people key each page, blind to each other (#37), or one as before."""
    require_job_manager(conn, job_id, user)
    _text_dataset(conn, job_id)
    store.write_lock(conn)
    if not body.double_keying and (typed := keying.being_typed(conn, job_id)):
        raise HTTPException(409, f'{typed} page{"" if typed == 1 else "s"} {"is" if typed == 1 else "are"} being keyed: '
                                 f'let {"its" if typed == 1 else "their"} keyers finish, or take '
                                 f'{"it" if typed == 1 else "them"} back first')
    conn.execute('UPDATE jobs SET double_keying = ?, keying_from_empty = ? WHERE id = ?',
                 (int(body.double_keying), int(body.from_empty), job_id))
    conn.commit()
    page_rows.forget_counts(conn, job_id)
    return {'double_keying': body.double_keying, 'from_empty': body.from_empty}


def _text_dataset(conn, job_id: str) -> dict:
    job = store.get_job(conn, job_id)
    if ingest.is_tile_task(job['task']):
        raise HTTPException(400, "A map dataset's tiles are not handed out")
    return job


class Assignment(BaseModel):
    # None takes the pages back: nobody has them.
    assignee: str | None
    # A double-keyed dataset's second keyer of the pages (#37).
    second_keyer: str | None = None
    page_ids: list[int] | None = None
    # The numbers the page table shows, as a range like "1-40" names them.
    numbers: list[int] | None = None


@router.put('/api/jobs/{job_id}/assignments')
def assign_pages(job_id: str, body: Assignment, conn=Depends(get_db), user: dict = Depends(current_user)):
    """Hand pages to one person of the dataset, or to two keyers of a double-keyed one, taking
    them from whoever had them (#137, #37). Whoever keeps a page keeps their hand-in and what they
    typed on it. A page that is no work - deleted, a duplicate, unreadable - is passed by, so a
    range can run over it; taking pages back takes those too."""
    require_job_manager(conn, job_id, user)
    job = _text_dataset(conn, job_id)
    if (body.page_ids is None) == (body.numbers is None):
        raise HTTPException(400, 'Name the pages by page_ids or by numbers')
    people = [name for name in (body.assignee, body.second_keyer) if name is not None]
    if body.second_keyer is not None:
        if not job['double_keying']:
            raise HTTPException(400, 'Only a double-keyed dataset gives a page a second keyer')
        if body.second_keyer == body.assignee:
            raise HTTPException(400, 'Two different people key a page')
    for name in people:
        if name not in store.people_of_job(conn, job_id):
            raise HTTPException(400, f'{name} cannot open this dataset')
    pages = _pages_named(conn, job_id, body, work_only=bool(people))
    for page_id in pages:
        leaving = [row[0] for row in conn.execute('SELECT username FROM page_assignees WHERE page_id = ?', (page_id,))
                   if row[0] not in people]
        conn.executemany('DELETE FROM page_assignees WHERE page_id = ? AND username = ?',
                         [(page_id, name) for name in leaving])
        keying.drop(conn, page_id, leaving)
        conn.executemany('INSERT OR IGNORE INTO page_assignees (page_id, username) VALUES (?, ?)',
                         [(page_id, name) for name in people])
    # A send-back was said to whoever had the page (#36).
    conn.executemany("DELETE FROM page_reviews WHERE page_id = ? AND state = 'sent_back'",
                     [(page_id,) for page_id in pages])
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
