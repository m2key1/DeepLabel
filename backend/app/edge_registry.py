"""Edge-detection method registry: which detectors the area-detect tool offers and what
parameters each takes, read from models/edge/registry.json.

The sibling of model_registry.py, and the same deal: app venv only, read fresh on every
call so a dropped-in method shows up without a restart, and a missing or malformed file
yields an empty list rather than an error — edge detection is optional, and a line job
without it still annotates by hand.

The ids here are the ids edge_detection_repo's METHODS dict uses; the route passes one
straight through to its CLI.

Registry shape (per method):
  {"id", "label", "params": {name: {"default": v, ...}, ...}, "checkpoint"?}

`params` is carried whole so the UI can render controls for it later. Today only the
defaults are executed: the route sends them to the CLI and the annotator picks a method,
not a threshold.
"""

import json
from pathlib import Path

from app import config


def _valid_params(params) -> bool:
    if not isinstance(params, dict):
        return False
    # Every parameter must state a default, since that is what actually gets run.
    return all(isinstance(spec, dict) and 'default' in spec for spec in params.values())


def _valid_entry(m) -> bool:
    if not isinstance(m, dict):
        return False
    if not all(isinstance(m.get(k), str) and m.get(k) for k in ('id', 'label')):
        return False
    if not _valid_params(m.get('params', {})):
        return False
    if 'checkpoint' in m and not (isinstance(m['checkpoint'], str) and m['checkpoint']):
        return False
    return True


def _load() -> list[dict]:
    try:
        data = json.loads(config.EDGE_REGISTRY.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return []
    methods = data.get('methods') if isinstance(data, dict) else None
    if not isinstance(methods, list):
        return []
    return [m for m in methods if _valid_entry(m)]


def checkpoint_path(method: dict) -> Path | None:
    """Absolute path to the method's weights, resolving relatives against the registry dir.
    None for the methods that need none — a classical one is just an algorithm."""
    if not method.get('checkpoint'):
        return None
    ckpt = Path(method['checkpoint'])
    return ckpt if ckpt.is_absolute() else (config.EDGE_REGISTRY.parent / ckpt)


def available(method: dict) -> bool:
    ckpt = checkpoint_path(method)
    return ckpt is None or ckpt.exists()


def default_params(method: dict) -> dict:
    return {name: spec['default'] for name, spec in method.get('params', {}).items()}


def list_methods() -> list[dict]:
    """Registry entries for the UI: [{id, label, params, available}]."""
    return [
        {'id': m['id'], 'label': m['label'], 'params': m.get('params', {}), 'available': available(m)}
        for m in _load()
    ]


def get_method(method_id: str) -> dict | None:
    return next((m for m in _load() if m['id'] == method_id), None)
