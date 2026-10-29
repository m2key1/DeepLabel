import json
import re
import sqlite3

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


def note(conn: sqlite3.Connection, names: list[str], added_from: str | None = None) -> None:
    """Put flags the catalog does not have yet into it, named as they were given, so they
    can be described afterwards. A flag already there is left as it is."""
    conn.executemany('INSERT OR IGNORE INTO convention_flags (name, label, added_from) VALUES (?, ?, ?)',
                     [(name, name, added_from) for name in names])


def catalog(conn: sqlite3.Connection) -> list[dict]:
    """Every flag, with how many models read it and how many datasets ask for it."""
    models: dict[str, int] = {}
    for row in conn.execute('SELECT conventions FROM models WHERE conventions IS NOT NULL'):
        for name in json.loads(row[0]):
            models[name] = models.get(name, 0) + 1
    datasets: dict[str, int] = {}
    for row in conn.execute('SELECT ocr_convention FROM jobs'):
        for name, on in parse(row[0]).items():
            if on:
                datasets[name] = datasets.get(name, 0) + 1
    return [{'name': row['name'], 'label': row['label'], 'description': row['description'],
             'added_from': row['added_from'], 'models': models.get(row['name'], 0),
             'datasets': datasets.get(row['name'], 0)}
            for row in conn.execute('SELECT * FROM convention_flags ORDER BY label COLLATE NOCASE')]
