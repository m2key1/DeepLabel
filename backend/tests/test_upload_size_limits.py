import io
import shutil
import zipfile

import pytest
from PIL import Image
from fastapi.testclient import TestClient

from app import store
from app.deps import get_db
from app.main import app

SECRET = 'test-secret'
EDITOR = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'alice', 'X-Auth-Role': 'member',
          'X-Auth-Caps': 'pipeline.layout pipeline.lines pipeline.ocr'}

PAGE_XML = b"""<?xml version="1.0" encoding="UTF-8"?>
<PcGts xmlns="http://schema.primaresearch.org/PAGE/gts/pagecontent/2019-07-15">
  <Page imageFilename="folio_1.png" imageWidth="20" imageHeight="10"/>
</PcGts>
"""


def png_bytes(width: int, height: int) -> bytes:
    buf = io.BytesIO()
    Image.new('RGB', (width, height), 'white').save(buf, 'PNG')
    return buf.getvalue()


def pdf_bytes(width: int, height: int) -> bytes:
    """One page holding one image that fills it, at 72 dpi: the page is width x height
    points and the image width x height pixels."""
    buf = io.BytesIO()
    Image.new('RGB', (width, height), 'white').save(buf, 'PDF', resolution=72)
    return buf.getvalue()


needs_poppler = pytest.mark.skipif(not shutil.which('pdfimages'), reason='poppler-utils not installed')


def export_zip(image: bytes) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as zf:
        zf.writestr('folio_1.xml', PAGE_XML)
        zf.writestr('folio_1.png', image)
    return buf.getvalue()


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    monkeypatch.setattr('app.config.JOBS_DIR', tmp_path / 'jobs')
    monkeypatch.setattr('app.config.MAX_IMAGE_PIXELS', 200)
    conn = store.connect(tmp_path / 'app.db')
    app.dependency_overrides[get_db] = lambda: conn
    yield TestClient(app), conn, tmp_path / 'jobs'
    app.dependency_overrides.clear()
    conn.close()


def job_names(conn) -> list[str]:
    return [row['name'] for row in conn.execute('SELECT name FROM jobs ORDER BY name')]


def written_files(jobs_dir) -> list[str]:
    return sorted(p.name for p in jobs_dir.rglob('*') if p.is_file()) if jobs_dir.exists() else []


class TestZipExtractionLimit:
    def test_a_zip_declaring_more_than_the_limit_is_refused_before_anything_is_written(
            self, client, monkeypatch):
        api, conn, jobs_dir = client
        monkeypatch.setattr('app.config.MAX_ZIP_EXTRACT_GB', 0.00002)
        image = png_bytes(20, 10) + b'\0' * 30_000
        res = api.post('/api/jobs/import', data={'name': 'runaway'}, headers=EDITOR,
                       files={'file': ('export.zip', export_zip(image), 'application/zip')})
        unpacked_kb = (len(PAGE_XML) + len(image)) / 1000
        assert res.status_code == 413, res.text
        assert res.json()['detail'] == (
            f"the zip unpacks to {unpacked_kb:.1f} KB, over this server's limit of "
            '20.0 KB (MAX_ZIP_EXTRACT_GB)')
        assert job_names(conn) == []
        assert written_files(jobs_dir) == []

    def test_a_zip_within_the_limit_imports(self, client, monkeypatch):
        api, conn, jobs_dir = client
        monkeypatch.setattr('app.config.MAX_ZIP_EXTRACT_GB', 0.00002)
        res = api.post('/api/jobs/import', data={'name': 'small'}, headers=EDITOR,
                       files={'file': ('export.zip', export_zip(png_bytes(20, 10)), 'application/zip')})
        assert res.status_code == 200, res.text
        assert job_names(conn) == ['small']
        assert written_files(jobs_dir) == ['00000_folio_1.png']

    def test_an_image_in_the_zip_over_the_pixel_limit_is_refused(self, client):
        api, conn, jobs_dir = client
        res = api.post('/api/jobs/import', data={'name': 'huge'}, headers=EDITOR,
                       files={'file': ('export.zip', export_zip(png_bytes(21, 10)), 'application/zip')})
        assert res.status_code == 413, res.text
        assert res.json()['detail'] == (
            "folio_1.png is 21 x 10 = 210 pixels, over this server's limit of 200 (MAX_IMAGE_PIXELS)")
        assert job_names(conn) == []
        assert written_files(jobs_dir) == []


class TestImagePixelLimit:
    def test_an_upload_over_the_pixel_limit_is_refused_and_leaves_nothing(self, client):
        api, conn, jobs_dir = client
        res = api.post('/api/jobs', data={'name': 'huge'}, headers=EDITOR, files=[
            ('files', ('small.png', png_bytes(20, 10), 'image/png')),
            ('files', ('big.png', png_bytes(30, 10), 'image/png')),
        ])
        assert res.status_code == 413, res.text
        assert res.json()['detail'] == (
            "big.png is 30 x 10 = 300 pixels, over this server's limit of 200 (MAX_IMAGE_PIXELS)")
        assert job_names(conn) == []
        assert written_files(jobs_dir) == []

    def test_an_upload_at_the_pixel_limit_is_kept(self, client):
        api, conn, jobs_dir = client
        res = api.post('/api/jobs', data={'name': 'fits'}, headers=EDITOR,
                       files=[('files', ('small.png', png_bytes(20, 10), 'image/png'))])
        assert res.status_code == 200, res.text
        assert job_names(conn) == ['fits']
        assert written_files(jobs_dir) == ['00000_small.png']

    def test_an_append_over_the_pixel_limit_adds_no_page(self, client):
        api, conn, jobs_dir = client
        res = api.post('/api/jobs', data={'name': 'seed'}, headers=EDITOR,
                       files=[('files', ('first.png', png_bytes(20, 10), 'image/png'))])
        assert res.status_code == 200, res.text
        job_id = res.json()['job_id']
        conn.execute("UPDATE jobs SET status = 'done' WHERE id = ?", (job_id,))
        conn.commit()
        res = api.post(f'/api/jobs/{job_id}/pages/upload', headers=EDITOR,
                       files=[('files', ('big.png', png_bytes(10, 21), 'image/png'))])
        assert res.status_code == 413, res.text
        assert res.json()['detail'] == (
            "big.png is 10 x 21 = 210 pixels, over this server's limit of 200 (MAX_IMAGE_PIXELS)")
        filenames = [row['filename'] for row in conn.execute(
            'SELECT filename FROM pages WHERE job_id = ? ORDER BY idx', (job_id,))]
        assert filenames == ['first.png']
        assert written_files(jobs_dir) == ['00000_first.png']

    def test_an_unreadable_image_is_left_to_the_ingest_phase(self, client):
        api, conn, jobs_dir = client
        res = api.post('/api/jobs', data={'name': 'stub'}, headers=EDITOR,
                       files=[('files', ('scan.png', b'\x89PNG\r\n\x1a\n', 'image/png'))])
        assert res.status_code == 200, res.text
        assert job_names(conn) == ['stub']

    def test_a_server_path_with_an_image_over_the_pixel_limit_is_refused(self, client, tmp_path):
        api, conn, jobs_dir = client
        folder = tmp_path / 'volume'
        folder.mkdir()
        (folder / 'a.png').write_bytes(png_bytes(20, 10))
        (folder / 'b.png').write_bytes(png_bytes(25, 10))
        res = api.post('/api/jobs/path', json={'name': 'volume', 'server_path': str(folder)},
                       headers={**EDITOR, 'X-Auth-Role': 'admin'})
        assert res.status_code == 413, res.text
        assert res.json()['detail'] == (
            "b.png is 25 x 10 = 250 pixels, over this server's limit of 200 (MAX_IMAGE_PIXELS)")
        assert job_names(conn) == []
        assert sorted(p.name for p in folder.iterdir()) == ['a.png', 'b.png']


@needs_poppler
class TestPdfPixelLimit:
    """A PDF page becomes an image only in the ingest phase, so its size is worked out
    from the document: an extracted scan keeps its own pixels, a rendered page is its
    size in points at PDF_RENDER_DPI."""

    def test_a_pdf_whose_scan_is_over_the_limit_is_refused_and_leaves_nothing(self, client):
        api, conn, jobs_dir = client
        res = api.post('/api/jobs', data={'name': 'book'}, headers=EDITOR,
                       files=[('files', ('book.pdf', pdf_bytes(30, 10), 'application/pdf'))])
        assert res.status_code == 413, res.text
        assert res.json()['detail'] == (
            "book.pdf page 1 is 30 x 10 = 300 pixels, over this server's limit of 200 (MAX_IMAGE_PIXELS)")
        assert job_names(conn) == []
        assert written_files(jobs_dir) == []

    def test_a_pdf_whose_rendered_page_is_over_the_limit_is_refused(self, client, monkeypatch):
        api, conn, jobs_dir = client
        monkeypatch.setattr('app.config.PDF_EXTRACT_COVERAGE', 2.0)
        monkeypatch.setattr('app.config.PDF_RENDER_DPI', 144)
        res = api.post('/api/jobs', data={'name': 'book'}, headers=EDITOR,
                       files=[('files', ('book.pdf', pdf_bytes(20, 10), 'application/pdf'))])
        assert res.status_code == 413, res.text
        assert res.json()['detail'] == (
            "book.pdf page 1 is 40 x 20 = 800 pixels, over this server's limit of 200 (MAX_IMAGE_PIXELS)")
        assert job_names(conn) == []

    def test_a_pdf_at_the_limit_is_kept(self, client):
        api, conn, jobs_dir = client
        res = api.post('/api/jobs', data={'name': 'book'}, headers=EDITOR,
                       files=[('files', ('book.pdf', pdf_bytes(20, 10), 'application/pdf'))])
        assert res.status_code == 200, res.text
        assert job_names(conn) == ['book']
        assert written_files(jobs_dir) == ['00000_book.pdf']

    def test_a_server_path_with_a_pdf_over_the_limit_is_refused(self, client, tmp_path):
        api, conn, jobs_dir = client
        folder = tmp_path / 'volume'
        folder.mkdir()
        (folder / 'book.pdf').write_bytes(pdf_bytes(30, 10))
        res = api.post('/api/jobs/path', json={'name': 'volume', 'server_path': str(folder)},
                       headers={**EDITOR, 'X-Auth-Role': 'admin'})
        assert res.status_code == 413, res.text
        assert res.json()['detail'] == (
            "book.pdf page 1 is 30 x 10 = 300 pixels, over this server's limit of 200 (MAX_IMAGE_PIXELS)")
        assert job_names(conn) == []


@needs_poppler
class TestAFailedAppendLeavesNoUpload:
    @pytest.fixture
    def seeded(self, client):
        api, conn, jobs_dir = client
        res = api.post('/api/jobs', data={'name': 'seed'}, headers=EDITOR,
                       files=[('files', ('first.png', png_bytes(20, 10), 'image/png'))])
        assert res.status_code == 200, res.text
        job_id = res.json()['job_id']
        conn.execute("UPDATE jobs SET status = 'done' WHERE id = ?", (job_id,))
        conn.commit()
        return api, conn, jobs_dir, job_id

    def pages(self, conn, job_id):
        return [row['filename'] for row in conn.execute(
            'SELECT filename FROM pages WHERE job_id = ? ORDER BY idx', (job_id,))]

    def test_an_unreadable_pdf_takes_the_images_before_it_away(self, seeded):
        api, conn, jobs_dir, job_id = seeded
        res = api.post(f'/api/jobs/{job_id}/pages/upload', headers=EDITOR, files=[
            ('files', ('second.png', png_bytes(20, 10), 'image/png')),
            ('files', ('broken.pdf', b'not a pdf at all', 'application/pdf')),
        ])
        assert res.status_code == 400, res.text
        assert res.json()['detail'].startswith('broken.pdf: ')
        assert self.pages(conn, job_id) == ['first.png']
        assert written_files(jobs_dir) == ['00000_first.png']

    def test_a_pdf_over_the_limit_takes_the_images_before_it_away(self, seeded):
        api, conn, jobs_dir, job_id = seeded
        res = api.post(f'/api/jobs/{job_id}/pages/upload', headers=EDITOR, files=[
            ('files', ('second.png', png_bytes(20, 10), 'image/png')),
            ('files', ('book.pdf', pdf_bytes(30, 10), 'application/pdf')),
        ])
        assert res.status_code == 413, res.text
        assert self.pages(conn, job_id) == ['first.png']
        assert written_files(jobs_dir) == ['00000_first.png']


class TestAnUploadThatBreaksOff:
    class Upload:
        def __init__(self, filename, file):
            self.filename, self.file = filename, file

    class Dropped(io.BytesIO):
        def read(self, *args):
            raise OSError('connection reset')

    def test_what_was_already_written_is_removed(self, tmp_path, monkeypatch):
        from app import ingest
        monkeypatch.setattr('app.config.JOBS_DIR', tmp_path / 'jobs')
        files = [self.Upload('folio_1.png', io.BytesIO(png_bytes(20, 10))),
                 self.Upload('folio_2.png', self.Dropped())]

        with pytest.raises(OSError, match='connection reset'):
            ingest.save_uploads('j1', files, 3)

        uploads = tmp_path / 'jobs' / 'j1' / 'uploads'
        assert uploads.is_dir()
        assert sorted(p.name for p in uploads.iterdir()) == []
