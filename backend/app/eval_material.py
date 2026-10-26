"""What an evaluation is scored on, handed over a batch at a time.

Opening every crop before scoring any of them cost 54 GB on a 30,426-line split, and the
kernel killed the run for it - twice, taking the machine's usability with it. Memory here
is one batch of images plus the references, so a split ten times larger costs the same.
"""
import json
from pathlib import Path
from typing import NamedTuple

from PIL import Image

from app import config, linecrop
from app.caches import counted_page
from app.train_snapshot import checked_by

# Images decoded at once. A line crop is a few hundred kilobytes as RGB, so this is tens
# of megabytes - far below what the model itself needs for a batch.
HELD_AT_ONCE = 512


class Crop(NamedTuple):
    image: Image.Image
    text: str
    group: str
    line_id: int | None
    page_id: int | None
    # What a model backend is told about the crop beyond its pixels (contract 4.1).
    context: dict | None = None


def _line_id(stem: str) -> int | None:
    """A snapshot crop is named after its line, line_<id>."""
    number = stem.removeprefix('line_')
    return int(number) if number.isdigit() else None


def _described(conn, batch: list[Crop]) -> list[Crop]:
    """The crops with what a live line of theirs would be told (4.1), where the line is
    still there to ask."""
    ids = [crop.line_id for crop in batch if crop.line_id is not None]
    if conn is None or not ids:
        return batch
    rows = conn.execute(
        'SELECT l.id, l.order_idx, e.class_name FROM lines l JOIN elements e ON l.element_id = e.id '
        f'WHERE l.id IN ({",".join("?" * len(ids))})', ids).fetchall()
    contexts = {row['id']: {'element_class': row['class_name'], 'line_index': row['order_idx']} for row in rows}
    return [crop._replace(context=contexts.get(crop.line_id)) for crop in batch]


def snapshot_batches(snapshot: Path, held: int = HELD_AT_ONCE, conn=None):
    """The frozen valid split: crops beside their ground truth, grouped by the dataset each
    came from (per the manifest; empty for a snapshot cut before manifests existed)."""
    manifest_file = snapshot / 'manifest.json'
    manifest = json.loads(manifest_file.read_text(encoding='utf-8')) if manifest_file.is_file() else {}
    batch = []
    for text_file in sorted((snapshot / 'valid').glob('*.txt')):
        image_file = text_file.with_suffix('.png')
        if not image_file.is_file():
            continue
        batch.append(Crop(Image.open(image_file).convert('RGB'),
                          text_file.read_text(encoding='utf-8'),
                          manifest.get(text_file.stem, ''), _line_id(text_file.stem), None))
        if len(batch) >= held:
            yield _described(conn, batch)
            batch = []
    if batch:
        yield _described(conn, batch)


def job_batches(conn, job_ids: list[str], held: int = HELD_AT_ONCE,
                human_checked_only: bool = False, test_pages_only: bool = False):
    """Checked lines of live datasets, cut from their pages as they are reached. The page
    is opened once for all of its lines and closed before the next one. A run trained only
    on what a person verified is scored only on that too, and a test set only on its test
    pages."""
    batch = []
    for job_id in job_ids:
        pages = conn.execute(
            'SELECT id, source_file FROM pages '
            f'WHERE job_id = ? AND {counted_page()} {"AND is_test = 1 " if test_pages_only else ""}'
            'ORDER BY id', (job_id,)).fetchall()
        for page in pages:
            lines = conn.execute(
                'SELECT l.id, l.polygon, l.orientation, l.text, l.corrected_text, l.order_idx, e.class_name '
                'FROM lines l '
                'JOIN elements e ON l.element_id = e.id '
                'WHERE e.page_id = ? AND l.checked = 1 AND l.deleted = 0 AND e.deleted = 0 '
                f'{checked_by(human_checked_only)} ORDER BY l.id',
                (page['id'],)).fetchall()
            if not lines:
                continue
            with Image.open(page['source_file']) as opened:
                image = opened.convert('RGB')
            for line in lines:
                text = line['corrected_text'] if line['corrected_text'] is not None else line['text']
                if not text:
                    continue
                polygon = [[x * image.width, y * image.height]
                           for x, y in json.loads(line['polygon'])]
                crop = linecrop.crop_line(image, polygon, line['orientation'],
                                          mask=config.LINE_CROP_MASK)
                if crop is None:
                    continue
                batch.append(Crop(crop, text, job_id, line['id'], page['id'],
                                  {'element_class': line['class_name'], 'line_index': line['order_idx']}))
                if len(batch) >= held:
                    yield batch
                    batch = []
            image.close()
    if batch:
        yield batch
