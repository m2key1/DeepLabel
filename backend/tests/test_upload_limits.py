"""Datasets arrive as one multipart request holding a whole scanned volume, so the
API must not cap the file count - Starlette parses multipart with a 1000-file
default that the upload routes have to lift.
"""
import io

import pytest
from PIL import Image
from fastapi.testclient import TestClient

from app import config, ingest, store
from app.deps import get_db
from app.main import app

SECRET = 'test-secret'
EDITOR = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'alice', 'X-Auth-Role': 'member',
          'X-Auth-Caps': 'pipeline.layout pipeline.lines pipeline.ocr'}


def png_bytes() -> bytes:
    buf = io.BytesIO()
    Image.new('RGB', (2, 2), 'white').save(buf, 'PNG')
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


def test_more_than_a_thousand_files_upload_in_one_request(client):
    api, conn = client
    png = png_bytes()
    files = [('files', (f'{i:05d}.png', png, 'image/png')) for i in range(1001)]
    res = api.post('/api/jobs', data={'name': 'big'}, files=files, headers=EDITOR)
    assert res.status_code == 200, res.text
    job_id = res.json()['job_id']
    count = conn.execute('SELECT COUNT(*) FROM pages WHERE job_id = ?', (job_id,)).fetchone()[0]
    assert count == 1001


def test_appending_more_than_a_thousand_files_works_too(client):
    api, conn = client
    png = png_bytes()
    res = api.post('/api/jobs', data={'name': 'seed'},
                   files=[('files', ('first.png', png, 'image/png'))], headers=EDITOR)
    assert res.status_code == 200, res.text
    job_id = res.json()['job_id']
    conn.execute("UPDATE jobs SET status = 'done' WHERE id = ?", (job_id,))
    conn.commit()

    files = [('files', (f'more_{i:05d}.png', png, 'image/png')) for i in range(1001)]
    res = api.post(f'/api/jobs/{job_id}/pages/upload', files=files, headers=EDITOR)
    assert res.status_code == 200, res.text
    count = conn.execute('SELECT COUNT(*) FROM pages WHERE job_id = ?', (job_id,)).fetchone()[0]
    assert count == 1002


ADMIN = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'root', 'X-Auth-Role': 'admin'}


def job_folders(tmp_path) -> list[str]:
    jobs = tmp_path / 'jobs'
    return sorted(p.name for p in jobs.iterdir()) if jobs.exists() else []


@pytest.mark.parametrize('form', [
    {'task': 'map_segmentation', 'run_tile': 'true', 'tile_size': '100'},
    {'line_width': '0'},
    {'page_reading_order': 'sideways'},
    {'task': 'map_segmentation', 'model_id': 'no-such-model'},
])
def test_a_refused_upload_leaves_no_folder_behind(client, tmp_path, form):
    api, conn = client
    res = api.post('/api/jobs', data={'name': 'refused', **form},
                   files=[('files', ('a.png', png_bytes(), 'image/png'))], headers=EDITOR)

    assert res.status_code == 400, res.text
    assert conn.execute('SELECT COUNT(*) FROM jobs').fetchone()[0] == 0
    assert job_folders(tmp_path) == []


def test_an_accepted_upload_keeps_its_folder(client, tmp_path):
    """The other half of the test above, so an empty listing means nothing was left rather
    than that the folder is looked for in the wrong place."""
    api, conn = client
    res = api.post('/api/jobs', data={'name': 'kept'},
                   files=[('files', ('a.png', png_bytes(), 'image/png'))], headers=EDITOR)

    assert res.status_code == 200, res.text
    assert job_folders(tmp_path) == [res.json()['job_id']]


def test_a_refused_server_path_leaves_no_folder_behind(client, tmp_path):
    api, conn = client
    source = tmp_path / 'scans'
    source.mkdir()
    (source / 'a.png').write_bytes(png_bytes())

    res = api.post('/api/jobs/path', json={'name': 'refused', 'server_path': str(source),
                                           'line_width': 0}, headers=ADMIN)

    assert res.status_code == 400, res.text
    assert job_folders(tmp_path) == []


def test_an_append_whose_transcriptions_fail_keeps_none_of_its_uploads(client, monkeypatch):
    api, conn = client
    res = api.post('/api/jobs', data={'name': 'seed'},
                   files=[('files', ('first.png', png_bytes(), 'image/png'))], headers=EDITOR)
    job_id = res.json()['job_id']
    conn.execute("UPDATE jobs SET status = 'done' WHERE id = ?", (job_id,))
    conn.commit()
    uploads = config.job_dir(job_id) / 'uploads'
    before = sorted(p.name for p in uploads.iterdir())

    def unreadable(*args, **kwargs):
        raise ingest.IngestError('broken.pdf: no text layer could be read')
    monkeypatch.setattr(ingest, 'ground_truth_texts', unreadable)
    res = api.post(f'/api/jobs/{job_id}/pages/upload',
                   files=[('files', ('second.png', png_bytes(), 'image/png'))], headers=EDITOR)

    assert res.status_code == 400, res.text
    assert len(before) == 1
    assert sorted(p.name for p in uploads.iterdir()) == before
    assert conn.execute('SELECT COUNT(*) FROM pages WHERE job_id = ?', (job_id,)).fetchone()[0] == 1


def test_a_dataset_whose_creation_breaks_part_way_is_not_kept(client, tmp_path, monkeypatch):
    """A failure after the dataset row is written must take the row with it, or the worker
    picks up a dataset its creator was told had failed."""
    api, _ = client
    def broken(*_args):
        raise RuntimeError('the corpus could not be stored')
    monkeypatch.setattr('app.corpus.store_documents', broken)

    res = TestClient(app, raise_server_exceptions=False).post(
        '/api/jobs', data={'name': 'half made'},
        files=[('files', ('a.png', png_bytes(), 'image/png'))], headers=EDITOR)

    assert res.status_code == 500
    other = store.connect(tmp_path / 'app.db')
    assert other.execute('SELECT COUNT(*) FROM jobs').fetchone()[0] == 0
    other.close()


class TestHeldUpload:
    """A volume too large for one request arrives in batches: the dataset waits as
    'uploading', so the queue never starts it on part of its pages."""

    def create_held(self, api):
        png = png_bytes()
        res = api.post('/api/jobs', data={'name': 'volume', 'hold': 'true'},
                       files=[('files', ('p_001.png', png, 'image/png'))], headers=EDITOR)
        assert res.status_code == 200, res.text
        return res.json()['job_id']

    def status(self, conn, job_id):
        return conn.execute('SELECT status FROM jobs WHERE id = ?', (job_id,)).fetchone()['status']

    def test_a_held_dataset_waits_while_batches_are_added(self, client):
        api, conn = client
        job_id = self.create_held(api)
        assert self.status(conn, job_id) == 'uploading'

        res = api.post(f'/api/jobs/{job_id}/pages/upload', headers=EDITOR,
                       files=[('files', ('p_002.png', png_bytes(), 'image/png'))])

        assert res.status_code == 200, res.text
        assert self.status(conn, job_id) == 'uploading'
        assert conn.execute('SELECT COUNT(*) c FROM pages WHERE job_id = ?', (job_id,)).fetchone()['c'] == 2

    def test_starting_it_queues_it_once(self, client):
        api, conn = client
        job_id = self.create_held(api)

        assert api.post(f'/api/jobs/{job_id}/start', headers=EDITOR).status_code == 200
        assert self.status(conn, job_id) == 'queued'
        again = api.post(f'/api/jobs/{job_id}/start', headers=EDITOR)
        assert again.status_code == 409
        assert self.status(conn, job_id) == 'queued'

    def test_only_its_owner_starts_it(self, client):
        api, conn = client
        job_id = self.create_held(api)
        bob = {**EDITOR, 'X-Auth-User': 'bob'}

        assert api.post(f'/api/jobs/{job_id}/start', headers=bob).status_code in (403, 404)
        assert self.status(conn, job_id) == 'uploading'

    def test_a_dataset_created_without_hold_is_queued_at_once(self, client):
        api, conn = client
        res = api.post('/api/jobs', data={'name': 'small'}, headers=EDITOR,
                       files=[('files', ('p.png', png_bytes(), 'image/png'))])
        assert self.status(conn, res.json()['job_id']) == 'queued'

    def test_answers_from_language_models_do_not_start_it(self, client):
        from app import llm_gt
        api, conn = client
        job_id = self.create_held(api)

        llm_gt._realign(conn, job_id)

        assert self.status(conn, job_id) == 'uploading'
