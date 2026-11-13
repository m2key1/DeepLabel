from collections.abc import Callable

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from app import config, recognize
from app.backend_client import BackendError
from app.deps import get_db, require_capability, require_role

router = APIRouter(tags=['recognition'])
may_recognize = require_capability('recognize')
admin_only = require_role('admin')


async def _uploads(request: Request, limit: int, unit: str) -> tuple[list[recognize.Upload], dict]:
    """The images sent as `files` parts, and the other form fields, checked against the
    request limits before anything is decoded."""
    budget = config.RECOGNIZE_MAX_MB * (1 << 20)
    too_large = HTTPException(413, f'at most {config.RECOGNIZE_MAX_MB} MB per request')
    if budget and int(request.headers.get('content-length') or 0) > budget:
        raise too_large
    form = await request.form(max_files=max(config.RECOGNIZE_MAX_PAGES, config.RECOGNIZE_MAX_LINES) + 1,
                              max_fields=20)
    files = [part for part in form.getlist('files') if not isinstance(part, str)]
    if not files:
        raise HTTPException(400, 'send at least one image as a files part')
    if limit and len(files) > limit:
        raise HTTPException(413, f'at most {limit} {unit} per request, this one has {len(files)}')
    uploads = [recognize.Upload(part.filename or f'{unit}-{i + 1}', await part.read()) for i, part in enumerate(files)]
    if budget and sum(len(u.data) for u in uploads) > budget:
        raise too_large
    names = [u.name for u in uploads]
    twice = next((name for name in names if names.count(name) > 1), None)
    if twice:
        raise HTTPException(400, f'each file needs a name of its own; {twice} comes more than once')
    return uploads, {key: value for key, value in form.multi_items() if isinstance(value, str)}


async def _answer(work: Callable[[], dict]) -> dict:
    try:
        return await run_in_threadpool(work)
    except recognize.Refused as refused:
        headers = {'Retry-After': str(refused.retry_after)} if refused.retry_after is not None else None
        raise HTTPException(refused.status, refused.message, headers=headers) from None
    except BackendError as error:
        raise HTTPException(502, f'the model backend failed: {error.message}') from None


@router.get('/api/recognize')
def offered(conn=Depends(get_db), user: dict = Depends(may_recognize)):
    """The line and OCR models a recognition request can name, their decodes and
    conventions, the formats, the limits of one request, and the caller's lines read this
    month against its cap."""
    return recognize.offered(conn, user['username'])


@router.post('/api/recognize/pages')
async def recognize_pages(request: Request, conn=Depends(get_db), user: dict = Depends(may_recognize)):
    """Whole pages in, as `files` parts; the lines found on each, in reading order, with
    their text and outlines in the pixels of the upright image. `lines` (JSON, by file
    name) gives a page its own outlines to read instead. Also `lines_model`, `ocr_model`,
    `decode`, `convention` (comma-separated) and `format` (json, page, alto, hocr, txt).
    Nothing of the request is stored."""
    uploads, fields = await _uploads(request, config.RECOGNIZE_MAX_PAGES, 'pages')
    return await _answer(lambda: recognize.pages(conn, user['username'], uploads, fields))


@router.post('/api/recognize/lines')
async def recognize_lines(request: Request, conn=Depends(get_db), user: dict = Depends(may_recognize)):
    """Line images in, as `files` parts; their text out, in the order sent. Also
    `ocr_model`, `decode` and `convention`. Nothing of the request is stored."""
    uploads, fields = await _uploads(request, config.RECOGNIZE_MAX_LINES, 'lines')
    return await _answer(lambda: recognize.lines(conn, user['username'], uploads, fields))


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

