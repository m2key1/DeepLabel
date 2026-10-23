from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app import presence
from app.deps import can_access_job, current_user, get_db, require_job_access

router = APIRouter(tags=['presence'])

TARGET_KINDS = ('line', 'element', 'region')


class Target(BaseModel):
    kind: str
    id: int


class Heartbeat(BaseModel):
    tab: str
    job_id: str | None = None
    page_id: int | None = None
    target: Target | None = None
    editing: bool = False


class Leave(BaseModel):
    tab: str


def _registry() -> presence.PresenceRegistry:
    return presence.registry


@router.post('/api/presence')
def heartbeat(body: Heartbeat, conn=Depends(get_db), user: dict = Depends(current_user),
              registry: presence.PresenceRegistry = Depends(_registry)):
    """One tab saying where it is. A location inside a dataset the caller cannot open is
    refused like any other request for it, so presence never leaks that it exists."""
    if not body.tab.strip():
        raise HTTPException(400, 'tab must not be empty')
    if body.job_id is not None:
        require_job_access(conn, body.job_id, user)
    if body.page_id is not None:
        if body.job_id is None:
            raise HTTPException(400, 'a page needs its dataset')
        page = conn.execute('SELECT job_id FROM pages WHERE id = ?', (body.page_id,)).fetchone()
        if page is None or page['job_id'] != body.job_id:
            raise HTTPException(400, 'page does not belong to that dataset')
    if body.target is not None and body.target.kind not in TARGET_KINDS:
        raise HTTPException(400, f'target kind must be one of {TARGET_KINDS}')
    location = presence.Location(
        job_id=body.job_id, page_id=body.page_id,
        target_kind=body.target.kind if body.target else None,
        target_id=body.target.id if body.target else None,
        editing=body.editing)
    registry.beat(user['username'], body.tab, location)
    return {'ok': True}


@router.post('/api/presence/leave')
def leave(body: Leave, user: dict = Depends(current_user),
          registry: presence.PresenceRegistry = Depends(_registry)):
    """Sent as the tab closes, so the entry goes at once instead of after the TTL."""
    registry.leave(user['username'], body.tab)
    return {'ok': True}


@router.get('/api/presence')
def online(conn=Depends(get_db), user: dict = Depends(current_user),
           registry: presence.PresenceRegistry = Depends(_registry)):
    """Everyone with a tab open, one entry per tab. A location the caller may not see
    keeps the person and drops the place, matching how the Queue redacts names. A
    dataset deleted since the last heartbeat is no place at all: they are simply online."""
    entries = registry.online()
    job_ids = {e.location.job_id for e in entries if e.location.job_id}
    page_ids = {e.location.page_id for e in entries if e.location.page_id}
    jobs = _jobs(conn, job_ids)
    page_idx = _page_idx(conn, page_ids)
    access = {job_id: can_access_job(conn, job_id, user) for job_id in jobs}
    users = []
    for entry in entries:
        loc = entry.location
        if loc.job_id not in jobs:
            loc = presence.Location()
        visible = loc.job_id is not None and access[loc.job_id]
        users.append({
            'username': entry.username,
            'tab': entry.tab,
            'seen_seconds_ago': registry.seconds_since(entry),
            'job_id': loc.job_id if visible else None,
            'job_name': jobs[loc.job_id]['name'] if visible else None,
            # The task decides which editor a link to the page opens.
            'job_task': jobs[loc.job_id]['task'] if visible else None,
            'page_id': loc.page_id if visible else None,
            'page_idx': page_idx.get(loc.page_id) if visible else None,
            'target': {'kind': loc.target_kind, 'id': loc.target_id}
                      if visible and loc.target_kind else None,
            'editing': loc.editing if visible else False,
            'accessible': visible or loc.job_id is None,
        })
    return {'users': users}


def _jobs(conn, ids: set[str]) -> dict[str, dict]:
    if not ids:
        return {}
    marks = ','.join('?' * len(ids))
    rows = conn.execute(f'SELECT id, name, task FROM jobs WHERE id IN ({marks})', tuple(ids))
    return {r['id']: {'name': r['name'], 'task': r['task']} for r in rows}


def _page_idx(conn, ids: set[int]) -> dict[int, int]:
    if not ids:
        return {}
    marks = ','.join('?' * len(ids))
    return {r['id']: r['idx'] for r in conn.execute(f'SELECT id, idx FROM pages WHERE id IN ({marks})', tuple(ids))}
