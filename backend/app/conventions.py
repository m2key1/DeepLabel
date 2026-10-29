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


def for_training(conn: sqlite3.Connection, base_model_id: int | None, job_ids: list[str]) -> dict | None:
    """The flags an OCR run conditions on: its base model's, in the base's order so what it
    learned of them carries over, then any its datasets set that the base does not know -
    the ones this run teaches. Each dataset gets its 0/1 row over those names. None when
    neither the base nor any dataset has a flag."""
    base = conn.execute('SELECT conventions FROM models WHERE id = ?', (base_model_id,)).fetchone() \
        if base_model_id else None
    known = json.loads(base['conventions']) if base is not None and base['conventions'] else []
    asked = {row['id']: parse(row['ocr_convention']) for row in conn.execute(
        f"SELECT id, ocr_convention FROM jobs WHERE id IN ({','.join('?' * len(job_ids))})", job_ids)}
    new = sorted({name for flags in asked.values() for name, on in flags.items() if on} - set(known))
    names = known + new
    if not names:
        return None
    return {'names': names, 'new': new, 'base': known,
            'by_dataset': {job_id: model_row(asked.get(job_id, {}), names) for job_id in job_ids}}


def label(conn: sqlite3.Connection, name: str) -> str:
    """What people read for a flag: its label, or until it has one its name in words."""
    row = conn.execute('SELECT label FROM convention_flags WHERE name = ?', (name,)).fetchone()
    words = row['label'] if row and row['label'] != name else name.replace('_', ' ')
    return words[:1].upper() + words[1:]
