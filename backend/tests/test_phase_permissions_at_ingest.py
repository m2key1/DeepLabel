"""Making a dataset or adding pages to one runs its phases without a grant being asked for:
running the models on what someone makes or adds is part of making it (#131, decision 318).
Only a Viewer, who writes nothing, is refused - and then nothing is made."""
import pytest
from fastapi.testclient import TestClient

from app import config, store
from app.deps import get_db
from app.main import app

SECRET = 'test-secret'
ANNOTATOR = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'alice', 'X-Auth-Role': 'annotator', 'X-Auth-Caps': ''}
VIEWER = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'vera', 'X-Auth-Role': 'viewer', 'X-Auth-Caps': ''}
PNG = b'\x89PNG\r\n\x1a\n'


@pytest.fixture
def client(tmp_path, monkeypatch):
    """Bob's two volumes, both shared with Alice."""
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    monkeypatch.setattr('app.config.JOBS_DIR', tmp_path / 'jobs')
    conn = store.connect(tmp_path / 'app.db')
    conn.executescript("""
        INSERT INTO jobs (id, name, owner, status, run_layout, run_lines, run_ocr)
            VALUES ('read', 'Read volume', 'bob', 'done', 0, 1, 1),
                   ('unread', 'Unread volume', 'bob', 'done', 1, 1, 0);
        INSERT INTO job_assignees (job_id, username) VALUES ('read', 'alice'), ('unread', 'alice');
    """)
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
    def test_an_annotator_makes_a_dataset_that_runs_every_phase(self, client):
        api, conn = client
        response = create(api, ANNOTATOR, run_layout=True, run_lines=True, run_ocr=True)
        assert response.status_code == 200, response.text
        job = store.get_job(conn, response.json()['job_id'])
        assert (job['owner'], job['run_layout'], job['run_lines'], job['run_ocr']) == ('alice', 1, 1, 1)

    def test_reading_without_lines_never_runs(self, client):
        api, conn = client
        response = create(api, ANNOTATOR, run_layout=True, run_lines=False, run_ocr=True)
        assert response.status_code == 200
        job = store.get_job(conn, response.json()['job_id'])
        assert (job['run_layout'], job['run_lines'], job['run_ocr']) == (1, 0, 0)

    def test_a_viewer_makes_nothing(self, client):
        api, conn = client
        response = create(api, VIEWER, run_layout=True, run_lines=True, run_ocr=True)
        assert response.status_code == 403
        assert response.json()['detail'] == 'read-only account'
        assert job_names(conn) == ['Read volume', 'Unread volume']
        assert not config.JOBS_DIR.exists() or list(config.JOBS_DIR.iterdir()) == []


class TestAppend:
    @pytest.mark.parametrize('job_id', ['read', 'unread'])
    def test_an_annotator_adds_pages_to_a_dataset_they_were_given(self, client, job_id):
        api, conn = client
        response = append(api, job_id, ANNOTATOR)
        assert response.status_code == 200, response.text
        assert page_count(conn, job_id) == 1
        assert store.get_job(conn, job_id)['status'] == 'queued'
