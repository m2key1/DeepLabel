import argparse
import base64
import hashlib
import hmac
import json
import sys
import threading
import time
import uuid
from pathlib import Path

from app import config, registry, store

ROLE_COLUMNS = {'weights': 'checkpoint', 'lm': 'lm_path', 'lm_dict': 'lm_dict_path'}
# The backend a model row with no backend of its own is served by.
TASK_BACKENDS = {'layout': 'layout', 'lines': 'lines', 'ocr': 'ocr', 'map_segmentation': 'mapseg',
                 'edges': 'edges'}
CHUNK = 1 << 20
# How often a backend that has not answered yet is asked again for its builtin weights.
BUILTIN_RETRY_SECONDS = 30


def blob_path(sha256: str) -> Path:
    return config.WEIGHTS_DIR / sha256[:2] / sha256


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        for block in iter(lambda: handle.read(CHUNK), b''):
            digest.update(block)
    return digest.hexdigest()


def put(source: Path) -> tuple[str, int]:
    """Copies a file into the store under its sha256, hashing as it copies. Content that is
    already there is not stored twice."""
    incoming = config.WEIGHTS_DIR / '.incoming'
    incoming.mkdir(parents=True, exist_ok=True)
    partial = incoming / uuid.uuid4().hex
    digest = hashlib.sha256()
    size = 0
    try:
        with open(source, 'rb') as src, open(partial, 'wb') as dst:
            for block in iter(lambda: src.read(CHUNK), b''):
                digest.update(block)
                dst.write(block)
                size += len(block)
        sha256 = digest.hexdigest()
        dest = blob_path(sha256)
        if dest.is_file() and dest.stat().st_size == size:
            partial.unlink()
        else:
            dest.parent.mkdir(parents=True, exist_ok=True)
            partial.replace(dest)
    finally:
        partial.unlink(missing_ok=True)
    return sha256, size


def model_files(conn, model_id: int) -> list[dict]:
    rows = conn.execute('SELECT role, filename, sha256, size FROM model_files WHERE model_id = ? ORDER BY role',
                        (model_id,)).fetchall()
    return [dict(row) for row in rows]


def files_by_model(conn) -> dict[int, list[dict]]:
    grouped: dict[int, list[dict]] = {}
    for row in conn.execute('SELECT model_id, role, filename, sha256, size FROM model_files ORDER BY role'):
        grouped.setdefault(row['model_id'], []).append(
            {'role': row['role'], 'filename': row['filename'], 'sha256': row['sha256'], 'size': row['size']})
    return grouped


def store_model_files(conn, model_id: int) -> list[str]:
    """Copies the files a model row points at into the store and records them. A role
    already stored is skipped, so an interrupted import resumes. Returns what was missing."""
    row = registry.get_model(conn, model_id)
    stored = {f['role']: f for f in model_files(conn, model_id)}
    missing = []
    for role, column in ROLE_COLUMNS.items():
        path = row[column]
        if not path:
            continue
        if role in stored and blob_path(stored[role]['sha256']).is_file():
            continue
        source = Path(path)
        if not source.is_file():
            missing.append(f'{role} file {path} is missing')
            continue
        sha256, size = put(source)
        conn.execute('INSERT OR REPLACE INTO model_files (model_id, role, filename, sha256, size) '
                     'VALUES (?, ?, ?, ?, ?)', (model_id, role, source.name, sha256, size))
    conn.commit()
    return missing


def forget_model(conn, model_id: int) -> None:
    """Drops a model's file records, and each stored file no other model still uses."""
    shas = [row['sha256'] for row in conn.execute('SELECT sha256 FROM model_files WHERE model_id = ?', (model_id,))]
    conn.execute('DELETE FROM model_files WHERE model_id = ?', (model_id,))
    for sha256 in shas:
        if conn.execute('SELECT 1 FROM model_files WHERE sha256 = ?', (sha256,)).fetchone() is None:
            blob_path(sha256).unlink(missing_ok=True)


def import_map_registry(conn) -> list[int]:
    """Turns each models/mapseg/registry.json entry into a models row, once (by ref)."""
    from app import model_registry
    added = []
    for entry in model_registry._load():
        if conn.execute('SELECT 1 FROM models WHERE ref = ?', (entry['id'],)).fetchone():
            continue
        cur = conn.execute(
            "INSERT INTO models (task, name, source, checkpoint, classes, input_size, ref) "
            "VALUES ('map_segmentation', ?, 'registry', ?, ?, ?, ?)",
            (entry['label'], str(model_registry.checkpoint_path(entry)),
             json.dumps(model_registry.classes_payload(entry)), model_registry.input_size(entry), entry['id']))
        added.append(cur.lastrowid)
    conn.commit()
    return added


def import_existing(conn) -> dict:
    """Every model row's files into the store. Idempotent;
    rows whose files are missing are reported, never deleted."""
    import_map_registry(conn)
    report = {'stored': [], 'skipped': [], 'missing': []}
    for row in conn.execute('SELECT id, name FROM models ORDER BY id').fetchall():
        before = {f['role'] for f in model_files(conn, row['id'])}
        problems = store_model_files(conn, row['id'])
        after = {f['role'] for f in model_files(conn, row['id'])}
        if problems:
            report['missing'].append({'id': row['id'], 'name': row['name'], 'problems': problems})
        if after - before:
            report['stored'].append({'id': row['id'], 'name': row['name'], 'roles': sorted(after - before)})
        elif not problems:
            report['skipped'].append({'id': row['id'], 'name': row['name']})
    return report


def import_file(conn, weights: Path, task: str, name: str, backend: str | None = None,
                model_type: str | None = None, lm: Path | None = None, lm_dict: Path | None = None) -> int:
    """Registers a model trained elsewhere and stores its files."""
    if task not in TASK_BACKENDS:
        raise ValueError(f'unknown task {task!r}; one of {", ".join(TASK_BACKENDS)}')
    if bool(lm) != bool(lm_dict):
        raise ValueError('an LM needs both its .bin and its .dict')
    clash = registry.name_clash(conn, task, name)
    if clash:
        raise ValueError(clash)
    for path in (weights, lm, lm_dict):
        if path is not None and not path.is_file():
            raise ValueError(f'{path} is not a file')
    cur = conn.execute(
        "INSERT INTO models (task, name, source, checkpoint, lm_path, lm_dict_path, backend, model_type) "
        "VALUES (?, ?, 'imported', ?, ?, ?, ?, ?)",
        (task, name, str(weights.resolve()), str(lm.resolve()) if lm else None,
         str(lm_dict.resolve()) if lm_dict else None, backend, model_type))
    conn.commit()
    store_model_files(conn, cur.lastrowid)
    return cur.lastrowid


def adopt_builtins(conn, backend: str, info: dict) -> list[int]:
    """One model row per text task a backend with builtin weights is the task's backend for
    (5.5): no files of its own, so requests omit the weights. It becomes the task's default
    unless another model already is. Returns the ids of the rows added."""
    if not (info.get('weights') or {}).get('builtin'):
        return []
    added = []
    for task in [t for t in registry.TASKS if t in info.get('tasks', []) and TASK_BACKENDS[t] == backend]:
        if conn.execute("SELECT 1 FROM models WHERE task = ? AND source = 'backend' AND backend = ?",
                        (task, backend)).fetchone():
            continue
        name = f'{info.get("model_type") or backend} (builtin)'
        added.append(conn.execute(
            "INSERT INTO models (task, name, source, checkpoint, backend, model_type, is_default) "
            "VALUES (?, ?, 'backend', '', ?, ?, ?)",
            (task, name, backend, info.get('model_type'), int(registry.default_model(conn, task) is None))).lastrowid)
    conn.commit()
    return added


def ask_for_builtins(conn, backends: list) -> list:
    """Adopt the builtins of each backend that answers; the ones that did not, to ask again."""
    from app import backend_client
    waiting = []
    for backend in backends:
        try:
            adopt_builtins(conn, backend.name, backend_client.BackendClient(backend).info())
        except backend_client.BackendError:
            waiting.append(backend)
    return waiting


def watch_builtins() -> None:
    """Ask every configured backend once for its builtin weights, retrying the ones that
    have not answered yet - a backend may come up after DeepLabel."""
    def run():
        waiting = [b for b in config.MODEL_BACKENDS.values() if b.url]
        while waiting:
            conn = store.connect(config.DB_PATH)
            try:
                waiting = ask_for_builtins(conn, waiting)
            finally:
                conn.close()
            if waiting:
                time.sleep(BUILTIN_RETRY_SECONDS)
    threading.Thread(target=run, daemon=True).start()


def backend_of(row) -> str | None:
    return row['backend'] or TASK_BACKENDS.get(row['task'])


def serving_backend(row) -> str | None:
    """The backend a model is predicted on, or None while it runs in-process: its backend
    is not configured with a URL, which is also how a task is rolled back."""
    backend = config.MODEL_BACKENDS.get(backend_of(row) or '')
    return backend.name if backend and backend.url else None


def backends_for_secret(secret: str) -> frozenset[str]:
    """The configured backends this secret belongs to - several, where one server is
    configured under more than one name. Every secret is compared, in constant time."""
    found = set()
    for backend in config.MODEL_BACKENDS.values():
        if hmac.compare_digest(secret.encode(), backend.secret.encode()):
            found.add(backend.name)
    return frozenset(found)


def may_serve(conn, backends: frozenset[str], sha256: str) -> bool:
    """Whether this file belongs to a model registered to one of those backends."""
    rows = conn.execute('SELECT m.task, m.backend FROM model_files f JOIN models m ON m.id = f.model_id '
                        'WHERE f.sha256 = ?', (sha256,)).fetchall()
    return any(backend_of(row) in backends for row in rows)


def repr_digest(sha256: str) -> str:
    return f'sha-256=:{base64.b64encode(bytes.fromhex(sha256)).decode()}:'


def file_url(sha256: str) -> str:
    return f'{config.MODEL_BACKEND_FETCH_URL}/backend-api/v1/files/{sha256}'


def manifest(conn, model_id: int) -> dict:
    row = registry.get_model(conn, model_id)
    return {'model_id': row['id'], 'name': row['name'], 'task': row['task'], 'model_type': row['model_type'],
            'backend': backend_of(row),
            'files': [{**f, 'url': file_url(f['sha256'])} for f in model_files(conn, model_id)]}


def _print(report) -> None:
    json.dump(report, sys.stdout, indent=2)
    sys.stdout.write('\n')


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog='python -m app.weights', description='DeepLabel weight store')
    commands = parser.add_subparsers(dest='command', required=True)
    existing = commands.add_parser('import-existing', help="store the files of every registered model")
    existing.set_defaults(command='import-existing')
    single = commands.add_parser('import', help='register a model trained elsewhere and store its files')
    single.add_argument('file', type=Path)
    single.add_argument('--task', required=True, choices=sorted(TASK_BACKENDS))
    single.add_argument('--name', required=True)
    single.add_argument('--backend')
    single.add_argument('--model-type')
    single.add_argument('--lm', type=Path)
    single.add_argument('--lm-dict', type=Path)
    args = parser.parse_args(argv)
    conn = store.connect(config.DB_PATH)
    try:
        if args.command == 'import-existing':
            report = import_existing(conn)
            _print(report)
            return 1 if report['missing'] else 0
        model_id = import_file(conn, args.file, args.task, args.name, args.backend, args.model_type,
                               args.lm, args.lm_dict)
        _print({'model_id': model_id, 'files': model_files(conn, model_id)})
        return 0
    except ValueError as error:
        print(f'error: {error}', file=sys.stderr)
        return 2
    finally:
        conn.close()


if __name__ == '__main__':
    sys.exit(main())

