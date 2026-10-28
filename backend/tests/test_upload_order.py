"""The order pages arrive in is their reading order, and the names they arrive under are
their identity - in exports and in pairing a transcription with its scan."""
import io

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app import config, store
from app.deps import get_db
from app.main import app
from tests.pdfs import text_pdf

SECRET = 'test-secret'
ADMIN = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'alice', 'X-Auth-Role': 'admin'}


def png_bytes(shade: int = 255) -> bytes:
    buf = io.BytesIO()
    Image.new('RGB', (2, 2), (shade, shade, shade)).save(buf, 'PNG')
    return buf.getvalue()


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    monkeypatch.setattr('app.config.JOBS_DIR', tmp_path / 'jobs')
    conn = store.connect(tmp_path / 'app.db')
    app.dependency_overrides[get_db] = lambda: conn
    yield TestClient(app), conn
    app.dependency_overrides.clear()
    conn.close()


def page_order(conn, job_id: str) -> list[tuple]:
    return [(row['filename'], row['source_pdf'] and row['source_pdf'].rsplit('/', 1)[-1])
            for row in conn.execute(
                'SELECT filename, source_pdf FROM pages WHERE job_id = ? ORDER BY idx', (job_id,))]


def upload(api, names: list[str], name='order', content=None):
    files = [('files', (n, content(n) if content else png_bytes(), 'image/png')) for n in names]
    return api.post('/api/jobs', data={'name': name}, files=files, headers=ADMIN)


class TestNaturalOrder:
    def test_unpadded_page_numbers_are_read_as_numbers(self, client):
        api, conn = client
        res = upload(api, ['scan_1.png', 'scan_2.png', 'scan_10.png', 'scan_11.png', 'scan_3.png'])
        assert res.status_code == 200, res.text
        assert [f for f, _ in page_order(conn, res.json()['job_id'])] == [
            'scan_1.png', 'scan_2.png', 'scan_3.png', 'scan_10.png', 'scan_11.png']

    def test_letter_case_does_not_split_the_order(self, client):
        api, conn = client
        res = upload(api, ['b_2.png', 'B_10.png', 'a_1.png', 'A_3.png'])
        assert res.status_code == 200, res.text
        assert [f for f, _ in page_order(conn, res.json()['job_id'])] == [
            'a_1.png', 'A_3.png', 'b_2.png', 'B_10.png']

    def test_appended_pages_follow_the_same_rule(self, client):
        api, conn = client
        res = upload(api, ['first.png'])
        job_id = res.json()['job_id']
        conn.execute("UPDATE jobs SET status = 'done' WHERE id = ?", (job_id,))
        conn.commit()
        files = [('files', (n, png_bytes(i), 'image/png'))
                 for i, n in enumerate(['p10.png', 'p9.png', 'p100.png'])]
        res = api.post(f'/api/jobs/{job_id}/pages/upload', files=files, headers=ADMIN)
        assert res.status_code == 200, res.text
        assert [f for f, _ in page_order(conn, job_id)] == ['first.png', 'p9.png', 'p10.png', 'p100.png']

    def test_a_pdf_keeps_its_pages_together_where_its_name_sorts(self, client):
        api, conn = client
        files = [
            ('files', ('scan_10.png', png_bytes(1), 'image/png')),
            ('files', ('scan_2.pdf', text_pdf([['a'], ['b']]), 'application/pdf')),
            ('files', ('scan_1.png', png_bytes(2), 'image/png')),
        ]
        res = api.post('/api/jobs', data={'name': 'pdf among scans'}, files=files, headers=ADMIN)
        assert res.status_code == 200, res.text
        assert [f.rsplit('.', 1)[0] for f, _ in page_order(conn, res.json()['job_id'])] == [
            'scan_1', 'scan_2_p0001', 'scan_2_p0002', 'scan_10']

    def test_same_named_pdfs_do_not_interleave(self, client):
        api, conn = client
        files = [
            ('files', ('vol.pdf', text_pdf([['A one'], ['A two']]), 'application/pdf')),
            ('files', ('vol.pdf', text_pdf([['B one'], ['B two']]), 'application/pdf')),
        ]
        res = api.post('/api/jobs', data={'name': 'twin pdfs'}, files=files, headers=ADMIN)
        assert res.status_code == 200, res.text
        order = page_order(conn, res.json()['job_id'])
        assert [f.rsplit('.', 1)[0] for f, _ in order] == [
            'vol_p0001', 'vol_p0002', 'vol_p0001', 'vol_p0002']
        assert [pdf for _, pdf in order] == [
            '00000_vol.pdf', '00000_vol.pdf', '00001_vol.pdf', '00001_vol.pdf']

    def test_a_server_folder_is_read_in_natural_order_folders_included(self, client, tmp_path):
        api, conn = client
        root = tmp_path / 'scans'
        for i, name in enumerate(['vol10/p1.png', 'vol2/p10.png', 'vol2/p2.png', 'vol2/p1.png']):
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(png_bytes(i))
        res = api.post('/api/jobs/path', headers=ADMIN, json={
            'name': 'folders', 'server_path': str(root), 'run_layout': False})
        assert res.status_code == 200, res.text
        sources = [row['source_file'] for row in conn.execute(
            'SELECT source_file FROM pages WHERE job_id = ? ORDER BY idx', (res.json()['job_id'],))]
        assert [s.split('/scans/', 1)[1] for s in sources] == [
            'vol2/p1.png', 'vol2/p2.png', 'vol2/p10.png', 'vol10/p1.png']


class TestLongNames:
    LONG = 'x' * 250 + '.png'

    def test_creating_with_an_overlong_name_is_refused_with_the_name(self, client):
        api, conn = client
        res = upload(api, ['ok.png', self.LONG], name='long names')
        assert res.status_code == 400, res.text
        assert res.json()['detail'] == (
            f'"{"x" * 40}....png" has a file name of 254 bytes, longer than the 200 a page '
            'name may be - shorten it and try again')
        assert conn.execute('SELECT COUNT(*) FROM jobs').fetchone()[0] == 0
        assert not (config.JOBS_DIR.exists() and any(config.JOBS_DIR.iterdir()))

    def test_appending_with_an_overlong_name_is_refused_and_writes_nothing(self, client):
        api, conn = client
        job_id = upload(api, ['first.png']).json()['job_id']
        conn.execute("UPDATE jobs SET status = 'done' WHERE id = ?", (job_id,))
        conn.commit()
        uploads = config.JOBS_DIR / job_id / 'uploads'
        before = sorted(p.name for p in uploads.iterdir())
        files = [('files', ('second.png', png_bytes(3), 'image/png')),
                 ('files', (self.LONG, png_bytes(4), 'image/png'))]
        res = api.post(f'/api/jobs/{job_id}/pages/upload', files=files, headers=ADMIN)
        assert res.status_code == 400, res.text
        assert self.LONG[:40] in res.json()['detail']
        assert sorted(p.name for p in uploads.iterdir()) == before
        assert conn.execute('SELECT COUNT(*) FROM pages WHERE job_id = ?', (job_id,)).fetchone()[0] == 1

    def test_a_name_of_exactly_the_limit_is_taken(self, client):
        api, conn = client
        name = 'y' * 196 + '.png'
        res = upload(api, [name], name='at the limit')
        assert res.status_code == 200, res.text
        assert page_order(conn, res.json()['job_id']) == [(name, None)]


class TestAZipOfScans:
    @staticmethod
    def zipped(names: list[str]) -> bytes:
        import zipfile
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, 'w') as zf:
            for name in names:
                zf.writestr(name, png_bytes() if not name.endswith('.pdf') else text_pdf([['a'], ['b']]))
            zf.writestr('__MACOSX/._scan_1.png', b'junk')
            zf.writestr('notes.docx', b'not a scan')
        return buf.getvalue()

    def test_its_scans_and_pdf_pages_become_pages_in_name_order(self, client):
        api, conn = client
        archive = self.zipped(['volume/scan_10.png', 'volume/scan_2.png', 'volume/letter.pdf'])
        res = api.post('/api/jobs', data={'name': 'zipped'}, headers=ADMIN,
                       files=[('files', ('volume.zip', archive, 'application/zip'))])

        assert res.status_code == 200, res.text
        assert [f for f, _ in page_order(conn, res.json()['job_id'])] == [
            'letter_p0001.png', 'letter_p0002.png', 'scan_2.png', 'scan_10.png']
