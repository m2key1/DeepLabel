import pytest
from fastapi.testclient import TestClient

from app import store
from app.deps import get_db
from app.main import app

SECRET = 'test-secret'
OWNER = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'alice', 'X-Auth-Role': 'member'}
SHARED = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'bob', 'X-Auth-Role': 'member'}
STRANGER = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'carol', 'X-Auth-Role': 'member'}
VIEWER = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'vera', 'X-Auth-Role': 'viewer'}


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    monkeypatch.setattr('app.config.JOBS_DIR', tmp_path / 'jobs')
    conn = store.connect(tmp_path / 'app.db')
    conn.executescript("""
        INSERT INTO jobs (id, name, owner, status) VALUES ('j1', 'Zollbuecher', 'alice', 'done');
        INSERT INTO job_assignees (job_id, username) VALUES ('j1', 'bob'), ('j1', 'vera');
        INSERT INTO pages (id, job_id, idx, filename, source_file, status) VALUES
            (1, 'j1', 0, 'a.png', '/a.png', 'done'), (2, 'j1', 1, 'b.png', '/b.png', 'done');
    """)
    conn.commit()
    app.dependency_overrides[get_db] = lambda: conn
    yield TestClient(app), conn
    app.dependency_overrides.clear()
    conn.close()


class TestDatasetNote:
    def test_anyone_who_may_edit_writes_it_and_it_says_who(self, client):
        api, _ = client
        response = api.put('/api/jobs/j1/note', json={'text': '  Pages 1-40 checked.  '}, headers=SHARED)

        assert response.status_code == 200, response.text
        note = response.json()
        assert (note['text'], note['by']) == ('Pages 1-40 checked.', 'bob')
        assert note['at']
        job = api.get('/api/jobs/j1', params={'pages': 'false'}, headers=OWNER).json()
        assert job['note'] == note
        listed = next(j for j in api.get('/api/jobs', headers=OWNER).json() if j['id'] == 'j1')
        assert listed['note'] == note
        assert 'note_by' not in listed

    def test_an_empty_text_removes_it(self, client):
        api, _ = client
        api.put('/api/jobs/j1/note', json={'text': 'x'}, headers=OWNER)

        assert api.put('/api/jobs/j1/note', json={'text': '   '}, headers=OWNER).json() is None
        assert api.get('/api/jobs/j1', params={'pages': 'false'}, headers=OWNER).json()['note'] is None

    def test_a_viewer_reads_but_cannot_write(self, client):
        api, _ = client
        api.put('/api/jobs/j1/note', json={'text': 'x'}, headers=OWNER)

        assert api.put('/api/jobs/j1/note', json={'text': 'y'}, headers=VIEWER).status_code == 403
        assert api.get('/api/jobs/j1', params={'pages': 'false'}, headers=VIEWER).json()['note']['text'] == 'x'

    def test_someone_without_access_gets_404(self, client):
        api, _ = client
        assert api.put('/api/jobs/j1/note', json={'text': 'x'}, headers=STRANGER).status_code == 404

    def test_a_note_has_a_length_limit(self, client):
        api, _ = client
        assert api.put('/api/jobs/j1/note', json={'text': 'x' * 10_001}, headers=OWNER).status_code == 422


class TestPageNote:
    def test_it_shows_on_the_page_and_its_row(self, client):
        api, _ = client
        response = api.put('/api/pages/2/note', json={'text': 'Marginalia not transcribed.'}, headers=SHARED)

        assert response.status_code == 200, response.text
        note = response.json()
        assert (note['text'], note['by']) == ('Marginalia not transcribed.', 'bob')
        assert api.get('/api/jobs/j1/pages/2', headers=OWNER).json()['note'] == note
        rows = api.get('/api/jobs/j1/page-rows', headers=OWNER).json()
        assert [r['note'] for r in rows['rows']] == [None, note]
        assert rows['counts']['has-note'] == 1
        filtered = api.get('/api/jobs/j1/page-rows', params={'filter': 'has-note'}, headers=OWNER).json()
        assert [r['id'] for r in filtered['rows']] == [2]

    def test_an_empty_text_removes_it(self, client):
        api, _ = client
        api.put('/api/pages/2/note', json={'text': 'x'}, headers=OWNER)

        api.put('/api/pages/2/note', json={'text': ''}, headers=OWNER)

        assert api.get('/api/jobs/j1/pages/2', headers=OWNER).json()['note'] is None
        assert api.get('/api/jobs/j1/page-rows', headers=OWNER).json()['counts']['has-note'] == 0

    def test_a_viewer_and_a_stranger_cannot_write(self, client):
        api, _ = client
        assert api.put('/api/pages/2/note', json={'text': 'x'}, headers=VIEWER).status_code == 403
        assert api.put('/api/pages/2/note', json={'text': 'x'}, headers=STRANGER).status_code == 404
