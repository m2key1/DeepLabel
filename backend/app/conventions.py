import json
import re

MAX_FLAGS = 32
FLAG_NAME = re.compile(r'^[a-z][a-z0-9_]{0,63}$')


def parse(raw: str | None) -> dict[str, bool]:
    return {name: bool(on) for name, on in json.loads(raw or '{}').items()}


def validate(requested: dict[str, bool]) -> dict[str, bool]:
    """Any flag name is accepted, not only those of the dataset's current model: a flag the
    model does not know stays set for the next model that does."""
    if len(requested) > MAX_FLAGS:
        raise ValueError(f'at most {MAX_FLAGS} convention flags')
    for name in requested:
        if not FLAG_NAME.match(name):
            raise ValueError(f'not a convention flag name: {name!r}')
    return {name: bool(on) for name, on in requested.items()}


def honoured(requested: dict[str, bool], known: list[str]) -> list[str]:
    """The flags a read actually asks the model for, in the model's own order."""
    return [name for name in known if requested.get(name)]


def model_row(requested: dict[str, bool], known: list[str]) -> list[float]:
    return [1.0 if requested.get(name) else 0.0 for name in known]
