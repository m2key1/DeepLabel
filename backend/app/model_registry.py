"""Map-segmentation model registry: the available pre-trained checkpoints and the class
vocabulary each was trained on, read from models/mapseg/registry.json.

Runs in the app venv only - it reads app.config for the registry path, so the mapseg
runner cannot import it. The runner does not need to: jobs.py resolves the checkpoint and
class ids here and passes them down as argv. Reads the file fresh on each call - it is
tiny, and this keeps a dropped-in model visible without a restart. A missing or malformed
file yields an empty list rather than an error, so annotation-only map jobs keep working
with the legacy default seed.

Registry shape (per model):
  {"id", "label", "checkpoint", "classes": [{"id","name","color":[r,g,b]}, ...],
   "class_priority": [name, ...],   # highest-priority name first
   "input_size": 512}               # optional: the square window the model reads, px
"""

import json
from pathlib import Path

from app import config, map_export

DEFAULT_INPUT_SIZE = 512
INPUT_SIZE_RANGE = (64, 4096)


def _valid_color(c) -> bool:
    return isinstance(c, list) and len(c) == 3 and all(isinstance(v, int) and 0 <= v <= 255 for v in c)


def _valid_entry(m) -> bool:
    if not isinstance(m, dict):
        return False
    if not all(isinstance(m.get(k), str) and m.get(k) for k in ('id', 'label', 'checkpoint')):
        return False
    classes = m.get('classes')
    if not isinstance(classes, list) or not classes:
        return False
    ids = set()
    for c in classes:
        if not isinstance(c, dict) or not isinstance(c.get('id'), int) or not isinstance(c.get('name'), str):
            return False
        if not 0 <= c['id'] <= map_export.MAX_CLASS_ID:
            return False
        if not _valid_color(c.get('color')):
            return False
        ids.add(c['id'])
    if len(ids) != len(classes) or 0 not in ids:  # unique ids, background present
        return False
    if not isinstance(m.get('class_priority', []), list):
        return False
    size = m.get('input_size', DEFAULT_INPUT_SIZE)
    if type(size) is not int or not INPUT_SIZE_RANGE[0] <= size <= INPUT_SIZE_RANGE[1]:
        return False
    return True


def _load() -> list[dict]:
    path = config.MAPSEG_REGISTRY
    try:
        data = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return []
    models = data.get('models') if isinstance(data, dict) else None
    if not isinstance(models, list):
        return []
    return [m for m in models if _valid_entry(m)]


def checkpoint_path(model: dict):
    """Absolute path to the model's checkpoint, resolving relatives against the registry dir."""
    ckpt = Path(model['checkpoint'])
    return ckpt if ckpt.is_absolute() else (config.MAPSEG_REGISTRY.parent / ckpt)


def classes_payload(model: dict) -> list[dict]:
    """[{id, name, color, priority}] — priority is the rank in class_priority (0 = wins);
    names not listed sort last, preserving id order among them."""
    order = {name: rank for rank, name in enumerate(model.get('class_priority', []))}
    fallback = len(order)
    return [
        {'id': c['id'], 'name': c['name'], 'color': c['color'],
         'priority': order.get(c['name'], fallback)}
        for c in model['classes']
    ]


def input_size(model: dict | None) -> int:
    """The square window the model reads, in pixels; prediction slides it over each tile."""
    return (model or {}).get('input_size', DEFAULT_INPUT_SIZE)


def list_models() -> list[dict]:
    """Registry entries for the UI: [{id, label, checkpoint_available, input_size, classes}]."""
    return [
        {'id': m['id'], 'label': m['label'],
         'checkpoint_available': checkpoint_path(m).exists(),
         'input_size': input_size(m),
         'classes': classes_payload(m)}
        for m in _load()
    ]


def get_model(model_id: str) -> dict | None:
    return next((m for m in _load() if m['id'] == model_id), None)
