"""The deep-zoom pyramid the viewer pans over, and the route that serves it.

Pages ingested before the viewer wanted tiles have renditions but no pyramid, so the
route builds one on the first ask rather than making anyone re-run ingest.
"""
import math

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app import renditions, store
from app.deps import get_db
from app.main import app

SECRET = 'test-secret'
ALICE = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'alice', 'X-Auth-Role': 'member'}
BOB = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'bob', 'X-Auth-Role': 'member'}

# 600 x 400 puts the top level at ceil(log2(600)) = 10 and leaves a part-width column and
# a part-height row, so the edge tiles are not the same size as the middle ones.
WIDTH, HEIGHT = 600, 400
TOP_LEVEL = 10


@pytest.fixture
def scan(tmp_path):
    uploads = tmp_path / 'jobs' / 'j1' / 'uploads'
    uploads.mkdir(parents=True)
    path = uploads / 'p1.png'
    Image.new('RGB', (WIDTH, HEIGHT), 'white').save(path)
    return path


@pytest.fixture
def conn(tmp_path, scan, monkeypatch):
    monkeypatch.setattr('app.config.JOBS_DIR', tmp_path / 'jobs')
    connection = store.connect(tmp_path / 'app.db')
    connection.executescript(f"""
        INSERT INTO jobs (id, name, owner, status) VALUES ('j1', 'Volume', 'alice', 'done');
        INSERT INTO pages (id, job_id, idx, filename, source_file, status, width, height) VALUES
            (1, 'j1', 0, 'p1.png', '{scan}', 'done', {WIDTH}, {HEIGHT});
    """)
    connection.commit()
    yield connection
    connection.close()


@pytest.fixture
def client(conn, monkeypatch):
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    app.dependency_overrides[get_db] = lambda: conn
    yield TestClient(app)
    app.dependency_overrides.clear()


def tiles_root(tmp_path):
    return renditions.tiles_dir(tmp_path / 'jobs' / 'j1' / 'renditions', 1)


class TestPyramidShape:
    """The level and tile arithmetic, against a size whose every count is worked out by
    hand above - a pyramid one level short still renders, just blurry at full zoom."""

    @pytest.fixture(autouse=True)
    def built(self, tmp_path, scan):
        with Image.open(scan) as img:
            renditions.write_tiles(img.convert('RGB'), tmp_path / 'jobs' / 'j1' / 'renditions', 1)

    def test_every_level_from_the_whole_page_to_full_size_is_there(self, tmp_path):
        levels = sorted(int(d.name) for d in tiles_root(tmp_path).iterdir() if d.is_dir())

        assert levels == list(range(0, TOP_LEVEL + 1))

    def test_the_top_level_is_the_scan_at_full_size(self, tmp_path):
        top = tiles_root(tmp_path) / str(TOP_LEVEL)

        # 600 x 400 over 254-wide tiles: three columns, two rows.
        assert sorted(p.name for p in top.iterdir()) == [
            '0_0.jpg', '0_1.jpg', '1_0.jpg', '1_1.jpg', '2_0.jpg', '2_1.jpg',
        ]

    def test_a_tile_carries_the_one_pixel_skirt_that_hides_the_seam(self, tmp_path):
        top = tiles_root(tmp_path) / str(TOP_LEVEL)

        # The first tile overlaps only on its inner sides; the middle one on both; the
        # last is what is left of the 600 pixels after two full columns.
        with Image.open(top / '0_0.jpg') as tile:
            assert tile.size == (255, 255)
        with Image.open(top / '1_0.jpg') as tile:
            assert tile.size == (256, 255)
        with Image.open(top / '2_0.jpg') as tile:
            assert tile.size == (93, 255)

    def test_halving_the_level_halves_the_grid(self, tmp_path):
        below = tiles_root(tmp_path) / str(TOP_LEVEL - 1)

        # 300 x 200 needs two columns and one row.
        assert sorted(p.name for p in below.iterdir()) == ['0_0.jpg', '1_0.jpg']

    def test_the_bottom_level_is_a_single_tile(self, tmp_path):
        bottom = tiles_root(tmp_path) / '0'

        assert [p.name for p in bottom.iterdir()] == ['0_0.jpg']
        with Image.open(bottom / '0_0.jpg') as tile:
            assert tile.size == (1, 1)

    def test_nothing_is_left_staged(self, tmp_path):
        root = tiles_root(tmp_path)

        assert not root.with_name(root.name + '.partial').exists()

    def test_rebuilding_replaces_rather_than_merges(self, tmp_path, scan):
        stale = tiles_root(tmp_path) / str(TOP_LEVEL) / '9_9.jpg'
        stale.write_bytes(b'not a tile')

        with Image.open(scan) as img:
            renditions.write_tiles(img.convert('RGB'), tmp_path / 'jobs' / 'j1' / 'renditions', 1)

        assert not stale.exists()
        assert (tiles_root(tmp_path) / str(TOP_LEVEL) / '0_0.jpg').exists()


class TestDescriptor:
    def test_it_states_the_size_the_viewer_lays_the_page_out_at(self):
        assert f'<Size Width="{WIDTH}" Height="{HEIGHT}"/>' in renditions.descriptor(WIDTH, HEIGHT)

    def test_it_states_the_tile_size_and_overlap_the_tiles_were_cut_with(self):
        document = renditions.descriptor(WIDTH, HEIGHT)

        assert f'TileSize="{renditions.TILE_SIZE}"' in document
        assert f'Overlap="{renditions.TILE_OVERLAP}"' in document

    def test_the_top_level_is_the_one_that_holds_the_whole_scan(self):
        assert renditions.max_level(WIDTH, HEIGHT) == TOP_LEVEL
        assert 2 ** TOP_LEVEL >= WIDTH
        assert math.ceil(WIDTH / 2 ** (TOP_LEVEL - TOP_LEVEL)) == WIDTH


class TestRoute:
    def test_a_tile_is_served_as_a_jpeg(self, client):
        response = client.get(f'/api/pages/1/tiles/0/{TOP_LEVEL}/0_0.jpg', headers=ALICE)

        assert response.status_code == 200, response.text
        assert response.headers['content-type'] == 'image/jpeg'

    def test_it_is_the_tile_that_was_asked_for(self, client):
        import io

        response = client.get(f'/api/pages/1/tiles/0/{TOP_LEVEL}/2_0.jpg', headers=ALICE)

        with Image.open(io.BytesIO(response.content)) as tile:
            assert tile.size == (93, 255)

    def test_the_first_ask_builds_the_pyramid_a_page_was_ingested_without(self, client, tmp_path):
        assert not tiles_root(tmp_path).exists()

        assert client.get('/api/pages/1/tiles/0/0/0_0.jpg', headers=ALICE).status_code == 200

        assert (tiles_root(tmp_path) / '0' / '0_0.jpg').exists()

    def test_tiles_are_cached_for_good(self, client):
        response = client.get('/api/pages/1/tiles/0/0/0_0.jpg', headers=ALICE)

        assert 'immutable' in response.headers['cache-control']

    def test_a_tile_off_the_edge_of_the_level_is_a_404(self, client):
        assert client.get(f'/api/pages/1/tiles/0/{TOP_LEVEL}/9_9.jpg', headers=ALICE).status_code == 404

    def test_a_level_above_the_top_is_a_404(self, client):
        assert client.get('/api/pages/1/tiles/0/99/0_0.jpg', headers=ALICE).status_code == 404

    @pytest.mark.parametrize('tile', ['../../../etc/passwd', '..%2F..%2Fapp.db', '0_0.jpg.bak', 'a_b.jpg'])
    def test_a_tile_name_that_is_not_two_numbers_is_refused(self, client, tile):
        response = client.get(f'/api/pages/1/tiles/0/{TOP_LEVEL}/{tile}', headers=ALICE)

        assert response.status_code == 404, response.text

    def test_someone_elses_dataset_is_a_404(self, client):
        assert client.get('/api/pages/1/tiles/0/0/0_0.jpg', headers=BOB).status_code == 404

    def test_a_page_that_does_not_exist_is_a_404(self, client):
        assert client.get('/api/pages/999/tiles/0/0/0_0.jpg', headers=ALICE).status_code == 404
