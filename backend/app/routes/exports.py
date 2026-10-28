import json
import os
import tempfile
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse, Response
from starlette.background import BackgroundTask

from app import coco, config, export, schemas, store
from app.deps import attachment, current_user, get_db, require_job_access, require_role

router = APIRouter(tags=['exports'])

EXPORT_FORMATS = {'json': ('application/json', 'json'), 'md': ('text/markdown', 'md'),
                  'txt': ('text/plain', 'txt'), 'zip': ('application/zip', 'zip'),
                  # The standard formats, each in a zip with the scans it describes.
                  'page': ('application/zip', 'page.zip'), 'alto': ('application/zip', 'alto.zip'),
                  'hocr': ('application/zip', 'hocr.zip'), 'tei': ('application/zip', 'tei.zip')}


@router.get('/api/jobs/{job_id}/export', responses={200: {'content': {
    'application/json': {}, 'text/markdown': {}, 'text/plain': {}, 'application/zip': {}}}})
def export_job(job_id: str, format: str = 'json', checked_only: bool = False,
               conn=Depends(get_db), user: dict = Depends(current_user)):
    """Download the dataset as json, md, txt or DeepLabel's zip, or as PAGE XML, ALTO, hOCR
    or TEI with its scans; checked_only keeps the reviewed lines and the pages that hold one."""
    require_job_access(conn, job_id, user)
    if format not in EXPORT_FORMATS:
        raise HTTPException(400, f'format must be one of {sorted(EXPORT_FORMATS)}')
    if store.get_job(conn, job_id) is None:
        raise HTTPException(404)
    data = export.collect_job(conn, job_id, checked_only=checked_only)
    media_type, ext = EXPORT_FORMATS[format]
    suffix = '-reviewed' if checked_only else ''
    name = f"{data['job'].get('name', job_id)}{suffix}.{ext}"

    if format == 'json':
        body = json.dumps(data, ensure_ascii=False, indent=2)
    elif format == 'md':
        body = export.to_markdown(data)
    elif format == 'txt':
        body = export.to_text(data)
    else:
        # Written to disk and streamed from there: the scans of a volume run to gigabytes.
        files = export.deeplabel_files(data) if format == 'zip' else export.standard_files(data, format)
        with tempfile.NamedTemporaryFile(suffix='.zip', delete=False) as out:
            export.write_archive(conn, data, files, out)
        return FileResponse(out.name, media_type=media_type, headers=attachment(name),
                            background=BackgroundTask(os.unlink, out.name))
    return Response(content=body, media_type=media_type, headers=attachment(name))


def _coco_dest(job) -> Path:
    return config.COCO_EXPORT_DIR / coco.slug(job['name'])


@router.get('/api/jobs/{job_id}/coco')
def coco_preview(job_id: str, conn=Depends(get_db), user: dict = Depends(current_user)):
    """What a COCO export would contain, without writing anything."""
    require_job_access(conn, job_id, user)
    job = store.get_job(conn, job_id)
    if job is None:
        raise HTTPException(404)
    _, manifest = coco.collect(conn, job_id)
    return {**manifest, 'dest': str(_coco_dest(job))}


@router.post('/api/jobs/{job_id}/coco')
def coco_export(job_id: str, conn=Depends(get_db), _admin=Depends(require_role('admin'))):
    """Write the COCO layout export into the server's export directory."""
    job = store.get_job(conn, job_id)
    if job is None:
        raise HTTPException(404)
    dataset, manifest = coco.collect(conn, job_id, outlines=True)
    if not manifest['pages']:
        raise HTTPException(400, 'no pages are marked layout complete')
    dest = _coco_dest(job)
    coco.write(dataset, dest)
    return {**manifest, 'dest': str(dest)}
