from fastapi import APIRouter, Depends, HTTPException

from app import corpus_search
from app.deps import VISIBLE_JOB_IDS, current_user, get_db
from app.text_search import MODES, PatternTooSlow

router = APIRouter(tags=['search'])


@router.get('/api/search')
def search(q: str, mode: str = 'fuzzy', checked: bool = False, group_id: int | None = None,
           job_id: str | None = None, offset: int = 0, limit: int = corpus_search.PAGE,
           conn=Depends(get_db), user: dict = Depends(current_user)):
    """The lines of every dataset the person can open that read like `q`, whatever its data
    use, grouped by dataset and best first - narrowed to a workspace, a dataset or the
    checked lines - a screenful at a time."""
    if mode not in MODES:
        raise HTTPException(400, f'mode must be one of {", ".join(MODES)}')
    visible = 'SELECT id FROM jobs' if user['role'] == 'admin' else VISIBLE_JOB_IDS
    try:
        return corpus_search.search(conn, user, visible, q, mode, checked, group_id, job_id,
                                    max(0, offset), min(max(1, limit), 200))
    except PatternTooSlow:
        raise HTTPException(400, 'pattern too slow over every dataset - narrow it to a workspace or a dataset') from None
