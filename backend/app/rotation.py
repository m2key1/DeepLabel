"""Turning a scan the right way up.

The turn is baked in rather than carried: a turned copy of the scan is written into the
dataset's own directory, the page's geometry is turned with it, and nothing downstream -
the crop, the runner, the evaluator, the training snapshot, the viewer - ever hears about
rotation. The scan as it arrived is kept and is what every turn is derived from, so a page
turned four times is not a scan encoded four times, and turning back to zero puts the
original file back untouched.

Never in place. An ingested page's file is a hard link into the blob store, shared with
every other dataset holding the same scan, and a path-ingested one belongs to the user.
"""
import json
from pathlib import Path

from PIL import Image

from app import blobs, config, geometry, renditions, store

TURNS = (90, 180, 270)
# PIL's transposes turn counter-clockwise; a page turns the way the button points.
_TRANSPOSE = {90: Image.Transpose.ROTATE_270, 180: Image.Transpose.ROTATE_180,
              270: Image.Transpose.ROTATE_90}


class CannotTurn(ValueError):
    """The page is not one that can be turned, carrying the sentence to say so with."""


def _turned_path(job_id: str, page_id: int, origin: Path) -> Path:
    directory = config.job_dir(job_id) / 'turned'
    directory.mkdir(parents=True, exist_ok=True)
    return directory / f'{page_id}{origin.suffix.lower()}'


def _turn_geometry(conn, page_id: int, turn: int) -> None:
    """Every page-relative shape this page holds, deleted rows included - a line that
    comes back from the dead has to come back onto the scan it was drawn on."""
    for row in conn.execute('SELECT id, bbox, lines_bbox, polygon FROM elements WHERE page_id = ?',
                            (page_id,)).fetchall():
        lines_bbox = row['lines_bbox']
        conn.execute(
            'UPDATE elements SET bbox = ?, lines_bbox = ?, polygon = ? WHERE id = ?',
            (json.dumps(geometry.turn_bbox(json.loads(row['bbox']), turn)),
             json.dumps(geometry.turn_bbox(json.loads(lines_bbox), turn)) if lines_bbox else None,
             json.dumps(geometry.turn_poly(json.loads(row['polygon']), turn)) if row['polygon'] else None,
             row['id']))
    for row in conn.execute(
            'SELECT l.id, l.polygon FROM lines l JOIN elements e ON l.element_id = e.id '
            'WHERE e.page_id = ?', (page_id,)).fetchall():
        conn.execute('UPDATE lines SET polygon = ? WHERE id = ?',
                     (json.dumps(geometry.turn_poly(json.loads(row['polygon']), turn)), row['id']))
    # A candidate keeps the geometry it was read from, and is matched back onto lines by
    # overlap: left unturned it would find no home on the page it belongs to.
    for row in conn.execute(
            'SELECT id, polygon FROM candidates WHERE page_id = ? AND polygon IS NOT NULL',
            (page_id,)).fetchall():
        conn.execute('UPDATE candidates SET polygon = ? WHERE id = ?',
                     (json.dumps(geometry.turn_poly(json.loads(row['polygon']), turn)), row['id']))
    for row in conn.execute('SELECT id, points, holes FROM regions WHERE page_id = ?',
                            (page_id,)).fetchall():
        conn.execute(
            'UPDATE regions SET points = ?, holes = ? WHERE id = ?',
            (json.dumps(geometry.turn_poly(json.loads(row['points']), turn)),
             json.dumps([geometry.turn_poly(hole, turn) for hole in json.loads(row['holes'])]),
             row['id']))


def turn_page(conn, page_id: int, degrees: int, author: str) -> dict:
    """Turn one page clockwise and everything drawn on it with it. Returns what changed,
    for the caller to hand back."""
    turn = degrees % 360
    if turn not in TURNS:
        raise CannotTurn('a page turns by 90, 180 or 270 degrees')
    page = conn.execute('SELECT * FROM pages WHERE id = ?', (page_id,)).fetchone()
    if page is None or page['deleted']:
        raise CannotTurn('the page is gone')
    if page['source_map'] is not None:
        raise CannotTurn('a tile is cut from its map and is turned with it, not on its own')
    if not page['content_hash']:
        raise CannotTurn('this page has not been ingested yet, so there is nothing to turn')
    origin = Path(page['origin_file'] or page['source_file'])
    if not origin.exists():
        raise CannotTurn('the image for this page is missing on disk')

    total = (int(page['rotation'] or 0) + turn) % 360
    job_path = config.job_dir(page['job_id'])
    turned_path = _turned_path(page['job_id'], page_id, origin)
    with Image.open(origin) as scan:
        fmt = scan.format
        if total:
            image = scan.transpose(_TRANSPOSE[total])
            # Unlinking first rather than writing through: this path may itself be a link
            # into the blob store, and writing into it would rewrite another dataset's scan.
            turned_path.unlink(missing_ok=True)
            # Always derived from the untouched original, so a lossy scan is re-encoded
            # once however many times the page is turned, rather than once per turn.
            image.save(turned_path, format=fmt, **({'quality': 95} if fmt == 'JPEG' else {}))
            source = turned_path
        else:
            image = scan.copy()
            source = origin
        renditions.write(image.convert('RGB'), job_path / 'renditions', page_id)
        width, height = image.width, image.height

    was_digest, was_source = page['content_hash'], page['source_file']
    digest = renditions.file_hash(str(source))
    blobs.share(str(source), digest, job_path, config.BLOBS_DIR)
    conn.execute(
        'UPDATE pages SET source_file = ?, origin_file = ?, rotation = ?, content_hash = ?, '
        'width = ?, height = ? WHERE id = ?',
        (str(source), str(origin) if total else None, total, digest, width, height, page_id))
    _turn_geometry(conn, page_id, turn)
    store.log_revision(conn, 'page', page_id, page['job_id'], author, 'update',
                       {'id': page_id, 'rotation': total})
    conn.commit()
    if not total:
        turned_path.unlink(missing_ok=True)
    if was_digest != digest:
        # Keyed by digest rather than by path: a page turned twice writes the same path
        # twice, and the store's copy of what it held before would otherwise be orphaned.
        blobs.release([(was_digest, was_source)], config.BLOBS_DIR)
    return {'id': page_id, 'job_id': page['job_id'], 'rotation': total,
            'width': width, 'height': height}
