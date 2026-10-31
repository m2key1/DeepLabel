from fastapi import APIRouter, Depends, HTTPException

from app import data_use, transcript
from app.deps import accessible_job, current_user, get_db
from app.text_search import MODES, PatternTooSlow

router = APIRouter(tags=['transcript'])


@router.get('/api/jobs/{job_id}/transcript')
def transcript_index(job_id: str, conn=Depends(get_db), user: dict = Depends(current_user)):
    """The pages a volume is read through, without their text: that comes a page at a time."""
    job = accessible_job(conn, job_id, user)
    data_use.note_admin_visit(conn, job_id, user)
    return {'job': {'id': job['id'], 'name': job['name']}, 'pages': transcript.index(conn, job_id)}


@router.get('/api/jobs/{job_id}/transcript/pages/{idx}')
def transcript_page(job_id: str, idx: int, conn=Depends(get_db), user: dict = Depends(current_user)):
    """One page of the volume, its blocks and lines in reading order."""
    accessible_job(conn, job_id, user)
    page = transcript.page(conn, job_id, idx)
    if page is None:
        raise HTTPException(404)
    return page


@router.get('/api/jobs/{job_id}/transcript/search')
def transcript_search(job_id: str, q: str, mode: str = 'fuzzy', reviewed: bool = False,
                      conn=Depends(get_db), user: dict = Depends(current_user)):
    """The lines of the volume that read like `q`: fuzzy forgives a misspelling, exact and
    case forgive nothing, regex is the reader's own pattern."""
    accessible_job(conn, job_id, user)
    if mode not in MODES:
        raise HTTPException(400, f'mode must be one of {", ".join(MODES)}')
    try:
        return transcript.search(conn, job_id, q, mode, reviewed)
    except PatternTooSlow:
        raise HTTPException(400, 'the pattern took too long - make it more specific') from None
