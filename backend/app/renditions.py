"""The sized copies the viewer serves, and the digest a scan is keyed by.

Shared by the GPU runner's ingest, the map runner's, and a page being turned, so all
three write the same set: renditions that disagreed with what ingest wrote would show
one image while the models read another. Config-free, so a runner can import it.
"""
import hashlib
import math
import shutil
from pathlib import Path

from PIL import Image

RENDITIONS = {'thumb': 256, 'screen': 1600}

# The deep-zoom pyramid the viewer pans over. 254 and 1 are the Deep Zoom defaults: a
# tile is a 256 square once the one-pixel skirt that hides the seams is added.
TILE_SIZE = 254
TILE_OVERLAP = 1
TILE_QUALITY = 80


def file_hash(path: str) -> str:
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def tiles_dir(rend_dir: Path, page_id: int) -> Path:
    return rend_dir / f'{page_id}_tiles'


def descriptor(width: int, height: int) -> str:
    """The .dzi document OpenSeadragon opens a pyramid with."""
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<Image xmlns="http://schemas.microsoft.com/deepzoom/2008" '
        f'TileSize="{TILE_SIZE}" Overlap="{TILE_OVERLAP}" Format="jpg">'
        f'<Size Width="{width}" Height="{height}"/>'
        '</Image>'
    )


def max_level(width: int, height: int) -> int:
    return math.ceil(math.log2(max(width, height, 1)))


def write_tiles(img: Image.Image, rend_dir: Path, page_id: int) -> None:
    """The page's deep-zoom pyramid, so zooming in fetches the few hundred kilobytes
    under the cursor instead of the whole scan. Built into a scratch directory and
    swapped in at the end: a half-written pyramid that another request started reading
    would show holes rather than a scan."""
    width, height = img.size
    final = tiles_dir(rend_dir, page_id)
    staging = final.with_name(final.name + '.partial')
    shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir(parents=True)

    top = max_level(width, height)
    level_img = img
    for level in range(top, -1, -1):
        scale = 2 ** (top - level)
        size = (max(1, math.ceil(width / scale)), max(1, math.ceil(height / scale)))
        # Resampled from the original every time rather than from the level above, so a
        # deep pyramid does not accumulate the blur of twelve successive halvings.
        if level_img.size != size:
            level_img = img.resize(size, Image.LANCZOS)
        level_dir = staging / str(level)
        level_dir.mkdir()
        for col in range((size[0] + TILE_SIZE - 1) // TILE_SIZE):
            for row in range((size[1] + TILE_SIZE - 1) // TILE_SIZE):
                box = (
                    max(0, col * TILE_SIZE - TILE_OVERLAP),
                    max(0, row * TILE_SIZE - TILE_OVERLAP),
                    min(size[0], (col + 1) * TILE_SIZE + TILE_OVERLAP),
                    min(size[1], (row + 1) * TILE_SIZE + TILE_OVERLAP),
                )
                level_img.crop(box).save(level_dir / f'{col}_{row}.jpg', quality=TILE_QUALITY)

    (staging / 'image.dzi').write_text(descriptor(width, height))
    shutil.rmtree(final, ignore_errors=True)
    staging.rename(final)


def write(img: Image.Image, rend_dir: Path, page_id: int) -> None:
    """One page's sized copies, replacing whatever was there."""
    rend_dir.mkdir(parents=True, exist_ok=True)
    for kind, target in RENDITIONS.items():
        copy = img.copy()
        copy.thumbnail((target, target * 4))
        copy.save(rend_dir / f'{page_id}_{kind}.jpg', quality=85)
    write_tiles(img, rend_dir, page_id)
