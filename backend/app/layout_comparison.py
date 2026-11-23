import json
from pathlib import Path

from app import config, evaluator, registry

# The split a layout run is compared on: the pages it never saw, or failing those the pages
# that only chose its kept epoch.
SPLITS = ('test', 'valid')


def split_of(training_id: int) -> str | None:
    """The split of the run's frozen snapshot to compare on, or None where it kept neither."""
    snapshot = config.training_dir(training_id) / 'snapshot'
    return next((split for split in SPLITS if (snapshot / split / '_annotations.coco.json').is_file()), None)


def compared(conn, training_id: int) -> bool:
    return conn.execute("SELECT 1 FROM evaluations WHERE training_id = ? AND source LIKE '%\"split\"%' LIMIT 1",
                        (training_id,)).fetchone() is not None


def schedule(conn, training: dict, model_id: int) -> list[int]:
    """Score the trained model and its base on the run's held-out pages, one evaluation
    each, so the run's page can set them side by side."""
    split = split_of(training['id'])
    if split is None:
        return []
    models = [model_id]
    if training['base_model_id'] and registry.get_model(conn, training['base_model_id']):
        models.append(training['base_model_id'])
    return [evaluator.create(conn, scored, {'snapshot': training['id'], 'split': split}, '',
                             training['owner'], training['id']) for scored in models]


def page_id(conn, image_name: str, job_id: str) -> int | None:
    """The page a snapshot image was cut from: its name is <job>_<hash8>_<filename>."""
    rest = image_name.removeprefix(f'{job_id}_')
    digest, _, filename = rest.partition('_')
    row = conn.execute('SELECT id FROM pages WHERE job_id = ? AND filename = ? AND content_hash LIKE ? '
                       'AND deleted = 0 ORDER BY id LIMIT 1', (job_id, filename, f'{digest}%')).fetchone()
    return row['id'] if row else None


def frozen(training_id: int, split: str) -> tuple[dict, dict, Path]:
    """The split's COCO file, which dataset each image came from, and its folder."""
    folder = config.training_dir(training_id) / 'snapshot' / split
    coco = json.loads((folder / '_annotations.coco.json').read_text(encoding='utf-8'))
    manifest = folder.parent / 'manifest.json'
    groups = json.loads(manifest.read_text(encoding='utf-8')) if manifest.is_file() else {}
    return coco, groups, folder
