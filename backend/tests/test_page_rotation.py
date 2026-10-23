"""Turning a scan the right way up.

The turn is baked in: the image and everything drawn on it are turned together, once, and
nothing downstream is ever told about it. What that has to protect is the scan as it
arrived - an ingested page's file is a hard link into the blob store, shared with every
other dataset holding the same scan.
"""
import json

import pytest
from PIL import Image

from app import rotation, store


@pytest.fixture
def job(tmp_path, monkeypatch):
    monkeypatch.setattr('app.config.JOBS_DIR', tmp_path / 'jobs')
    monkeypatch.setattr('app.config.BLOBS_DIR', tmp_path / 'blobs')
    uploads = tmp_path / 'jobs' / 'j1' / 'uploads'
    uploads.mkdir(parents=True)
    scan = uploads / 'page.png'
    # A landscape scan with one black corner, so the pixels themselves say which way up it is.
    image = Image.new('RGB', (80, 40), 'white')
    image.paste((0, 0, 0), (0, 0, 20, 10))
    image.save(scan)
    conn = store.connect(tmp_path / 'app.db')
    conn.executescript(f"""
        INSERT INTO jobs (id, name, owner, status) VALUES ('j1', 'First', 'alice', 'done');
        INSERT INTO pages (id, job_id, idx, filename, source_file, content_hash, status, width, height)
            VALUES (1, 'j1', 0, 'page.png', '{scan}', 'the-original-digest', 'done', 80, 40);
        INSERT INTO elements (id, page_id, order_idx, class_name, bbox, kind)
            VALUES (1, 1, 0, 'Paragraph', '[0.1,0.2,0.3,0.5]', 'content');
        INSERT INTO lines (id, element_id, order_idx, polygon, text)
            VALUES (1, 1, 0, '[[0.1,0.2],[0.3,0.2],[0.3,0.5],[0.1,0.5]]', 'A line');
    """)
    conn.commit()
    yield conn, scan
    conn.close()


def page(conn):
    return conn.execute('SELECT * FROM pages WHERE id = 1').fetchone()


def corner_is_dark(path) -> tuple[bool, bool, bool, bool]:
    """Which corner of the scan holds the black block: (top-left, top-right, bottom-right,
    bottom-left)."""
    with Image.open(path) as image:
        w, h = image.width - 1, image.height - 1
        dark = [image.getpixel(xy)[0] < 128 for xy in ((1, 1), (w - 1, 1), (w - 1, h - 1), (1, h - 1))]
    return tuple(dark)


class TestTurningThePage:
    def test_a_half_turn_turns_the_scan_and_its_geometry_together(self, job):
        conn, scan = job

        rotation.turn_page(conn, 1, 180, 'alice')

        turned = page(conn)
        assert corner_is_dark(turned['source_file']) == (False, False, True, False)
        assert json.loads(conn.execute('SELECT bbox FROM elements WHERE id = 1').fetchone()['bbox']) \
            == [0.7, 0.5, 0.9, 0.8]
        assert json.loads(conn.execute('SELECT polygon FROM lines WHERE id = 1').fetchone()['polygon']) \
            == [[0.9, 0.8], [0.7, 0.8], [0.7, 0.5], [0.9, 0.5]]

    def test_a_quarter_turn_stands_the_page_up(self, job):
        conn, _ = job

        rotation.turn_page(conn, 1, 90, 'alice')

        turned = page(conn)
        assert (turned['width'], turned['height']) == (40, 80)
        # The block was in the top-left of a landscape scan; a clockwise turn puts it top-right.
        assert corner_is_dark(turned['source_file']) == (False, True, False, False)

    def test_the_scan_as_it_arrived_is_never_written_to(self, job):
        """It is a hard link into the blob store - writing through it would rewrite the
        same scan in every other dataset that holds it."""
        conn, scan = job
        before = scan.read_bytes()

        rotation.turn_page(conn, 1, 180, 'alice')

        assert scan.read_bytes() == before
        assert page(conn)['source_file'] != str(scan)
        assert page(conn)['origin_file'] == str(scan)

    def test_turning_back_to_zero_puts_the_original_back(self, job):
        conn, scan = job
        rotation.turn_page(conn, 1, 90, 'alice')

        rotation.turn_page(conn, 1, 270, 'alice')

        restored = page(conn)
        assert (restored['rotation'], restored['origin_file']) == (0, None)
        assert restored['source_file'] == str(scan)
        assert (restored['width'], restored['height']) == (80, 40)
        # Turning and turning back is the identity to the last bit float subtraction allows.
        assert json.loads(conn.execute('SELECT bbox FROM elements WHERE id = 1').fetchone()['bbox']) \
            == pytest.approx([0.1, 0.2, 0.3, 0.5], abs=1e-12)

    def test_a_second_turn_is_derived_from_the_original_rather_than_the_last_one(self, job):
        conn, _ = job
        rotation.turn_page(conn, 1, 90, 'alice')

        rotation.turn_page(conn, 1, 90, 'alice')

        turned = page(conn)
        assert turned['rotation'] == 180
        assert (turned['width'], turned['height']) == (80, 40)
        assert corner_is_dark(turned['source_file']) == (False, False, True, False)

    def test_the_turned_page_is_keyed_by_its_own_bytes(self, job):
        conn, _ = job

        rotation.turn_page(conn, 1, 180, 'alice')

        assert page(conn)['content_hash'] != 'the-original-digest'

    def test_the_viewer_renditions_are_rebuilt_for_the_turn(self, job, tmp_path):
        conn, _ = job

        rotation.turn_page(conn, 1, 90, 'alice')

        screen = tmp_path / 'jobs' / 'j1' / 'renditions' / '1_screen.jpg'
        with Image.open(screen) as thumb:
            assert thumb.height > thumb.width


class TestWhatCannotBeTurned:
    def test_a_turn_that_is_not_a_quarter_says_so(self, job):
        conn, _ = job

        with pytest.raises(rotation.CannotTurn, match='90, 180 or 270'):
            rotation.turn_page(conn, 1, 45, 'alice')

    def test_a_page_that_was_never_ingested_has_nothing_to_turn(self, job):
        conn, _ = job
        conn.execute('UPDATE pages SET content_hash = NULL WHERE id = 1')

        with pytest.raises(rotation.CannotTurn, match='not been ingested'):
            rotation.turn_page(conn, 1, 90, 'alice')

    def test_a_map_tile_is_turned_with_its_map_and_not_on_its_own(self, job):
        conn, _ = job
        conn.execute('UPDATE pages SET source_map = 7 WHERE id = 1')

        with pytest.raises(rotation.CannotTurn, match='cut from its map'):
            rotation.turn_page(conn, 1, 90, 'alice')

    def test_a_page_whose_image_is_gone_says_so_instead_of_failing_on_open(self, job):
        conn, scan = job
        scan.unlink()

        with pytest.raises(rotation.CannotTurn, match='missing on disk'):
            rotation.turn_page(conn, 1, 90, 'alice')
