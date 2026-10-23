"""A read-only API token keeps its owner's role - an admin's token still reads every
job - so the write refusal cannot be expressed as a role and rides on its own header.
"""
import pytest
from fastapi.testclient import TestClient

from app import store
from app.deps import get_db
from app.main import app

SECRET = 'test-secret'
ADMIN = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'root', 'X-Auth-Role': 'admin'}
READONLY = {**ADMIN, 'X-Auth-Readonly': '1'}


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    conn = store.connect(tmp_path / 'app.db')
    conn.execute("INSERT INTO jobs (id, name, owner, status) VALUES ('j1', 'data', 'root', 'done')")
    conn.commit()
    app.dependency_overrides[get_db] = lambda: conn
    yield TestClient(app)
    app.dependency_overrides.clear()
    conn.close()


def test_a_readonly_token_may_read(client):
    assert client.get('/api/jobs/j1', headers=READONLY).status_code == 200


def test_a_readonly_token_may_not_write(client):
    response = client.delete('/api/jobs/j1', headers=READONLY)
    assert response.status_code == 403
    assert response.json()['detail'] == 'read-only API token'
    # Same request without the flag is the control: the refusal is the header, not the route.
    assert client.delete('/api/jobs/j1', headers=ADMIN).status_code == 200
