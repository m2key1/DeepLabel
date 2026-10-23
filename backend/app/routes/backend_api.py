import re

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse

from app import config, registry, remote_training, weights
from app.deps import get_db

SECRET_HEADER = 'X-Model-Backend-Secret'
SHA256 = re.compile(r'[0-9a-f]{64}')

router = APIRouter(prefix='/backend-api/v1', tags=['model backends'], include_in_schema=False)


def calling_backend(request: Request) -> frozenset[str]:
    """The model backends whose secret came with the request - one, or every name the same
    server is configured under. These routes sit outside the frontend's identity gate: a
    backend has no user, only its own secret."""
    backends = weights.backends_for_secret(request.headers.get(SECRET_HEADER, ''))
    if not backends:
        raise HTTPException(401, 'missing or wrong model backend secret')
    return backends


@router.api_route('/files/{sha256}', methods=['GET', 'HEAD'])
def get_file(sha256: str, backends: frozenset[str] = Depends(calling_backend), conn=Depends(get_db)):
    """One stored file, with Range for resuming. Files of models served by another backend
    are 404 rather than 403, so a backend cannot probe which files exist."""
    path = weights.blob_path(sha256) if SHA256.fullmatch(sha256) else None
    if path is None or not weights.may_serve(conn, backends, sha256) or not path.is_file():
        raise HTTPException(404)
    return FileResponse(path, media_type='application/octet-stream',
                        headers={'ETag': f'"{sha256}"', 'Repr-Digest': weights.repr_digest(sha256)})


@router.get('/models/{model_id}/manifest')
def get_manifest(model_id: int, backends: frozenset[str] = Depends(calling_backend), conn=Depends(get_db)):
    row = registry.get_model(conn, model_id)
    if row is None or weights.backend_of(row) not in backends:
        raise HTTPException(404)
    return weights.manifest(conn, model_id)


def _training_for(conn, training_id: int, backends: frozenset[str]):
    """The run's snapshot is open to the backend training it, while it trains - to no one
    else, and 404 rather than 403 so a backend cannot probe for runs."""
    row = conn.execute("SELECT id, backend FROM trainings WHERE id = ? AND status IN ('preparing', 'running')",
                       (training_id,)).fetchone()
    if row is None or row['backend'] not in backends:
        raise HTTPException(404)
    return row


@router.get('/trainings/{training_id}/snapshot/manifest.json')
def get_snapshot_manifest(training_id: int, backends: frozenset[str] = Depends(calling_backend), conn=Depends(get_db)):
    _training_for(conn, training_id, backends)
    path = config.training_dir(training_id) / remote_training.MANIFEST_NAME
    if not path.is_file():
        raise HTTPException(404)
    return FileResponse(path, media_type='application/json')


@router.api_route('/trainings/{training_id}/snapshot/{name:path}', methods=['GET', 'HEAD'])
def get_snapshot_file(training_id: int, name: str, backends: frozenset[str] = Depends(calling_backend), conn=Depends(get_db)):
    """One file of the run's snapshot, with Range for resuming (6.4)."""
    _training_for(conn, training_id, backends)
    root = (config.training_dir(training_id) / 'snapshot').resolve()
    path = (root / name).resolve()
    if not path.is_relative_to(root) or not path.is_file() or path == root / 'manifest.json':
        raise HTTPException(404)
    return FileResponse(path, media_type='application/octet-stream')
