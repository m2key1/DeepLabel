import shutil
from collections.abc import Callable
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile

from app import recognize, recognize_async
from app.backend_client import BackendError
from app.deps import current_user, get_db, require_capability, require_role

router = APIRouter(tags=['recognition'])
may_recognize = require_capability('recognize')
admin_only = require_role('admin')


def _megabytes(queued: bool) -> int:
    return recognize.limit_of('MB', queued) * (1 << 20)


async def _form(request: Request, unit: str) -> tuple[list[UploadFile], dict, bool]:
    """The `files` parts, the other form fields, and whether the request is async - checked
    against the request limits before any image is decoded. Before the form is read only
    the larger of the two size limits can be told apart from the length."""
    budgets = [_megabytes(False), _megabytes(True)]
    if all(budgets) and int(request.headers.get('content-length') or 0) > max(budgets):
        raise HTTPException(413, f'at most {recognize.limit_of("MB", False)} MB per request, '
                                 f'{recognize.limit_of("MB", True)} MB per async request')
    most = max(recognize.limit_of(kind, queued) for kind in ('pages', 'lines') for queued in (False, True))
    form = await request.form(max_files=most + 1, max_fields=20)
    fields = {key: value for key, value in form.multi_items() if isinstance(value, str)}
    queued = recognize.flag(fields.pop('async', None))
    files = [part for part in form.getlist('files') if not isinstance(part, str)]
    if not files:
        raise HTTPException(400, 'send at least one image as a files part')
    try:
        recognize.within_limit(len(files), unit, queued)
    except recognize.Refused as refused:
        raise HTTPException(refused.status, refused.message) from None
    if _megabytes(queued) and sum(part.size or 0 for part in files) > _megabytes(queued):
        raise HTTPException(413, f'at most {recognize.limit_of("MB", queued)} MB per {"async " if queued else ""}request')
    names = _names(files, unit)
    twice = next((name for name in names if names.count(name) > 1), None)
    if twice:
        raise HTTPException(400, f'each file needs a name of its own; {twice} comes more than once')
    return files, fields, queued


def _names(files: list[UploadFile], unit: str) -> list[str]:
    return [part.filename or f'{unit}-{i + 1}' for i, part in enumerate(files)]


async def _uploads(files: list[UploadFile], unit: str) -> list[recognize.Upload]:
    return [recognize.Upload(name, await part.read()) for name, part in zip(_names(files, unit), files)]


def _saver(files: list[UploadFile]) -> Callable[[Path], None]:
    """Writes each file into the request's folder as it arrived, without holding it in memory."""
    def save(folder: Path) -> None:
        for i, part in enumerate(files):
            part.file.seek(0)
            with (folder / f'{i:05d}').open('wb') as out:
                shutil.copyfileobj(part.file, out)
    return save


async def _answer(work: Callable[[], object]):
    try:
        return await run_in_threadpool(work)
    except recognize.Refused as refused:
        headers = {'Retry-After': str(refused.retry_after)} if refused.retry_after is not None else None
        raise HTTPException(refused.status, refused.message, headers=headers) from None
    except BackendError as error:
        raise HTTPException(502, f'the model backend failed: {error.message}') from None


@router.get('/api/recognize')
def offered(conn=Depends(get_db), user: dict = Depends(may_recognize)):
    """The layout, line and OCR models a recognition request can name - each layout model
    with the template it reads by, each OCR model with its decodes and conventions - the
    formats, the limits of one request and of an async one, the caller's lines read this
    month against its cap, and the caller's async requests."""
    return {**recognize.offered(conn, user['username']), 'requests': recognize_async.listed(conn, user['username'])}


def _may_keep(request: Request, user: dict) -> None:
    """Keeping writes a dataset, so it asks what writing one asks."""
    if user['role'] not in ('admin', 'member'):
        raise HTTPException(403, 'keeping writes a dataset, which a read-only account may not do')
    if request.headers.get('X-Auth-Readonly') == '1':
        raise HTTPException(403, 'keeping writes a dataset, which a read-only token may not do')


@router.post('/api/recognize/pages')
async def recognize_pages(request: Request, conn=Depends(get_db), user: dict = Depends(may_recognize)):
    """Whole pages in, as `files` parts; the lines found on each, in reading order, with
    their text and outlines in the pixels of the upright image. `lines` (JSON, by file
    name) gives a page its own outlines to read instead. `layout_model` finds each page's
    regions first and its lines inside each; the answer then carries the regions, and
    each line the region it was found in. Also `lines_model`, `ocr_model`, `decode`,
    `convention` (comma-separated) and `format` (json, page, alto, hocr, txt).
    `characters=true` gives each line the confidence bands it was read with.
    Nothing of the request is stored, unless `keep` names a dataset of the caller's to
    file the pages and their lines in, which is created if no dataset has that name.
    With `async=true` it is answered 202 at once with its id, waits on disk for its turn
    in the queue, and its answer at GET /api/recognize/{id}."""
    files, fields, queued = await _form(request, 'pages')
    if (fields.get('keep') or '').strip():
        _may_keep(request, user)
    if queued:
        return await _queue(conn, user, 'pages', files, fields)
    uploads = await _uploads(files, 'pages')
    return await _answer(lambda: recognize.pages(conn, user['username'], uploads, fields))


@router.post('/api/recognize/lines')
async def recognize_lines(request: Request, conn=Depends(get_db), user: dict = Depends(may_recognize)):
    """Line images in, as `files` parts; their text out, in the order sent. Also
    `ocr_model`, `decode`, `convention` and `characters`. Nothing of the request is stored; with
    `async=true` it is queued as for pages."""
    files, fields, queued = await _form(request, 'lines')
    if (fields.get('keep') or '').strip():
        raise HTTPException(400, 'keep works on pages: send them to /api/recognize/pages')
    if queued:
        return await _queue(conn, user, 'lines', files, fields)
    uploads = await _uploads(files, 'lines')
    return await _answer(lambda: recognize.lines(conn, user['username'], uploads, fields))


async def _queue(conn, user: dict, route: str, files: list[UploadFile], fields: dict) -> JSONResponse:
    """An async request: answered 202 with its id as soon as its files are on disk."""
    state = await _answer(lambda: recognize_async.submit(conn, user['username'], route, _names(files, route),
                                                         fields, _saver(files)))
    return JSONResponse(state, status_code=202, headers={'Location': f'/api/recognize/{state["id"]}'})


@router.get('/api/recognize/{request_id}')
async def recognition_request(request_id: str, conn=Depends(get_db), user: dict = Depends(may_recognize)):
    """An async request of the caller's: 202 and where it stands while it waits or reads,
    200 once it finished - with the answer an at-once request gives, or the error that
    stopped it."""
    code, state = await _answer(lambda: recognize_async.status(conn, user['username'], request_id))
    return JSONResponse(state, status_code=code)


@router.delete('/api/recognize/{request_id}', status_code=204)
async def delete_recognition_request(request_id: str, conn=Depends(get_db), user: dict = Depends(current_user)):
    """Take an async request off the queue, or its result off the disk; one that is reading
    stops after the batch it is on. Its owner may, and an admin."""
    await _answer(lambda: recognize_async.delete(conn, user, request_id))
    return Response(status_code=204)


@router.get('/api/recognition-usage')
def usage(conn=Depends(get_db), _admin: dict = Depends(admin_only)):
    """What every account read through the recognition API this month and last, and its cap."""
    return recognize.usage_report(conn)


class CapChange(BaseModel):
    account: str
    monthly_lines: int | None = None


@router.put('/api/recognition-caps')
def set_cap(body: CapChange, conn=Depends(get_db), _admin: dict = Depends(admin_only)):
    """Set an account's monthly cap on lines read, or lift it with null."""
    if body.monthly_lines is not None and body.monthly_lines < 0:
        raise HTTPException(400, 'a cap is a number of lines, 0 or more')
    recognize.set_cap(conn, body.account, body.monthly_lines)
    return {'account': body.account, 'cap': recognize.cap_of(conn, body.account)}

