"""Augmentation pipelines: the albumentations catalog the training backends offer, the
pipelines people save, and the preview that shows what a stack does to real line crops.

Every albumentations call happens in the trainer of the task's model backend (6.2) - the
app venv has neither torch nor albumentations. A spec travels in the library's own dict form
(what `A.to_dict` writes and `A.from_dict` reads), which is exactly what the trainer
loads. Pipelines are private to whoever saved them; the one an admin marks as a task's
default is visible to everyone, read-only, and is what "Default" means in the dialog.
"""
import base64
import hashlib
import io
import json
import tempfile
import threading
import time
from dataclasses import dataclass
from pathlib import Path

from PIL import Image

from app import backend_client, config, linecrop, registry, weights
from app.backend_client import BackendClient, BackendError
from app.caches import counted_page

# A failed catalog read is retried this often, so a backend that comes up is noticed
# without a restart.
CATALOG_RETRY_SECONDS = 60
SAMPLE_COUNT = 1
# Draws taken per crop so the preview can show the harshest one. Steps fire at p 0.3 or
# so, which makes the damaging draw rare, and rare is what a single sample hides.
HARSHEST_DRAWS = 12
# The height a line is shown at while its model has not reported the one it reads at.
LINE_HEIGHT = 128
MAX_SPEC_BYTES = 64_000
MAX_NODES = 200
MAX_NAME_LENGTH = 80
GROUPS = ('OneOf', 'SomeOf', 'Sequential')
# What the trainer appends itself after the stack; a saved stack must not carry them.
TRAINER_TAIL = ('Normalize', 'ToTensorV2')


# The group types a pipeline may nest, which are DeepLabel's own builder's.
GROUP_TYPES = [
    {'name': 'OneOf', 'doc': 'Applies exactly one of its steps, picked at random, with probability p.'},
    {'name': 'SomeOf', 'doc': 'Applies n of its steps, picked at random, with probability p.'},
    {'name': 'Sequential', 'doc': 'Applies all of its steps in order, with probability p.'},
]


def trainer_backend(task: str) -> BackendClient | None:
    """The model backend that trains this task by default, once configured with a URL and
    declaring the task: whose trainer then runs the stack, so whose catalog it is."""
    backend = config.MODEL_BACKENDS.get(weights.TASK_BACKENDS.get(task, ''))
    if backend is None or not backend.url:
        return None
    client = BackendClient(backend)
    try:
        trains = (client.info().get('train') or {}).get('tasks', [])
    except BackendError:
        return None
    return client if task in trains else None


class NoTrainer(Exception):
    """No configured model backend trains the task, so nothing can run a stack for it."""


def _trainer(task: str) -> BackendClient:
    client = trainer_backend(task)
    if client is None:
        raise NoTrainer(f'no configured model backend trains {task}')
    return client


@dataclass
class Catalog:
    transforms: list
    groups: list
    version: str | None
    error: str | None
    checked_at: float

    def payload(self) -> dict:
        return {'version': self.version, 'transforms': self.transforms, 'groups': self.groups,
                'error': self.error}


_catalog: Catalog | None = None
_catalog_lock = threading.Lock()


def catalog() -> Catalog:
    """The catalog, read once from a training backend and kept; a failed read is retried
    after a pause."""
    global _catalog
    with _catalog_lock:
        if _catalog is not None and (_catalog.error is None
                                     or time.monotonic() - _catalog.checked_at < CATALOG_RETRY_SECONDS):
            return _catalog
        client = next((c for c in map(trainer_backend, ('ocr', 'lines', 'layout')) if c), None)
        try:
            if client is None:
                raise NoTrainer('no configured model backend trains a task')
            result = client._call('GET', '/v1/train/augmentations')
            _catalog = Catalog(result.get('transforms') or [], GROUP_TYPES,
                               result.get('version'), None, time.monotonic())
        except (NoTrainer, BackendError) as exc:
            _catalog = Catalog([], [], None, str(exc), time.monotonic())
        return _catalog


def warm_up() -> None:
    def run():
        try:
            catalog()
        except Exception as exc:
            print(f'augmentation catalog: {exc}', flush=True)
    threading.Thread(target=run, daemon=True).start()


def _is_group(name) -> bool:
    return name in GROUPS or name == 'Compose'


def _steps(node: dict) -> list:
    """The steps a group nests; a plain transform has none, whatever else it carries.
    Only for a spec that passed the structural check."""
    return node['transforms'] if _is_group(node['__class_fullname__']) else []


def _count_nodes(node: dict) -> int:
    return 1 + sum(_count_nodes(child) for child in _steps(node))


def spec_errors(spec) -> str | None:
    """What can be checked without albumentations: the shape the library's dict form
    has, sensible probabilities, and a size a runner will not choke on."""
    if not isinstance(spec, dict) or not isinstance(spec.get('transform'), dict):
        return 'a pipeline is an object with a "transform" root'
    if len(json.dumps(spec)) > MAX_SPEC_BYTES:
        return f'the pipeline is larger than {MAX_SPEC_BYTES // 1000} kB'
    root = spec['transform']
    if root.get('__class_fullname__') != 'Compose':
        return 'the root of a pipeline must be a Compose'

    def check(node, path):
        name = node.get('__class_fullname__')
        if not isinstance(name, str) or not name:
            return f'{path}: every step names its transform'
        p = node.get('p', 1.0)
        if isinstance(p, bool) or not isinstance(p, (int, float)) or not 0 <= p <= 1:
            return f'{path}{name}: p must be between 0 and 1'
        if _is_group(name):
            children = node.get('transforms')
            if not isinstance(children, list):
                return f'{path}{name}: a group holds a list of steps'
            if name != 'Compose' and not children:
                return f'{path}{name}: a group needs at least one step'
            if name == 'SomeOf' and (isinstance(node.get('n'), bool) or not isinstance(node.get('n'), int)
                                     or node['n'] < 1):
                return f'{path}{name}: n must be a whole number of at least 1'
            for index, child in enumerate(children):
                if not isinstance(child, dict):
                    return f'{path}{name}[{index}]: a step is an object'
                error = check(child, f'{path}{name}[{index}].')
                if error:
                    return error
        elif name in TRAINER_TAIL:
            return f'{path}{name}: the trainer applies {name} itself, after the stack'
        return None

    error = check(root, '')
    if error:
        return error
    if _count_nodes(root) > MAX_NODES:
        return f'a pipeline may hold at most {MAX_NODES} steps'
    return None


def unknown_steps(spec) -> str | None:
    """A step the catalog does not offer, which is also a step the builder could not have
    produced. Albumentations would happily build some of those (a font path to read, a
    transform that wants a second image), so the API accepts exactly what the UI offers.
    Skipped when the catalog itself could not be read - the runner refuses those anyway."""
    known = catalog()
    if known.error:
        return None
    names = {t['name'] for t in known.transforms} | {g['name'] for g in known.groups} | {'Compose'}

    def walk(node, path):
        name = node.get('__class_fullname__')
        if name not in names:
            return f'{path}{name}: not a transform this deployment offers'
        for index, child in enumerate(_steps(node)):
            error = walk(child, f'{path}{name}[{index}].')
            if error:
                return error
        return None

    return walk(spec['transform'], '')


def check_spec(spec, task: str = 'ocr') -> str | None:
    """The structural check, the catalog check, then the backend's trainer building every
    step and running the lot over a stand-in line. None when the spec is sound; the
    message names the step otherwise."""
    error = spec_errors(spec) or unknown_steps(spec)
    if error:
        return error
    try:
        backend_client.preview_augmentations(_trainer(task), spec,
                                             [Image.new('RGB', (LINE_HEIGHT * 4, LINE_HEIGHT), 'white')], 0)
    except BackendError as error:
        return error.message
    return None


def strip_trainer_tail(spec: dict) -> dict:
    """The stack a train module serialises ends in the normalisation and tensor steps it
    applies itself; the builder edits only what comes before them."""
    root = dict(spec.get('transform') or {})
    root['transforms'] = [t for t in root.get('transforms', []) if t.get('__class_fullname__') not in TRAINER_TAIL]
    return {**spec, 'transform': root}


def builtin_spec(task: str) -> dict:
    """The stack the task's trainer uses when no pipeline is chosen, as its model backend
    declares it, or why it is unknown."""
    try:
        stack = _trainer(task)._call('GET', '/v1/train/augmentations').get('default')
    except NoTrainer as error:
        return {'spec': None, 'error': str(error)}
    except BackendError as error:
        return {'spec': None, 'error': error.message}
    if stack is None:
        return {'spec': None, 'error': 'the model backend declares no default stack'}
    return {'spec': strip_trainer_tail(stack), 'error': None}


def sample_lines(conn, job_ids: list[str], seed: int, count: int = SAMPLE_COUNT) -> list[dict]:
    """A seeded, dataset-spanning pick of checked lines: the same seed picks the same
    lines again, and each next seed the lines after them in one fixed shuffle, so no line
    comes back before every other one has been shown."""
    if not job_ids:
        return []
    marks = ','.join('?' * len(job_ids))
    ids = [row['id'] for row in conn.execute(
        f'SELECT l.id FROM lines l JOIN elements e ON l.element_id = e.id '
        f"JOIN pages p ON e.page_id = p.id WHERE p.job_id IN ({marks}) AND {counted_page('p')} "
        'AND l.checked = 1 AND l.deleted = 0 AND e.deleted = 0', job_ids)]
    if not ids:
        return []
    shuffled = sorted(ids, key=lambda line_id: hashlib.sha256(str(line_id).encode()).digest())
    start = (seed - 1) * count % len(shuffled)
    chosen = (shuffled[start:] + shuffled[:start])[:count]
    marks = ','.join('?' * len(chosen))
    rows = conn.execute(
        f'SELECT l.id, l.polygon, l.orientation, l.text, l.corrected_text, p.source_file, j.name AS dataset '
        f'FROM lines l JOIN elements e ON l.element_id = e.id JOIN pages p ON e.page_id = p.id '
        f'JOIN jobs j ON p.job_id = j.id WHERE l.id IN ({marks})', chosen).fetchall()
    by_id = {row['id']: dict(row) for row in rows}
    return [by_id[line_id] for line_id in chosen if line_id in by_id]


def crop_samples(samples: list[dict], out_dir: Path) -> tuple[list[tuple[dict, Path]], list[str]]:
    """Cut each sampled line the way the snapshot cuts it, so the preview starts from the
    very crop a training would. Returns what was cut and, for what was not, why - the
    scans a training will read are the same ones, so a reason here is worth reporting."""
    cropped, problems = [], []
    for sample in samples:
        source = Path(sample['source_file'])
        try:
            with Image.open(source) as opened:
                page = opened.convert('RGB')
        except FileNotFoundError:
            problems.append(f'the scan {source} is not on this machine')
            continue
        except (OSError, ValueError) as exc:
            problems.append(f'the scan {source} could not be read ({exc})')
            continue
        polygon = [[x * page.width, y * page.height] for x, y in json.loads(sample['polygon'])]
        crop = linecrop.crop_line(page, polygon, sample['orientation'] or 0,
                                  mask=config.LINE_CROP_MASK)
        if crop is None:
            problems.append(f'line {sample["id"]} has no area to cut')
            continue
        path = out_dir / f'line_{sample["id"]}.png'
        crop.save(path)
        cropped.append((sample, path))
    return cropped, problems


def preview(conn, task: str, spec: dict, job_ids: list[str], line_seed: int, render_seed: int) -> dict:
    """What the stack does to one of the chosen datasets' checked lines: the crop
    before and after, at the height the model reads.

    The two seeds move independently: line_seed picks which lines are shown, render_seed
    is the random draw the stack itself makes. Changing one alone answers a different
    question - does this hold on other material, or was that one roll unlucky."""
    error = spec_errors(spec)
    if error:
        return {'ok': False, 'error': error, 'samples': []}
    samples = sample_lines(conn, job_ids, line_seed)
    if not samples:
        return {'ok': False, 'error': 'the chosen datasets have no checked lines to preview on', 'samples': []}
    client = _trainer(task)
    model = registry.default_model(conn, task)
    height = (model['target_height'] if model else None) or LINE_HEIGHT
    with tempfile.TemporaryDirectory(prefix='augment-preview-') as tmp:
        cropped, problems = crop_samples(samples, Path(tmp))
        if not cropped:
            detail = f': {problems[0]}' if problems else ''
            return {'ok': False, 'error': f'none of the sampled lines could be cut{detail}', 'samples': []}
        return _backend_preview(client, spec, cropped, height, line_seed, render_seed)


def _backend_preview(client: BackendClient, spec: dict, cropped: list, height: int, line_seed: int,
                     render_seed: int) -> dict:
    """The preview drawn by the backend's trainer: each crop at the height the model
    reads, before and after one draw, and the harshest of many (6.2)."""
    originals = []
    for _sample, path in cropped:
        with Image.open(path) as crop:
            scale = height / crop.height
            originals.append(crop.convert('RGB').resize((max(1, round(crop.width * scale)), height)))
    try:
        drawn = backend_client.preview_augmentations(client, spec, originals, render_seed)
        harshest = backend_client.preview_augmentations(client, spec, originals, render_seed, HARSHEST_DRAWS)
    except BackendError as error:
        return {'ok': False, 'error': error.message, 'samples': []}
    rendered = []
    for (sample, _path), original, augmented, worst in zip(cropped, originals, drawn, harshest):
        buffer = io.BytesIO()
        original.save(buffer, format='PNG')
        rendered.append({
            'line_id': sample['id'], 'dataset': sample['dataset'],
            'text': sample['corrected_text'] if sample['corrected_text'] is not None else sample['text'],
            'original': 'data:image/png;base64,' + base64.b64encode(buffer.getvalue()).decode(),
            'augmented': augmented, 'harshest': worst,
        })
    return {'ok': True, 'error': None, 'height': height, 'line_seed': line_seed, 'render_seed': render_seed,
            'draws': HARSHEST_DRAWS, 'samples': rendered}


def pipeline_payload(row, user: dict) -> dict:
    pipeline = dict(row)
    pipeline['spec'] = json.loads(pipeline['spec'])
    pipeline['is_default'] = bool(pipeline['is_default'])
    pipeline['editable'] = pipeline['owner'] == user['username']
    return pipeline


def get_pipeline(conn, pipeline_id: int) -> dict | None:
    row = conn.execute('SELECT * FROM augmentation_pipelines WHERE id = ?', (pipeline_id,)).fetchone()
    return dict(row) if row else None


def visible_to(pipeline: dict, user: dict) -> bool:
    """A person sees their own pipelines and each task's default; nothing else exists
    for them."""
    return pipeline['owner'] == user['username'] or bool(pipeline['is_default'])


def list_pipelines(conn, task: str, user: dict) -> list[dict]:
    rows = conn.execute(
        'SELECT * FROM augmentation_pipelines WHERE task = ? AND (owner = ? OR is_default = 1) '
        'ORDER BY is_default DESC, lower(name)', (task, user['username'])).fetchall()
    return [pipeline_payload(row, user) for row in rows]


def name_taken(conn, task: str, owner: str, name: str, except_id: int | None = None) -> bool:
    row = conn.execute(
        'SELECT id FROM augmentation_pipelines WHERE task = ? AND owner = ? AND lower(name) = lower(?)',
        (task, owner, name)).fetchone()
    return row is not None and row['id'] != except_id


def task_default(conn, task: str) -> dict | None:
    row = conn.execute('SELECT * FROM augmentation_pipelines WHERE task = ? AND is_default = 1',
                       (task,)).fetchone()
    return dict(row) if row else None
