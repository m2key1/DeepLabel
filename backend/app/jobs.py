import os
import signal
import subprocess
import sys
import threading
import time
import traceback
from pathlib import Path

from app import (config, dataset_sync, evaluator, ingest, map_classes, map_ingest, model_registry,
                 map_job, registry, store, trainer)

BACKEND_DIR = Path(__file__).resolve().parents[1]


def predict_classes(task: str, job_drawable: list, model_drawable: set) -> tuple:
    """(class_ids to extract, merge_class_id) for a predict run.

    Polygon jobs intersect: the job's drawable classes ∩ the model's, so a class the user
    deleted is never re-introduced, falling back to the model's own set if the intersection
    is empty. Line jobs invert this — their vocabulary is the single 'edge lines' class, so
    intersecting would extract *only that id's* surfaces (buildings, say) and silently lose
    every other one. They want every surface the model can find, since it is the outlines
    that matter, all merged onto their one class."""
    if task == 'map_lines':
        merge = min(job_drawable) if job_drawable else map_classes.LINE_CLASS_ID
        return sorted(model_drawable), merge
    return [c for c in job_drawable if c in model_drawable] or sorted(model_drawable), None


def _map_runner_config(conn, job_id: str, needs_checkpoint: bool = True):
    """Resolve a map-predict job to (checkpoint_path, num_classes, class_ids, merge_class_id).
    Raises RuntimeError with a user-facing message on any unrecoverable config problem.

    num_classes always comes from the model (the checkpoint head size); class_ids are the
    job's drawable classes intersected with the model's, so a class the user deleted from
    the job is never re-introduced by prediction. Falls back to MAPSEG_CHECKPOINT with 6
    classes when the job has no model (registry absent).

    Line jobs invert the class_ids logic: their vocabulary is the single 'edge lines' class,
    so intersecting would extract only that one id's surfaces. They want *every* surface the
    model detects — it is the outlines that matter — merged into their one class, which
    `merge_class_id` names (None for polygon jobs, which keep the model's classes)."""
    job = store.get_job(conn, job_id)
    model = model_registry.get_model(job['model_id']) if job.get('model_id') else None
    if job.get('model_id') and model is None:
        raise RuntimeError(f"map model '{job['model_id']}' is no longer in the registry")
    if model:
        ckpt = model_registry.checkpoint_path(model)
        num_classes = len(model['classes'])
        model_drawable = {c['id'] for c in model['classes']} - {0}
    else:
        ckpt = Path(config.MAPSEG_CHECKPOINT)
        num_classes = 6
        model_drawable = set(range(1, num_classes))
    # A model on a model backend is read from the weight store, not from this path.
    if needs_checkpoint and not ckpt.exists():
        raise RuntimeError(f'map-segmentation checkpoint not found: {ckpt}')
    job_drawable = [c['id'] for c in store.job_classes(conn, job_id) if c['id'] != 0]
    class_ids, merge_class_id = predict_classes(job['task'], job_drawable, model_drawable)
    return ckpt, num_classes, class_ids, merge_class_id


def map_runner_problem() -> str | None:
    """Why map tiling and pre-annotation cannot run on this deployment, or None if they can."""
    if config.MAPSEG_PYTHON is None:
        return 'MAPSEG_PYTHON is not set, so this deployment cannot cut maps into tiles or pre-annotate them'
    if not Path(config.MAPSEG_PYTHON).exists():
        return f'MAPSEG_PYTHON ({config.MAPSEG_PYTHON}) does not exist, so this deployment cannot cut ' \
               'maps into tiles or pre-annotate them'
    if not (config.MAPSEG_ROOT / 'inference' / 'engine.py').exists():
        return f'MAPSEG_ROOT ({config.MAPSEG_ROOT}) does not point at the cadastre_segmentation repo, ' \
               'so this deployment cannot cut maps into tiles or pre-annotate them'
    return None


def map_window(conn, job_id: str) -> int:
    """The square window the job's map model reads, which prediction slides over each tile."""
    job = store.get_job(conn, job_id)
    model = model_registry.get_model(job['model_id']) if job.get('model_id') else None
    return model_registry.input_size(model)


def _spawn_runner(conn, job_id: str) -> subprocess.Popen:
    """A text job's process, under DeepLabel's own interpreter; its models run on their
    backends."""
    env = os.environ.copy()
    job = store.get_job(conn, job_id)
    env.update(registry.chosen_models(conn, job) if job is not None else {})
    env['PYTHONPATH'] = str(BACKEND_DIR)
    command = [sys.executable, '-m', 'app.text_job',
               '--job-id', job_id,
               '--db-path', str(config.DB_PATH),
               '--job-path', str(config.job_dir(job_id)),
               '--layout-batch-size', str(config.LAYOUT_BATCH_SIZE),
               '--ocr-chunk-lines', str(config.OCR_CHUNK_LINES)]
    # The child inherits the log fd at spawn, so closing our handle right after is safe.
    with open(config.job_dir(job_id) / 'runner.log', 'a') as log:
        return subprocess.Popen(command, cwd=BACKEND_DIR, env=env, stdout=log, stderr=subprocess.STDOUT)


def _spawn_map_runner(job_id: str, run_tile: bool, run_predict: bool, tile_size: int,
                      skip_blank: bool, ckpt: Path | None = None, num_classes: int = 6,
                      class_ids: list | None = None, region_kind: str = 'polygon',
                      merge_class_id: int | None = None,
                      window: int = model_registry.DEFAULT_INPUT_SIZE, served: bool = False) -> subprocess.Popen:
    # Tiling (numpy/rasterio) and prediction (torch/SMP) both need the mapseg venv, absent
    # from the app venv — so they run in a subprocess under MAPSEG_PYTHON. The model code itself lives in the cadastre_segmentation repo, put on
    # the path via MAPSEG_ROOT: the runner imports app.* + inference.* and no Schematismus.
    # Predict-only args are passed only when prediction is enabled.
    env = os.environ.copy()
    env['PYTHONPATH'] = f'{config.MAPSEG_ROOT}:{BACKEND_DIR}'
    env['BLOBS_DIR'] = str(config.BLOBS_DIR)
    args = [str(config.MAPSEG_PYTHON), '-m', 'runner.run_map_job',
            '--job-id', job_id,
            '--db-path', str(config.DB_PATH),
            '--job-path', str(config.job_dir(job_id)),
            '--run-tile', '1' if run_tile else '0',
            '--run-predict', '1' if run_predict else '0',
            '--tile-size', str(tile_size),
            '--skip-blank', '1' if skip_blank else '0']
    if run_predict:
        args += ['--checkpoint', str(ckpt),
                 '--num-classes', str(num_classes),
                 '--class-ids', ','.join(str(c) for c in (class_ids or [])),
                 '--batch-size', str(config.MAPSEG_BATCH_SIZE),
                 '--epsilon', str(config.MAPSEG_EPSILON),
                 '--min-area', str(config.MAPSEG_MIN_AREA),
                 '--window', str(window),
                 # Line-tracing jobs run the same segmentation checkpoint and reduce the
                 # detected surfaces to their outlines instead of filled polygons.
                 '--region-kind', region_kind]
        if merge_class_id is not None:
            # Every detected surface's outline lands on this one class.
            args += ['--merge-class-id', str(merge_class_id)]
        if served:
            args += ['--served', '1']
    with open(config.job_dir(job_id) / 'runner.log', 'a') as log:
        return subprocess.Popen(args, cwd=str(BACKEND_DIR), env=env, stdout=log, stderr=subprocess.STDOUT)


def _spawn_served_map_job(job_id: str, class_ids: list, region_kind: str,
                          merge_class_id: int | None) -> subprocess.Popen:
    """A map job with nothing to cut and its model on a model backend: DeepLabel's own
    interpreter ingests the tiles and has them read there, with no map venv at all."""
    env = os.environ.copy()
    env['PYTHONPATH'] = str(BACKEND_DIR)
    args = [sys.executable, '-m', 'app.map_job', '--job-id', job_id, '--db-path', str(config.DB_PATH),
            '--job-path', str(config.job_dir(job_id)), '--blobs-dir', str(config.BLOBS_DIR),
            '--class-ids', ','.join(str(c) for c in class_ids),
            '--epsilon', str(config.MAPSEG_EPSILON), '--min-area', str(config.MAPSEG_MIN_AREA),
            '--region-kind', region_kind]
    if merge_class_id is not None:
        args += ['--merge-class-id', str(merge_class_id)]
    with open(config.job_dir(job_id) / 'runner.log', 'a') as log:
        return subprocess.Popen(args, cwd=str(BACKEND_DIR), env=env, stdout=log, stderr=subprocess.STDOUT)


QUEUE_KINDS = ('job', 'training', 'evaluation')


def queue_order(row, kind: str, submission_id: int) -> tuple:
    """Where a piece of queued work stands: first queued first - work run again queues
    anew, work never run since it was made queued when it was made - and within one
    second, datasets, then trainings, then evaluations, each in the order they were
    submitted. The worker and the Queue tab both sort by this."""
    return (queued_since(row), QUEUE_KINDS.index(kind), submission_id)


def queued_since(row) -> str:
    return row['queued_at'] or row['created_at']


def _next_work(conn):
    """Datasets, local trainings, and evaluations share the one GPU, oldest first. A
    dataset's id is random, so its rowid is what records the order it was submitted in."""
    heads = {
        'job': "SELECT id, rowid seq, created_at, queued_at FROM jobs WHERE status = 'queued' "
               'ORDER BY coalesce(queued_at, created_at), rowid LIMIT 1',
        'training': "SELECT id, id seq, created_at, queued_at FROM trainings WHERE status = 'queued' "
                    "AND target = 'local' ORDER BY coalesce(queued_at, created_at), id LIMIT 1",
        'evaluation': "SELECT id, id seq, created_at, queued_at FROM evaluations WHERE status = 'queued' "
                      'ORDER BY coalesce(queued_at, created_at), id LIMIT 1',
    }
    candidates = []
    for kind, sql in heads.items():
        row = conn.execute(sql).fetchone()
        if row is not None:
            candidates.append((queue_order(row, kind, row['seq']), kind, row['id']))
    if not candidates:
        return None
    _, kind, work_id = min(candidates)
    return (kind, work_id)


def _worker_loop():
    conn = store.connect(config.DB_PATH)
    conn.execute("UPDATE jobs SET status = 'queued', pid = NULL WHERE status = 'running'")
    conn.execute("UPDATE trainings SET status = 'queued', pid = NULL "
                 "WHERE target = 'local' AND status IN ('preparing', 'running')")
    conn.execute("UPDATE evaluations SET status = 'queued', pid = NULL WHERE status = 'running'")
    conn.commit()

    while True:
        work = _next_work(conn)
        if work is None:
            time.sleep(1)
            continue
        kind, work_id = work
        try:
            _run_work(conn, kind, work_id)
        except Exception as exc:
            traceback.print_exc()
            try:
                _fail_work(conn, kind, work_id, f'{type(exc).__name__}: {exc}')
            except Exception:
                traceback.print_exc()


WORK_TABLES = {'job': 'jobs', 'training': 'trainings', 'evaluation': 'evaluations'}


def _fail_work(conn, kind: str, work_id, error: str):
    """One piece of work that raised must not stop the queue, nor be picked up again."""
    conn.rollback()
    conn.execute(f"UPDATE {WORK_TABLES[kind]} SET status = 'error', error = ?, pid = NULL "
                 "WHERE id = ? AND status IN ('queued', 'preparing', 'running')", (error, work_id))
    conn.commit()


def _run_work(conn, kind: str, work_id):
    if kind == 'training':
        trainer.run_local(conn, work_id)
        return
    if kind == 'evaluation':
        evaluator.run_local(conn, work_id)
        return

    job_id = work_id
    jrow = conn.execute(
        'SELECT task, run_predict, run_tile, tile_size, tile_skip_blank FROM jobs WHERE id = ?',
        (job_id,)).fetchone()
    task = jrow['task']

    if task in ingest.TILE_TASKS:
        # Annotation-only map jobs (no tiling, no predict) ingest already-cut tiles
        # with pure PIL in this thread — no GPU, no model repos, no dataset_sync.
        if not jrow['run_predict'] and not jrow['run_tile']:
            _run_map_job(conn, job_id)
            return
        served = bool(jrow['run_predict']) and map_job.served_model(conn, store.get_job(conn, job_id)) is not None
        # Tiling, and prediction in-process, need the mapseg venv → subprocess. Fail loudly
        # (job error) rather than silently ingest-only if it isn't configured.
        problem = map_runner_problem() if jrow['run_tile'] or not served else None
        if problem:
            store.set_job_state(conn, job_id, status='error', error=problem)
            return
        ckpt = num_classes = class_ids = merge_class_id = None
        if jrow['run_predict']:
            try:
                ckpt, num_classes, class_ids, merge_class_id = _map_runner_config(conn, job_id,
                                                                                  needs_checkpoint=not served)
            except RuntimeError as exc:
                store.set_job_state(conn, job_id, status='error', error=str(exc))
                return
        region_kind = 'polyline' if task == 'map_lines' else 'polygon'
        try:
            if served and not jrow['run_tile']:
                proc = _spawn_served_map_job(job_id, class_ids, region_kind, merge_class_id)
            else:
                proc = _spawn_map_runner(job_id, bool(jrow['run_tile']), bool(jrow['run_predict']),
                                         jrow['tile_size'], bool(jrow['tile_skip_blank']),
                                         ckpt, num_classes, class_ids, region_kind,
                                         merge_class_id, map_window(conn, job_id), served)
        except OSError as exc:
            store.set_job_state(conn, job_id, status='error',
                                error=f'could not start map runner: {type(exc).__name__}: {exc}')
            return
        store.set_job_state(conn, job_id, status='running', pid=proc.pid)
        proc.wait()
        status = conn.execute('SELECT status FROM jobs WHERE id = ?', (job_id,)).fetchone()
        if status and status['status'] == 'running':
            error = 'runner exited unexpectedly' if proc.returncode else None
            store.set_job_state(conn, job_id, status='error' if proc.returncode else 'done', error=error)
        conn.execute('UPDATE jobs SET pid = NULL WHERE id = ?', (job_id,))
        conn.commit()
        return

    proc = _spawn_runner(conn, job_id)
    store.set_job_state(conn, job_id, status='running', pid=proc.pid)
    proc.wait()
    try:
        status = conn.execute('SELECT status FROM jobs WHERE id = ?', (job_id,)).fetchone()
        if status and status['status'] == 'running':
            error = 'runner exited unexpectedly' if proc.returncode else None
            store.set_job_state(conn, job_id, status='error' if proc.returncode else 'done',
                                error=error)
        conn.execute('UPDATE jobs SET pid = NULL WHERE id = ?', (job_id,))
        conn.commit()
    finally:
        # The runner is a separate process, so the API's in-process queue never saw
        # its element writes; rebuild the dataset once the run finishes.
        dataset_sync.enqueue(job_id)


def _run_map_job(conn, job_id: str):
    store.set_job_state(conn, job_id, status='running', phase='ingest')
    log = open(config.job_dir(job_id) / 'runner.log', 'a')
    try:
        map_ingest.ingest_map_job(conn, job_id, config.job_dir(job_id), blobs_dir=config.BLOBS_DIR)
    except Exception as exc:
        print(f'map ingest failed: {type(exc).__name__}: {exc}', file=log, flush=True)
        store.set_job_state(conn, job_id, status='error', error=f'{type(exc).__name__}: {exc}')
        return
    finally:
        log.close()
    status = conn.execute('SELECT status FROM jobs WHERE id = ?', (job_id,)).fetchone()
    # A cancel mid-ingest already set 'cancelled'; only a still-running job completes.
    if status and status['status'] == 'running':
        store.set_job_state(conn, job_id, status='done')
    conn.execute('UPDATE jobs SET phase = NULL WHERE id = ?', (job_id,))
    conn.commit()


def start_worker():
    threading.Thread(target=_worker_loop, daemon=True).start()


REOCR_INTERVAL = 60  # batch pending re-OCRs so many edits amortize one model load
_next_reocr_pass = 0.0


def next_reocr_pass_in() -> float | None:
    """Seconds until the batcher's next sweep - the queue page counts down to it so a
    freshly flagged line is visibly on its way. None until the batcher has started."""
    return max(0.0, _next_reocr_pass - time.time()) if _next_reocr_pass else None


def _reocr_batch_loop():
    """Re-queue jobs that have lines flagged needs_ocr (from a reshape/rotate of an
    untouched line). The runner's OCR phase re-reads them, keeping the old text until
    the fresh read lands. Runs on its own cadence so rapid edits batch into one pass."""
    global _next_reocr_pass
    conn = store.connect(config.DB_PATH)
    while True:
        _next_reocr_pass = time.time() + REOCR_INTERVAL
        time.sleep(REOCR_INTERVAL)
        rows = conn.execute(
            "SELECT DISTINCT p.job_id FROM lines l "
            "JOIN elements e ON l.element_id = e.id JOIN pages p ON e.page_id = p.id "
            "JOIN jobs j ON j.id = p.job_id "
            "WHERE l.needs_ocr = 1 AND l.deleted = 0 AND j.run_ocr = 1 "
            "AND j.status NOT IN ('queued', 'running', 'uploading')").fetchall()
        for row in rows:
            conn.execute(
                "UPDATE jobs SET status = 'queued', phase = NULL, error = NULL "
                "WHERE id = ? AND status NOT IN ('queued', 'running', 'uploading')", (row['job_id'],))
        conn.commit()


def start_reocr_batcher():
    threading.Thread(target=_reocr_batch_loop, daemon=True).start()


CANCELLABLE_STATUSES = ('queued', 'running')


def cancel_job(conn, job_id: str) -> bool:
    """Stop a dataset that is still to run, and say whether there was one. A finished
    run is left as it ended - a Cancel from a stale tab must not unfinish it."""
    row = conn.execute('SELECT pid FROM jobs WHERE id = ?', (job_id,)).fetchone()
    cancelled = conn.execute(
        "UPDATE jobs SET status = 'cancelled' WHERE id = ? AND status IN (?, ?)",
        (job_id, *CANCELLABLE_STATUSES)).rowcount
    conn.commit()
    if not cancelled:
        return False
    if row['pid']:
        try:
            os.kill(row['pid'], signal.SIGTERM)
        except ProcessLookupError:
            pass
    return True
