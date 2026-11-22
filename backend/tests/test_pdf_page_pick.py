"""A PDF's pages picked in the New job wizard: only those become pages of the dataset, under
their own page numbers, so the scan each one is rendered from is the page that was picked (#46)."""
import json
import shutil

import pytest
from fastapi.testclient import TestClient

from app import store
from app.deps import get_db
from app.main import app
from tests.pdfs import text_pdf

pytestmark = pytest.mark.skipif(shutil.which('pdfinfo') is None, reason='needs poppler')

SECRET = 'test-secret'
ADMIN = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'alice', 'X-Auth-Role': 'admin'}
VOLUME = [[f'Seite {n}'] for n in range(1, 6)]


@pytest.fixture
def api(tmp_path, monkeypatch):
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    monkeypatch.setattr('app.config.JOBS_DIR', tmp_path / 'jobs')
    conn = store.connect(tmp_path / 'app.db')
    app.dependency_overrides[get_db] = lambda: conn
    yield TestClient(app), conn
    app.dependency_overrides.clear()
    conn.close()


def upload(client, **form):
    return client.post('/api/jobs', headers=ADMIN, data={'name': 'Volume', 'run_layout': 'false', **form},
                       files=[('files', ('volume.pdf', text_pdf(VOLUME), 'application/pdf')),
                              ('files', ('cover.png', b'\x89PNG', 'image/png'))])


def pages_of(conn, job_id):
    return [(row['filename'], row['source_page']) for row in conn.execute(
        'SELECT filename, source_page FROM pages WHERE job_id = ? AND source_pdf IS NOT NULL ORDER BY idx', (job_id,))]


def test_only_the_picked_pages_of_a_pdf_become_pages(api):
    client, conn = api
    response = upload(client, pdf_pages=json.dumps({'volume.pdf': [2, 4, 5]}))
    assert response.status_code == 200, response.text
    assert pages_of(conn, response.json()['job_id']) == [
        ('volume_p0002.png', 2), ('volume_p0004.png', 4), ('volume_p0005.png', 5)]


def test_a_pdf_named_in_no_pick_is_taken_whole(api):
    client, conn = api
    response = upload(client)
    assert response.status_code == 200, response.text
    assert [page for _, page in pages_of(conn, response.json()['job_id'])] == [1, 2, 3, 4, 5]


@pytest.mark.parametrize('picked', ['not json', json.dumps(['volume.pdf']), json.dumps({'volume.pdf': [0]}),
                                    json.dumps({'volume.pdf': [6]}), json.dumps({'volume.pdf': []})])
def test_a_pick_that_names_no_page_of_the_pdf_is_refused(api, picked):
    client, conn = api
    response = upload(client, pdf_pages=picked)
    assert response.status_code == 400
    assert conn.execute('SELECT COUNT(*) n FROM jobs').fetchone()['n'] == 0
