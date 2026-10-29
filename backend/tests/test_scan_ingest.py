"""What ingest makes of each scan: one that cannot be read is that page's failure alone,
and one that can is brought to the same footing - upright, 8-bit, opaque - before any
geometry is drawn on it."""
import json

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app import map_ingest, store
from app.deps import get_db
from app.main import app

SECRET = 'secret'
ADMIN = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'root', 'X-Auth-Role': 'admin'}
ORIENTATION = 0x0112


@pytest.fixture
def job(tmp_path):
    conn = store.connect(tmp_path / 'app.db')
    conn.execute("INSERT INTO jobs (id, name, task) VALUES ('job1', 'Job', 'map_segmentation')")
    conn.commit()
    yield conn, tmp_path
    conn.close()


def add_page(conn, idx, source):
    cur = conn.execute(
        "INSERT INTO pages (job_id, idx, filename, source_file) VALUES ('job1', ?, ?, ?)",
        (idx, source.name, str(source)))
    conn.commit()
    return cur.lastrowid


def page_row(conn, page_id):
    return conn.execute('SELECT * FROM pages WHERE id = ?', (page_id,)).fetchone()


def counters(conn):
    return json.loads(conn.execute("SELECT counters FROM jobs WHERE id = 'job1'").fetchone()['counters'])


class TestUnreadableScans:
    def test_one_unreadable_scan_fails_that_page_alone(self, job):
        conn, tmp_path = job
        good, empty, other = tmp_path / 'a.png', tmp_path / 'b.png', tmp_path / 'c.png'
        Image.new('RGB', (40, 30), 'white').save(good)
        empty.write_bytes(b'')
        Image.new('RGB', (40, 30), 'black').save(other)
        ids = [add_page(conn, i, path) for i, path in enumerate((good, empty, other))]

        map_ingest.ingest_map_job(conn, 'job1', tmp_path)

        rows = [page_row(conn, i) for i in ids]
        assert [(r['status'], r['error']) for r in rows] == [
            ('done', None), ('unreadable', 'b.png could not be read: the file is empty'), ('done', None)]
        assert (rows[1]['width'], rows[1]['height']) == (None, None)
        assert (counters(conn)['pages_total'], counters(conn)['pages_ingested']) == (2, 2)

    def test_a_file_that_is_not_an_image_says_so(self, job):
        conn, tmp_path = job
        fake = tmp_path / 'notes.jpg'
        fake.write_text('this is a shopping list')
        page_id = add_page(conn, 0, fake)

        map_ingest.ingest_map_job(conn, 'job1', tmp_path)

        assert (page_row(conn, page_id)['status'], page_row(conn, page_id)['error']) == (
            'unreadable', 'notes.jpg could not be read: it is not an image in a format this server reads')

    def test_a_missing_file_is_unreadable_too(self, job):
        conn, tmp_path = job
        page_id = add_page(conn, 0, tmp_path / 'gone.png')

        map_ingest.ingest_map_job(conn, 'job1', tmp_path)

        assert (page_row(conn, page_id)['status'], page_row(conn, page_id)['error']) == (
            'unreadable', 'gone.png could not be read: the file is missing')

    def test_the_dataset_names_its_unreadable_pages(self, job, monkeypatch):
        conn, tmp_path = job
        monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
        good, empty = tmp_path / 'a.png', tmp_path / 'b.png'
        Image.new('RGB', (40, 30), 'white').save(good)
        empty.write_bytes(b'')
        add_page(conn, 0, good)
        bad = add_page(conn, 1, empty)
        map_ingest.ingest_map_job(conn, 'job1', tmp_path)

        app.dependency_overrides[get_db] = lambda: conn
        try:
            client = TestClient(app)
            full = client.get('/api/jobs/job1', headers=ADMIN).json()
            lean = client.get('/api/jobs/job1?pages=false', headers=ADMIN).json()
        finally:
            app.dependency_overrides.clear()

        expected = [{'id': bad, 'filename': 'b.png', 'error': 'b.png could not be read: the file is empty',
                     'iiif': False}]
        assert full['unreadable'] == expected
        assert lean['unreadable'] == expected
        assert (full['pages_live'], full['tiles_total']) == (1, 1)
        assert [p['status'] for p in full['pages']] == ['done', 'unreadable']


def ingest_one(conn, tmp_path, source):
    page_id = add_page(conn, 0, source)
    map_ingest.ingest_map_job(conn, 'job1', tmp_path)
    row = page_row(conn, page_id)
    assert row['status'] == 'done', row['error']
    return row


class TestNormalisation:
    def test_exif_orientation_is_applied(self, job):
        conn, tmp_path = job
        photo = tmp_path / 'phone.jpg'
        img = Image.new('RGB', (400, 100), 'white')
        img.paste((0, 0, 0), (0, 0, 40, 100))
        exif = img.getexif()
        exif[ORIENTATION] = 6
        img.save(photo, exif=exif, quality=95)
        original = photo.read_bytes()

        row = ingest_one(conn, tmp_path, photo)

        assert (row['width'], row['height']) == (100, 400)
        assert row['source_file'] != str(photo)
        assert row['source_file'].endswith('.jpg')
        with Image.open(row['source_file']) as stored:
            assert stored.format == 'JPEG'
            assert stored.size == (100, 400)
            assert stored.getexif().get(ORIENTATION) in (None, 1)
            # Orientation 6 turns the left edge, where the black band was, to the top.
            assert stored.convert('L').getpixel((50, 10)) < 30
            assert stored.convert('L').getpixel((50, 390)) > 225
        assert photo.read_bytes() == original

    def test_sixteen_bit_greys_are_scaled_not_clipped(self, job):
        conn, tmp_path = job
        ramp = tmp_path / 'ramp.png'
        img = Image.new('I;16', (256, 1))
        img.putdata([v * 257 for v in range(256)])
        img.save(ramp)

        row = ingest_one(conn, tmp_path, ramp)

        with Image.open(row['source_file']) as stored:
            assert stored.mode == 'RGB'
            assert [stored.getpixel((x, 0)) for x in (0, 64, 128, 255)] == [
                (0, 0, 0), (64, 64, 64), (128, 128, 128), (255, 255, 255)]

    def test_a_transparent_background_becomes_white_and_the_ink_stays(self, job):
        conn, tmp_path = job
        sheet = tmp_path / 'cutout.png'
        img = Image.new('RGBA', (20, 20), (0, 0, 0, 0))
        img.paste((0, 0, 0, 255), (5, 5, 15, 15))
        img.save(sheet)

        row = ingest_one(conn, tmp_path, sheet)

        with Image.open(row['source_file']) as stored:
            assert stored.mode == 'RGB'
            assert stored.getpixel((0, 0)) == (255, 255, 255)
            assert stored.getpixel((10, 10)) == (0, 0, 0)

    def test_an_ordinary_scan_is_left_as_it_arrived(self, job):
        conn, tmp_path = job
        scan = tmp_path / 'plain.png'
        Image.new('L', (30, 20), 128).save(scan)

        row = ingest_one(conn, tmp_path, scan)

        assert row['source_file'] == str(scan)
        assert (row['width'], row['height']) == (30, 20)

    def test_two_copies_of_one_turned_photo_are_still_one_scan(self, job):
        conn, tmp_path = job
        photo = tmp_path / 'phone.jpg'
        img = Image.new('RGB', (40, 10), 'white')
        exif = img.getexif()
        exif[ORIENTATION] = 6
        img.save(photo, exif=exif)
        first = add_page(conn, 0, photo)
        second = add_page(conn, 1, photo)

        map_ingest.ingest_map_job(conn, 'job1', tmp_path)

        assert (page_row(conn, first)['status'], page_row(conn, second)['status']) == ('done', 'duplicate')
