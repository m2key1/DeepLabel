"""Making a dataset or adding pages to one queues its phases, so it asks for the grants a
re-run of those phases asks for (D55). A refusal names the capability and writes nothing."""
import pytest
from fastapi.testclient import TestClient

from app import config, store
from app.deps import get_db
from app.main import app

SECRET = 'test-secret'
MEMBER = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'alice', 'X-Auth-Role': 'member'}
EVERY_PHASE = {**MEMBER, 'X-Auth-Caps': 'pipeline.layout pipeline.lines pipeline.ocr'}
NO_LAYOUT = {**MEMBER, 'X-Auth-Caps': 'pipeline.lines pipeline.ocr'}
NO_OCR = {**MEMBER, 'X-Auth-Caps': 'pipeline.layout pipeline.lines'}
PNG = b'\x89PNG\r\n\x1a\n'


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    monkeypatch.setattr('app.config.JOBS_DIR', tmp_path / 'jobs')
    conn = store.connect(tmp_path / 'app.db')
    conn.execute("INSERT INTO jobs (id, name, owner, status, run_layout, run_lines, run_ocr) "
                 "VALUES ('read', 'Read volume', 'alice', 'done', 0, 1, 1)")
    conn.execute("INSERT INTO jobs (id, name, owner, status, run_layout, run_lines, run_ocr) "
                 "VALUES ('unread', 'Unread volume', 'alice', 'done', 1, 1, 0)")
    conn.commit()
    app.dependency_overrides[get_db] = lambda: conn
    yield TestClient(app), conn
    app.dependency_overrides.clear()
    conn.close()


def create(api, headers, **phases):
    form = {'name': 'New volume', **{k: str(v).lower() for k, v in phases.items()}}
    return api.post('/api/jobs', headers=headers, data=form,
                    files=[('files', ('scan_1.png', PNG, 'image/png'))])


def append(api, job_id, headers):
    return api.post(f'/api/jobs/{job_id}/pages/upload', headers=headers,
                    files=[('files', ('scan_9.png', PNG, 'image/png'))])


def job_names(conn) -> list[str]:
    return [row['name'] for row in conn.execute('SELECT name FROM jobs ORDER BY name')]


def page_count(conn, job_id) -> int:
    return conn.execute('SELECT COUNT(*) FROM pages WHERE job_id = ?', (job_id,)).fetchone()[0]


class TestCreate:
    def test_a_phase_not_granted_is_refused_by_name_and_nothing_is_made(self, client):
        api, conn = client
        response = create(api, NO_LAYOUT, run_layout=True, run_lines=True, run_ocr=True)
        assert response.status_code == 403
        assert response.json()['detail'] == 'not permitted: pipeline.layout'
        assert job_names(conn) == ['Read volume', 'Unread volume']
        assert not config.JOBS_DIR.exists() or list(config.JOBS_DIR.iterdir()) == []

    def test_the_same_person_may_make_it_with_that_phase_off(self, client):
        api, conn = client
        response = create(api, NO_LAYOUT, run_layout=False, run_lines=True, run_ocr=True)
        assert response.status_code == 200
        job = store.get_job(conn, response.json()['job_id'])
        assert (job['run_layout'], job['run_lines'], job['run_ocr']) == (0, 1, 1)

    def test_reading_without_lines_never_runs_so_it_needs_no_grant(self, client):
        api, conn = client
        response = create(api, NO_OCR, run_layout=True, run_lines=False, run_ocr=True)
        assert response.status_code == 200
        job = store.get_job(conn, response.json()['job_id'])
        assert (job['run_layout'], job['run_lines'], job['run_ocr']) == (1, 0, 0)

    def test_every_phase_granted_is_let_through(self, client):
        api, conn = client
        response = create(api, EVERY_PHASE, run_layout=True, run_lines=True, run_ocr=True)
        assert response.status_code == 200
        assert job_names(conn) == ['New volume', 'Read volume', 'Unread volume']


class TestAppend:
    def test_adding_pages_to_a_dataset_that_reads_needs_the_reading_grant(self, client):
        api, conn = client
        response = append(api, 'read', NO_OCR)
        assert response.status_code == 403
        assert response.json()['detail'] == 'not permitted: pipeline.ocr'
        assert page_count(conn, 'read') == 0
        assert store.get_job(conn, 'read')['status'] == 'done'

    def test_a_phase_the_dataset_does_not_run_needs_no_grant(self, client):
        api, conn = client
        response = append(api, 'unread', NO_OCR)
        assert response.status_code == 200
        assert page_count(conn, 'unread') == 1
        assert store.get_job(conn, 'unread')['status'] == 'queued'
