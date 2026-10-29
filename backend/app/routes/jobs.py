import asyncio
import json
import math
import re
from datetime import datetime, timezone
import shutil
from pathlib import Path
from uuid import uuid4

from fastapi import APIRouter, Depends, Form, HTTPException, Request, UploadFile
from fastapi.responses import Response, StreamingResponse
from fastapi.routing import APIRoute
from pydantic import BaseModel, Field

from app import (blobs, caches, config, consensus, conventions, corpus, data_use, decode, evaluator, geometry,
                 iiif, imports, ingest, jobs, layout_templates, llm, map_classes, model_registry, page_rows, queue_eta,
                 reading_order, registry, schemas, store, trainer)
from app.deps import (can_access_job, can_reach_group, check_capability, current_user, get_db, get_user,
                      require_job_access, require_job_owner, require_role)


class UncappedUploadRequest(Request):
    """A dataset arrives as one multipart request holding a whole scanned volume,
    so Starlette's 1000-file parsing default must not apply."""

    def form(self, *, max_files=math.inf, max_fields=1000, max_part_size=1024 * 1024):
        return super().form(max_files=max_files, max_fields=max_fields, max_part_size=max_part_size)


class UncappedUploadRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()

        async def uncapped_handler(request: Request):
            return await handler(UncappedUploadRequest(request.scope, request.receive))

        return uncapped_handler


router = APIRouter(tags=['datasets'], route_class=UncappedUploadRoute)

TERMINAL_STATUSES = {'done', 'error', 'cancelled'}

MODEL_COLUMNS = {'layout': 'model_layout_id', 'lines': 'model_lines_id', 'ocr': 'model_ocr_id'}


TILE_SIZE_RANGE = (256, 4096)


def _valid_tile_size(tile_size: int) -> int:
    low, high = TILE_SIZE_RANGE
    if not low <= tile_size <= high:
        raise HTTPException(400, f'tile_size must be between {low} and {high} px')
    return tile_size


def _require_map_runner(needed: bool) -> None:
    """Tiling and pre-annotation run under the map runner; refuse them up front when this
    deployment has none, rather than queue a dataset that fails on its first run."""
    problem = jobs.map_runner_problem() if needed else None
    if problem:
        raise HTTPException(400, problem)


def _valid_map_phases(run_tile: bool, run_predict: bool, tile_size: int) -> int:
    _require_map_runner(run_tile or run_predict)
    return _valid_tile_size(tile_size) if run_tile else tile_size


def _valid_line_width(line_width: int) -> int:
    if not 1 <= line_width <= 25:
        raise HTTPException(400, 'line_width must be between 1 and 25')
    return line_width


def _resolve_map_model(conn, is_map: bool, model_id, run_predict: bool, task: str = 'map_segmentation'):
    """Validate a map job's model selection; return (model_id | None, seed_classes).
    seed_classes is the classes_payload the job's vocabulary is seeded from — the model's
    when one is chosen, else the legacy default. Non-map jobs get (None, None).

    Line jobs are the exception: they still pick a model (it supplies the checkpoint to
    predict with) but ignore its vocabulary, seeding the single 'edge lines' class instead,
    because an outline does not inherit the class of the surface it bounded."""
    if not is_map:
        return None, None
    model_id = (model_id or '').strip() or None
    model = model_registry.get_model(model_id) if model_id else None
    if model_id and model is None:
        raise HTTPException(400, f'unknown map model: {model_id}')
    if run_predict and model is None and model_registry.list_models():
        raise HTTPException(400, 'model pre-annotation requires selecting a map model')
    if task == 'map_lines':
        return model_id, map_classes.line_classes_payload()
    classes = model_registry.classes_payload(model) if model else map_classes.classes_payload()
    return model_id, classes


def _job_payload(conn, row, shared_with: list[str] | None = None) -> dict:
    """One dataset as the list and the detail view read it. Deliberately without its size
    on disk: that means walking every rendition and line crop of every dataset the caller
    can see, which is what the dataset list spent its time on before rendering anything.
    The info endpoint reports it, beside the breakdown that gives it meaning. The list
    passes `shared_with` in, read once for every dataset it shows."""
    job = store.job_row_to_dict(row)
    if shared_with is None:
        shared_with = [r['username'] for r in conn.execute(
            'SELECT username FROM job_assignees WHERE job_id = ? ORDER BY username', (job['id'],))]
    job['shared_with'] = shared_with
    return job


PHASE_CAPABILITIES = (('run_layout', 'pipeline.layout'), ('run_lines', 'pipeline.lines'),
                     ('run_ocr', 'pipeline.ocr'))


def _require_phase_grants(user: dict, **phases: bool) -> None:
    """Making a dataset or adding pages to one queues its phases, so it asks for the grants
    a re-run of those phases would."""
    for phase, capability in PHASE_CAPABILITIES:
        if phases[phase]:
            check_capability(user, capability)


@router.post('/api/jobs')
def create_job(name: str = Form(...), line_mode: str = Form('per_crop'), task: str = Form('text'),
               page_reading_order: str = Form(reading_order.AUTO),
               run_layout: bool = Form(True), run_lines: bool = Form(True), run_ocr: bool = Form(True),
               run_predict: bool = Form(False), model_id: str = Form(''),
               run_tile: bool = Form(False), tile_size: int = Form(512), tile_skip_blank: bool = Form(True),
               line_width: int = Form(3),
               model_layout_id: int | None = Form(None), model_lines_id: int | None = Form(None),
               model_ocr_id: int | None = Form(None), ocr_decode: str = Form(decode.DEFAULT_DECODE),
               gt_autocheck: bool = Form(False), gt_ordered: bool = Form(False),
               gt_from_pdf: bool = Form(False), layout_template_id: int | None = Form(None),
               hold: bool = Form(False), as_test: bool = Form(False),
               ocr_convention: str = Form('{}'), data_use: str = Form('{}'),
               files: list[UploadFile] = None, conn=Depends(get_db),
               user: str = Depends(get_user), _editor=Depends(require_role('admin', 'member'))):
    """Create a dataset from uploaded files - a .txt beside an image is ingested as that page's transcription.
    With `hold`, it waits as 'uploading' while more batches are added, until it is started."""
    if not files:
        raise HTTPException(400, 'no files uploaded')
    ingest.valid_task(task)
    ingest.valid_line_mode(line_mode)
    name = ingest.require_unique_name(conn, name)
    is_map = ingest.is_tile_task(task)
    # Map jobs annotate pre-cut tiles: images only (no PDF expansion) and no text phases.
    extensions = config.IMAGE_EXTENSIONS if is_map else config.INGEST_EXTENSIONS
    # Loop vars are prefixed: `task` and `model_id` are the map job's own parameters.
    models = {'layout': model_layout_id, 'lines': model_lines_id, 'ocr': model_ocr_id}
    for _mtask, _mid in models.items():
        if _mid is not None:
            _require_model_choice(conn, _mid, _mtask)
    _valid_ocr_decode(ocr_decode)
    # Everything that can refuse the request is asked before a file is written.
    if is_map:
        run_layout = run_lines = run_ocr = False
    granted_layout, granted_lines, granted_ocr, _ = ingest.coherent_phases(
        run_layout, run_lines, run_ocr, line_mode)
    _require_phase_grants(_editor, run_layout=granted_layout, run_lines=granted_lines,
                          run_ocr=granted_ocr)
    run_predict = run_predict and is_map  # prediction is a map-only phase
    run_tile = run_tile and is_map        # tiling is a map-only phase
    tile_size = _valid_map_phases(run_tile, run_predict, tile_size)
    line_width = _valid_line_width(line_width)
    if page_reading_order not in reading_order.CHOICES:
        raise HTTPException(400, f'reading order must be one of {list(reading_order.CHOICES)}')
    model_id, seed_classes = _resolve_map_model(conn, is_map, model_id, run_predict, task)
    _require_layout_template(conn, layout_template_id)
    try:
        convention = _valid_convention(json.loads(ocr_convention or '{}'))
    except json.JSONDecodeError:
        raise HTTPException(400, 'the convention is not JSON')
    try:
        uses = _valid_data_use(json.loads(data_use or '{}'))
    except json.JSONDecodeError:
        raise HTTPException(400, 'the data use is not JSON')
    job_id = uuid4().hex[:12]
    try:
        images, transcriptions = ingest.split_transcriptions(files)
        saved, skipped = ingest.save_uploads(job_id, images, 0, extensions=extensions)
    except ingest.IngestError as e:
        shutil.rmtree(config.job_dir(job_id), ignore_errors=True)
        raise HTTPException(e.status_code, e.detail)
    if not saved:
        shutil.rmtree(config.job_dir(job_id), ignore_errors=True)
        detail = 'no image files in upload' if is_map else 'no image or PDF files in upload'
        if skipped:
            raise HTTPException(400, f'{detail} (skipped {", ".join(skipped[:5])})')
        raise HTTPException(400, detail)

    gt_from_pdf = gt_from_pdf and not is_map  # map jobs have no transcriptions at all
    sidecars, corpus_texts = ingest.partition_transcriptions(saved, transcriptions)
    if is_map:
        corpus_texts = {}  # map jobs have no transcriptions at all
    try:
        gt_texts = ingest.ground_truth_texts(saved, sidecars, gt_from_pdf)
    except ingest.IngestError as e:
        shutil.rmtree(config.job_dir(job_id), ignore_errors=True)
        raise HTTPException(e.status_code, e.detail)

    run_layout, run_lines, run_ocr, line_mode = ingest.coherent_phases(
        run_layout, run_lines, run_ocr, line_mode)
    conn.execute(
        'INSERT INTO jobs (id, name, owner, line_mode, task, run_layout, run_lines, run_ocr, '
        'run_predict, model_id, run_tile, tile_size, tile_skip_blank, line_width, '
        'model_layout_id, model_lines_id, model_ocr_id, ocr_decode, gt_autocheck, gt_ordered, '
        'gt_from_pdf, reading_order, new_pages_test, status) '
        'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        (job_id, name, user, line_mode, task, int(run_layout), int(run_lines), int(run_ocr),
         int(run_predict), model_id, int(run_tile), tile_size, int(tile_skip_blank), line_width,
         models['layout'], models['lines'], models['ocr'], ocr_decode, int(gt_autocheck),
         int(gt_ordered), int(gt_from_pdf), page_reading_order, int(as_test),
         UPLOADING if hold else 'queued'))
    _set_convention(conn, job_id, convention)
    _set_data_use(conn, job_id, uses)
    # Tiling jobs register the uploads as full maps (job_maps); the tile phase produces
    # the page rows. Non-tiling jobs treat each upload as a ready tile (a page).
    if run_tile:
        ingest.insert_maps(conn, job_id, saved)
    else:
        page_ids = ingest.insert_pages(conn, job_id, saved)
    if is_map:
        store.seed_job_classes(conn, job_id, seed_classes)
    else:
        layout_templates.copy_into(conn, job_id, layout_template_id)
        ingest.attach_ground_truth(conn, page_ids, gt_texts)
        corpus.store_documents(conn, job_id, corpus_texts)
    conn.commit()
    return {'job_id': job_id, 'documents': len(corpus_texts)}


def _valid_convention(requested) -> dict[str, bool]:
    if not isinstance(requested, dict):
        raise HTTPException(400, 'the convention is a map of flag names to true or false')
    try:
        return conventions.validate(requested)
    except ValueError as error:
        raise HTTPException(400, str(error))


def _valid_data_use(requested) -> dict[str, bool]:
    if not isinstance(requested, dict) or set(requested) - set(store.DATA_USE_COLUMNS) \
            or not all(isinstance(on, bool) for on in requested.values()):
        raise HTTPException(400, f'the data use is a map of {", ".join(store.DATA_USE_COLUMNS)} to true or false')
    return requested


def _set_data_use(conn, job_id: str, uses: dict[str, bool]) -> None:
    for use, on in uses.items():
        conn.execute(f'UPDATE jobs SET {store.DATA_USE_COLUMNS[use]} = ? WHERE id = ?', (int(on), job_id))


def _set_convention(conn, job_id: str, convention: dict[str, bool]) -> None:
    """The flags a dataset starts with, picked when it was created."""
    if convention:
        conn.execute('UPDATE jobs SET ocr_convention = ? WHERE id = ?', (json.dumps(convention), job_id))
        conventions.note(conn, [name for name, on in convention.items() if on])


def _require_layout_template(conn, template_id: int | None) -> None:
    if template_id is not None and not conn.execute('SELECT 1 FROM layout_templates WHERE id = ?',
                                                    (template_id,)).fetchone():
        raise HTTPException(400, f'no layout template {template_id}')


@router.post('/api/jobs/import')
def import_job(name: str = Form(...), reviewed: bool = Form(True), data_use: str = Form('{}'),
               file: UploadFile = None, conn=Depends(get_db),
               user: str = Depends(get_user), _editor=Depends(require_role('admin', 'member'))):
    """Transkribus/eScriptorium-style export: pages arrive segmented and
    transcribed, so no pipeline phase has to run - only the ingest phase, which
    builds the renditions the viewer needs."""
    if file is None:
        raise HTTPException(400, 'no file uploaded')
    name = ingest.require_unique_name(conn, name)
    try:
        uses = _valid_data_use(json.loads(data_use or '{}'))
    except json.JSONDecodeError:
        raise HTTPException(400, 'the data use is not JSON')
    try:
        pages = imports.read_export_zip(file.file)
    except imports.ScansOnly as e:
        # Its own status, so the page can send the same zip on as an upload of scans.
        raise HTTPException(422, e.detail)
    except imports.ImportError_ as e:
        raise HTTPException(400, e.detail)
    except ingest.IngestError as e:
        raise HTTPException(e.status_code, e.detail)
    job_id = uuid4().hex[:12]
    uploads = config.job_dir(job_id) / 'uploads'
    uploads.mkdir(parents=True, exist_ok=True)
    try:
        entries = imports.extract_images(file.file, pages, uploads)
    except ingest.IngestError as e:
        shutil.rmtree(config.job_dir(job_id), ignore_errors=True)
        raise HTTPException(e.status_code, e.detail)
    try:
        conn.execute('INSERT INTO jobs (id, name, owner, line_mode, run_layout, run_lines, run_ocr) '
                     "VALUES (?,?,?,'per_page',0,0,0)", (job_id, name, user))
        _set_data_use(conn, job_id, uses)
        layout_templates.copy_into(conn, job_id)
        # An import may bring classes this instance's template lacks; they join the
        # dataset. Matched without case, as class names are (a Schematismus dataset stores
        # PageNumber as Pagenumber); the unassigned lines' holder is not a class.
        known = {c['name'].lower() for c in layout_templates.job_classes(conn, job_id)}
        brought = {r['class_name']: r.get('kind') or 'content' for p in pages
                   for r in p['regions'] if r.get('kind') != 'orphan'}
        for name in sorted(n for n in brought if n.lower() not in known):
            layout_templates.add_class(conn, job_id, name, 'container' if brought[name] == 'container' else 'content',
                                       'down' if brought[name] == 'container' else None)
        # Image name order, as an import has always been laid out.
        ingest.insert_pages(conn, job_id, sorted(entries))
        counts = imports.ingest_pages(conn, job_id, pages, f'import:{user}', reviewed)
    except Exception:
        # Nothing of a failed import stays: neither its unpacked images nor a half-made dataset.
        conn.rollback()
        shutil.rmtree(config.job_dir(job_id), ignore_errors=True)
        raise
    return {'job_id': job_id, 'format': pages[0].get('format'), **counts}


class JobOptions(BaseModel):
    name: str
    line_mode: str = 'per_crop'
    task: str = 'text'
    run_layout: bool = True
    run_lines: bool = True
    run_ocr: bool = True
    run_predict: bool = False
    model_id: str | None = None
    run_tile: bool = False
    tile_size: int = 512
    tile_skip_blank: bool = True
    line_width: int = 3
    model_layout_id: int | None = None
    model_lines_id: int | None = None
    model_ocr_id: int | None = None
    ocr_decode: str = decode.DEFAULT_DECODE
    gt_autocheck: bool = False
    gt_ordered: bool = False
    gt_from_pdf: bool = False
    page_reading_order: str = reading_order.AUTO
    layout_template_id: int | None = None
    ocr_convention: dict[str, bool] = {}
    data_use: dict[str, bool] = {}


class PathJob(JobOptions):
    server_path: str


class IiifJob(JobOptions):
    manifest: str
    canvases: list[str]


def _checked_options(conn, body: JobOptions, grants) -> dict:
    """What a JSON-created dataset will run, once everything that can refuse it has been asked."""
    ingest.valid_task(body.task)
    ingest.valid_line_mode(body.line_mode)
    is_map = ingest.is_tile_task(body.task)
    models = {'layout': body.model_layout_id, 'lines': body.model_lines_id, 'ocr': body.model_ocr_id}
    for _mtask, _mid in models.items():
        if _mid is not None:
            _require_model_choice(conn, _mid, _mtask)
    _valid_ocr_decode(body.ocr_decode)
    run_layout, run_lines, run_ocr, line_mode = ingest.coherent_phases(
        not is_map and body.run_layout, not is_map and body.run_lines,
        not is_map and body.run_ocr, body.line_mode)
    _require_phase_grants(grants, run_layout=run_layout, run_lines=run_lines, run_ocr=run_ocr)
    run_predict = body.run_predict and is_map  # prediction is a map-only phase
    run_tile = body.run_tile and is_map        # tiling is a map-only phase
    tile_size = _valid_map_phases(run_tile, run_predict, body.tile_size)
    line_width = _valid_line_width(body.line_width)
    if body.page_reading_order not in reading_order.CHOICES:
        raise HTTPException(400, f'reading order must be one of {list(reading_order.CHOICES)}')
    model_id, seed_classes = _resolve_map_model(conn, is_map, body.model_id, run_predict, body.task)
    _require_layout_template(conn, body.layout_template_id)
    return {'name': ingest.require_unique_name(conn, body.name), 'is_map': is_map, 'models': models,
            'run_layout': run_layout, 'run_lines': run_lines, 'run_ocr': run_ocr, 'line_mode': line_mode,
            'run_predict': run_predict, 'run_tile': run_tile, 'tile_size': tile_size, 'line_width': line_width,
            'model_id': model_id, 'seed_classes': seed_classes,
            'convention': _valid_convention(body.ocr_convention), 'data_use': _valid_data_use(body.data_use),
            'gt_from_pdf': body.gt_from_pdf and not is_map}  # map jobs have no transcriptions at all


def _insert_job(conn, job_id: str, user: str, body: JobOptions, o: dict,
                source_path: str | None = None, iiif_source: dict | None = None) -> None:
    conn.execute(
        'INSERT INTO jobs (id, name, owner, source_path, iiif_source, line_mode, task, run_layout, run_lines, '
        'run_ocr, run_predict, model_id, run_tile, tile_size, tile_skip_blank, line_width, '
        'model_layout_id, model_lines_id, model_ocr_id, ocr_decode, gt_autocheck, gt_ordered, '
        'gt_from_pdf, reading_order) '
        'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        (job_id, o['name'], user, source_path, json.dumps(iiif_source) if iiif_source else None,
         o['line_mode'], body.task, int(o['run_layout']), int(o['run_lines']), int(o['run_ocr']),
         int(o['run_predict']), o['model_id'], int(o['run_tile']), o['tile_size'], int(body.tile_skip_blank),
         o['line_width'], o['models']['layout'], o['models']['lines'], o['models']['ocr'], body.ocr_decode,
         int(body.gt_autocheck), int(body.gt_ordered), int(o['gt_from_pdf']), body.page_reading_order))
    _set_convention(conn, job_id, o['convention'])
    _set_data_use(conn, job_id, o['data_use'])


@router.post('/api/jobs/path')
def create_job_from_path(body: PathJob, conn=Depends(get_db), user: str = Depends(get_user),
                         _admin=Depends(require_role('admin'))):
    """Create a dataset from a directory that already sits on the backend host."""
    o = _checked_options(conn, body, _admin)
    is_map = o['is_map']
    extensions = config.IMAGE_EXTENSIONS if is_map else config.INGEST_EXTENSIONS
    root, sources, skipped_symlinks = ingest.scan_path(body.server_path, extensions=extensions)
    job_id = uuid4().hex[:12]
    config.job_dir(job_id).mkdir(parents=True, exist_ok=True)
    try:
        entries, gt_texts, corpus_texts = ingest.read_path(job_id, root, sources, 0, o['gt_from_pdf'])
    except ingest.IngestError as e:
        shutil.rmtree(config.job_dir(job_id), ignore_errors=True)
        raise HTTPException(e.status_code, e.detail)
    _insert_job(conn, job_id, user, body, o, source_path=str(root))
    # Path-ingested map sources point at the user's external files; purge never touches
    # them (only pages under job_dir). Tile PNGs land in job_dir/tiles/, which purge owns.
    if o['run_tile']:
        ingest.insert_maps(conn, job_id, entries)
    else:
        page_ids = ingest.insert_pages(conn, job_id, entries)
    if is_map:
        store.seed_job_classes(conn, job_id, o['seed_classes'])
        corpus_texts = {}  # map jobs have no transcriptions at all
    else:
        layout_templates.copy_into(conn, job_id, body.layout_template_id)
        ingest.attach_ground_truth(conn, page_ids, gt_texts)
        corpus.store_documents(conn, job_id, corpus_texts)
    conn.commit()
    return {'job_id': job_id, 'documents': len(corpus_texts),
            'skipped_symlinks': skipped_symlinks}


def _read_iiif(url: str) -> dict:
    try:
        return iiif.read(url)
    except iiif.IiifError as error:
        raise HTTPException(400, str(error))


class IiifInspect(BaseModel):
    url: str


@router.post('/api/iiif/inspect')
def inspect_iiif(body: IiifInspect, user: str = Depends(get_user), _editor=Depends(require_role('admin', 'member'))):
    """A manifest's pages, or a collection's members, for the New dataset form to choose from."""
    if not body.url.strip():
        raise HTTPException(400, 'give the address of a IIIF manifest or collection')
    return {**_read_iiif(body.url), 'max_pages': config.IIIF_MAX_PAGES, 'max_width': config.IIIF_MAX_WIDTH}


@router.get('/api/iiif/thumbnail')
def iiif_thumbnail(url: str, user: str = Depends(get_user)):
    """A canvas thumbnail fetched here, so the browser needs no route to the archive and
    the same address checks apply as to the manifest."""
    try:
        body, content_type = iiif.thumbnail(url)
    except iiif.IiifError as error:
        raise HTTPException(502, str(error))
    return Response(content=body, media_type=content_type, headers={'Cache-Control': 'private, max-age=86400'})


def _page_filename(position: int, label: str) -> str:
    slug = re.sub(r'[^0-9A-Za-z]+', '-', label).strip('-')[:40]
    return f'{position:04d}{"_" + slug if slug else ""}.jpg'


@router.post('/api/jobs/iiif')
def create_job_from_iiif(body: IiifJob, conn=Depends(get_db), user: str = Depends(get_user),
                         _editor=Depends(require_role('admin', 'member'))):
    """Create a text dataset from canvases of a IIIF manifest. The manifest is read again
    here rather than trusted from the form; each page's image is downloaded at ingest."""
    if body.task != 'text':
        raise HTTPException(400, 'a IIIF manifest makes a text dataset')
    o = _checked_options(conn, body, _editor)
    manifest = _read_iiif(body.manifest)
    if manifest['kind'] != 'manifest':
        raise HTTPException(400, 'this is a collection - choose one of its manifests')
    chosen = set(body.canvases)
    canvases = [c for c in manifest['canvases'] if c['canvas'] in chosen]
    if not canvases:
        raise HTTPException(400, 'choose at least one page')
    if len(canvases) > config.IIIF_MAX_PAGES:
        raise HTTPException(400, f'{len(canvases)} pages is more than the {config.IIIF_MAX_PAGES} '
                                 'one dataset may import from IIIF')
    job_id = uuid4().hex[:12]
    pages_dir = config.job_dir(job_id) / 'pages'
    pages_dir.mkdir(parents=True, exist_ok=True)
    position = {c['canvas']: i for i, c in enumerate(manifest['canvases'], 1)}
    entries = [(name, str(pages_dir / name)) for name in
               (_page_filename(position[c['canvas']], c['label']) for c in canvases)]
    _insert_job(conn, job_id, user, body, o, iiif_source={
        'manifest': manifest['url'], 'label': manifest['label'],
        'attribution': manifest['attribution'], 'rights': manifest['rights']})
    page_ids = ingest.insert_pages(conn, job_id, entries)
    for (_, source), canvas in zip(entries, canvases):
        conn.execute('UPDATE pages SET iiif = ? WHERE id = ?', (json.dumps(
            {k: canvas[k] for k in ('canvas', 'label', 'width', 'height', 'image')}), page_ids[source]))
    layout_templates.copy_into(conn, job_id, body.layout_template_id)
    conn.commit()
    return {'job_id': job_id, 'pages': len(canvases)}


@router.post('/api/jobs/{job_id}/iiif/retry')
def retry_iiif_downloads(job_id: str, conn=Depends(get_db), user: dict = Depends(current_user)):
    """Download again the IIIF pages whose image could not be fetched."""
    require_job_owner(conn, job_id, user)
    _require_appendable(conn, job_id)
    retried = conn.execute(
        "UPDATE pages SET status = 'pending', error = NULL "
        "WHERE job_id = ? AND deleted = 0 AND status = 'unreadable' AND iiif IS NOT NULL", (job_id,)).rowcount
    if not retried:
        raise HTTPException(409, 'no IIIF page is waiting for its image')
    store.recount_pages(conn, job_id, commit=False)
    _queue_unless_held(conn, job_id)
    conn.commit()
    return {'retried': retried}


UPLOADING = 'uploading'


def _queue_unless_held(conn, job_id: str) -> None:
    """Added pages are processed next - unless the dataset is still waiting for the rest
    of its upload, which its start queues all at once."""
    conn.execute("UPDATE jobs SET status = 'queued', phase = NULL, error = NULL "
                 "WHERE id = ? AND status != ?", (job_id, UPLOADING))


@router.post('/api/jobs/{job_id}/start')
def start_held(job_id: str, conn=Depends(get_db), user: dict = Depends(current_user)):
    """Queue a dataset that waited while its upload arrived in batches."""
    require_job_owner(conn, job_id, user)
    job = store.get_job(conn, job_id)
    if job is None:
        raise HTTPException(404)
    if job['status'] != UPLOADING:
        raise HTTPException(409, f'this dataset is {job["status"]}, not waiting for its upload')
    conn.execute("UPDATE jobs SET status = 'queued' WHERE id = ?", (job_id,))
    conn.commit()
    return {'ok': True}


def _require_appendable(conn, job_id: str) -> dict:
    job = store.get_job(conn, job_id)
    if job is None:
        raise HTTPException(404)
    if job['status'] in ('queued', 'running'):
        raise HTTPException(409, 'job is queued or running')
    return job


def _append_text_pages(conn, job_id: str, entries: list, gt_texts: dict, corpus_texts: dict,
                       as_test: bool | None = None) -> int:
    """Adds a text dataset's pages with the ground truth that came with them and keeps the
    corpus documents among them; returns how many documents were kept."""
    ingest.attach_ground_truth(conn, ingest.insert_pages(conn, job_id, entries, as_test), gt_texts)
    return corpus.store_documents(conn, job_id, corpus_texts)


def _discard_uploads(job_id: str, saved: list[tuple]) -> None:
    """Take back what save_uploads wrote into a dataset that already existed, so a refused
    append leaves its uploads folder as it found it: every file an entry names in there,
    the image itself or the PDF its page was cut from."""
    uploads = config.job_dir(job_id) / 'uploads'
    named = {Path(part) for entry in saved for part in entry if isinstance(part, str)}
    for path in named:
        if path.parent == uploads:
            path.unlink(missing_ok=True)


@router.post('/api/jobs/{job_id}/pages/upload')
def append_uploads(job_id: str, files: list[UploadFile] = None, as_test: bool | None = Form(None),
                   conn=Depends(get_db), user: dict = Depends(current_user)):
    """Add pages to an existing dataset by upload. `as_test` says whether they are test
    pages; left out, they follow the dataset's "New pages are test pages"."""
    require_job_owner(conn, job_id, user)
    job = _require_appendable(conn, job_id)
    _require_phase_grants(user, **{phase: bool(job[phase]) for phase, _ in PHASE_CAPABILITIES})
    if not files:
        raise HTTPException(400, 'no files uploaded')
    is_map = ingest.is_tile_task(job['task'])
    tiling = bool(job.get('run_tile'))
    _require_map_runner(is_map and (tiling or bool(job['run_predict'])))
    extensions = config.IMAGE_EXTENSIONS if is_map else config.INGEST_EXTENSIONS
    offset = ingest.map_count(conn, job_id) if tiling else ingest.page_count(conn, job_id)
    try:
        images, transcriptions = ingest.split_transcriptions(files)
        saved, skipped = ingest.save_uploads(job_id, images, offset, extensions=extensions)
    except ingest.IngestError as e:
        raise HTTPException(e.status_code, e.detail)
    if not saved:
        detail = 'no image files in upload' if is_map else 'no image or PDF files in upload'
        if skipped:
            raise HTTPException(400, f'{detail} (skipped {", ".join(skipped[:5])})')
        raise HTTPException(400, detail)
    if is_map:
        ingest.insert_maps(conn, job_id, saved) if tiling else ingest.insert_pages(conn, job_id, saved, as_test)
        documents = 0
    else:
        # gt_from_pdf is a property of the dataset, so appended pages are treated
        # exactly like the batch the dataset was created from.
        sidecars, corpus_texts = ingest.partition_transcriptions(saved, transcriptions)
        try:
            texts = ingest.ground_truth_texts(saved, sidecars, bool(job['gt_from_pdf']))
        except ingest.IngestError as e:
            _discard_uploads(job_id, saved)
            raise HTTPException(e.status_code, e.detail)
        documents = _append_text_pages(conn, job_id, saved, texts, corpus_texts, as_test)
    _queue_unless_held(conn, job_id)
    conn.commit()
    return {'ok': True, 'added': len(saved), 'documents': documents}


class AppendPath(BaseModel):
    server_path: str


@router.post('/api/jobs/{job_id}/pages/path')
def append_path(job_id: str, body: AppendPath, conn=Depends(get_db),
                _admin=Depends(require_role('admin'))):
    """Add pages to an existing dataset from a directory on the backend host."""
    job = _require_appendable(conn, job_id)
    _require_phase_grants(_admin, **{phase: bool(job[phase]) for phase, _ in PHASE_CAPABILITIES})
    is_map = ingest.is_tile_task(job['task'])
    tiling = bool(job.get('run_tile'))
    _require_map_runner(is_map and (tiling or bool(job['run_predict'])))
    extensions = config.IMAGE_EXTENSIONS if is_map else config.INGEST_EXTENSIONS
    root, sources, skipped_symlinks = ingest.scan_path(body.server_path, extensions=extensions)
    offset = ingest.map_count(conn, job_id) if tiling else ingest.page_count(conn, job_id)
    try:
        # gt_from_pdf is a property of the dataset, so appended pages are treated
        # exactly like the batch the dataset was created from.
        entries, texts, corpus_texts = ingest.read_path(
            job_id, root, sources, offset, bool(job['gt_from_pdf']) and not is_map)
    except ingest.IngestError as e:
        raise HTTPException(e.status_code, e.detail)
    if is_map:
        ingest.insert_maps(conn, job_id, entries) if tiling else ingest.insert_pages(conn, job_id, entries)
        documents = 0
    else:
        documents = _append_text_pages(conn, job_id, entries, texts, corpus_texts)
    _queue_unless_held(conn, job_id)
    conn.commit()
    return {'ok': True, 'added': len(entries), 'documents': documents,
            'skipped_symlinks': skipped_symlinks}


@router.get('/api/jobs', responses={200: {'model': list[schemas.JobSummary]}})
def list_jobs(conn=Depends(get_db), user: dict = Depends(current_user)):
    """Datasets the caller may see: their own, those shared with them, everything for an admin."""
    if user['role'] == 'admin':
        rows = conn.execute('SELECT * FROM jobs ORDER BY created_at DESC').fetchall()
    else:
        rows = conn.execute(
            'SELECT * FROM jobs WHERE owner = ? '
            'OR id IN (SELECT job_id FROM job_assignees WHERE username = ?) '
            'OR group_id IN (SELECT group_id FROM group_assignees WHERE username = ?) '
            'ORDER BY created_at DESC',
            (user['username'], user['username'], user['username'])).fetchall()
    progress = caches.job_progress(conn)
    shared: dict[str, list[str]] = {}
    for r in conn.execute('SELECT job_id, username FROM job_assignees ORDER BY username'):
        shared.setdefault(r['job_id'], []).append(r['username'])
    empty = {'pages_total': 0, 'layout_checked_pages': 0, 'test_pages': 0, 'lines_total': 0, 'lines_done': 0}
    payloads = []
    for row in rows:
        job = _job_payload(conn, row, shared.get(row['id'], []))
        job.update(progress.get(job['id'], empty))
        payloads.append(job)
    return payloads


def _map_job_payload(conn, job: dict, job_id: str) -> dict:
    """Job detail for a tile-annotation job (map_segmentation / map_lines): per-tile
    region counts instead of the element/line stats, and simplified job-level tile
    tallies. Region counts are kind-agnostic — a traced line counts like a polygon."""
    counts = {r['page_id']: r for r in conn.execute(
        'SELECT page_id, COUNT(*) total, SUM(checked) checked FROM regions '
        'WHERE deleted = 0 AND page_id IN (SELECT id FROM pages WHERE job_id = ?) '
        'GROUP BY page_id', (job_id,))}
    job['pages'] = [
        {**dict(p),
         'layout_checked': bool(p['layout_checked']),
         'lines_checked': bool(p['lines_checked']),
         'deleted': bool(p['deleted']),
         'min_confidence': None, 'avg_confidence': None,
         'elements_total': 0, 'elements_checked': 0,
         'regions_total': counts[p['id']]['total'] if p['id'] in counts else 0,
         'regions_checked': (counts[p['id']]['checked'] or 0) if p['id'] in counts else 0}
        for p in conn.execute(
            'SELECT id, idx, filename, width, height, status, layout_checked, lines_checked, deleted '
            'FROM pages WHERE job_id = ? ORDER BY idx', (job_id,))]
    # A duplicate or an unreadable scan is never rendered or exported, so it is no tile to
    # annotate or review.
    tiles = [p for p in job['pages'] if not p['deleted'] and p['status'] not in caches.UNCOUNTED_STATUSES]
    job['tiles_total'] = len(tiles)
    job['tiles_annotated'] = sum(1 for p in tiles if p['regions_total'])
    job['tiles_reviewed'] = sum(1 for p in tiles if p['layout_checked'])
    # pages_checked keeps the same "fully reviewed tiles" meaning the jobs list reads.
    job['pages_checked'] = job['tiles_reviewed']
    return job


@router.get('/api/jobs/{job_id}', responses={200: {'model': schemas.JobDetail}})
def get_job(job_id: str, pages: bool = True, conn=Depends(get_db),
            user: dict = Depends(current_user)):
    """One dataset with its pages, counters and per-page review state.

    `pages=false` leaves the page list out. The largest dataset here holds 18,580 of them
    and they are 10 MB of JSON, which is worth avoiding for a caller that reads the table
    a screenful at a time from /page-rows. `pages_live` is always there either way, since
    a caller without the list still has to say how many pages the dataset has.
    """
    require_job_access(conn, job_id, user)
    row = conn.execute('SELECT * FROM jobs WHERE id = ?', (job_id,)).fetchone()
    if row is None:
        raise HTTPException(404)
    data_use.note_admin_visit(conn, job_id, user)
    job = _job_payload(conn, row)
    job['unreadable'] = [{**dict(r), 'iiif': bool(r['iiif'])} for r in conn.execute(
        "SELECT id, filename, error, iiif FROM pages WHERE job_id = ? AND deleted = 0 AND status = 'unreadable' "
        'ORDER BY idx', (job_id,))]
    job['pages_live'] = conn.execute(
        f'SELECT COUNT(*) c FROM pages WHERE job_id = ? AND {caches.counted_page()}',
        (job_id,)).fetchone()['c']
    job['reading_order_template'] = layout_templates.order_set_by(conn, job_id)
    if ingest.is_tile_task(job['task']):
        job = _map_job_payload(conn, job, job_id)
        if not pages:
            job.pop('pages', None)
        return job
    # The table's own "Lines reviewed" chip, so the header and the chip cannot disagree.
    job['pages_checked'] = page_rows.counts(conn, job_id, task=job['task'])['lines-reviewed']
    if not pages:
        job.pop('pages', None)
        return job
    stats = {r['page_id']: r for r in conn.execute(
        'SELECT e.page_id page_id, min(l.confidence) mn, avg(l.confidence) av '
        'FROM lines l JOIN elements e ON l.element_id = e.id '
        'JOIN pages p ON e.page_id = p.id '
        'WHERE p.job_id = ? AND p.deleted = 0 AND e.deleted = 0 AND l.deleted = 0 AND l.confidence IS NOT NULL '
        'GROUP BY e.page_id', (job_id,))}
    # An element counts as reviewed once every one of its live lines is checked
    # (or it was marked checked directly), so line-by-line checking rolls up here.
    checks = {r['page_id']: r for r in conn.execute(
        "SELECT e.page_id page_id, COUNT(*) total, "
        "  SUM(CASE WHEN e.checked = 1 OR (lc.n > 0 AND lc.unchecked = 0) THEN 1 ELSE 0 END) done "
        "FROM elements e "
        "LEFT JOIN (SELECT element_id, COUNT(*) n, SUM(CASE WHEN checked = 0 THEN 1 ELSE 0 END) unchecked "
        "           FROM lines WHERE deleted = 0 GROUP BY element_id) lc ON lc.element_id = e.id "
        "WHERE e.kind = 'content' AND e.class_name != 'Divider' AND e.deleted = 0 "
        "AND e.page_id IN (SELECT id FROM pages WHERE job_id = ?) "
        'GROUP BY e.page_id', (job_id,))}
    # Every live line, whatever holds it. A dataset that skipped layout keeps all of them
    # in one kind='orphan' bucket per page, which the element counts above exclude - so
    # without this its review progress reads as 0/0 however much of it is done.
    line_counts = {r['page_id']: r for r in conn.execute(
        'SELECT e.page_id page_id, COUNT(*) total, '
        '  SUM(CASE WHEN l.checked = 1 THEN 1 ELSE 0 END) done '
        'FROM lines l JOIN elements e ON l.element_id = e.id '
        "WHERE e.deleted = 0 AND l.deleted = 0 AND e.kind != 'container' "
        'AND e.page_id IN (SELECT id FROM pages WHERE job_id = ?) '
        'GROUP BY e.page_id', (job_id,))}
    # How many language models have a reading standing on this page, so the table can mark
    # the rows that have been transcribed. Dismissed readings are a model's earlier word,
    # replaced since, and do not count as one it holds.
    readers = {r['page_id']: r['models'] for r in conn.execute(
        'SELECT page_id, COUNT(DISTINCT llm_model_id) models FROM candidates '
        "WHERE source = 'llm' AND dismissed = 0 AND llm_model_id IS NOT NULL "
        'AND page_id IN (SELECT id FROM pages WHERE job_id = ?) GROUP BY page_id', (job_id,))}
    job['pages'] = [
        {**dict(p),
         'layout_checked': bool(p['layout_checked']),
         'lines_checked': bool(p['lines_checked']),
         'deleted': bool(p['deleted']),
         'is_test': bool(p['is_test']),
         'llm_models': readers.get(p['id'], 0),
         'min_confidence': stats[p['id']]['mn'] if p['id'] in stats else None,
         'avg_confidence': stats[p['id']]['av'] if p['id'] in stats else None,
         'elements_total': checks[p['id']]['total'] if p['id'] in checks else 0,
         'elements_checked': (checks[p['id']]['done'] or 0) if p['id'] in checks else 0,
         'lines_total': line_counts[p['id']]['total'] if p['id'] in line_counts else 0,
         'lines_reviewed': (line_counts[p['id']]['done'] or 0) if p['id'] in line_counts else 0}
        for p in conn.execute(
            'SELECT id, idx, filename, width, height, status, layout_checked, lines_checked, deleted, is_test '
            'FROM pages WHERE job_id = ? ORDER BY idx', (job_id,))]
    return job


@router.get('/api/jobs/{job_id}/info')
def job_info(job_id: str, conn=Depends(get_db), user: dict = Depends(current_user)):
    """Where a dataset came from and what it holds: who uploaded it when, what was
    uploaded, how much annotation sits on it, who has edited it, and where its bytes go."""
    require_job_access(conn, job_id, user)
    row = conn.execute('SELECT * FROM jobs WHERE id = ?', (job_id,)).fetchone()
    if row is None:
        raise HTTPException(404)
    job = _job_payload(conn, row)
    pages = conn.execute(
        'SELECT COUNT(*) AS live, COUNT(DISTINCT source_pdf) AS documents, '
        'SUM(source_pdf IS NOT NULL) AS from_documents, '
        "SUM(COALESCE(gt_text, '') != '') AS transcribed "
        f'FROM pages WHERE job_id = ? AND {caches.counted_page()}', (job_id,)).fetchone()
    deleted = conn.execute(
        'SELECT COUNT(*) FROM pages WHERE job_id = ? AND deleted = 1', (job_id,)).fetchone()[0]
    duplicates = conn.execute(
        "SELECT COUNT(*) FROM pages WHERE job_id = ? AND deleted = 0 AND status = 'duplicate'",
        (job_id,)).fetchone()[0]
    maps = conn.execute(
        'SELECT COUNT(*) FROM job_maps WHERE job_id = ? AND deleted = 0', (job_id,)).fetchone()[0]
    elements = conn.execute(
        'SELECT COUNT(*) FROM elements e JOIN pages p ON e.page_id = p.id '
        'WHERE p.job_id = ? AND p.deleted = 0 AND e.deleted = 0', (job_id,)).fetchone()[0]
    lines = conn.execute(
        'SELECT COUNT(*) AS total, SUM(l.checked) AS checked FROM lines l '
        'JOIN elements e ON l.element_id = e.id JOIN pages p ON e.page_id = p.id '
        'WHERE p.job_id = ? AND p.deleted = 0 AND e.deleted = 0 AND l.deleted = 0',
        (job_id,)).fetchone()
    regions = conn.execute(
        'SELECT COUNT(*) AS total, SUM(checked) AS checked FROM regions WHERE deleted = 0 '
        'AND page_id IN (SELECT id FROM pages WHERE job_id = ? AND deleted = 0)',
        (job_id,)).fetchone()
    # People only: the pipeline, alignment, the LLM and an import log their passes as
    # revisions too, and those are the dataset's provenance, not its contributors. The
    # upload itself leaves no revision, so an untouched dataset simply has no editors.
    editors = conn.execute(
        'SELECT author, COUNT(*) AS edits, MAX(created_at) AS last_at FROM revisions '
        f'WHERE job_id = ? AND {store.person_author_sql()} '
        'GROUP BY author ORDER BY edits DESC, author', (job_id,)).fetchall()
    group = conn.execute(
        'SELECT name FROM groups WHERE id = ?', (job['group_id'],)).fetchone() if job['group_id'] else None
    disk = caches.job_disk_usage(job_id)
    models = {}
    for task, column in MODEL_COLUMNS.items():
        model = registry.get_model(conn, job[column]) if job[column] else None
        models[task] = model['name'] if model else None
    return {
        'owner': job['owner'],
        'created_at': job['created_at'],
        'task': job['task'],
        'line_mode': job['line_mode'],
        'group': group['name'] if group else None,
        'shared_with': job['shared_with'],
        'pages': pages['live'],
        'pages_deleted': deleted,
        'pages_duplicate': duplicates,
        'documents': pages['documents'],
        'images': pages['live'] - (pages['from_documents'] or 0),
        'maps': maps,
        'transcriptions': pages['transcribed'] or 0,
        'elements': elements,
        'lines': lines['total'],
        'lines_checked': lines['checked'] or 0,
        'regions': regions['total'],
        'regions_checked': regions['checked'] or 0,
        # The one place the walk is worth doing, and the one place the total is shown.
        'disk_bytes': sum(disk.values()),
        'disk': disk,
        'editors': [dict(e) for e in editors],
        'models': models,
    }


@router.get('/api/jobs/{job_id}/review')
def review_queue(job_id: str, max_conf: float = 0.85, include_checked: bool = False,
                 conn=Depends(get_db), user: dict = Depends(current_user)):
    """Lines worth reviewing, in reading order across the whole job: the ones the OCR model
    doubted, and the ones language models settled among themselves that nobody has checked -
    however sure the OCR model was, an unchecked line is review work - and the ones an
    evaluation page sent here, checked or not."""
    require_job_access(conn, job_id, user)
    if conn.execute('SELECT id FROM jobs WHERE id = ?', (job_id,)).fetchone() is None:
        raise HTTPException(404)
    doubted = 'l.confidence IS NOT NULL AND l.confidence < ? ' + ('' if include_checked else 'AND l.checked = 0 ')
    settled = 'l.corrected_by LIKE ? AND l.checked = 0'
    # Sent from an evaluation page: queued checked or not, until a person checks it again.
    flagged = 'rf.line_id IS NOT NULL'
    rows = conn.execute(
        'SELECT l.id, l.confidence, e.page_id, p.idx page_idx, rf.line_id IS NOT NULL flagged '
        'FROM lines l JOIN elements e ON l.element_id = e.id JOIN pages p ON e.page_id = p.id '
        'LEFT JOIN review_flags rf ON rf.line_id = l.id '
        f"WHERE p.job_id = ? AND {caches.counted_page('p')} AND e.kind != 'container' "
        "AND e.class_name != 'Divider' AND e.deleted = 0 AND l.deleted = 0 "
        f'AND (({doubted}) OR ({settled}) OR ({flagged})) '
        'ORDER BY p.idx, e.order_idx, l.order_idx',
        (job_id, max_conf, consensus.SETTLED_BY + '%')).fetchall()
    return {'max_conf': max_conf, 'total': len(rows),
            'lines': [{'id': r['id'], 'page_id': r['page_id'], 'page_idx': r['page_idx'],
                       'confidence': r['confidence'], 'flagged': bool(r['flagged'])} for r in rows]}


@router.get('/api/jobs/{job_id}/events')
async def job_events(job_id: str, user: dict = Depends(current_user)):
    """Server-sent events: status, phase and counters as the dataset progresses."""
    conn = store.connect(config.DB_PATH)
    try:
        require_job_access(conn, job_id, user)
    finally:
        conn.close()

    async def stream():
        while True:
            conn = store.connect(config.DB_PATH)
            job = store.get_job(conn, job_id)
            conn.close()
            if job is None:
                break
            payload = {'status': job['status'], 'phase': job['phase'], 'counters': job['counters']}
            yield f'data: {json.dumps(payload)}\n\n'
            if job['status'] in TERMINAL_STATUSES:
                break
            await asyncio.sleep(1)
    return StreamingResponse(stream(), media_type='text/event-stream')


OCR_DECODES = decode.OCR_DECODES


def _valid_ocr_decode(value: str) -> str:
    if value not in OCR_DECODES:
        raise HTTPException(400, f'ocr_decode must be one of {OCR_DECODES}')
    return value


def _require_model_choice(conn, model_id: int, task: str):
    model = registry.get_model(conn, model_id)
    if model is None or model['task'] != task:
        raise HTTPException(400, f'not an available {task} model')
    if model['archived']:
        raise HTTPException(409, 'archived models cannot be selected')


class JobPatch(BaseModel):
    checked: bool | None = None
    gt_autocheck: bool | None = None
    gt_ordered: bool | None = None
    auto_redetect: bool | None = None
    name: str | None = None
    group_id: int | None = None
    line_width: int | None = None
    # Which text phases the next run performs, and whether line detection works inside the
    # layout boxes or across the whole page. Set at creation until now, so a dataset could
    # never be moved between the two once its first run had happened.
    line_mode: str | None = None
    # How the pages are laid out, for ordering the lines of a page with no layout boxes:
    # 'auto', or '<leaves>x<columns>'. Changing it re-orders the pages it applies to.
    reading_order: str | None = None
    # 'box' or 'polygon': how the dataset's layout elements are drawn and edited.
    layout_shape: str | None = None
    run_layout: bool | None = None
    run_lines: bool | None = None
    run_ocr: bool | None = None
    # A map dataset's tile size, for the maps cut from then on; tiles already cut keep theirs.
    tile_size: int | None = None
    model_layout_id: int | None = None
    model_lines_id: int | None = None
    model_ocr_id: int | None = None
    ocr_decode: str | None = None
    # The transcription-convention flags this dataset asks its OCR model for.
    ocr_convention: dict[str, bool] | None = None
    llm_consensus_min: int | None = None
    llm_autocheck: bool | None = None
    llm_consensus_with_ocr: bool | None = None
    llm_prompt: str | None = None
    # Wording for the diplomatic reading that turns a corpus span into ground truth, and
    # how many corpus lines of slack each page's span is given.
    gt_prompt: str | None = None
    reference_overlap: int | None = None
    # The models this dataset is read with, settable without starting a read - which is
    # otherwise the only thing that writes them.
    llm_model_ids: list[int] | None = None
    # Whether pages added from now on arrive as test pages.
    new_pages_test: bool | None = None


PROCESSING_FIELDS = ('line_mode', 'run_layout', 'run_lines', 'run_ocr')


def _patch_processing(conn, job_id: str, job, body: JobPatch, fields: set, user: dict) -> None:
    """Change which text phases a dataset runs, and where its lines are looked for.

    It takes effect from the next run: nothing already recognised is discarded, and the
    runner reads these when it starts, so changing them mid-run would have the phases
    disagree with the pages they are producing. Hence the refusal while one is in flight."""
    if user['role'] != 'admin' and job['owner'] != user['username']:
        raise HTTPException(403, 'not permitted')
    if ingest.is_tile_task(job['task'] or 'text'):
        raise HTTPException(400, 'a tile dataset runs no text phases')
    if job['status'] in ('queued', 'running'):
        raise HTTPException(409, 'the dataset is already queued or running')

    def wanted(name: str, current):
        asked = getattr(body, name)
        return current if name not in fields or asked is None else asked

    run_layout, run_lines, run_ocr, line_mode = ingest.coherent_phases(
        wanted('run_layout', bool(job['run_layout'])),
        wanted('run_lines', bool(job['run_lines'])),
        wanted('run_ocr', bool(job['run_ocr'])),
        ingest.valid_line_mode(wanted('line_mode', job['line_mode'])))
    conn.execute(
        'UPDATE jobs SET line_mode = ?, run_layout = ?, run_lines = ?, run_ocr = ? WHERE id = ?',
        (line_mode, int(run_layout), int(run_lines), int(run_ocr), job_id))


def resequence_job(conn, job_id: str) -> int:
    """Put every page back in order under the dataset's current answer: the boxes
    outside every container and the unassigned lines among them."""
    pages = conn.execute(
        "SELECT DISTINCT e.page_id FROM elements e JOIN pages p ON e.page_id = p.id "
        "WHERE p.job_id = ? AND p.deleted = 0 AND e.deleted = 0",
        (job_id,)).fetchall()
    for page in pages:
        geometry.resequence_page(conn, page['page_id'])
    return len(pages)


LAYOUT_SHAPES = ('box', 'polygon')


def set_layout_shape(conn, job_id: str, shape: str) -> None:
    """Switch a dataset between box and polygon elements. Into polygons, every element
    without an outline takes its box's four corners; back to boxes, the outlines stay on
    file, so switching back loses nothing."""
    if shape not in LAYOUT_SHAPES:
        raise HTTPException(400, f'layout_shape must be one of {list(LAYOUT_SHAPES)}')
    conn.execute('UPDATE jobs SET layout_shape = ? WHERE id = ?', (shape, job_id))
    if shape == 'polygon':
        for row in conn.execute(
                'SELECT e.id, e.bbox FROM elements e JOIN pages p ON e.page_id = p.id '
                'WHERE p.job_id = ? AND e.polygon IS NULL', (job_id,)).fetchall():
            conn.execute('UPDATE elements SET polygon = ? WHERE id = ?',
                         (json.dumps(geometry.bbox_ring(json.loads(row['bbox']))), row['id']))


def apply_patch(conn, job_id: str, job, body: JobPatch, fields: set, user: dict) -> None:
    """Every setting a dataset takes, applied to one. Each field carries its own gate, so
    a member changing what annotators change is let through while the rest is refused."""
    if 'checked' in fields and body.checked is not None:
        conn.execute('UPDATE jobs SET checked = ? WHERE id = ?', (int(body.checked), job_id))
    if 'auto_redetect' in fields and body.auto_redetect is not None:
        conn.execute('UPDATE jobs SET auto_redetect = ? WHERE id = ?', (int(body.auto_redetect), job_id))
    if 'reading_order' in fields and body.reading_order is not None:
        if body.reading_order not in reading_order.CHOICES:
            raise HTTPException(400, f'reading_order must be one of {list(reading_order.CHOICES)}')
        conn.execute('UPDATE jobs SET reading_order = ? WHERE id = ?', (body.reading_order, job_id))
        resequence_job(conn, job_id)
    if 'layout_shape' in fields and body.layout_shape is not None:
        if user['role'] != 'admin' and job['owner'] != user['username']:
            raise HTTPException(403, 'not permitted')
        set_layout_shape(conn, job_id, body.layout_shape)
    if 'tile_size' in fields and body.tile_size is not None:
        if user['role'] != 'admin' and job['owner'] != user['username']:
            raise HTTPException(403, 'not permitted')
        if not job['run_tile']:
            raise HTTPException(400, 'only a dataset that cuts its maps into tiles has a tile size')
        if job['status'] in ('queued', 'running'):
            raise HTTPException(409, 'the dataset is already queued or running')
        conn.execute('UPDATE jobs SET tile_size = ? WHERE id = ?',
                     (_valid_tile_size(body.tile_size), job_id))
    if 'line_width' in fields and body.line_width is not None:
        # Member-editable like the review flags: it only changes how the next export
        # rasterizes, so annotators tune it after looking at a mask.
        conn.execute('UPDATE jobs SET line_width = ? WHERE id = ?',
                     (_valid_line_width(body.line_width), job_id))
    if 'name' in fields and body.name is not None:
        # Renaming is as weighty as creating or deleting a dataset: owner or admin,
        # unlike the review flags above, which any assigned member sets while working.
        if user['role'] != 'admin' and job['owner'] != user['username']:
            raise HTTPException(403, 'not permitted')
        name = ingest.require_unique_name(conn, body.name, exclude_id=job_id)
        conn.execute('UPDATE jobs SET name = ? WHERE id = ?', (name, job_id))
    if 'group_id' in fields:
        if user['role'] != 'admin' and job['owner'] != user['username']:
            raise HTTPException(403, 'not permitted')
        # Filing shares the dataset with the group's people and shows the group to the
        # filer, so a group they cannot reach answers as one that does not exist.
        if body.group_id is not None and not can_reach_group(conn, body.group_id, user):
            raise HTTPException(404, 'group not found')
        conn.execute('UPDATE jobs SET group_id = ? WHERE id = ?', (body.group_id, job_id))
    for task, column in MODEL_COLUMNS.items():
        if column not in fields:
            continue
        if user['role'] != 'admin' and job['owner'] != user['username']:
            raise HTTPException(403, 'not permitted')
        chosen = getattr(body, column)
        # Keeping the model already pinned is no new choice, even if it was archived since.
        if chosen is not None and chosen != job[column]:
            _require_model_choice(conn, chosen, task)
        conn.execute(f'UPDATE jobs SET {column} = ? WHERE id = ?', (chosen, job_id))
    if 'new_pages_test' in fields and body.new_pages_test is not None:
        if user['role'] != 'admin' and job['owner'] != user['username']:
            raise HTTPException(403, 'not permitted')
        conn.execute('UPDATE jobs SET new_pages_test = ? WHERE id = ?', (int(body.new_pages_test), job_id))
    for column in ('gt_autocheck', 'gt_ordered'):
        # Whether alignment checks lines off, and whether the transcription is complete and
        # in reading order so that order alone may - the owner's claim to make, as checking
        # a line puts it in the training corpus. Read by the next Alignment run.
        if column not in fields or getattr(body, column) is None:
            continue
        if user['role'] != 'admin' and job['owner'] != user['username']:
            raise HTTPException(403, 'not permitted')
        conn.execute(f'UPDATE jobs SET {column} = ? WHERE id = ?',
                     (int(getattr(body, column)), job_id))
    if 'gt_prompt' in fields and body.gt_prompt is not None:
        wording = body.gt_prompt.strip()
        if len(wording) > llm.MAX_PROMPT_LENGTH:
            raise HTTPException(400, f'wording is longer than {llm.MAX_PROMPT_LENGTH} characters')
        unknown = llm.unknown_placeholders(llm.effective_gt_prompt(wording))
        if unknown:
            raise HTTPException(400, f'nothing supplies {{{{{unknown[0]}}}}}. '
                                     f'Available: {", ".join(llm.PAGE_VARIABLES)}')
        conn.execute('UPDATE jobs SET gt_prompt = ? WHERE id = ?', (wording, job_id))
    if 'reference_overlap' in fields and body.reference_overlap is not None:
        if not 0 <= body.reference_overlap <= 20:
            raise HTTPException(400, 'overlap must be between 0 and 20 lines')
        conn.execute('UPDATE jobs SET reference_overlap = ? WHERE id = ?',
                     (body.reference_overlap, job_id))
    if 'llm_model_ids' in fields and body.llm_model_ids is not None:
        usable = {model['id'] for model in llm.usable_models(conn, user)}
        beyond = [model_id for model_id in body.llm_model_ids if model_id not in usable]
        if beyond:
            raise HTTPException(400, f'not a model you can read with: {beyond[0]}')
        conn.execute('UPDATE jobs SET llm_model_ids = ? WHERE id = ?',
                     (json.dumps(body.llm_model_ids), job_id))
    if 'llm_consensus_min' in fields and body.llm_consensus_min is not None:
        # How many must agree decides what settles, so it is the owner's call like
        # autocheck below.
        if user['role'] != 'admin' and job['owner'] != user['username']:
            raise HTTPException(403, 'not permitted')
        if not 1 <= body.llm_consensus_min <= 10:
            raise HTTPException(400, 'between 1 and 10 models must agree')
        conn.execute('UPDATE jobs SET llm_consensus_min = ? WHERE id = ?',
                     (body.llm_consensus_min, job_id))
    if 'llm_autocheck' in fields and body.llm_autocheck is not None:
        # Checking a line off puts it in the training corpus under a human's authority,
        # so who may turn that on is the owner's call, not any assignee's.
        if user['role'] != 'admin' and job['owner'] != user['username']:
            raise HTTPException(403, 'not permitted')
        conn.execute('UPDATE jobs SET llm_autocheck = ? WHERE id = ?',
                     (int(body.llm_autocheck), job_id))
    if 'llm_consensus_with_ocr' in fields and body.llm_consensus_with_ocr is not None:
        # Who counts as a reader decides what settles, and therefore what a training run
        # can be handed - the owner's call for the same reason autocheck is.
        if user['role'] != 'admin' and job['owner'] != user['username']:
            raise HTTPException(403, 'not permitted')
        conn.execute('UPDATE jobs SET llm_consensus_with_ocr = ? WHERE id = ?',
                     (int(body.llm_consensus_with_ocr), job_id))
    if 'llm_prompt' in fields and body.llm_prompt is not None:
        prompt = body.llm_prompt.strip()
        if len(prompt) > llm.MAX_PROMPT_LENGTH:
            raise HTTPException(400, f'the prompt must be at most {llm.MAX_PROMPT_LENGTH} characters')
        # Replaces the model's wording entirely, so what it says is what the models are
        # told - the shipped rules included, or not.
        conn.execute('UPDATE jobs SET llm_prompt = ? WHERE id = ?', (prompt, job_id))
    if 'ocr_decode' in fields and body.ocr_decode is not None:
        if user['role'] != 'admin' and job['owner'] != user['username']:
            raise HTTPException(403, 'not permitted')
        conn.execute('UPDATE jobs SET ocr_decode = ? WHERE id = ?',
                     (_valid_ocr_decode(body.ocr_decode), job_id))
    if 'ocr_convention' in fields and body.ocr_convention is not None:
        if user['role'] != 'admin' and job['owner'] != user['username']:
            raise HTTPException(403, 'not permitted')
        conn.execute('UPDATE jobs SET ocr_convention = ? WHERE id = ?',
                     (json.dumps(_valid_convention(body.ocr_convention)), job_id))
        conventions.note(conn, [name for name, on in body.ocr_convention.items() if on])
    asked = fields.intersection(PROCESSING_FIELDS)
    if asked:
        _patch_processing(conn, job_id, job, body, asked, user)


@router.patch('/api/jobs/{job_id}')
def patch_job(job_id: str, body: JobPatch, conn=Depends(get_db), user: dict = Depends(current_user)):
    """Rename a dataset or change its models, processing, decode mode and review settings."""
    require_job_access(conn, job_id, user)
    job = conn.execute('SELECT * FROM jobs WHERE id = ?', (job_id,)).fetchone()
    if job is None:
        raise HTTPException(404)
    apply_patch(conn, job_id, job, body, body.model_fields_set, user)
    conn.commit()
    row = conn.execute('SELECT name, checked, auto_redetect, group_id, line_width, model_layout_id, '
                       'model_lines_id, model_ocr_id, ocr_decode, llm_consensus_min, llm_autocheck, '
                       'llm_prompt, gt_prompt, reference_overlap, gt_autocheck, gt_ordered, line_mode, '
                       'run_layout, run_lines, run_ocr, reading_order, tile_size, '
                       'llm_consensus_with_ocr, ocr_convention, new_pages_test FROM jobs WHERE id = ?',
                       (job_id,)).fetchone()
    return {'id': job_id, 'name': row['name'], 'checked': bool(row['checked']),
            'gt_autocheck': bool(row['gt_autocheck']), 'gt_ordered': bool(row['gt_ordered']),
            'auto_redetect': bool(row['auto_redetect']), 'group_id': row['group_id'],
            'line_width': row['line_width'],
            'model_layout_id': row['model_layout_id'], 'model_lines_id': row['model_lines_id'],
            'model_ocr_id': row['model_ocr_id'], 'ocr_decode': row['ocr_decode'],
            'ocr_convention': json.loads(row['ocr_convention']),
            'llm_consensus_min': row['llm_consensus_min'],
            'llm_autocheck': bool(row['llm_autocheck']), 'llm_prompt': row['llm_prompt'],
            'gt_prompt': row['gt_prompt'], 'reference_overlap': row['reference_overlap'],
            'llm_consensus_with_ocr': bool(row['llm_consensus_with_ocr']),
            'line_mode': row['line_mode'], 'run_layout': bool(row['run_layout']),
            'run_lines': bool(row['run_lines']), 'run_ocr': bool(row['run_ocr']),
            'reading_order': row['reading_order'], 'tile_size': row['tile_size'],
            'new_pages_test': bool(row['new_pages_test'])}


class Share(BaseModel):
    usernames: list[str]


@router.put('/api/jobs/{job_id}/share')
def share_job(job_id: str, body: Share, conn=Depends(get_db), user: dict = Depends(current_user)):
    """Replace the set of users a dataset is shared with."""
    require_job_owner(conn, job_id, user)
    names = sorted({n.strip() for n in body.usernames if n.strip()})
    conn.execute('DELETE FROM job_assignees WHERE job_id = ?', (job_id,))
    conn.executemany('INSERT INTO job_assignees (job_id, username) VALUES (?, ?)',
                     [(job_id, n) for n in names])
    conn.commit()
    return {'job_id': job_id, 'shared_with': names}


def _data_use_payload(conn, job_id: str) -> dict:
    row = conn.execute('SELECT * FROM jobs WHERE id = ?', (job_id,)).fetchone()
    return {'data_use': store.job_row_to_dict(row)['data_use'],
            'models': data_use.models_made_from(conn, job_id),
            'admin_visits': data_use.admin_visits(conn, job_id)}


@router.get('/api/jobs/{job_id}/data-use')
def get_data_use(job_id: str, conn=Depends(get_db), user: dict = Depends(current_user)):
    """What the dataset may be used for, the models already made from it, and the admins
    who opened it while it restricted its use."""
    require_job_owner(conn, job_id, user)
    return _data_use_payload(conn, job_id)


@router.put('/api/jobs/{job_id}/data-use')
def put_data_use(job_id: str, body: dict[str, bool], conn=Depends(get_db), user: dict = Depends(current_user)):
    """Switch uses on or off. Models already trained on the dataset stay as they are."""
    require_job_owner(conn, job_id, user)
    uses = _valid_data_use(body)
    before = store.job_row_to_dict(conn.execute('SELECT * FROM jobs WHERE id = ?', (job_id,)).fetchone())['data_use']
    changed = {use: on for use, on in uses.items() if before[use] != on}
    if changed:
        _set_data_use(conn, job_id, changed)
        data_use.log(conn, job_id, user['username'], 'data_use', changed)
    return _data_use_payload(conn, job_id)


class Note(BaseModel):
    text: str = Field(max_length=10_000)


@router.put('/api/jobs/{job_id}/note')
def put_job_note(job_id: str, body: Note, conn=Depends(get_db), user: dict = Depends(current_user)):
    """Write the dataset's shared note; an empty text removes it."""
    require_job_access(conn, job_id, user)
    return store.set_note(conn, 'jobs', job_id, body.text, user['username'])


class TestPages(BaseModel):
    # The pages to mark or unmark; left out, every page of the dataset, and the dataset's
    # "New pages are test pages" follows.
    page_ids: list[int] | None = None
    test: bool


@router.post('/api/jobs/{job_id}/test-pages')
def mark_test_pages(job_id: str, body: TestPages, conn=Depends(get_db), user: dict = Depends(current_user)):
    """Mark pages as test data, which no training uses, or unmark them."""
    require_job_owner(conn, job_id, user)
    if body.page_ids is None:
        conn.execute('UPDATE pages SET is_test = ? WHERE job_id = ?', (int(body.test), job_id))
        conn.execute('UPDATE jobs SET new_pages_test = ? WHERE id = ?', (int(body.test), job_id))
    else:
        conn.executemany('UPDATE pages SET is_test = ? WHERE id = ? AND job_id = ?',
                         [(int(body.test), page_id, job_id) for page_id in body.page_ids])
    conn.commit()
    caches.refresh_progress(conn, job_id)
    page_rows.forget_counts(conn, job_id)
    return test_page_counts(conn, job_id)


def test_page_counts(conn, job_id: str) -> dict:
    row = conn.execute(
        'SELECT COUNT(*) pages, COALESCE(SUM(is_test), 0) test_pages, '
        '(SELECT new_pages_test FROM jobs WHERE id = ?) new_pages_test '
        f'FROM pages WHERE job_id = ? AND {caches.counted_page()}', (job_id, job_id)).fetchone()
    return {'test_pages': row['test_pages'], 'pages': row['pages'], 'new_pages_test': bool(row['new_pages_test'])}


@router.post('/api/jobs/{job_id}/cancel')
def cancel(job_id: str, conn=Depends(get_db), user: dict = Depends(current_user)):
    """Stop a queued or running dataset job."""
    require_job_owner(conn, job_id, user)
    job = store.get_job(conn, job_id)
    if job is None:
        raise HTTPException(404)
    if not jobs.cancel_job(conn, job_id):
        raise HTTPException(409, f'this dataset is already {job["status"]} - '
                                 'only a queued or running one can be cancelled')
    return {'ok': True}


@router.delete('/api/jobs/{job_id}')
def delete_job(job_id: str, conn=Depends(get_db), user: dict = Depends(current_user)):
    """Delete a dataset and everything derived from it. Owning it is not enough: deleting
    is a capability of its own, which a member does not have unless an admin grants it."""
    require_job_owner(conn, job_id, user)
    check_capability(user, 'dataset.delete')
    if store.get_job(conn, job_id) is None:
        raise HTTPException(404)
    jobs.cancel_job(conn, job_id)
    shared = [(r['content_hash'], r['source_file']) for table in ('pages', 'job_maps')
              for r in conn.execute(
                  f'SELECT content_hash, source_file FROM {table} WHERE job_id = ?', (job_id,))]
    # The only place the append-only log is broken, deliberately: the scans go with
    # it, so an audit trail for images that no longer exist is unbounded noise.
    conn.execute('DELETE FROM revisions WHERE job_id = ?', (job_id,))
    conn.execute('DELETE FROM jobs WHERE id = ?', (job_id,))
    conn.commit()
    shutil.rmtree(config.job_dir(job_id), ignore_errors=True)
    blobs.release(shared, config.BLOBS_DIR)
    caches.forget_job(job_id)
    return {'ok': True}


QUEUE_PROGRESS_FIELDS = ('status', 'counters', 'run_layout', 'run_lines', 'run_ocr',
                         'run_predict', 'run_tile')


@router.get('/api/queue')
def queue(conn=Depends(get_db), user: dict = Depends(current_user)):
    """Everything the shared GPU worker is running or holding - datasets, local
    trainings, evaluations - in execution order, plus the cluster's active runs.
    The queue is global (one GPU), so everyone sees how busy it is - but names of
    datasets a user cannot access are redacted."""

    def dataset_entry(row) -> dict:
        job = store.job_row_to_dict(row)
        accessible = can_access_job(conn, job['id'], user)
        # Only what draws the progress bar, so a row everyone sees says nothing more about
        # a dataset than its redacted name does.
        progress = {key: job[key] for key in QUEUE_PROGRESS_FIELDS}
        return {'kind': 'dataset', 'id': job['id'],
                'name': job['name'] if accessible else 'another dataset', 'owner': job['owner'],
                'status': job['status'], 'phase': job['phase'], 'created_at': job['created_at'],
                'queued_at': jobs.queued_since(row), 'started_at': row['started_at'], 'accessible': accessible,
                'job': progress}

    def training_entry(row) -> dict:
        t = trainer.training_payload(row)
        return {'kind': 'training', 'id': t['id'], 'name': t['name'], 'owner': t['owner'],
                'status': t['status'], 'phase': t['phase'], 'created_at': t['created_at'],
                'queued_at': jobs.queued_since(row), 'started_at': row['started_at'],
                'training': {'task': t['task'], 'target': t['target'], 'epochs': t['epochs'],
                             'progress_last': t['progress_last'],
                             'snapshot_progress': t['snapshot_progress']}}

    def evaluation_entry(row) -> dict:
        ev = evaluator.payload(row)
        model = registry.get_model(conn, ev['model_id'])
        if 'snapshot' in ev['source']:
            trow = conn.execute('SELECT name FROM trainings WHERE id = ?',
                                (ev['source']['snapshot'],)).fetchone()
            on = f"valid split of {trow['name']}" if trow else 'a valid split'
        else:
            names = []
            for job_id in ev['source'].get('jobs', []):
                jrow = conn.execute('SELECT name FROM jobs WHERE id = ?', (job_id,)).fetchone()
                if jrow is not None:
                    names.append(jrow['name'] if can_access_job(conn, job_id, user)
                                 else 'another dataset')
            on = ', '.join(names) or 'datasets'
        return {'kind': 'evaluation', 'id': ev['id'],
                'name': f"{model['name'] if model else 'model'} on {on}",
                'owner': ev['owner'], 'status': ev['status'], 'phase': None,
                'created_at': ev['created_at'], 'queued_at': jobs.queued_since(row), 'started_at': row['started_at']}

    running = ([dataset_entry(r) for r in conn.execute("SELECT * FROM jobs WHERE status = 'running'")]
               + [training_entry(r) for r in conn.execute(
                   "SELECT * FROM trainings WHERE target = 'local' AND status IN ('preparing', 'running')")]
               + [evaluation_entry(r) for r in conn.execute(
                   "SELECT * FROM evaluations WHERE status = 'running'")])
    waiting = ([(jobs.queue_order(r, 'job', r['seq']), dataset_entry(r))
                for r in conn.execute("SELECT rowid seq, * FROM jobs WHERE status = 'queued'")]
               + [(jobs.queue_order(r, 'training', r['id']), training_entry(r))
                  for r in conn.execute(
                      "SELECT * FROM trainings WHERE target = 'local' AND status = 'queued'")]
               + [(jobs.queue_order(r, 'evaluation', r['id']), evaluation_entry(r))
                  for r in conn.execute("SELECT * FROM evaluations WHERE status = 'queued'")])
    # Sorted by the worker's own key (jobs.queue_order), so the list shown is the order
    # things will actually run in.
    queued = [entry for _, entry in sorted(waiting, key=lambda pair: pair[0])]
    cluster = [training_entry(r) for r in conn.execute(
        "SELECT * FROM trainings WHERE target = 'slurm' AND status IN ('queued', 'preparing', 'running') "
        'ORDER BY created_at')]

    # Lines flagged for re-read that the batcher's next sweep will re-queue. The WHERE
    # mirrors jobs._reocr_batch_loop exactly, so this never counts work the sweep would
    # skip - and never double-counts a dataset already sitting in the queue.
    flagged = conn.execute(
        'SELECT j.id, j.name, COUNT(*) AS lines FROM lines l '
        'JOIN elements e ON l.element_id = e.id JOIN pages p ON e.page_id = p.id '
        'JOIN jobs j ON j.id = p.job_id '
        'WHERE l.needs_ocr = 1 AND l.deleted = 0 AND j.run_ocr = 1 '
        "AND j.status NOT IN ('queued', 'running') GROUP BY j.id ORDER BY j.name").fetchall()
    pending_reocr = None
    if flagged:
        datasets = []
        for row in flagged:
            accessible = can_access_job(conn, row['id'], user)
            datasets.append({'id': row['id'], 'name': row['name'] if accessible else 'another dataset',
                             'lines': row['lines'], 'accessible': accessible})
        pending_reocr = {'lines': sum(r['lines'] for r in flagged), 'datasets': datasets,
                         'next_pass_in': jobs.next_reocr_pass_in()}

    # How long each will take, so the page can lay the lanes out over time.
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    for entry in [*running, *queued, *cluster]:
        if entry['kind'] == 'dataset':
            entry['eta'] = queue_eta.dataset(conn, entry['id'], now)
        elif entry['kind'] == 'training':
            entry['eta'] = queue_eta.training(conn, entry['id'], entry['training']['progress_last'], now)
        else:
            entry['eta'] = queue_eta.evaluation(conn, entry['id'], now)
    return {'gpu': {'running': running[0] if running else None, 'queued': queued},
            'cluster': cluster, 'pending_reocr': pending_reocr}
