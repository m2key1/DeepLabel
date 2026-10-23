"""A PDF's own text layer as ground truth: opt-in, page-accurate, and inherited by appends.

The text layer is only trustworthy when the user says it is - a scanned PDF carries some
other OCR system's output, which must never enter the corpus as ground truth by default.
So the flag gates it, and a sidecar .txt outranks it wherever both exist.
"""
import io

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app import pdf, store
from app.deps import get_db
from app.main import app
from tests.pdfs import text_pdf

SECRET = 'test-secret'
ADMIN = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'alice', 'X-Auth-Role': 'admin'}

PAGES = [
    ['Pfarre Wien', 'Kaplan Huber'],
    ['Pfarre Graz', 'Kaplan Gruber'],
]


@pytest.fixture
def api(tmp_path, monkeypatch):
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    monkeypatch.setattr('app.config.JOBS_DIR', tmp_path / 'jobs')
    conn = store.connect(tmp_path / 'app.db')
    app.dependency_overrides[get_db] = lambda: conn
    yield TestClient(app), conn
    app.dependency_overrides.clear()
    conn.close()


def upload(client, name: str, pdf_bytes: bytes, **form):
    return client.post('/api/jobs', headers=ADMIN,
                       data={'name': name, 'run_layout': 'false', **form},
                       files=[('files', ('schematismus.pdf', pdf_bytes, 'application/pdf'))])


def page_gt(conn, job_id: str) -> dict[str, str | None]:
    return {row['filename']: row['gt_text'] for row in conn.execute(
        'SELECT filename, gt_text FROM pages WHERE job_id = ? ORDER BY idx', (job_id,))}


def page_sources(conn, job_id: str) -> dict[str, str | None]:
    return {row['filename']: row['gt_source'] for row in conn.execute(
        'SELECT filename, gt_source FROM pages WHERE job_id = ? ORDER BY idx', (job_id,))}


class TestCreateFromUpload:
    def test_text_layer_lands_on_the_right_page(self, api):
        client, conn = api
        response = upload(client, 'pdf gt', text_pdf(PAGES), gt_from_pdf='true')
        assert response.status_code == 200
        gt = page_gt(conn, response.json()['job_id'])

        assert set(page_sources(conn, response.json()['job_id']).values()) == {'pdf'}
        assert list(gt) == ['schematismus_p0001.png', 'schematismus_p0002.png']
        assert 'Pfarre Wien' in gt['schematismus_p0001.png']
        assert 'Kaplan Huber' in gt['schematismus_p0001.png']
        # Page two's text must not bleed into page one, which a whole-document
        # extraction split on the wrong boundary would do.
        assert 'Pfarre Graz' not in gt['schematismus_p0001.png']
        assert 'Pfarre Graz' in gt['schematismus_p0002.png']

    def test_the_flag_is_required(self, api):
        client, conn = api
        response = upload(client, 'pdf no gt', text_pdf(PAGES))
        assert response.status_code == 200
        assert set(page_gt(conn, response.json()['job_id']).values()) == {None}

    def test_a_pdf_without_a_text_layer_is_not_an_error(self, api):
        client, conn = api
        response = upload(client, 'pdf empty', text_pdf([[], []]), gt_from_pdf='true')
        assert response.status_code == 200
        assert set(page_gt(conn, response.json()['job_id']).values()) == {None}

    def test_the_setting_is_remembered_on_the_job(self, api):
        client, conn = api
        job_id = upload(client, 'pdf remembered', text_pdf(PAGES), gt_from_pdf='true').json()['job_id']
        assert conn.execute('SELECT gt_from_pdf FROM jobs WHERE id = ?', (job_id,)).fetchone()[0] == 1

    def test_a_sidecar_txt_outranks_the_text_layer(self, api):
        """Both name the same page; the hand-written file is the deliberate one."""
        client, conn = api
        response = client.post('/api/jobs', headers=ADMIN,
                               data={'name': 'pdf vs sidecar', 'run_layout': 'false',
                                     'gt_from_pdf': 'true'},
                               files=[
                                   ('files', ('schematismus.pdf', text_pdf(PAGES), 'application/pdf')),
                                   ('files', ('schematismus_p0001.txt', b'Hand typed', 'text/plain')),
                               ])
        job_id = response.json()['job_id']
        gt = page_gt(conn, job_id)
        assert gt['schematismus_p0001.png'] == 'Hand typed'
        assert 'Pfarre Graz' in gt['schematismus_p0002.png']  # untouched by the sidecar
        # Provenance follows the winner, so the alignment phase knows which page it
        # may auto-check and which it may not.
        assert page_sources(conn, job_id) == {
            'schematismus_p0001.png': 'sidecar', 'schematismus_p0002.png': 'pdf',
        }


class TestCreateFromPath:
    def test_text_layer_is_read_from_the_directory(self, api, tmp_path):
        client, conn = api
        source = tmp_path / 'scans'
        source.mkdir()
        (source / 'volume.pdf').write_bytes(text_pdf(PAGES))

        response = client.post('/api/jobs/path', headers=ADMIN, json={
            'name': 'path pdf gt', 'server_path': str(source),
            'run_layout': False, 'gt_from_pdf': True,
        })
        assert response.status_code == 200
        gt = page_gt(conn, response.json()['job_id'])
        assert 'Pfarre Wien' in gt['volume_p0001.png']
        assert 'Pfarre Graz' in gt['volume_p0002.png']

    def test_a_txt_beside_a_pdf_is_a_corpus_document_as_in_an_upload(self, api, tmp_path):
        """A PDF's pages are named volume_p0001 and on, so volume.txt transcribes none of
        them: it is a document of the corpus, whichever way the files arrived."""
        client, conn = api
        text = 'Pfarre Wien\nKaplan Huber\n'
        source = tmp_path / 'scans'
        source.mkdir()
        (source / 'volume.pdf').write_bytes(text_pdf(PAGES))
        (source / 'volume.txt').write_text(text)

        uploaded = client.post('/api/jobs', headers=ADMIN, data={'name': 'upload', 'run_layout': 'false'},
                               files=[('files', ('volume.pdf', text_pdf(PAGES), 'application/pdf')),
                                      ('files', ('volume.txt', text.encode(), 'text/plain'))])
        from_path = client.post('/api/jobs/path', headers=ADMIN, json={
            'name': 'path', 'server_path': str(source), 'run_layout': False,
        })

        for origin, response in (('upload', uploaded), ('path', from_path)):
            assert response.status_code == 200
            assert (origin, response.json()['documents']) == (origin, 1)
            job_id = response.json()['job_id']
            assert [tuple(row) for row in conn.execute(
                'SELECT name, text FROM job_documents WHERE job_id = ?', (job_id,))] == [('volume', text)]
            assert page_gt(conn, job_id) == {'volume_p0001.png': None, 'volume_p0002.png': None}


class TestAppendInheritsTheSetting:
    def test_appended_pdf_pages_get_their_text_layer(self, api):
        client, conn = api
        job_id = upload(client, 'pdf append', text_pdf(PAGES), gt_from_pdf='true').json()['job_id']
        conn.execute("UPDATE jobs SET status = 'done' WHERE id = ?", (job_id,))
        conn.commit()

        response = client.post(f'/api/jobs/{job_id}/pages/upload', headers=ADMIN, files=[
            ('files', ('anhang.pdf', text_pdf([['Pfarre Linz']]), 'application/pdf')),
        ])
        assert response.status_code == 200
        assert 'Pfarre Linz' in page_gt(conn, job_id)['anhang_p0001.png']

    def test_a_dataset_that_declined_keeps_declining(self, api):
        client, conn = api
        job_id = upload(client, 'pdf append off', text_pdf(PAGES)).json()['job_id']
        conn.execute("UPDATE jobs SET status = 'done' WHERE id = ?", (job_id,))
        conn.commit()

        client.post(f'/api/jobs/{job_id}/pages/upload', headers=ADMIN, files=[
            ('files', ('anhang.pdf', text_pdf([['Pfarre Linz']]), 'application/pdf')),
        ])
        assert page_gt(conn, job_id)['anhang_p0001.png'] is None

    def test_a_second_copy_of_a_pdf_leaves_the_first_ones_text_alone(self, api):
        """The re-appended pages share their filenames with the first copy's, which must
        keep the text its own text layer gave it."""
        client, conn = api
        job_id = upload(client, 'pdf again', text_pdf(PAGES), gt_from_pdf='true').json()['job_id']
        conn.execute("UPDATE jobs SET status = 'done' WHERE id = ?", (job_id,))
        conn.commit()

        client.post(f'/api/jobs/{job_id}/pages/upload', headers=ADMIN, files=[
            ('files', ('schematismus.pdf', text_pdf([['Pfarre Linz']]), 'application/pdf')),
        ])
        texts = [(row['filename'], row['gt_text']) for row in conn.execute(
            'SELECT filename, gt_text FROM pages WHERE job_id = ? ORDER BY idx', (job_id,))]
        assert [filename for filename, _ in texts] == [
            'schematismus_p0001.png', 'schematismus_p0002.png', 'schematismus_p0001.png']
        assert 'Pfarre Wien' in texts[0][1] and 'Linz' not in texts[0][1]
        assert 'Pfarre Linz' in texts[2][1]

    def test_a_refused_append_takes_back_every_file_it_wrote(self, api, tmp_path, monkeypatch):
        """An image beside a PDF whose text layer cannot be read: both uploads go again,
        and what the dataset was created from stays."""
        client, conn = api
        job_id = upload(client, 'pdf refused', text_pdf(PAGES), gt_from_pdf='true').json()['job_id']
        conn.execute("UPDATE jobs SET status = 'done' WHERE id = ?", (job_id,))
        conn.commit()

        def unreadable(_path):
            raise pdf.PdfError('text layer is damaged')

        monkeypatch.setattr(pdf, 'page_texts', unreadable)
        scan = io.BytesIO()
        Image.new('RGB', (8, 8), 'white').save(scan, 'PNG')
        response = client.post(f'/api/jobs/{job_id}/pages/upload', headers=ADMIN, files=[
            ('files', ('anhang.pdf', text_pdf([['Pfarre Linz']]), 'application/pdf')),
            ('files', ('beilage.png', scan.getvalue(), 'image/png')),
        ])

        assert response.status_code == 400
        assert response.json()['detail'] == '00002_anhang.pdf: text layer is damaged'
        uploads = tmp_path / 'jobs' / job_id / 'uploads'
        assert sorted(p.name for p in uploads.iterdir()) == ['00000_schematismus.pdf']
