from fastapi import HTTPException


def selected_pages(conn, job_id: str, page_ids: list[int] | None) -> list[int] | None:
    """The selection, checked against the dataset. A page id from elsewhere is a mistake
    worth reporting, not a page to silently leave out of the bill."""
    if page_ids is None:
        return None
    held = {row['id'] for row in conn.execute(
        'SELECT id FROM pages WHERE job_id = ? AND deleted = 0', (job_id,))}
    missing = [page_id for page_id in page_ids if page_id not in held]
    if missing:
        raise HTTPException(404, f'no such page in this dataset: {missing[0]}')
    return page_ids
