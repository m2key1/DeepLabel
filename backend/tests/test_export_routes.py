"""Getting a dataset back out: the four download formats, and the COCO layout export that
writes to the server rather than to the browser. What comes back has to be the reviewed
subset when that was asked for - an export nobody can trust the scope of is worth nothing.
"""
import io
import json
import zipfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app import imports, store
from app.deps import get_db
from app.main import app

SECRET = 'test-secret'
ADMIN = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'root', 'X-Auth-Role': 'admin'}
ALICE = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'alice', 'X-Auth-Role': 'member'}
BOB = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'bob', 'X-Auth-Role': 'member'}

POLY = '[[0,0],[1,0],[1,1],[0,1]]'


@pytest.fixture
def scan(tmp_path):
    """A real file: the COCO export copies the images it lists."""
    path = tmp_path / 'p1.png'
    Image.new('RGB', (120, 60), 'white').save(path)
    return path


@pytest.fixture
def conn(tmp_path, scan):
    connection = store.connect(tmp_path / 'app.db')
    connection.executescript(f"""
        INSERT INTO jobs (id, name, owner, status) VALUES ('j1', 'Volume I', 'alice', 'done');
        INSERT INTO pages (id, job_id, idx, filename, source_file, status, layout_checked,
                           content_hash, width, height)
            VALUES (1, 'j1', 0, 'p1.png', '{scan}', 'done', 1, 'hash-of-p1', 120, 60);
        INSERT INTO elements (id, page_id, order_idx, class_name, bbox, kind)
            VALUES (1, 1, 0, 'Paragraph', '[0,0,1,1]', 'content');
        INSERT INTO lines (id, element_id, order_idx, polygon, text, corrected_text, checked)
            VALUES (1, 1, 0, '{POLY}', 'Reviewed line', 'Reviewed line', 1),
                   (2, 1, 1, '{POLY}', 'Unreviewed line', NULL, 0);
    """)
    connection.commit()
    yield connection
    connection.close()


@pytest.fixture
def client(conn, tmp_path, monkeypatch):
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    monkeypatch.setattr('app.config.COCO_EXPORT_DIR', tmp_path / 'coco')
    app.dependency_overrides[get_db] = lambda: conn
    yield TestClient(app)
    app.dependency_overrides.clear()


def download(client, fmt='json', checked_only=False, headers=ALICE, job_id='j1'):
    return client.get(f'/api/jobs/{job_id}/export',
                      params={'format': fmt, 'checked_only': checked_only}, headers=headers)


class TestFormats:
    def test_json_carries_the_lines_and_says_it_is_json(self, client):
        response = download(client)

        assert response.status_code == 200
        assert response.headers['content-type'].startswith('application/json')
        assert 'Reviewed line' in json.dumps(response.json())

    def test_json_says_which_way_up_each_page_is(self, client, conn):
        """The transcript draws every scan from this list, and renditions and tiles are
        served immutable: a turned page is asked for under its turn or the browser keeps
        handing back the way up from before."""
        conn.execute('UPDATE pages SET rotation = 90 WHERE id = 1')
        conn.commit()

        pages = download(client).json()['pages']

        assert [(page['id'], page['rotation']) for page in pages] == [(1, 90)]

    def test_markdown_comes_back_as_markdown(self, client):
        response = download(client, 'md')

        assert response.headers['content-type'].startswith('text/markdown')
        assert 'Reviewed line' in response.text

    def test_plain_text_is_the_transcription_and_nothing_else(self, client):
        response = download(client, 'txt')

        assert response.headers['content-type'].startswith('text/plain')
        assert 'Reviewed line' in response.text

    def test_zip_comes_back_as_a_readable_archive(self, client, tmp_path):
        response = download(client, 'zip')

        assert response.headers['content-type'].startswith('application/zip')
        archive = tmp_path / 'out.zip'
        archive.write_bytes(response.content)
        with zipfile.ZipFile(archive) as z:
            assert z.namelist(), 'the archive has something in it'
            assert z.testzip() is None

    def test_the_zip_carries_its_scans_and_imports_back(self, client, scan):
        response = download(client, 'zip')

        archive = zipfile.ZipFile(io.BytesIO(response.content))
        assert archive.read('images/p1.png') == scan.read_bytes()
        pages = imports.read_export_zip(io.BytesIO(response.content))
        assert [(p['image'], p['image_member'], p['width'], p['height']) for p in pages] == \
            [('p1.png', 'images/p1.png', 120, 60)]

    def test_a_format_nobody_offers_is_refused_with_the_list(self, client):
        response = download(client, 'pdf')

        assert response.status_code == 400
        assert 'json' in response.json()['detail']


class TestScope:
    def test_the_whole_dataset_comes_back_by_default(self, client):
        assert 'Unreviewed line' in download(client, 'txt').text

    def test_asking_for_the_reviewed_subset_leaves_the_rest_out(self, client):
        body = download(client, 'txt', checked_only=True).text

        assert 'Reviewed line' in body
        assert 'Unreviewed line' not in body

    def test_the_filename_says_which_of_the_two_it_is(self, client):
        whole = download(client)
        reviewed = download(client, checked_only=True)

        assert 'Volume I.json' in whole.headers['content-disposition']
        assert 'Volume I-reviewed.json' in reviewed.headers['content-disposition']

    def test_a_quote_in_the_name_cannot_break_out_of_the_header(self, client, conn):
        conn.execute("""UPDATE jobs SET name = 'A "quoted" volume' WHERE id = 'j1'""")
        conn.commit()

        disposition = download(client).headers['content-disposition']

        assert disposition == 'attachment; filename="A quoted volume.json"'

    def test_a_name_beyond_latin_1_downloads_under_its_own_name(self, client, conn):
        """Headers travel as Latin-1, so the real name goes in filename* and an ASCII
        stand-in in filename for clients that do not read it."""
        conn.execute("UPDATE jobs SET name = 'Księga – Briefe' WHERE id = 'j1'")
        conn.commit()

        response = download(client, 'txt')

        assert response.status_code == 200
        assert response.headers['content-disposition'] == (
            'attachment; filename="Ksiega _ Briefe.txt"; '
            "filename*=UTF-8''Ksi%C4%99ga%20%E2%80%93%20Briefe.txt")


class TestReviewedOnly:
    @pytest.fixture
    def unreviewed_page(self, conn, scan):
        conn.executescript(f"""
            INSERT INTO pages (id, job_id, idx, filename, source_file, status, width, height)
                VALUES (2, 'j1', 1, 'p2.png', '{scan}', 'done', 120, 60);
            INSERT INTO elements (id, page_id, order_idx, class_name, bbox, kind)
                VALUES (2, 2, 0, 'Paragraph', '[0,0,1,1]', 'content');
            INSERT INTO lines (id, element_id, order_idx, polygon, text, checked)
                VALUES (3, 2, 0, '{POLY}', 'Nobody looked at this', 0);
        """)
        conn.commit()

    def test_text_holds_only_what_was_reviewed(self, client, unreviewed_page):
        assert download(client, 'txt', checked_only=True).text == 'Reviewed line'

    def test_markdown_names_only_the_pages_with_something_reviewed(self, client, unreviewed_page):
        body = download(client, 'md', checked_only=True).text

        assert 'p1.png' in body
        assert 'p2.png' not in body

    def test_json_lists_only_the_pages_with_something_reviewed(self, client, unreviewed_page):
        pages = download(client, 'json', checked_only=True).json()['pages']

        assert [p['filename'] for p in pages] == ['p1.png']

    def test_the_archive_holds_no_file_for_a_page_with_nothing_reviewed(self, client, unreviewed_page):
        response = download(client, 'zip', checked_only=True)

        names = zipfile.ZipFile(io.BytesIO(response.content)).namelist()
        assert sorted(names) == ['images/p1.png', 'job.json', 'pages/page_0001.json', 'pages/page_0001.md']

    def test_the_whole_export_still_keeps_every_page(self, client, unreviewed_page):
        pages = download(client, 'json').json()['pages']

        assert [p['filename'] for p in pages] == ['p1.png', 'p2.png']


class TestWhoMayExport:
    def test_a_stranger_is_not_told_the_dataset_exists(self, client):
        assert download(client, headers=BOB).status_code == 404
        assert download(client, headers=ALICE).status_code == 200

    def test_someone_it_was_shared_with_may_export_it(self, client, conn):
        conn.execute("INSERT INTO job_assignees (job_id, username) VALUES ('j1', 'bob')")
        conn.commit()

        assert download(client, headers=BOB).status_code == 200

    def test_a_dataset_that_does_not_exist_is_a_404(self, client):
        assert download(client, headers=ADMIN, job_id='nope').status_code == 404


class TestCoco:
    def test_the_preview_says_what_would_be_written_and_where(self, client):
        response = client.get('/api/jobs/j1/coco', headers=ALICE)

        assert response.status_code == 200
        body = response.json()
        assert body['pages'] == 1
        assert body['dest'].endswith('volume-i')

    def test_the_preview_writes_nothing(self, client, tmp_path):
        client.get('/api/jobs/j1/coco', headers=ALICE)

        assert not (tmp_path / 'coco').exists()

    def test_exporting_writes_the_dataset_where_the_preview_said(self, client):
        preview = client.get('/api/jobs/j1/coco', headers=ADMIN).json()

        response = client.post('/api/jobs/j1/coco', headers=ADMIN)

        assert response.status_code == 200
        assert response.json()['dest'] == preview['dest']
        assert Path(preview['dest']).exists()

    def test_a_dataset_with_no_finished_layout_has_nothing_to_export(self, client, conn):
        conn.execute('UPDATE pages SET layout_checked = 0')
        conn.commit()

        response = client.post('/api/jobs/j1/coco', headers=ADMIN)

        assert response.status_code == 400
        assert 'layout complete' in response.json()['detail']

    def test_writing_the_export_is_an_admins_job(self, client):
        assert client.post('/api/jobs/j1/coco', headers=ALICE).status_code == 403
        assert client.post('/api/jobs/j1/coco', headers=ADMIN).status_code == 200

    def test_previewing_a_dataset_that_does_not_exist_is_a_404(self, client):
        assert client.get('/api/jobs/nope/coco', headers=ADMIN).status_code == 404
        assert client.post('/api/jobs/nope/coco', headers=ADMIN).status_code == 404


class TestRoundTrip:
    """What any of the archive formats exports, the import reads back into a new dataset -
    the scans, the regions and lines, their text and which lines were checked."""

    @pytest.mark.parametrize('fmt', ['zip', 'page', 'alto', 'hocr', 'tei'])
    def test_an_export_imports_back_as_the_same_dataset(self, client, conn, tmp_path, monkeypatch, fmt):
        monkeypatch.setattr('app.config.JOBS_DIR', tmp_path / 'jobs')
        conn.execute("UPDATE elements SET class_name = 'Kopfzeile' WHERE id = 1")
        conn.commit()
        exported = download(client, fmt)
        assert exported.status_code == 200, exported.text

        imported = client.post('/api/jobs/import', data={'name': f'Back from {fmt}', 'reviewed': 'false'},
                               files={'file': (f'volume.{fmt}.zip', exported.content, 'application/zip')},
                               headers=ALICE)

        assert imported.status_code == 200, imported.text
        job_id = imported.json()['job_id']
        rows = conn.execute(
            'SELECT e.class_name, l.text, l.corrected_text, l.checked FROM lines l '
            'JOIN elements e ON l.element_id = e.id JOIN pages p ON e.page_id = p.id '
            'WHERE p.job_id = ? ORDER BY e.order_idx, l.order_idx', (job_id,)).fetchall()
        texts = [r['corrected_text'] or r['text'] for r in rows]
        assert texts == ['Reviewed line', 'Unreviewed line']
        assert {r['class_name'] for r in rows} == {'Kopfzeile'}
        # ALTO has no place to say a line was checked; the others carry it.
        expected = [False, False] if fmt == 'alto' else [True, False]
        assert [bool(r['checked']) for r in rows] == expected
        page = conn.execute('SELECT filename, width, height FROM pages WHERE job_id = ?', (job_id,)).fetchone()
        assert tuple(page) == ('p1.png', 120, 60)

    def test_a_zip_of_scans_alone_is_told_to_go_up_as_pages(self, client, tmp_path, monkeypatch, scan):
        monkeypatch.setattr('app.config.JOBS_DIR', tmp_path / 'jobs')
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, 'w') as zf:
            zf.write(scan, 'scans/p1.png')

        response = client.post('/api/jobs/import', data={'name': 'Scans'},
                               files={'file': ('scans.zip', archive.getvalue(), 'application/zip')}, headers=ALICE)

        assert response.status_code == 422
        assert 'upload it as pages' in response.json()['detail']
