import json
import math
import os
import re
import shlex
import shutil
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

from app import (backend_client, caches, config, decode, evaluator, line_shapes, registry, remote_training,
                 slurm_session, store, train_snapshot, weights)

BACKEND_DIR = Path(__file__).resolve().parents[1]

CHECKPOINT_NAME = 'model.ckpt'
METRICS_NAME = 'metrics.json'
PROGRESS_NAME = 'progress.jsonl'
LOG_TAIL_LINES = 80

SLURM_POLL_SECONDS = 60

# Scheduler holds that mean "this will not start by waiting" - shown as a warning.
STUCK_PENDING_REASONS = re.compile(r'Assoc|QOS|Limit|Account|Held|Licenses|PartitionDown')

_EXCEPTION_LINE = re.compile(r'\b[A-Za-z_.]*(?:Error|Exception)\b[: ].*|CUDA out of memory.*')
_GENERIC_ERROR_LINE = re.compile(r'error: .*')


def parse_progress(path: Path) -> list[dict]:
    """The TRAIN_OUTPUT/progress.jsonl contract: one JSON object per line, merged
    per epoch (a loss line and a cer line for the same epoch become one point)."""
    if not path.is_file():
        return []
    by_epoch: dict = {}
    order = []
    for line in path.read_text(encoding='utf-8', errors='replace').splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except ValueError:
            continue
        if not isinstance(obj, dict):
            continue
        key = obj.get('epoch', len(order))
        if key not in by_epoch:
            by_epoch[key] = {}
            order.append(key)
        by_epoch[key].update(obj)
    return [by_epoch[k] for k in order]


def extract_error(log_text: str) -> str | None:
    """The last line of a training log that names an exception - what a human
    would quote when asked why the run died. Named exceptions beat generic
    'error:' lines like srun's exit-code notice."""
    lines = list(reversed(log_text.splitlines()))
    for pattern in (_EXCEPTION_LINE, _GENERIC_ERROR_LINE):
        for line in lines:
            match = pattern.search(line)
            if match:
                return match.group(0).strip()[:300]
    return None


def read_log_tail(training: dict) -> str:
    tdir = config.training_dir(training['id'])
    if training['target'] == 'slurm':
        # The full log is fetched when the job ends, the tail while it runs - so the
        # freshest of the two is the current one. A retried run still holds the failed
        # attempt's full log, and preferring that outright showed a dead run's output
        # for the whole of the live one.
        have = [p for p in (tdir / 'slurm.out', tdir / 'slurm.tail') if p.is_file()]
        source = max(have, key=lambda p: p.stat().st_mtime) if have else None
    elif training.get('backend'):
        source = tdir / remote_training.BACKEND_LOG_NAME
    else:
        source = tdir / 'training.log'
    if source is None or not source.is_file():
        return ''
    lines = source.read_text(encoding='utf-8', errors='replace').splitlines()
    return '\n'.join(lines[-LOG_TAIL_LINES:])

# Layout and lines training are wired but not yet validated end to end; the UI
# shows them as coming soon until they graduate.
TRAINABLE_TASKS = ('ocr', 'lines', 'layout')

# SLURM GPU choices: gres name -> the largest single-node count on the cluster (SLURM_GPUS).
GPU_TYPES = {name: most for name, (most, _) in config.SLURM_GPUS.items()}
GPU_PARTITIONS = {name: partition for name, (_, partition) in config.SLURM_GPUS.items() if partition}
# The OCR and layout trainers shard across the cards they are given; the lines trainer is
# single-process, so a multi-card lines run would hold cards it never touches.
MULTI_GPU_TASKS = ('ocr', 'layout')


def gpu_limit(task: str, gpu_type: str) -> int:
    """The most cards this task can use on that card type."""
    return GPU_TYPES[gpu_type] if task in MULTI_GPU_TASKS else 1


AUGMENT_NAME = 'augmentation.json'


def write_augmentation(training: dict) -> Path | None:
    """The run's frozen stack, written into its directory for its backend to load.
    The whole directory is what a cluster submit rsyncs, so this travels with it."""
    spec = training.get('augmentation')
    if not spec:
        return None
    path = config.training_dir(training['id']) / AUGMENT_NAME
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(spec, encoding='utf-8')
    return path


LM_NAME = 'domain'


def lm_paths(training_id: int) -> tuple[str, str] | None:
    """The language model this run fitted, if it has one on disk."""
    out = config.training_dir(training_id) / 'lm' / LM_NAME
    binary, tokens = out.with_suffix('.bin'), out.with_suffix('.dict')
    return (str(binary), str(tokens)) if binary.is_file() and tokens.is_file() else None


def lm_build_outcome(training: dict) -> str | None:
    """'built' or 'failed' once this run's own language model was attempted, None when it
    asked for none or the attempt has not finished. Kept with the run when the build ends;
    a run from before that reads it off the folder the build leaves behind either way,
    since a run past preparing is past the build. A retry removes the folder the attempt
    before left, so its build is never reported as this attempt's."""
    if not training.get('build_lm'):
        return None
    if training.get('lm_build'):
        return training['lm_build']
    if training['status'] in ('queued', 'preparing'):
        return None
    if lm_paths(training['id']) is not None:
        return 'built'
    attempted = (config.training_dir(training['id']) / 'lm').is_dir()
    return 'failed' if attempted else None


def eligible_counts(conn, task: str, job_ids: list[str],
                    human_checked_only: bool = False) -> dict[str, int]:
    """How much checked material each dataset would contribute to a snapshot."""
    queries = {
        'ocr': ('SELECT COUNT(*) n FROM lines l JOIN elements e ON l.element_id = e.id '
                'JOIN pages p ON e.page_id = p.id '
                f"WHERE p.job_id = ? AND {caches.counted_page('p')} "
                'AND l.checked = 1 AND l.deleted = 0 AND e.deleted = 0 '
                + train_snapshot.checked_by(human_checked_only)),
        'layout': f'SELECT COUNT(*) n FROM pages WHERE job_id = ? AND layout_checked = 1 '
                  f'AND {caches.counted_page()}',
        'lines': f'SELECT COUNT(*) n FROM pages WHERE job_id = ? AND lines_checked = 1 '
                 f'AND {caches.counted_page()}',
    }
    return {job_id: conn.execute(queries[task], (job_id,)).fetchone()['n'] for job_id in job_ids}


PREVIEW_CHUNK = 500


def _preview_sql(task: str, marks: str) -> str:
    """Per dataset: checked items and pages, and of each what a person checked. The pages
    are the ones the split would divide, so they follow train_snapshot._task_keys."""
    if task == 'ocr':
        human = train_snapshot.HUMAN_CHECK
        return (f'SELECT p.job_id, COUNT(*) items, SUM({human}) human_items, '
                'COUNT(DISTINCT p.id) pages, '
                f'COUNT(DISTINCT CASE WHEN {human} THEN p.id END) human_pages '
                'FROM lines l JOIN elements e ON l.element_id = e.id '
                'JOIN pages p ON e.page_id = p.id '
                f"WHERE p.job_id IN ({marks}) AND {caches.counted_page('p')} "
                'AND l.checked = 1 AND l.deleted = 0 AND e.deleted = 0 GROUP BY p.job_id')
    flag, splittable = {
        'layout': ('layout_checked',
                   'content_hash IS NOT NULL AND width IS NOT NULL AND height IS NOT NULL'),
        'lines': ('lines_checked', 'width IS NOT NULL'),
    }[task]
    return (f'SELECT job_id, COUNT(*) items, COUNT(*) human_items, SUM({splittable}) pages, '
            f'SUM({splittable}) human_pages FROM pages '
            f'WHERE job_id IN ({marks}) AND {flag} = 1 AND {caches.counted_page()} '
            'GROUP BY job_id')


def preview_counts(conn, task: str, job_ids: list[str]) -> dict[str, dict[str, int]]:
    """How much checked material each dataset would contribute, how many pages it spans -
    the split is cut per page, so that is what a fraction divides - and of both what a
    person rather than agreeing language models checked. One grouped query per chunk of
    datasets: the dialog previews every dataset there is."""
    found = {}
    for start in range(0, len(job_ids), PREVIEW_CHUNK):
        chunk = job_ids[start:start + PREVIEW_CHUNK]
        found.update({r['job_id']: r for r in conn.execute(
            _preview_sql(task, ', '.join('?' * len(chunk))), chunk)})

    def column(name):
        return {job_id: found[job_id][name] if job_id in found else 0 for job_id in job_ids}
    items, human_items = column('items'), column('human_items')
    return {'counts': items, 'pages': column('pages'),
            'machine_settled': {job_id: items[job_id] - human_items[job_id] for job_id in job_ids},
            'human_checked_pages': column('human_pages')}


def set_state_for_attempt(conn, training_id: int, attempt: int, **fields) -> bool:
    """Write only while this is still the run's current attempt, and say whether it was.

    A submit runs for hours in a thread of its own. When a retry starts the next attempt,
    the one before it may still be inside a transfer, and what it reports when that
    transfer is killed belongs to a run that no longer exists."""
    sets, params = store.state_update(fields)
    cur = conn.execute(f'UPDATE trainings SET {sets} WHERE id = ? AND attempt = ?', (*params, training_id, attempt))
    conn.commit()
    return cur.rowcount == 1


def claim_retry(conn, training_id: int) -> int | None:
    """Take a failed run for one more submit, returning the attempt number to submit
    under. None means there was nothing to take - it already succeeded, is running, or
    another request claimed it first, and a second transfer of the same snapshot is
    exactly what must not happen."""
    cur = conn.execute(
        "UPDATE trainings SET status = 'queued', phase = NULL, error = NULL, lm_build = NULL, "
        "attempt = attempt + 1 WHERE id = ? AND status = 'error'", (training_id,))
    conn.commit()
    if cur.rowcount != 1:
        return None
    shutil.rmtree(config.training_dir(training_id) / 'lm', ignore_errors=True)
    return conn.execute('SELECT attempt FROM trainings WHERE id = ?',
                        (training_id,)).fetchone()['attempt']


def set_state(conn, training_id: int, **fields):
    sets, params = store.state_update(fields)
    conn.execute(f'UPDATE trainings SET {sets} WHERE id = ?', (*params, training_id))
    conn.commit()


def record_fallback(conn, training_id: int, out_dir: Path) -> None:
    """What the backend's out-of-memory fallback trained at instead of what was asked, so the
    run shows the batch it really had (6.9)."""
    note_file = out_dir / remote_training.FALLBACK_NAME
    if not note_file.is_file():
        return
    note = json.loads(note_file.read_text(encoding='utf-8'))
    conn.execute('UPDATE trainings SET batch_size = ?, grad_accum_steps = ?, batch_fallback = ? WHERE id = ?',
                 (note['trained']['batch_size'], note['trained']['grad_accum_steps'], json.dumps(note), training_id))
    conn.commit()


def _layout_template(conn, training: dict, base) -> int | None:
    """The template a layout run belongs to: its datasets', which hold the
    classes it learned, when they share one; else its base's."""
    if training['task'] != 'layout':
        return None
    ids = json.loads(training.get('dataset_job_ids') or '[]')
    found = {r['layout_template_id'] for r in conn.execute(
        f"SELECT layout_template_id FROM jobs WHERE id IN ({','.join('?' * len(ids))})", ids)} if ids else set()
    if len(found) == 1 and None not in found:
        return found.pop()
    return base['layout_template_id'] if base is not None else None


def register_result(conn, training: dict, out_dir: Path) -> int:
    """Register the finished checkpoint as a model object; returns the model id."""
    remote_training.adopt_weights(out_dir)
    checkpoint = out_dir / CHECKPOINT_NAME
    if not checkpoint.is_file():
        raise FileNotFoundError(f'training produced no {CHECKPOINT_NAME} in {out_dir}')
    record_fallback(conn, training['id'], out_dir)
    if training.get('build_lm'):
        outcome = remote_training.adopt_lm(out_dir, config.training_dir(training['id']) / 'lm' / LM_NAME)
        if outcome:
            conn.execute('UPDATE trainings SET lm_build = ? WHERE id = ?', (outcome, training['id']))
    metrics_file = out_dir / METRICS_NAME
    metrics = metrics_file.read_text(encoding='utf-8') if metrics_file.is_file() else None
    base = registry.get_model(conn, training['base_model_id']) if training['base_model_id'] else None
    # A finetune keeps its base's vocab, so the base's beam LM stays index-parallel
    # and is inherited; from-scratch models start LM-less (decoder-rescore path).
    lm_path = base['lm_path'] if base is not None else None
    lm_dict_path = base['lm_dict_path'] if base is not None else None
    # A model fitted to this run's own text outranks whatever the base carried, which was
    # built for other material. Both are byte-inventory LMs, so either stays index-parallel.
    own_lm = lm_paths(training['id'])
    if own_lm is not None:
        lm_path, lm_dict_path = own_lm
    # A fine-tune is read where its base is read: a base pinned to a backend pins it too.
    cur = conn.execute(
        "INSERT INTO models (task, name, source, checkpoint, trained_from, metrics, notes, "
        'lm_path, lm_dict_path, backend, layout_template_id) '
        "VALUES (?, ?, 'trained', ?, ?, ?, ?, ?, ?, ?, ?)",
        (training['task'], training['name'], str(checkpoint), training['base_model_id'],
         metrics, training.get('description'), lm_path, lm_dict_path,
         base['backend'] if base is not None else None, _layout_template(conn, training, base)))
    model_id = cur.lastrowid
    if training['task'] == 'layout':
        # The classes it learned, so a later fine-tune can tell whether its head carries over.
        learned = remote_training.snapshot_classes(config.training_dir(training['id']) / 'snapshot')
        if learned:
            conn.execute('UPDATE models SET classes = ? WHERE id = ?',
                         (json.dumps([{'id': i + 1, 'name': n} for i, n in enumerate(learned)]), model_id))
    conn.execute('UPDATE trainings SET model_id = ?, metrics = ? WHERE id = ?',
                 (model_id, metrics, training['id']))
    conn.commit()
    # Into the weight store as well, so model backends can fetch it. Best effort: the run
    # has its model either way, and `python -m app.weights import-existing` catches up.
    try:
        weights.store_model_files(conn, model_id)
    except OSError as error:
        print(f'weight store: model {model_id} not stored: {error}', file=sys.stderr)
    if training['task'] == 'ocr':
        # Both scores are scheduled here, when the run has something to be compared with.
        # Scheduling the baseline at submit put a long local GPU job beside the snapshot
        # transfer, and on 2026-09-11 the two together took the machine off the network.
        evaluator.create_baseline(conn, training)
        evaluator.create_result_eval(conn, training, model_id)
        # A test set is never trained on and never steers the run - it is scored once,
        # base model and new model alike, so "did it help?" has an untouched answer.
        test_ids = json.loads(training.get('test_job_ids') or '[]')
        if test_ids:
            test_source = {'jobs': test_ids}
            if training.get('human_checked_only'):
                test_source['human_checked_only'] = True
            # One headline number per model, in the mode they actually run in.
            evaluator.create(conn, model_id, test_source, decode.DEFAULT_DECODE,
                             training['owner'], training['id'])
            if training['base_model_id'] and registry.get_model(conn, training['base_model_id']):
                evaluator.create(conn, training['base_model_id'], test_source,
                                 decode.DEFAULT_DECODE, training['owner'], training['id'])
    return model_id


def get_training(conn, training_id: int) -> dict | None:
    row = conn.execute('SELECT * FROM trainings WHERE id = ?', (training_id,)).fetchone()
    return dict(row) if row else None


def training_payload(row) -> dict:
    t = dict(row)
    t['dataset_job_ids'] = json.loads(t['dataset_job_ids'] or '[]')
    t['valid_job_ids'] = json.loads(t.get('valid_job_ids') or '[]')
    t['test_job_ids'] = json.loads(t.get('test_job_ids') or '[]')
    t['snapshot_counts'] = json.loads(t['snapshot_counts']) if t['snapshot_counts'] else None
    t['metrics'] = json.loads(t['metrics']) if t['metrics'] else None
    t['hyperparams'] = json.loads(t.get('hyperparams') or '{}')
    t['augmentation'] = json.loads(t['augmentation']) if t.get('augmentation') else None
    t['batch_fallback'] = json.loads(t['batch_fallback']) if t.get('batch_fallback') else None
    t['metric_info'] = json.loads(t['metric_info']) if t.get('metric_info') else None
    t['build_lm'] = bool(t.get('build_lm'))
    t['lm_build'] = lm_build_outcome(t)
    t['snapshot_progress'] = (json.loads(t['snapshot_progress'])
                              if t.get('snapshot_progress') else None)
    if t['status'] in ('running', 'preparing'):
        points = parse_progress(config.training_dir(t['id']) / 'output' / PROGRESS_NAME)
        t['progress_last'] = points[-1] if points else None
    else:
        t['progress_last'] = None
    t.pop('pid', None)
    return t


def is_cancelled(conn, training_id: int) -> bool:
    row = conn.execute('SELECT status FROM trainings WHERE id = ?', (training_id,)).fetchone()
    return row is None or row['status'] == 'cancelled'


PROGRESS_INTERVAL = 2.0  # seconds between snapshot progress writes


def _progress_writer(conn, training_id: int):
    """Reports how much of the snapshot is cut. Throttled: a large cut completes a page
    every few milliseconds, and each write is a commit."""
    last = 0.0

    def report(done: int, total: int):
        nonlocal last
        now = time.monotonic()
        if done < total and now - last < PROGRESS_INTERVAL:
            return
        last = now
        set_state(conn, training_id, snapshot_progress=json.dumps({'done': done, 'total': total}))

    return report


SNAPSHOT_KIND_NAME = 'snapshot.kind'


def prepare_snapshot(conn, training: dict) -> dict:
    """Cut the frozen material this run trains on, or keep the one it already has:
    a snapshot that recorded its counts is complete, and a retry paying to rebuild
    tens of thousands of crops would only reproduce it. A kept snapshot cut in the
    in-process trainer's layout, from before every run trained on a backend, is cut again."""
    tdir = config.training_dir(training['id'])
    kind = 'native' if training['task'] == 'ocr' else 'contract'
    counts = json.loads(training.get('snapshot_counts') or 'null')
    marker = tdir / SNAPSHOT_KIND_NAME
    cut_as = marker.read_text(encoding='utf-8') if marker.is_file() else 'native'
    if counts and (tdir / 'snapshot').is_dir() and cut_as == kind:
        return counts
    set_state(conn, training['id'], status='preparing', phase='snapshot')
    counts = train_snapshot.build(conn, training['id'], training['task'],
                                  json.loads(training['dataset_job_ids']),
                                  training.get('val_fraction') or 0.1,
                                  training.get('split_strategy') or 'uniform',
                                  json.loads(training.get('valid_job_ids') or '[]'),
                                  on_progress=_progress_writer(conn, training['id']),
                                  should_stop=lambda: is_cancelled(conn, training['id']),
                                  human_checked_only=bool(training.get('human_checked_only')),
                                  test_job_ids=json.loads(training.get('test_job_ids') or '[]'),
                                  line_shape=training.get('line_shape') or 'polygon')
    marker.write_text(kind, encoding='utf-8')
    set_state(conn, training['id'], snapshot_counts=json.dumps(counts), snapshot_progress=None)
    return counts


# The batch per GPU of a run whose backend declares none.
FALLBACK_BATCH = 8


def gres_card() -> str:
    """The card SLURM_GRES names, which a cluster run without its own choice lands on."""
    parts = config.SLURM_GRES.split(':')
    return parts[1] if len(parts) > 2 else ''


def line_shape_for(conn, task: str, base_model_id: int | None, asked: str | None = None) -> str | None:
    """The shape a lines run trains each line as: the one asked for, else its model
    backend's declared default."""
    if task != 'lines':
        return None
    if asked:
        return asked
    try:
        client = remote_training.training_backend(conn, {'task': task, 'base_model_id': base_model_id})
    except (remote_training.CannotTrain, backend_client.BackendError):
        client = None
    if client is None:
        return line_shapes.BACKEND_DEFAULT
    declared = client.info()['train'].get('line_shape')
    return declared if declared in line_shapes.LINE_SHAPES else line_shapes.BACKEND_DEFAULT


def run_scaling(conn, task: str, target: str, gpu_type: str | None, gpu_count: int | None,
                base_model_id: int | None, batch_size: int | None, hyperparams: dict | None = None) -> dict:
    """What a run trains at (MODEL-BACKENDS.md 6.9): the batch per GPU - the one asked for,
    else the one its model backend measured for the card it lands on - and, where that
    backend declares the effective batch its learning rates were tuned at, the gradient
    accumulation that keeps it and the factor on the learning rates once more GPUs
    outgrow it. A backend declaring none of this keeps the batch alone."""
    plain = {'batch_size': batch_size or FALLBACK_BATCH, 'grad_accum_steps': None,
             'lr_scale': None, 'effective_batch': None}
    try:
        client = remote_training.training_backend(conn, {'task': task, 'base_model_id': base_model_id})
    except (remote_training.CannotTrain, backend_client.BackendError):
        client = None
    if client is None:
        return plain
    info = client.info()
    train = info['train']
    resources = train.get('resources') or {}
    card = (info.get('gpu') or {}).get('card') if target == 'local' else (gpu_type or gres_card())
    per_gpu = (batch_size or (resources.get('batch_by_gpu') or {}).get(card)
               or (resources.get('default_batch') or {}).get('local' if target == 'local' else 'cluster')
               or FALLBACK_BATCH)
    gpus = 1 if target == 'local' else (gpu_count or 1)
    target_batch = resources.get('effective_batch')
    roles = {t['key']: t.get('role') for t in train.get('tunables') or []}
    chosen = hyperparams or {}
    knob = next((key for key, role in roles.items() if role == 'accumulation'), None)
    if knob in chosen:
        accumulation, steps = None, int(chosen[knob])
    else:
        accumulation = max(1, round(target_batch / (per_gpu * gpus))) if target_batch and knob else None
        steps = accumulation or 1
    effective = per_gpu * gpus * steps
    scales = target_batch and 'learning_rate' in roles.values() and effective != target_batch
    return {'batch_size': int(per_gpu), 'grad_accum_steps': accumulation,
            'lr_scale': round(math.sqrt(effective / target_batch), 4) if scales else None,
            'effective_batch': effective}


def run_local(conn, training_id: int):
    """Executed from the shared GPU worker: snapshot, then train on the run's backend."""
    training = get_training(conn, training_id)
    if training is None:
        return
    try:
        client = remote_training.training_backend(conn, training)
        prepare_snapshot(conn, training)
    except train_snapshot.SnapshotCancelled:
        set_state(conn, training_id, phase=None, snapshot_progress=None)
        return
    except Exception as e:
        set_state(conn, training_id, status='error', error=str(e), phase=None)
        return
    # Cancelling during the snapshot leaves nothing to signal - it runs in this thread,
    # with no pid - so the decision is read here before anything is sent.
    if is_cancelled(conn, training_id):
        set_state(conn, training_id, phase=None)
        return
    try:
        # Marked first, so the backend may fetch the snapshot it is about to be sent.
        set_state(conn, training_id, backend=client.backend.name)
        augmentation = write_augmentation(training)
        remote_training.run(conn, get_training(conn, training_id), client,
                            json.loads(augmentation.read_text(encoding='utf-8')) if augmentation else None,
                            set_state, is_cancelled, register_result)
    except (remote_training.CannotTrain, backend_client.BackendError, OSError) as error:
        set_state(conn, training_id, status='error', phase=None, error=str(error))


CANCELLABLE_STATUSES = ('queued', 'preparing', 'running')


def cancel(conn, training_id: int) -> bool:
    """Stop a run that is still to finish, and say whether there was one. A finished
    run is left as it ended - a Cancel from a stale tab must not unfinish it."""
    training = get_training(conn, training_id)
    if training is None:
        return False
    cancelled = conn.execute(
        "UPDATE trainings SET status = 'cancelled', phase = NULL "
        'WHERE id = ? AND status IN (?, ?, ?)', (training_id, *CANCELLABLE_STATUSES)).rowcount
    conn.commit()
    if not cancelled:
        return False
    if training.get('pid'):
        try:
            os.kill(training['pid'], signal.SIGTERM)
        except ProcessLookupError:
            pass
    if training['target'] == 'slurm' and training.get('slurm_job_id'):
        _ssh(['scancel', training['slurm_job_id']])
    return True


def delete(conn, training: dict):
    """Remove the training's artifacts and row. An archived model it produced goes
    too - its checkpoint lives in the deleted directory - so every reference to
    that model is cleared first (readers fall back to the task default)."""
    shutil.rmtree(config.training_dir(training['id']), ignore_errors=True)
    if training['target'] == 'slurm' and slurm_available():
        try:
            _ssh(['rm', '-rf', f'{config.SLURM_REMOTE_DIR}/{training["id"]}'])
        except Exception:
            pass
    # Queued evals would find no snapshot to read once the directory is gone.
    conn.execute("DELETE FROM evaluations WHERE training_id = ? AND status = 'queued'",
                 (training['id'],))
    conn.execute('UPDATE evaluations SET training_id = NULL WHERE training_id = ?', (training['id'],))
    conn.execute('DELETE FROM trainings WHERE id = ?', (training['id'],))
    model_id = training.get('model_id')
    if model_id:
        for col in ('model_layout_id', 'model_lines_id', 'model_ocr_id'):
            conn.execute(f'UPDATE jobs SET {col} = NULL WHERE {col} = ?', (model_id,))
        conn.execute('UPDATE models SET trained_from = NULL WHERE trained_from = ?', (model_id,))
        conn.execute('UPDATE trainings SET base_model_id = NULL WHERE base_model_id = ?', (model_id,))
        conn.execute('DELETE FROM evaluations WHERE model_id = ?', (model_id,))
        weights.forget_model(conn, model_id)
        conn.execute('DELETE FROM models WHERE id = ?', (model_id,))
    conn.commit()


def slurm_available() -> bool:
    return bool(config.SLURM_HOST)


def probe_cluster() -> str | None:
    """Why the cluster cannot be used right now, in words that name the cure - or None
    when it answers. A live check, unlike cluster_reachable(), which only reports the last
    call that happened to run. Cheap enough to sit in front of work that would be wasted."""
    if not slurm_available():
        return 'no cluster is configured'
    try:
        proc = _ssh(['true'])
        detail = None if proc.returncode == 0 else _last_line(proc)
    except subprocess.TimeoutExpired:
        detail = f'no answer within {SSH_TIMEOUT} s'
    _set_reachable(detail is None)
    if detail is None:
        return None
    if 'keyboard-interactive' in detail:
        return SECOND_FACTOR_NEEDED
    return f'the cluster could not be reached ({detail}) - check the host and the network, then retry'


SLURM_ACCOUNT_RE = re.compile(r'^[A-Za-z0-9._-]{1,64}$')


def sanitize_slurm_account(value: str | None) -> str:
    """The account a run is charged to ends up in a #SBATCH directive, so anything that is
    not an account name is dropped rather than escaped. The auth service refuses these on
    the way in; this is the check on the way out of the identity header."""
    value = (value or '').strip()
    return value if SLURM_ACCOUNT_RE.match(value) else ''


def cluster_accounts() -> list[str]:
    """The SLURM accounts the shared login may charge to, so an admin picks one instead of
    typing it and finding out hours later that it was wrong. Best effort: an unreachable or
    locked cluster yields nothing and the Admin page falls back to free text."""
    if not slurm_available():
        return []
    proc = _ssh(['sacctmgr', '-n', '-P', 'show', 'assoc', f'user={config.SLURM_USER}',
                 'format=Account'])
    if proc.returncode:
        return []
    found = {line.strip() for line in proc.stdout.splitlines() if line.strip()}
    return sorted(a for a in found if SLURM_ACCOUNT_RE.match(a))


def _ssh_target() -> str:
    return slurm_session.ssh_target()


def _ssh_base() -> list[str]:
    return ['ssh', *slurm_session.ssh_opts(), _ssh_target()]


# One remote command's budget. The connect itself gives up far sooner (slurm_session's
# ConnectTimeout); this bounds a login that answers and then stalls.
SSH_TIMEOUT = 120

SECOND_FACTOR_NEEDED = ('the cluster asked for its second factor - connect to it from '
                        'the training dialog')


def _ssh(remote_cmd: list[str]) -> subprocess.CompletedProcess:
    """Decoded leniently: what comes back is a training log, and a tail of tqdm bars is
    cut mid-character as often as not. A strict decode raised out of the poll instead."""
    return subprocess.run(_ssh_base() + [shlex.join(remote_cmd)], capture_output=True,
                          text=True, errors='replace', timeout=SSH_TIMEOUT)


def _last_line(proc: subprocess.CompletedProcess) -> str:
    """What the cluster said last, which is where ssh and sbatch put the reason."""
    lines = [l for l in (proc.stderr or proc.stdout or '').strip().splitlines() if l.strip()]
    return lines[-1] if lines else 'no output'


def _check(proc: subprocess.CompletedProcess, what: str) -> subprocess.CompletedProcess:
    """Fail with what the cluster actually said. CalledProcessError carries only the
    exit status, so a refused login or a rejected sbatch reached the user as a bare
    'non-zero exit status 255' while the captured output was dropped."""
    if not proc.returncode:
        return proc
    detail = _last_line(proc)
    # The one failure with a cure the user can apply from the UI.
    if 'keyboard-interactive' in detail:
        raise RuntimeError(f'{SECOND_FACTOR_NEEDED} ({detail})')
    raise RuntimeError(f'{what} failed ({proc.returncode}): {detail}')


def _rsync(src: str, dst: str, on_pid=None) -> subprocess.CompletedProcess:
    """The snapshot, to the cluster and back. Uncompressed on purpose - it is PNG crops,
    which spend CPU and shrink by nothing - rate limited where the deployment says so, and
    resumable: a transfer that was interrupted picks the partial files up rather than
    sending them again.

    `on_pid` is handed the running rsync, so a cancel has something to signal: hundreds of
    gigabytes take hours, and a cancel that only marks the row leaves the uplink saturated
    for the rest of them."""
    ssh_cmd = shlex.join(['ssh', *slurm_session.ssh_opts()])
    flags = ['-a', '--partial', f'--timeout={config.SLURM_RSYNC_STALL}']
    if config.SLURM_RSYNC_BWLIMIT:
        flags.append(f'--bwlimit={config.SLURM_RSYNC_BWLIMIT}')
    proc = subprocess.Popen(['rsync', *flags, '-e', ssh_cmd, src, dst],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            text=True, errors='replace')
    if on_pid is not None:
        on_pid(proc.pid)
    try:
        out, err = proc.communicate(timeout=config.SLURM_RSYNC_TIMEOUT)
    except subprocess.TimeoutExpired:
        proc.kill()
        out, err = proc.communicate()
        raise
    return subprocess.CompletedProcess(proc.args, proc.returncode, out, err)


MEM_UNITS = {'K': 1 / 1024 / 1024, 'M': 1 / 1024, 'G': 1.0, 'T': 1024.0}


def _gib(value: str) -> float | None:
    """A SLURM memory figure in GiB, or None where it is spelled some way this does not
    read. A bare number is megabytes, which is what --mem means without a unit."""
    text = (value or '').strip().upper()
    unit = MEM_UNITS.get(text[-1:])
    try:
        return float(text[:-1] if unit else text) * (unit or MEM_UNITS['M'])
    except ValueError:
        return None


def job_resources(gpu_count: int, resources: dict | None = None) -> tuple[str, str]:
    """The CPUs and host memory one run asks for. Requested is what the cluster charges,
    so this is per GPU up to the ceiling one job may reach - a two-GPU run must not pay
    for the cores and memory an eight-GPU one needs. A model backend's declared need per
    GPU (6.4 resources) comes before the configured one. A figure this cannot read is left
    exactly as configured rather than guessed at."""
    declared = resources or {}
    gpus = max(1, gpu_count)
    cpus = int(declared.get('cpus_per_gpu') or config.SLURM_CPUS_PER_GPU) * gpus
    ceiling = str(config.SLURM_CPUS).strip()
    if ceiling.isdigit():
        cpus = min(cpus, int(ceiling))
    memory = declared.get('memory_per_gpu_gb')
    per_gpu = float(memory) if memory else _gib(config.SLURM_MEM_PER_GPU)
    if per_gpu is None:
        return str(cpus), config.SLURM_MEM
    mem = per_gpu * gpus
    most = _gib(config.SLURM_MEM)
    return str(cpus), f'{round(min(mem, most) if most else mem)}G'


def _sbatch_directives(training: dict, resources: dict | None = None) -> tuple[list[str], int]:
    """The #SBATCH lines this run's GPU choice asks for, and its GPU count."""
    gpu_type = training.get('gpu_type')
    if gpu_type:
        gres = f'gpu:{gpu_type}:{training["gpu_count"]}'
        gpu_count = training['gpu_count']
        partition = GPU_PARTITIONS.get(gpu_type, config.SLURM_PARTITION)
    else:
        gres = config.SLURM_GRES
        gpu_count = int(config.SLURM_GRES.rsplit(':', 1)[-1]) if ':' in config.SLURM_GRES else 1
        partition = config.SLURM_PARTITION
    directives = [f'#SBATCH --job-name=deeplabel-{training["task"]}-{training["id"]}']
    if partition:
        directives.append(f'#SBATCH --partition={partition}')
    account = training.get('slurm_account') or config.SLURM_ACCOUNT
    if account:
        directives.append(f'#SBATCH --account={account}')
    # Every run submits under the same cluster login, so sacct's User column cannot tell
    # two people apart. The comment can.
    if training.get('owner'):
        directives.append(f'#SBATCH --comment=deeplabel:{training["owner"]}')
    cpus, mem = job_resources(gpu_count, resources)
    directives += [
        f'#SBATCH --gres={gres}',
        f'#SBATCH --cpus-per-task={cpus}',
        f'#SBATCH --mem={mem}',
    ]
    if config.SLURM_TIME:
        directives.append(f'#SBATCH --time={config.SLURM_TIME}')
    directives += ['#SBATCH --output=slurm.out', '#SBATCH --error=slurm.out']
    return directives, gpu_count


def _backend_sbatch_script(training: dict, image: str, entrypoint: list[str], resume: bool = False,
                           resources: dict | None = None) -> str:
    """The generic job script of 6.7: the backend's own image, its own entrypoint, and the
    entrypoint contract's five variables (6.6) - the same run as on the backend itself,
    on the cluster's cards. The contract manifest takes the snapshot's manifest.json there,
    as fetching the snapshot over HTTP makes it locally. A resumed run also names its
    output directory as TRAIN_RESUME, where the entrypoint finds its last checkpoint (6.9).
    The job asks for the cores and memory the backend declares it needs per GPU."""
    directives, gpu_count = _sbatch_directives(training, resources)
    command = ' '.join(shlex.quote(part) for part in entrypoint)
    return '\n'.join([
        '#!/bin/bash',
        *directives,
        'set -euo pipefail',
        # The nodes start a job at 1024 open files, which RF-DETR's data-loader workers exhaust.
        'ulimit -n "$(ulimit -Hn)"',
        'cd "${SLURM_SUBMIT_DIR}"',
        'export PYTHONNOUSERSITE=1',
        'export TRAIN_SNAPSHOT="${SLURM_SUBMIT_DIR}/snapshot"',
        'export TRAIN_OUTPUT="${SLURM_SUBMIT_DIR}/output"',
        'export TRAIN_BASE="${SLURM_SUBMIT_DIR}/base"',
        'export TRAIN_PARAMS="${SLURM_SUBMIT_DIR}/params.json"',
        f'export TRAIN_GPUS="{gpu_count}"',
        f'cp "${{SLURM_SUBMIT_DIR}}/{remote_training.MANIFEST_NAME}" "${{TRAIN_SNAPSHOT}}/manifest.json"',
        # A resumed run trains on from the checkpoint in its output; any other attempt starts
        # from an empty one, or its progress lands behind a failed attempt's.
        *(['export TRAIN_RESUME="${TRAIN_OUTPUT}"'] if resume else ['rm -rf "${TRAIN_OUTPUT}"']),
        'mkdir -p "${TRAIN_OUTPUT}"',
        'srun --container-image=' + shlex.quote(image) + ' --container-mounts="${SLURM_SUBMIT_DIR}:${SLURM_SUBMIT_DIR}"'
        ' --container-workdir="${SLURM_SUBMIT_DIR}" ' + command,
    ]) + '\n'


def submit_slurm(conn, training_id: int, attempt: int | None = None):
    """Cut, ship and queue one attempt of a run. Every write it makes names the attempt it
    started under, so a submit that is still on its feet when a retry replaces it reports
    nothing at all."""
    training = get_training(conn, training_id)
    if training is None:
        return
    attempt = training['attempt'] if attempt is None else attempt

    def report(**fields) -> bool:
        return set_state_for_attempt(conn, training_id, attempt, **fields)

    try:
        # Before the snapshot, not after: cutting one takes minutes and a closed session
        # cannot be recovered from here, so the whole cut would be thrown away.
        unreachable = probe_cluster()
        if unreachable:
            raise RuntimeError(unreachable)
        client = remote_training.training_backend(conn, training)
        prepare_snapshot(conn, training)
        if is_cancelled(conn, training_id):
            report(phase=None)
            return
        tdir = config.training_dir(training_id)
        # The run trains in its backend's image, as it would on the backend itself.
        if not client.backend.cluster_image:
            raise remote_training.CannotTrain(
                f'model backend "{client.backend.name}" has no cluster image '
                f'(MODEL_BACKEND_{client.backend.name.upper()}_CLUSTER_IMAGE)')
        augmentation = write_augmentation(training)
        remote_training.prepare_cluster_run(
            conn, training, json.loads(augmentation.read_text(encoding='utf-8')) if augmentation else None)
        report(backend=client.backend.name, metric_info=remote_training.declared_metrics(client))
        train = client.info()['train']
        script = _backend_sbatch_script(training, client.backend.cluster_image, train['entrypoint'],
                                        resources=train.get('resources'))
        (tdir / 'train.sbatch').write_text(script, encoding='utf-8')
        # Asked again here, not only before the cut: a snapshot takes as long as it takes,
        # and the session can drop while it runs - a backend restart is enough. Without
        # this the transfer fails with rsync's exit code, which names nothing.
        unreachable = probe_cluster()
        if unreachable:
            raise RuntimeError(unreachable)
        remote = f'{config.SLURM_REMOTE_DIR}/{training_id}'
        _check(_ssh(['mkdir', '-p', remote]), 'ssh to the cluster')
        # The pid goes on the row for as long as the transfer runs, because that is what a
        # cancel signals; hours of uplink are otherwise spent on a run nobody wants.
        transfer = _rsync(f'{tdir}/', f'{_ssh_target()}:{remote}/',
                          on_pid=lambda pid: report(pid=pid))
        report(pid=None)
        _check(transfer, 'rsync to the cluster')
        out = _check(_ssh(['bash', '-lc', f'cd {shlex.quote(remote)} && sbatch --parsable train.sbatch']),
                     'sbatch on the cluster')
        slurm_id = out.stdout.strip().splitlines()[-1]
        # error is cleared here, not at submit: a retried run otherwise carries the
        # message from the attempt that failed for the whole of its healthy life.
        report(status='running', phase='slurm:PENDING', slurm_job_id=slurm_id, error=None)
    except train_snapshot.SnapshotCancelled:
        report(phase=None, snapshot_progress=None, pid=None)
    except Exception as e:
        # A cancelled run failing its transfer is the cancel working, not a failure.
        if is_cancelled(conn, training_id):
            report(phase=None, pid=None)
            return
        report(status='error', phase=None, pid=None, error=str(e)[:500])


def _pending_reason(slurm_job_id: str) -> str:
    out = _ssh(['squeue', '-j', slurm_job_id, '-h', '-o', '%R'])
    reason = out.stdout.strip().splitlines()[-1].strip() if out.returncode == 0 and out.stdout.strip() else ''
    return reason if reason and reason != 'None' else ''


def _fetch_live_artifacts(training: dict, remote: str):
    """Pulled on every poll while the job runs: the tiny progress file and the
    log tail, so the UI can chart and show output without anyone ssh-ing in."""
    tdir = config.training_dir(training['id'])
    (tdir / 'output').mkdir(parents=True, exist_ok=True)
    _rsync(f'{_ssh_target()}:{remote}/output/{PROGRESS_NAME}', f'{tdir}/output/{PROGRESS_NAME}')
    tail = _ssh(['tail', '-n', str(LOG_TAIL_LINES), f'{remote}/slurm.out'])
    if tail.returncode == 0:
        (tdir / 'slurm.tail').write_text(tail.stdout, encoding='utf-8')


def _fetch_full_log(training: dict, remote: str) -> str:
    tdir = config.training_dir(training['id'])
    _rsync(f'{_ssh_target()}:{remote}/slurm.out', f'{tdir}/slurm.out')
    log = tdir / 'slurm.out'
    return log.read_text(encoding='utf-8', errors='replace') if log.is_file() else ''


_cluster_reachable = True


def cluster_reachable() -> bool:
    """Whether the last poll of a running cluster job got through. A dropped session
    (backend restart, network blip) lands here: the job keeps running untouched, but
    its state stops updating, which is indistinguishable from a slow epoch unless it
    is reported. Driven by a real failed call, so a cluster that needs no unlocking
    never looks lost."""
    return _cluster_reachable


def _set_reachable(reachable: bool) -> None:
    global _cluster_reachable
    _cluster_reachable = reachable


def _poll_slurm_once(conn):
    rows = conn.execute(
        "SELECT * FROM trainings WHERE target = 'slurm' AND status = 'running' "
        'AND slurm_job_id IS NOT NULL').fetchall()
    for row in rows:
        training = dict(row)
        remote = f'{config.SLURM_REMOTE_DIR}/{training["id"]}'
        out = _ssh(['sacct', '-j', training['slurm_job_id'], '-n', '-X', '-o', 'State'])
        _set_reachable(out.returncode == 0)
        if out.returncode != 0:
            # Never an error for the run: the job is on the cluster either way, and
            # the next poll after a reconnect picks it up where it left off.
            continue
        state = (out.stdout.strip().split() or ['UNKNOWN'])[0]
        if state == 'PENDING':
            reason = _pending_reason(training['slurm_job_id'])
            set_state(conn, training['id'],
                      phase=f'slurm:PENDING ({reason})' if reason else 'slurm:PENDING')
            continue
        if state in ('RUNNING', 'COMPLETING'):
            _fetch_live_artifacts(training, remote)
            set_state(conn, training['id'], phase=f'slurm:{state}')
            continue
        if state == 'COMPLETED':
            tdir = config.training_dir(training['id'])
            fetch = _rsync(f'{_ssh_target()}:{remote}/output/', f'{tdir}/output/')
            _fetch_full_log(training, remote)
            if fetch.returncode != 0:
                set_state(conn, training['id'], status='error', phase=None,
                          error=f'fetching results failed: {fetch.stderr[:300]}')
                continue
            try:
                register_result(conn, training, tdir / 'output')
                set_state(conn, training['id'], status='done', phase=None)
            except Exception as e:
                set_state(conn, training['id'], status='error', phase=None, error=str(e)[:500])
        else:
            if state == 'TIMEOUT' and _resume_from_checkpoint(conn, training, remote):
                continue
            detail = extract_error(_fetch_full_log(training, remote))
            error = f'slurm state {state}' + (f': {detail}' if detail else '')
            if state == 'TIMEOUT' and training.get('resumes'):
                error += f' (resumed {training["resumes"]} times)'
            set_state(conn, training['id'], status='error', phase=None, error=error[:500])


def _resume_from_checkpoint(conn, training: dict, remote: str) -> bool:
    """Resubmit a run that hit the time limit, in the same remote directory with
    TRAIN_RESUME set, when its backend declares it can resume and the run has resumes
    left (6.9). False leaves it to fail as a timeout."""
    resumes = training.get('resumes') or 0
    if not training.get('backend') or resumes >= config.SLURM_MAX_RESUMES:
        return False
    try:
        client = remote_training.training_backend(conn, training)
    except (remote_training.CannotTrain, backend_client.BackendError):
        return False
    train = client.info()['train']
    if not train.get('resume'):
        return False
    tdir = config.training_dir(training['id'])
    tdir.mkdir(parents=True, exist_ok=True)
    (tdir / 'train.sbatch').write_text(
        _backend_sbatch_script(training, client.backend.cluster_image, train['entrypoint'], resume=True,
                               resources=train.get('resources')),
        encoding='utf-8')
    if _rsync(f'{tdir}/train.sbatch', f'{_ssh_target()}:{remote}/train.sbatch').returncode != 0:
        return False
    out = _ssh(['bash', '-lc', f'cd {shlex.quote(remote)} && sbatch --parsable train.sbatch'])
    if out.returncode != 0:
        return False
    set_state(conn, training['id'], slurm_job_id=out.stdout.strip().splitlines()[-1], resumes=resumes + 1,
              phase=f'slurm:PENDING (resumed {resumes + 1} of {config.SLURM_MAX_RESUMES})')
    return True


def _slurm_poll_loop():
    conn = store.connect(config.DB_PATH)
    while True:
        time.sleep(SLURM_POLL_SECONDS)
        try:
            _poll_slurm_once(conn)
        except Exception:
            pass


def start_slurm_poller():
    if slurm_available():
        threading.Thread(target=_slurm_poll_loop, daemon=True).start()
