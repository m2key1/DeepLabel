from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile
from pydantic import BaseModel

from app import config, corpus, data_use, ingest, llm, llm_gt, store
from app.caches import counted_page
from app.deps import accessible_job, current_user, get_db, require_job_access, require_job_owner
from app.routes.selection import selected_pages

router = APIRouter(tags=['reference'])

MAX_DOCUMENT_BYTES = 4 * 1024 * 1024
TEXT_SUFFIX = '.txt'


def require_enabled() -> None:
    """Reads stay open so the UI can explain itself; writing is what a deployment that
    switched the feature off must refuse."""
    if not config.ENABLE_LLM_OCR:
        raise HTTPException(403, 'LLM pre-annotation is disabled on this deployment')


@router.get('/api/jobs/{job_id}/documents')
def list_documents(job_id: str, conn=Depends(get_db), user: dict = Depends(current_user)):
    """The corpus this dataset was uploaded with, in reading order, with how many pages
    each document was cut onto."""
    accessible_job(conn, job_id, user)
    placed = {row['reference_document']: row['c'] for row in conn.execute(
        'SELECT reference_document, COUNT(*) c FROM pages WHERE job_id = ? AND deleted = 0 '
        'AND reference_document IS NOT NULL GROUP BY reference_document', (job_id,))}
    return {'documents': [
        {'name': row['name'], 'idx': row['idx'], 'characters': len(row['text']),
         'lines': len([line for line in row['text'].splitlines() if line.strip()]),
         'pages': placed.get(row['name'], 0)}
        for row in conn.execute(
            'SELECT idx, name, text FROM job_documents WHERE job_id = ? ORDER BY idx',
            (job_id,))]}


@router.get('/api/jobs/{job_id}/documents/{name:path}')
def read_document(job_id: str, name: str, conn=Depends(get_db),
                  user: dict = Depends(current_user)):
    """One corpus document, whole, as it was uploaded."""
    accessible_job(conn, job_id, user)
    row = conn.execute('SELECT name, text FROM job_documents WHERE job_id = ? AND name = ?',
                       (job_id, name)).fetchone()
    if row is None:
        raise HTTPException(404, 'no such document')
    return {'name': row['name'], 'text': row['text']}


@router.post('/api/jobs/{job_id}/documents')
def upload_documents(job_id: str, files: list[UploadFile] = None, conn=Depends(get_db),
                     user: dict = Depends(current_user)):
    """Add corpus text files, or replace ones already held by uploading them again.

    The cut is not redone here: it needs recognition to anchor against, and re-running it
    is a separate, explicit step - so a corpus can be corrected a file at a time without
    every upload moving every page's reference.
    """
    require_job_owner(conn, job_id, user)
    if not files:
        raise HTTPException(400, 'no files uploaded')
    texts, skipped = {}, []
    for file in files:
        name = (file.filename or '').strip()
        if not name.lower().endswith(TEXT_SUFFIX):
            skipped.append(name)
            continue
        raw = file.file.read(MAX_DOCUMENT_BYTES + 1)
        if len(raw) > MAX_DOCUMENT_BYTES:
            raise HTTPException(400, f'{name} is larger than {MAX_DOCUMENT_BYTES // 1024 // 1024}MB')
        stem = name[:-len(TEXT_SUFFIX)].strip()
        if not stem:
            skipped.append(name)
            continue
        try:
            texts[stem] = ingest.decode_text(raw, name)
        except ingest.IngestError as e:
            raise HTTPException(e.status_code, e.detail)
    if not texts:
        raise HTTPException(400, f'no .txt files in upload (skipped {", ".join(skipped[:5])})'
                            if skipped else 'no .txt files in upload')
    stored = corpus.store_documents(conn, job_id, texts)
    conn.commit()
    return {'stored': stored, 'skipped': skipped,
            'documents': corpus.document_count(conn, job_id)}


@router.delete('/api/jobs/{job_id}/documents/{name:path}')
def delete_document(job_id: str, name: str, conn=Depends(get_db),
                    user: dict = Depends(current_user)):
    """Drop one document from the corpus. Spans already cut from it are left until the
    next cut, which is the only thing that rewrites them."""
    require_job_owner(conn, job_id, user)
    if not corpus.remove_document(conn, job_id, name):
        raise HTTPException(404, 'no such document')
    conn.commit()
    return {'documents': corpus.document_count(conn, job_id)}


@router.get('/api/jobs/{job_id}/reference')
def list_reference(job_id: str, limit: int = Query(default=200, ge=1, le=2000),
                   offset: int = Query(default=0, ge=0), conn=Depends(get_db),
                   user: dict = Depends(current_user)):
    """What each page is answerable for, in reading order. A page with few anchors and a
    low score is where a cut goes wrong quietly, so both travel with the text. Duplicate
    scans are left out, as the cut leaves them out."""
    accessible_job(conn, job_id, user)
    cut_pages = f'FROM pages WHERE job_id = ? AND {counted_page()}'
    rows = conn.execute(
        'SELECT id, idx, filename, reference_document, reference_anchors, reference_score, '
        f'reference_text, gt_text, gt_source {cut_pages} ORDER BY idx LIMIT ? OFFSET ?',
        (job_id, limit, offset)).fetchall()
    total = conn.execute(f'SELECT COUNT(*) c {cut_pages}', (job_id,)).fetchone()['c']
    return {'total': total, 'pages': [
        {'page_id': row['id'], 'idx': row['idx'], 'filename': row['filename'],
         'document': row['reference_document'], 'anchors': row['reference_anchors'],
         'score': row['reference_score'], 'text': row['reference_text'] or '',
         # Ground truth written before provenance was tracked has no source, so whether
         # a page carries any has to be said outright - a null source is not "none".
         'has_gt': bool((row['gt_text'] or '').strip()), 'gt_source': row['gt_source']}
        for row in rows]}


@router.post('/api/jobs/{job_id}/reference/cut')
def cut_reference(job_id: str, conn=Depends(get_db), user: dict = Depends(current_user)):
    """Cut the corpus across the pages now, without waiting for a pipeline run. With no
    documents left it clears every span, which is how a deleted document's are taken back.

    Writes only the reference columns, so no transcription of record is at risk. Pages
    whose span moves are read again by the next diplomatic run rather than silently
    keeping ground truth produced from the old one.
    """
    require_job_owner(conn, job_id, user)
    job = store.get_job(conn, job_id)
    if job is None:
        raise HTTPException(404)
    if job['status'] in ('queued', 'running'):
        raise HTTPException(409, 'job is queued or running')
    if not corpus.needs_cut(conn, job_id):
        raise HTTPException(400, 'this dataset has no corpus documents')
    return corpus.apply_cut(conn, job_id, job['reference_overlap'])


class GroundTruthRequest(BaseModel):
    # Which registered models to read with. Empty keeps whatever the dataset already uses.
    model_ids: list[int] | None = None
    # Read again even the pages whose wording and reference have not moved; a page whose
    # question has moved is read again regardless. Off by default, so asking twice does not
    # bill a whole volume twice.
    refresh: bool = False
    # Read only these pages. Absent reads every placed page of the dataset.
    page_ids: list[int] | None = None
    # Read the pages a person transcribed too. Off by default: a call costs money, and the
    # person's text wins anyway, so their answer is only ever offered for comparison.
    include_transcribed: bool = False


def _models(conn, job_id: str, body: GroundTruthRequest | None) -> list[int]:
    if body is not None and body.model_ids is not None:
        return body.model_ids
    return llm_gt.default_models(conn, job_id)


@router.get('/api/jobs/{job_id}/groundtruth/prompt')
def groundtruth_prompt(job_id: str, conn=Depends(get_db), user: dict = Depends(current_user)):
    """The wording a diplomatic reading is asked with: this dataset's own, the shipped one,
    and which of the two is actually in force. An editor that could not show the shipped
    wording would leave a dataset with none of its own looking as if it had no wording at
    all, and the names it may fill in undiscoverable."""
    job = accessible_job(conn, job_id, user)
    return {'prompt': job['gt_prompt'], 'default': llm.DEFAULT_GT_PROMPT,
            'in_force': llm.effective_gt_prompt(job['gt_prompt']),
            'variables': list(llm.PAGE_VARIABLES)}


@router.get('/api/jobs/{job_id}/groundtruth/preview')
def groundtruth_preview(job_id: str, model_ids: list[int] = Query(default=[]),
                        page_ids: list[int] | None = Query(default=None),
                        include_transcribed: bool = False,
                        conn=Depends(get_db), user: dict = Depends(current_user)):
    """What a diplomatic run would cost, per model, the pages whose answer still matches
    the wording and reference they were read under, and how many a person transcribed."""
    accessible_job(conn, job_id, user)
    chosen = model_ids or _models(conn, job_id, None)
    return llm_gt.preview(conn, job_id, chosen, user, selected_pages(conn, job_id, page_ids),
                          include_transcribed=include_transcribed)


@router.post('/api/jobs/{job_id}/groundtruth/read')
def groundtruth_read(job_id: str, body: GroundTruthRequest | None = None,
                     conn=Depends(get_db), user: dict = Depends(current_user),
                     _on=Depends(require_enabled)):
    """Queue a diplomatic reading of every placed page, each asked with its own span.

    What comes back becomes the page's ground truth, recorded as machine-made: alignment
    offers it to the lines and never checks one off, so a person still decides.
    """
    require_job_access(conn, job_id, user)
    job = store.get_job(conn, job_id)
    if job is None:
        raise HTTPException(404)
    chosen = _models(conn, job_id, body)
    if not chosen:
        raise HTTPException(400, 'choose at least one model to read with')
    data_use.require_llm(conn, job_id, chosen)
    unknown = llm.unknown_placeholders(llm.effective_gt_prompt(job['gt_prompt']))
    if unknown:
        raise HTTPException(400, f'the wording asks for {{{{{unknown[0]}}}}}, which nothing '
                                 f'supplies. Available: {", ".join(llm.PAGE_VARIABLES)}')
    result = llm_gt.enqueue(conn, job_id, chosen, user,
                            refresh=bool(body and body.refresh),
                            page_ids=selected_pages(conn, job_id, body.page_ids if body else None),
                            include_transcribed=bool(body and body.include_transcribed))
    if not result['pages'] and not result['skipped']:
        raise HTTPException(400, 'no page carries a reference span - cut the corpus first')
    return result


@router.get('/api/jobs/{job_id}/groundtruth/status')
def groundtruth_status(job_id: str, page_ids: list[int] | None = Query(default=None),
                       conn=Depends(get_db), user: dict = Depends(current_user)):
    """How far the diplomatic readings have got, with the first few failures."""
    accessible_job(conn, job_id, user)
    return llm_gt.status(conn, job_id, selected_pages(conn, job_id, page_ids))


@router.post('/api/jobs/{job_id}/groundtruth/cancel')
def groundtruth_cancel(job_id: str, conn=Depends(get_db), user: dict = Depends(current_user),
                       _on=Depends(require_enabled)):
    """Drop the readings not yet sent. Anything already in flight is paid for, so it is
    left to finish and be kept."""
    require_job_access(conn, job_id, user)
    return {'cancelled': llm_gt.cancel(conn, job_id)}
