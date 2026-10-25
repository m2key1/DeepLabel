import hashlib
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

from app import config, decode, eval_lines, registry, store

BACKEND_DIR = Path(__file__).resolve().parents[1]


def lines_path(eval_id: int) -> Path:
    """Where the runner writes one record per scored line, beside its log."""
    return config.EVALS_DIR / f'{eval_id}.lines.jsonl'


def get_evaluation(conn, eval_id: int) -> dict | None:
    row = conn.execute('SELECT * FROM evaluations WHERE id = ?', (eval_id,)).fetchone()
    return dict(row) if row else None


def payload(row) -> dict:
    ev = dict(row)
    ev['source'] = json.loads(ev['source'] or '{}')
    ev['breakdown'] = json.loads(ev['breakdown']) if ev.get('breakdown') else None
    ev.pop('pid', None)
    return ev


def create(conn, model_id: int, source: dict, decode: str, owner: str,
           training_id: int | None = None, fingerprint: str | None = None) -> int:
    cur = conn.execute(
        'INSERT INTO evaluations (model_id, training_id, source, decode, owner, fingerprint) '
        'VALUES (?, ?, ?, ?, ?, ?)',
        (model_id, training_id, json.dumps(source), decode, owner, fingerprint))
    conn.commit()
    return cur.lastrowid


def split_fingerprint(training_id: int) -> str | None:
    """Content hash of the frozen valid split. Crop names carry the line ids, so
    two snapshots of untouched data hash identically across trainings."""
    valid = config.training_dir(training_id) / 'snapshot' / 'valid'
    if not valid.is_dir():
        return None
    digest = hashlib.sha256()
    pairs = 0
    for txt in sorted(valid.glob('*.txt')):
        image_file = txt.with_suffix('.png')
        if not image_file.is_file():
            continue
        pairs += 1
        digest.update(txt.name.encode())
        digest.update(txt.read_bytes())
        digest.update(image_file.read_bytes())
    return digest.hexdigest() if pairs else None


def valid_split_is_empty(training: dict) -> bool:
    """Whether the run froze nothing to validate on. The counts are the run's own record of
    the cut; a split with no pairs has nothing to score, and a CER over no lines would sit
    on the run page as if it were one. The form warns of exactly this before the run
    starts, and says the baseline/result comparison will be skipped."""
    counts = json.loads(training.get('snapshot_counts') or 'null')
    return counts is not None and not counts.get('val')


def create_baseline(conn, training: dict):
    """Queued as soon as the snapshot exists: scores the base model on the valid
    split while the training runs, so the number to beat is known early - and
    survives even if the training itself fails. If the same model was already
    scored on a byte-identical split, the scores are copied instead of re-run."""
    if valid_split_is_empty(training):
        return
    if not training.get('base_model_id'):
        return
    if registry.get_model(conn, training['base_model_id']) is None:
        return
    fingerprint = split_fingerprint(training['id'])
    for mode in decode.OCR_DECODES:
        prior = conn.execute(
            'SELECT id, cer, wer, line_count FROM evaluations '
            'WHERE model_id = ? AND decode = ? AND fingerprint = ? AND status = ? '
            'ORDER BY id DESC LIMIT 1',
            (training['base_model_id'], mode, fingerprint, 'done')).fetchone() if fingerprint else None
        if prior is not None:
            cur = conn.execute(
                'INSERT INTO evaluations (model_id, training_id, source, decode, owner, '
                "fingerprint, status, cer, wer, line_count) VALUES (?, ?, ?, ?, ?, ?, 'done', ?, ?, ?)",
                (training['base_model_id'], training['id'], json.dumps({'snapshot': training['id']}),
                 mode, training['owner'], fingerprint, prior['cer'], prior['wer'], prior['line_count']))
            conn.commit()
            eval_lines.copy(conn, prior['id'], cur.lastrowid)
            continue
        create(conn, training['base_model_id'], {'snapshot': training['id']}, mode,
               training['owner'], training['id'], fingerprint)


def create_result_eval(conn, training: dict, new_model_id: int):
    """After the training registers its model: score it on the same valid split as the
    baseline - the pair answers "did it help?". Every decode is scored, because they
    disagree: the LM beam and the decoder rerank differ by more than a point of CER on
    material the LM was not built for, and one number cannot show that."""
    if valid_split_is_empty(training):
        return
    fingerprint = split_fingerprint(training['id'])
    for mode in decode.OCR_DECODES:
        create(conn, new_model_id, {'snapshot': training['id']}, mode,
               training['owner'], training['id'], fingerprint)


def set_state(conn, eval_id: int, **fields):
    sets, params = store.state_update(fields)
    conn.execute(f'UPDATE evaluations SET {sets} WHERE id = ?', (*params, eval_id))
    conn.commit()


def finish(conn, eval_id: int, **fields):
    """The runner's last word, written only while the evaluation still runs, so a cancel
    that lands just before it stays a cancel."""
    sets, params = store.state_update(fields)
    conn.execute(f"UPDATE evaluations SET {sets} WHERE id = ? AND status = 'running'",
                 (*params, eval_id))
    conn.commit()


def cancel(conn, eval_id: int) -> bool:
    """Stop an evaluation that is still to finish, and say whether there was one."""
    evaluation = get_evaluation(conn, eval_id)
    cancelled = conn.execute(
        "UPDATE evaluations SET status = 'cancelled' WHERE id = ? AND status IN ('queued', 'running')",
        (eval_id,)).rowcount
    conn.commit()
    if not cancelled:
        return False
    if evaluation.get('pid'):
        _stop(evaluation['pid'])
    return True


def _stop(pid: int):
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass


def _spawn(conn, evaluation: dict) -> subprocess.Popen:
    env = os.environ.copy()
    env['PYTHONPATH'] = str(BACKEND_DIR)
    config.EVALS_DIR.mkdir(parents=True, exist_ok=True)
    with open(config.EVALS_DIR / f'{evaluation["id"]}.log', 'a') as log:
        return subprocess.Popen(
            [sys.executable, '-m', 'app.eval_run',
             '--evaluation-id', str(evaluation['id']),
             '--db-path', str(config.DB_PATH),
             '--lines-out', str(lines_path(evaluation['id']))],
            cwd=BACKEND_DIR, env=env, stdout=log, stderr=subprocess.STDOUT)


# How often the ceiling is checked. A run climbs to tens of gigabytes over minutes, so
# seconds of granularity is plenty and costs one small read of /proc.
MEMORY_POLL_SECONDS = 2.0


def host_memory_bytes() -> int | None:
    """Total RAM, read where Linux publishes it. None where it cannot be read, which
    disables the ceiling rather than guessing one."""
    try:
        for line in Path('/proc/meminfo').read_text().splitlines():
            if line.startswith('MemTotal:'):
                return int(line.split()[1]) * 1024
    except OSError:
        return None
    return None


def memory_ceiling() -> int | None:
    """What one evaluation may hold before it is stopped. Configured, or half the host."""
    if config.EVAL_MEMORY_LIMIT_GB:
        return int(config.EVAL_MEMORY_LIMIT_GB * 1024 ** 3)
    total = host_memory_bytes()
    return total // 2 if total else None


def process_memory(pid: int) -> int:
    """Resident bytes of a running process, or 0 once it is gone."""
    try:
        return int(Path(f'/proc/{pid}/statm').read_text().split()[1]) * os.sysconf('SC_PAGE_SIZE')
    except (OSError, IndexError, ValueError):
        return 0


def _wait_within(proc, ceiling: int | None) -> int | None:
    """Wait for the runner, stopping it if it grows past the ceiling. Returns the resident
    size it reached when it was stopped, or None when it finished on its own.

    The kernel's own answer to a run that eats everything is to kill the largest process on
    the machine, which on 2026-09-11 was this one three times over and could as easily have
    been the backend. A ceiling here ends one evaluation instead."""
    if ceiling is None:
        proc.wait()
        return None
    while True:
        try:
            proc.wait(timeout=MEMORY_POLL_SECONDS)
            return None
        except subprocess.TimeoutExpired:
            held = process_memory(proc.pid)
            if held > ceiling:
                proc.kill()
                proc.wait()
                return held


def run_local(conn, eval_id: int):
    """Executed from the shared GPU worker slot."""
    evaluation = get_evaluation(conn, eval_id)
    if evaluation is None:
        return
    if registry.get_model(conn, evaluation['model_id']) is None:
        set_state(conn, eval_id, status='error', error='model no longer exists')
        return
    ceiling = memory_ceiling()
    lines_path(eval_id).unlink(missing_ok=True)
    set_state(conn, eval_id, status='running')
    proc = _spawn(conn, evaluation)
    set_state(conn, eval_id, pid=proc.pid)
    if get_evaluation(conn, eval_id)['status'] != 'running':
        _stop(proc.pid)
    overrun = _wait_within(proc, ceiling)
    if overrun is not None:
        finish(conn, eval_id, status='error',
               error=f'stopped at {overrun / 1024 ** 3:.1f} GB, over the '
                     f'{ceiling / 1024 ** 3:.0f} GB an evaluation may hold')
    elif proc.returncode:
        finish(conn, eval_id, status='error', error='evaluation runner exited unexpectedly')
    else:
        finish(conn, eval_id, status='done')
    finished = get_evaluation(conn, eval_id)
    if finished is None:
        return
    if finished['status'] != 'done':
        lines_path(eval_id).unlink(missing_ok=True)
    if finished['status'] == 'done':
        try:
            eval_lines.import_file(conn, eval_id, lines_path(eval_id))
        except Exception as exc:
            conn.rollback()
            set_state(conn, eval_id, status='error',
                      error=f'could not import the scored lines: {type(exc).__name__}: {exc}')
    set_state(conn, eval_id, pid=None)
