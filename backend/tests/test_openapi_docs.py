"""The schema at /openapi.json is the only API documentation, so it is kept honest here:
every operation carries a summary and a tag, and the shapes declared for the endpoints a
script consumes are checked against what those endpoints actually return.
"""
import pytest
from fastapi.testclient import TestClient

from app import schemas, store
from app.deps import get_db
from app.main import app

SECRET = 'test-secret'
ADMIN = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'root', 'X-Auth-Role': 'admin'}


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    conn = store.connect(tmp_path / 'app.db')
    conn.execute("INSERT INTO jobs (id, name, owner, status) VALUES ('j1', 'data', 'root', 'done')")
    conn.execute("INSERT INTO pages (id, job_id, idx, filename, source_file, status, width, height) "
                 "VALUES (1, 'j1', 0, 'p1.png', '/nonexistent.png', 'done', 100, 200)")
    conn.execute("INSERT INTO elements (id, page_id, order_idx, class_name, bbox, kind) "
                 "VALUES (1, 1, 0, 'Paragraph', '[0,0,1,1]', 'content')")
    conn.execute("INSERT INTO lines (id, element_id, order_idx, polygon, text) "
                 "VALUES (1, 1, 0, '[[0,0],[1,0],[1,1],[0,1]]', 'Wien')")
    conn.commit()
    app.dependency_overrides[get_db] = lambda: conn
    yield TestClient(app)
    app.dependency_overrides.clear()
    conn.close()


def _operations():
    return [(path, method, op)
            for path, methods in app.openapi()['paths'].items()
            for method, op in methods.items()]


def test_every_operation_has_a_summary():
    missing = [f'{m.upper()} {p}' for p, m, op in _operations() if not op.get('description')]
    assert missing == []


def test_every_operation_is_grouped_under_a_tag():
    untagged = [f'{m.upper()} {p}' for p, m, op in _operations() if not op.get('tags')]
    assert untagged == []


@pytest.mark.parametrize('url, model, unwrap', [
    ('/api/jobs', schemas.JobSummary, lambda body: body[0]),
    ('/api/jobs/j1', schemas.JobDetail, lambda body: body),
    ('/api/models', schemas.ModelList, lambda body: body),
])
def test_documented_fields_exist_in_the_real_payload(client, url, model, unwrap):
    """Declared fields must be a subset of what ships: extra columns are fine, a field
    the docs promise and the API never sends is a lie."""
    payload = unwrap(client.get(url, headers=ADMIN).json())
    assert set(model.model_fields) - set(payload) == set()


def test_the_documented_page_shape_matches_a_real_page(client):
    page = client.get('/api/jobs/j1', headers=ADMIN).json()['pages'][0]
    assert set(schemas.PageSummary.model_fields) - set(page) == set()
