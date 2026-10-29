import json
import shutil
import time
from pathlib import Path

from app import backend_client, config, registry, weights
from app.backend_client import BackendClient, BackendError

# What the backend's out-of-memory fallback writes when it had to shrink the batch (6.9).
FALLBACK_NAME = 'fallback.json'
# The snapshot kind DeepLabel cuts for each task, in the contract's terms (6.3).
SNAPSHOT_KINDS = {'ocr': 'ocr-lines/1', 'lines': 'page-lines/1', 'layout': 'page-boxes/1'}
MANIFEST_NAME = 'snapshot-manifest.json'
# The flags each dataset was transcribed under, written beside an OCR snapshot (6.3).
CONVENTIONS_NAME = 'conventions.json'
BACKEND_LOG_NAME = 'backend.log'
POLL_SECONDS = 2.0
# A backend that stops answering for this long has lost the run.
UNREACHABLE_FOR = 300


class CannotTrain(RuntimeError):
    """The run's backend cannot train it, with the sentence to say why."""


def training_backend(conn, training: dict) -> BackendClient:
    """The model backend a run trains on: its base model's, or for a run from scratch the
    task's default backend - once configured with a URL, and only if it declares the task
    trainable."""
    if training['base_model_id']:
        row = registry.get_model(conn, training['base_model_id'])
        name = weights.serving_backend(row) if row else None
        if name is None:
            raise CannotTrain(f'the base model ({training["base_model_id"]}) is not on a configured model backend')
    else:
        backend = config.MODEL_BACKENDS.get(weights.TASK_BACKENDS.get(training['task'], ''))
        name = backend.name if backend and backend.url else None
        if name is None:
            raise CannotTrain(f'no configured model backend trains {training["task"]}')
    client = BackendClient(config.MODEL_BACKENDS[name])
    train = client.info().get('train') or {}
    if training['task'] not in train.get('tasks', []):
        raise CannotTrain(f'model backend "{name}" does not train {training["task"]}')
    kind = SNAPSHOT_KINDS.get(training['task'])
    if kind is None or train.get('snapshot') != kind:
        raise CannotTrain(f'model backend "{name}" wants a {train.get("snapshot")} snapshot, '
                          f'and DeepLabel cuts {kind or "no contract snapshot"} for {training["task"]}')
    return client


def snapshot_classes(snapshot: Path) -> list[str]:
    """A layout snapshot's classes by category id, as its COCO files name them; none for a
    snapshot of another kind."""
    coco_file = snapshot / 'train' / '_annotations.coco.json'
    if not coco_file.is_file():
        return []
    categories = json.loads(coco_file.read_text(encoding='utf-8')).get('categories', [])
    return [c['name'] for c in sorted(categories, key=lambda c: c['id'])]


def write_snapshot_manifest(training: dict) -> dict:
    """The snapshot as the contract describes it (6.3): every file with its hash, so the
    backend can fetch and verify it file by file. The OCR cut's own manifest.json - which
    line came from which dataset - becomes the contract manifest's `groups`."""
    root = config.training_dir(training['id']) / 'snapshot'
    native = root / 'manifest.json'
    groups = json.loads(native.read_text(encoding='utf-8')) if native.is_file() else {}
    flags_file = root / CONVENTIONS_NAME
    flags = json.loads(flags_file.read_text(encoding='utf-8')) if flags_file.is_file() else None
    counts_file = root / 'counts.json'
    counts = json.loads(counts_file.read_text(encoding='utf-8')) if counts_file.is_file() else {}
    files = []
    for path in sorted(p for p in root.rglob('*') if p.is_file() and p not in (native, flags_file)):
        files.append({'path': path.relative_to(root).as_posix(), 'sha256': weights.file_sha256(path),
                      'size': path.stat().st_size})
    kind, version = SNAPSHOT_KINDS[training['task']].split('/')
    manifest = {'format': 'deeplabel-snapshot/1', 'kind': kind, 'kind_version': int(version),
                'task': training['task'], 'training_id': training['id'],
                'splits': {'train': counts.get('train', 0), 'valid': counts.get('val', counts.get('valid', 0)),
                           **({'test': counts['test']} if counts.get('test') else {})},
                'groups': groups, 'classes': snapshot_classes(root), 'files': files,
                **({'conventions': flags} if flags else {})}
    (config.training_dir(training['id']) / MANIFEST_NAME).write_text(json.dumps(manifest), encoding='utf-8')
    return manifest


def _base_weights(conn, training: dict) -> dict | None:
    if not training['base_model_id']:
        return None
    files = weights.model_files(conn, training['base_model_id'])
    main = next((f for f in files if f['role'] == 'weights'), None)
    if main is None:
        if training_backend(conn, training).info().get('weights', {}).get('builtin'):
            return {'builtin': True}
        raise CannotTrain(f"the base model {training['base_model_id']} has no files in the weight store - "
                          'run python -m app.weights import-existing')
    return {'sha256': main['sha256'],
            'files': {f['role']: {'sha256': f['sha256'], 'size': f['size'], 'url': weights.file_url(f['sha256'])}
                      for f in files}}


def request_for(conn, training: dict, augmentation: dict | None) -> dict:
    return {
        'run': {'id': training['id'], 'attempt': training['attempt'], 'name': training['name'],
                'owner': training['owner']},
        'task': training['task'],
        'snapshot': {'manifest_url': f"{config.MODEL_BACKEND_FETCH_URL}/backend-api/v1/trainings/{training['id']}"
                                     '/snapshot/manifest.json'},
        'base_weights': _base_weights(conn, training),
        'params': {'epochs': training.get('epochs'), 'batch_size': training.get('batch_size'), 'gpus': 1,
                   'hyperparams': json.loads(training.get('hyperparams') or '{}'),
                   'augmentation': augmentation, 'build_lm': bool(training.get('build_lm')),
                   # Only when set: a backend from before contract 1.1 knows neither.
                   **{key: training[key] for key in ('grad_accum_steps', 'lr_scale') if training.get(key)}},
    }


def prepare_cluster_run(conn, training: dict, augmentation: dict | None) -> None:
    """What the entrypoint needs beside the snapshot when it runs on the cluster (6.6), put
    in the run directory that is rsynced up: the contract manifest, the params file and
    the base version's files by role."""
    tdir = config.training_dir(training['id'])
    write_snapshot_manifest(training)
    request = request_for(conn, training, augmentation)
    params = {**request['params'], 'gpus': training.get('gpu_count') or 1, 'task': training['task'],
              'run': request['run']}
    (tdir / 'params.json').write_text(json.dumps(params), encoding='utf-8')
    base = tdir / 'base'
    shutil.rmtree(base, ignore_errors=True)
    base.mkdir()
    if (request['base_weights'] or {}).get('builtin'):
        (base / 'builtin').touch()
    for f in weights.model_files(conn, training['base_model_id']) if training['base_model_id'] else []:
        shutil.copyfile(weights.blob_path(f['sha256']), base / f['role'])


def declared_metrics(client: BackendClient) -> str | None:
    """The metrics the backend declares for its runs (6.9), as the run keeps them."""
    metrics = (client.info().get('train') or {}).get('metrics')
    return json.dumps(metrics) if metrics else None


def adopt_weights(output) -> None:
    """A backend's entrypoint may write its weights under any name its artifacts list
    gives them; the run's model is registered from model.ckpt."""
    listing = output / 'artifacts.json'
    if not listing.is_file() or (output / 'model.ckpt').is_file():
        return
    for entry in json.loads(listing.read_text(encoding='utf-8')).get('files', []):
        if entry.get('role') == 'weights' and (output / entry['path']).is_file():
            shutil.copyfile(output / entry['path'], output / 'model.ckpt')
            return


def adopt_lm(output, target: Path) -> str | None:
    """The language model a backend built beside the weights (6.6), put where an in-process
    build leaves its own (`target` with .bin and .dict), and how the build went; None for
    a run whose output lists no artifacts."""
    listing = output / 'artifacts.json'
    if not listing.is_file():
        return None
    artifacts = json.loads(listing.read_text(encoding='utf-8'))
    built = {e['role']: output / e['path'] for e in artifacts.get('files', [])
             if e.get('role') in ('lm', 'lm_dict') and (output / e['path']).is_file()}
    if len(built) == 2:
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(built['lm'], target.with_suffix('.bin'))
        shutil.copyfile(built['lm_dict'], target.with_suffix('.dict'))
    return artifacts.get('lm_build') or ('built' if len(built) == 2 else 'failed')


def _append_progress(output, lines: list[str]) -> None:
    if lines:
        with open(output / 'progress.jsonl', 'a', encoding='utf-8') as handle:
            handle.write(''.join(f'{line}\n' for line in lines))


def run(conn, training: dict, client: BackendClient, augmentation: dict | None, set_state, is_cancelled,
        register_result) -> None:
    """A local run on its model backend, from start to registered model. Progress and the
    log tail are mirrored into the run's own directory, so the run page reads them as it
    reads an in-process run's; a cancel here is passed on to the backend."""
    tdir = config.training_dir(training['id'])
    output = tdir / 'output'
    output.mkdir(parents=True, exist_ok=True)
    write_snapshot_manifest(training)
    started = backend_client.start_training(client, request_for(conn, training, augmentation))
    set_state(conn, training['id'], status='running', phase='training', backend=client.backend.name,
              backend_train_id=started.id, metric_info=declared_metrics(client))
    progress_file = output / 'progress.jsonl'
    seen = len(progress_file.read_text(encoding='utf-8').splitlines()) if progress_file.is_file() else 0
    last_answer = time.monotonic()
    while True:
        if is_cancelled(conn, training['id']):
            started.cancel()
            return
        try:
            state = started.state()
            fresh = started.progress(seen)
        except BackendError as error:
            if not error.retryable or time.monotonic() - last_answer > UNREACHABLE_FOR:
                raise
            time.sleep(POLL_SECONDS)
            continue
        last_answer = time.monotonic()
        _append_progress(output, fresh)
        seen += len(fresh)
        (tdir / BACKEND_LOG_NAME).write_text(state.get('log_tail') or '', encoding='utf-8')
        if state['state'] in ('done', 'error', 'cancelled'):
            break
        time.sleep(POLL_SECONDS)

    if state['state'] == 'cancelled':
        set_state(conn, training['id'], status='cancelled', phase=None)
        return
    if state['state'] == 'error':
        set_state(conn, training['id'], status='error', phase=None,
                  error=state.get('error') or 'the training failed on its model backend')
        return
    set_state(conn, training['id'], phase='collecting')
    listing = started.artifacts()
    for entry in listing.get('files', []):
        started.download(entry['path'], output / entry['path'], entry['sha256'])
    (output / 'artifacts.json').write_text(json.dumps(listing), encoding='utf-8')
    # The figures the run ended on, which the model row keeps, and what the out-of-memory
    # fallback trained at; a run without them still registers its model.
    for name in ('metrics.json', FALLBACK_NAME):
        try:
            (output / name).write_bytes(started.read(name))
        except BackendError:
            pass
    register_result(conn, training, output)
    set_state(conn, training['id'], status='done', phase=None)
    started.delete()

