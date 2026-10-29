import re
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from PIL import Image

from app import (augmentations, caches, config, dataset_sync, geometry, jobs, llm_gt, llm_ocr,
                 llm_queue, store, trainer, training, weights)
from app.routes import (augmentations as augmentation_routes, backend_api, bulk, contributors, conventions, elements,
                        evaluations, exports, groups, lines, llm, maps, models, pages, people, pipeline, presence,
                        reference as reference_routes, trainings)
from app.routes import jobs as job_routes
from app.routes import layout_templates as layout_template_routes

Image.MAX_IMAGE_PIXELS = None


@asynccontextmanager
async def lifespan(_app: FastAPI):
    config.JOBS_DIR.mkdir(parents=True, exist_ok=True)
    # Create the schema before the worker threads open their own connections, so
    # they never contend over initialising a fresh database.
    conn = store.connect(config.DB_PATH)
    caches.warm_progress(conn)
    conn.close()
    jobs.start_worker()
    trainer.start_slurm_poller()
    jobs.start_reocr_batcher()
    # Page readings are network work, so they run beside the GPU queue, not in it. Both
    # kinds share one worker, so one model's ceiling is one ceiling rather than two.
    llm_queue.start_worker([llm_ocr.QUEUE, llm_gt.QUEUE])
    training.start_writer()
    dataset_sync.start_writer()
    augmentations.warm_up()
    weights.watch_builtins()
    yield


app = FastAPI(title='DeepLabel', lifespan=lifespan)


@app.exception_handler(geometry.InvalidGeometry)
async def invalid_geometry(_request: Request, exc: geometry.InvalidGeometry) -> JSONResponse:
    """Geometry validation lives in a module the runner imports, so it cannot raise an
    HTTPException itself - the web layer is what turns its refusal into a 400."""
    return JSONResponse({'detail': str(exc)}, status_code=400)

WRITE_METHODS = ('POST', 'PATCH', 'PUT', 'DELETE')
CLIENT_ID = re.compile(r'[A-Za-z0-9-]{1,64}')


@app.middleware('http')
async def auth_gate(request: Request, call_next):
    if request.url.path.startswith('/api/'):
        if not config.FRONTEND_SECRET or request.headers.get('X-Frontend-Secret') != config.FRONTEND_SECRET:
            return JSONResponse({'detail': 'forbidden'}, status_code=403)
        username = request.headers.get('X-Auth-User')
        role = request.headers.get('X-Auth-Role')
        if not username or not role:
            return JSONResponse({'detail': 'not authenticated'}, status_code=401)
        if request.method in WRITE_METHODS:
            if role == 'viewer':
                return JSONResponse({'detail': 'read-only account'}, status_code=403)
            # A token the user marked read-only keeps their role for reads, so it is the
            # header - not the role - that decides whether this request may write.
            if request.headers.get('X-Auth-Readonly') == '1':
                return JSONResponse({'detail': 'read-only API token'}, status_code=403)
        # What this person may do, resolved by the auth service out of their role and the
        # exceptions an admin made - the backend never works that out for itself. When the
        # set arrives it is the whole answer, training included. Only a gateway that does
        # not forward it yet falls back to the two training headers that predate it, which
        # the auth service derives from the same set.
        caps_header = request.headers.get('X-Auth-Caps')
        caps = set((caps_header or '').split())
        if caps_header is None:
            legacy = {'train.local': 'X-Auth-Train-Local', 'train.cluster': 'X-Auth-Train-Cluster'}
            caps |= {cap for cap, header in legacy.items() if request.headers.get(header) == '1'}
        request.state.user = {
            'username': username, 'role': role, 'caps': caps,
            'train_local': 'train.local' in caps,
            'train_cluster': 'train.cluster' in caps,
            'slurm_account': trainer.sanitize_slurm_account(request.headers.get('X-Auth-Slurm-Account')),
        }
        client_id = request.headers.get('X-Client-Id') or ''
        store.revision_client.set(client_id if CLIENT_ID.fullmatch(client_id) else None)
    return await call_next(request)


@app.get('/api/meta', tags=['meta'])
def get_meta():
    """The release this deployment runs, and the commit its image was built from."""
    return {'version': config.VERSION, 'commit': config.GIT_COMMIT or None}


@app.get('/api/tasks', tags=['meta'])
def get_tasks():
    """Job kinds this deployment offers, so the New job picker shows only what it can
    actually create. The backend refuses the rest regardless of what the client sends."""
    return {'tasks': config.enabled_tasks()}


app.include_router(job_routes.router)
app.include_router(layout_template_routes.router)
app.include_router(conventions.router)
app.include_router(pages.router)
app.include_router(elements.router)
app.include_router(lines.router)
app.include_router(exports.router)
app.include_router(pipeline.router)
app.include_router(maps.router)
app.include_router(groups.router)
app.include_router(reference_routes.router)
app.include_router(bulk.router)
app.include_router(models.router)
app.include_router(trainings.router)
app.include_router(augmentation_routes.router)
app.include_router(llm.router)
app.include_router(evaluations.router)
app.include_router(contributors.router)
app.include_router(people.router)
app.include_router(presence.router)
app.include_router(backend_api.router)
