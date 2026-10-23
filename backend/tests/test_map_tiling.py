"""A full map is cut into tiles the way a page scan is ingested: upright, 8-bit and opaque.
The tiler reads whatever file it is handed, so the map has to be normalised before it."""
import importlib
import importlib.util
import sys
import types
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from app import store

ORIENTATION = 0x0112
ROTATE_90_CLOCKWISE = 6
TILE = 20
RED, BLUE, WHITE, BLACK = (255, 0, 0), (0, 0, 255), (255, 255, 255), (0, 0, 0)


class FakeReader:
    """Reads the file as stored, like the sibling repo's streaming reader."""

    def __init__(self, path):
        self.image = Image.open(path)
        self.image.load()
        self.width, self.height = self.image.size

    def read_tile(self, x0, y0):
        return np.asarray(self.image.crop((x0, y0, x0 + TILE, y0 + TILE)).convert('RGB'))

    def close(self):
        self.image.close()


def fake_tiling():
    tiling = types.ModuleType('inference.tiling')
    tiling.open_map_reader = lambda path, tile_size, stream: FakeReader(path)
    tiling.tile_positions = lambda h, w, t: [(x, y) for y in range(0, h, t) for x in range(0, w, t)]
    tiling.is_near_blank = lambda arr: arr.min() > 250
    tiling.pad_tile = lambda arr, t: arr
    return tiling


@pytest.fixture
def runner(monkeypatch):
    if importlib.util.find_spec('inference') is None:
        tiling = fake_tiling()
        package = types.ModuleType('inference')
        package.tiling = tiling
        monkeypatch.setitem(sys.modules, 'inference', package)
        monkeypatch.setitem(sys.modules, 'inference.tiling', tiling)
    sys.modules.pop('runner.run_map_job', None)
    yield importlib.import_module('runner.run_map_job')
    sys.modules.pop('runner.run_map_job', None)


@pytest.fixture
def job(tmp_path):
    conn = store.connect(tmp_path / 'app.db')
    conn.execute("INSERT INTO jobs (id, name, task, run_tile, tile_size) "
                 "VALUES ('j', 'Maps', 'map_segmentation', 1, ?)", (TILE,))
    conn.commit()
    yield conn, tmp_path / 'job'
    conn.close()


def add_map(conn, path: Path, status='pending'):
    idx = conn.execute("SELECT COUNT(*) FROM job_maps WHERE job_id = 'j'").fetchone()[0]
    return conn.execute(
        "INSERT INTO job_maps (job_id, idx, filename, source_file, status) VALUES ('j', ?, ?, ?, ?)",
        (idx, path.name, str(path), status)).lastrowid


def tile(runner, conn, job_path, skip_blank=True):
    conn.commit()
    runner.phase_tile(conn, 'j', job_path, TILE, skip_blank)


def map_row(conn, map_id):
    return conn.execute('SELECT * FROM job_maps WHERE id = ?', (map_id,)).fetchone()


def tiles_of(conn, map_id):
    return {(row['tile_x'], row['tile_y']): Image.open(row['source_file']).convert('RGB')
            for row in conn.execute('SELECT * FROM pages WHERE source_map = ?', (map_id,))}


def rotated_photo(path: Path) -> Path:
    """Stored 40 wide and 20 tall, red on the left and blue on the right; the camera says
    to turn it a quarter clockwise, which makes it 20 wide and 40 tall, red on top."""
    img = Image.new('RGB', (2 * TILE, TILE), BLUE)
    img.paste(RED, (0, 0, TILE, TILE))
    exif = Image.Exif()
    exif[ORIENTATION] = ROTATE_90_CLOCKWISE
    img.save(path, exif=exif)
    return path


def test_a_rotated_map_is_cut_upright(runner, job, tmp_path):
    conn, job_path = job
    map_id = add_map(conn, rotated_photo(tmp_path / 'phone.png'))
    tile(runner, conn, job_path)

    row = map_row(conn, map_id)
    assert (row['width'], row['height'], row['n_tiles']) == (TILE, 2 * TILE, 2)
    tiles = tiles_of(conn, map_id)
    assert sorted(tiles) == [(0, 0), (0, TILE)]
    assert tiles[(0, 0)].getpixel((5, 5)) == RED
    assert tiles[(0, TILE)].getpixel((5, 5)) == BLUE


def test_a_rotated_map_points_at_its_upright_copy(runner, job, tmp_path):
    conn, job_path = job
    original = rotated_photo(tmp_path / 'phone.png')
    as_uploaded = original.read_bytes()
    map_id = add_map(conn, original)
    tile(runner, conn, job_path)

    source = Path(map_row(conn, map_id)['source_file'])
    assert source != original and source.is_relative_to(job_path)
    with Image.open(source) as copy:
        assert copy.size == (TILE, 2 * TILE)
        assert copy.getexif().get(ORIENTATION) in (None, 1)
    assert original.read_bytes() == as_uploaded


def test_a_sixteen_bit_map_is_scaled_not_clipped(runner, job, tmp_path):
    conn, job_path = job
    path = tmp_path / 'deep.png'
    Image.new('I;16', (2 * TILE, TILE), 128 * 257).save(path)
    map_id = add_map(conn, path)
    tile(runner, conn, job_path)

    assert map_row(conn, map_id)['n_tiles'] == 2
    tiles = tiles_of(conn, map_id)
    assert sorted(tiles) == [(0, 0), (TILE, 0)]
    assert tiles[(0, 0)].getpixel((5, 5)) == (128, 128, 128)


def test_a_transparent_map_is_laid_on_white(runner, job, tmp_path):
    conn, job_path = job
    path = tmp_path / 'clear.png'
    img = Image.new('RGBA', (2 * TILE, TILE), (0, 0, 0, 0))
    img.paste((0, 0, 0, 255), (2, 2, 8, 8))
    img.save(path)
    map_id = add_map(conn, path)
    tile(runner, conn, job_path, skip_blank=False)

    tiles = tiles_of(conn, map_id)
    assert sorted(tiles) == [(0, 0), (TILE, 0)]
    assert tiles[(0, 0)].getpixel((4, 4)) == BLACK
    assert tiles[(0, 0)].getpixel((15, 15)) == WHITE
    assert tiles[(TILE, 0)].getpixel((5, 5)) == WHITE


def test_a_plain_map_is_cut_from_the_original(runner, job, tmp_path):
    conn, job_path = job
    path = tmp_path / 'plain.png'
    Image.new('RGB', (TILE, TILE), RED).save(path)
    map_id = add_map(conn, path)
    tile(runner, conn, job_path)

    assert map_row(conn, map_id)['source_file'] == str(path)
    assert tiles_of(conn, map_id)[(0, 0)].getpixel((5, 5)) == RED


def test_a_map_tiled_earlier_keeps_its_file_and_tiles(runner, job, tmp_path):
    conn, job_path = job
    earlier = add_map(conn, rotated_photo(tmp_path / 'earlier.png'), status='done')
    pending = add_map(conn, rotated_photo(tmp_path / 'pending.png'))
    tile(runner, conn, job_path)

    assert map_row(conn, earlier)['source_file'] == str(tmp_path / 'earlier.png')
    assert tiles_of(conn, earlier) == {}
    assert sorted(tiles_of(conn, pending)) == [(0, 0), (0, TILE)]
