from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app import ingest, keying, page_rows, store, training
from app.deps import current_user, get_db, job_of, require_page_access, require_role_on

router = APIRouter(tags=['pages'])


def _text_page(conn, page_id: int) -> str:
    """The page's dataset, refusing a map's tile."""
    job_id = job_of(conn, 'page', page_id)
    if ingest.is_tile_task(store.get_job(conn, job_id)['task']):
        raise HTTPException(400, "A map dataset's tiles are reviewed with their Reviewed toggle")
    return job_id


def _changed(conn, job_id: str, page_id: int) -> dict:
    conn.commit()
    page_rows.forget_counts(conn, job_id)
    return store.page_review(conn, page_id)


def _signed_off(conn, page_id: int) -> bool:
    return store.page_review(conn, page_id)['state'] == 'signed_off'


@router.post('/api/pages/{page_id}/hand-in')
def hand_in(page_id: int, conn=Depends(get_db), user: dict = Depends(current_user)):
    """The page's assignee says it is done, for a Reviewer to sign off or send back (#36)."""
    require_page_access(conn, page_id, user)
    job_id = _text_page(conn, page_id)
    # Held from here, so that two hand-ins at once cannot both find themselves the second.
    store.write_lock(conn)
    if _signed_off(conn, page_id):
        raise HTTPException(409, 'This page is signed off already')
    if keying.role(conn, page_id, user['username']) == 'keyed':
        raise HTTPException(409, keying.KEYED)
    _hand_in(conn, page_id, user, handed=True)
    # Handing it in again answers a send-back.
    conn.execute("DELETE FROM page_reviews WHERE page_id = ? AND state = 'sent_back'", (page_id,))
    # The second keyer in has the two keyings compared (#37).
    keyed = keying.role(conn, page_id, user['username']) == 'keyed'
    compared = keying.compare(conn, page_id, user['username']) if keyed else []
    review = _changed(conn, job_id, page_id)
    for line_id in compared:
        training.enqueue(line_id)
    return review


@router.delete('/api/pages/{page_id}/hand-in')
def take_hand_in_back(page_id: int, conn=Depends(get_db), user: dict = Depends(current_user)):
    """The assignee takes their hand-in back, to go on working on the page."""
    require_page_access(conn, page_id, user)
    job_id = _text_page(conn, page_id)
    store.write_lock(conn)
    if _signed_off(conn, page_id):
        raise HTTPException(409, 'This page is signed off already')
    if keying.role(conn, page_id, user['username']) == 'keyed':
        raise HTTPException(409, keying.KEYED)
    _hand_in(conn, page_id, user, handed=False)
    return _changed(conn, job_id, page_id)


def _hand_in(conn, page_id: int, user: dict, handed: bool) -> None:
    """Set or clear the caller's own hand-in, refusing anyone the page is not assigned to."""
    when = "datetime('now')" if handed else 'NULL'
    written = conn.execute(f'UPDATE page_assignees SET handed_in_at = {when} WHERE page_id = ? AND username = ?',
                           (page_id, user['username']))
    if written.rowcount == 0:
        raise HTTPException(403, 'Only the person this page is assigned to hands it in')


class Review(BaseModel):
    verdict: Literal['signed_off', 'sent_back']
    # What the assignee is to do on a page sent back.
    note: str | None = None


@router.put('/api/pages/{page_id}/review')
def review_page(page_id: int, body: Review, conn=Depends(get_db), user: dict = Depends(current_user)):
    """A Reviewer signs the page off, whoever worked on it and whether or not it was handed in,
    once every line on it is checked; or sends it back to its assignee with a note, keeping
    every edit and check made on it."""
    require_page_access(conn, page_id, user)
    job_id = _text_page(conn, page_id)
    require_role_on(conn, 'page', page_id, user, 'reviewer')
    # Held from the count to the sign-off, so no line can lose its check in between.
    store.write_lock(conn)
    keyed = keying.state(conn, page_id)
    note = None
    if body.verdict == 'signed_off':
        if keyed and keyed['open']:
            raise HTTPException(409, 'The page is still being keyed')
        if unchecked := store.unchecked_lines(conn, page_id):
            raise HTTPException(400, f'{unchecked} line{"" if unchecked == 1 else "s"} on this page '
                                     f'{"is" if unchecked == 1 else "are"} not checked yet')
    elif keyed:
        raise HTTPException(400, 'A double-keyed page is not sent back: its Reviewer settles what the keyers '
                                 'disagree on')
    else:
        note = (body.note or '').strip()
        if not note:
            raise HTTPException(400, 'Say what is to be done on the page')
        if conn.execute('SELECT 1 FROM page_assignees WHERE page_id = ?', (page_id,)).fetchone() is None:
            raise HTTPException(400, 'Nobody has this page to send it back to')
        conn.execute('UPDATE page_assignees SET handed_in_at = NULL WHERE page_id = ?', (page_id,))
    conn.execute("INSERT OR REPLACE INTO page_reviews (page_id, state, by_user, at, note) "
                 "VALUES (?, ?, ?, datetime('now'), ?)", (page_id, body.verdict, user['username'], note))
    return _changed(conn, job_id, page_id)


@router.delete('/api/pages/{page_id}/review')
def take_review_back(page_id: int, conn=Depends(get_db), user: dict = Depends(current_user)):
    """A Reviewer takes a sign-off or a send-back back; a page handed in stays handed in."""
    require_page_access(conn, page_id, user)
    job_id = _text_page(conn, page_id)
    require_role_on(conn, 'page', page_id, user, 'reviewer')
    # Under the lock a sign-off takes, so the two cannot cross.
    store.write_lock(conn)
    conn.execute('DELETE FROM page_reviews WHERE page_id = ?', (page_id,))
    return _changed(conn, job_id, page_id)
