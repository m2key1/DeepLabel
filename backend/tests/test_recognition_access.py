"""Who reaches the recognition routes. A recognition-only token reaches them and nothing
else; a read-only token may call them, since they write nothing; and the recognize
permission decides, whatever the token.
"""
import pytest
from fastapi.testclient import TestClient

from app import store
from app.deps import get_db
from app.main import app

SECRET = 'test-secret'
MEMBER = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'alice', 'X-Auth-Role': 'member',
          'X-Auth-Caps': 'pipeline.layout pipeline.lines pipeline.ocr train.local'}
MAY_RECOGNIZE = {**MEMBER, 'X-Auth-Caps': 'pipeline.ocr recognize'}
RECOGNITION_ONLY = {**MAY_RECOGNIZE, 'X-Auth-Scope': 'recognize'}
READONLY = {**MAY_RECOGNIZE, 'X-Auth-Readonly': '1'}


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    monkeypatch.setattr('app.config.MODEL_BACKENDS', {})
    conn = store.connect(tmp_path / 'app.db')
    conn.execute("INSERT INTO jobs (id, name, owner, status) VALUES ('j1', 'data', 'alice', 'done')")
    conn.commit()
    app.dependency_overrides[get_db] = lambda: conn
    yield TestClient(app)
    app.dependency_overrides.clear()
    conn.close()


def test_a_recognition_only_token_reaches_nothing_else(client):
    for response in (client.get('/api/jobs', headers=RECOGNITION_ONLY),
                     client.get('/api/jobs/j1', headers=RECOGNITION_ONLY),
                     client.get('/api/queue', headers=RECOGNITION_ONLY),
                     client.delete('/api/jobs/j1', headers=RECOGNITION_ONLY)):
        assert response.status_code == 403
        assert response.json()['detail'] == 'recognition-only API token'
    # The same person without the scope is the control: the refusal is the scope, not the route.
    assert client.get('/api/jobs/j1', headers=MAY_RECOGNIZE).status_code == 200


def test_a_recognition_only_token_reaches_the_recognition_routes(client):
    offered = client.get('/api/recognize', headers=RECOGNITION_ONLY)
    assert offered.status_code == 200
    assert offered.json()['limits'] == {'pages': 10, 'lines': 500, 'megabytes': 100}
    # No files is the route's own answer, so the request got past every gate to it.
    for path in ('/api/recognize/pages', '/api/recognize/lines'):
        empty = client.post(path, headers=RECOGNITION_ONLY)
        assert empty.status_code == 400
        assert empty.json()['detail'] == 'send at least one image as a files part'


def test_a_readonly_token_may_recognize_but_still_not_write(client):
    for path in ('/api/recognize/pages', '/api/recognize/lines'):
        empty = client.post(path, headers=READONLY)
        assert empty.status_code == 400
        assert empty.json()['detail'] == 'send at least one image as a files part'
    refused = client.delete('/api/jobs/j1', headers=READONLY)
    assert refused.status_code == 403
    assert refused.json()['detail'] == 'read-only API token'


def test_recognizing_needs_the_permission(client):
    for response in (client.get('/api/recognize', headers=MEMBER),
                     client.post('/api/recognize/pages', headers=MEMBER),
                     client.post('/api/recognize/lines', headers=MEMBER)):
        assert response.status_code == 403
        assert response.json()['detail'] == 'not permitted: recognize'
    assert client.get('/api/recognize', headers=MAY_RECOGNIZE).status_code == 200
