"""Every mode the UI offers has to be acceptable to the route that receives it. The
Evaluate dialog defaults to beam, and the route accepted only the two older names -
so the dialog's own default came back a 400.
"""
import pytest
from fastapi.testclient import TestClient

from app import decode, store
from app.deps import get_db
from app.main import app

SECRET = 'test-secret'
ADMIN = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'root', 'X-Auth-Role': 'admin'}


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    conn = store.connect(tmp_path / 'app.db')
    conn.execute("INSERT INTO jobs (id, name, owner, status) VALUES ('j1', 'data', 'root', 'done')")
    conn.execute("INSERT INTO pages (id, job_id, idx, filename, source_file, status) "
                 "VALUES (1, 'j1', 0, 'p1.png', '/nonexistent.png', 'done')")
    conn.execute("INSERT INTO elements (id, page_id, order_idx, class_name, bbox, kind) "
                 "VALUES (1, 1, 0, 'Paragraph', '[0,0,1,1]', 'content')")
    conn.execute("INSERT INTO lines (id, element_id, order_idx, polygon, text, checked) "
                 "VALUES (1, 1, 0, '[[0,0],[1,0],[1,1],[0,1]]', 'Wien', 1)")
    conn.execute("INSERT INTO models (id, task, name, source, checkpoint) "
                 "VALUES (9, 'ocr', 'm', 'builtin', '/ckpt.pt')")
    conn.commit()
    app.dependency_overrides[get_db] = lambda: conn
    yield TestClient(app), conn
    app.dependency_overrides.clear()
    conn.close()


@pytest.mark.parametrize('mode', decode.OCR_DECODES)
def test_every_offered_mode_is_accepted(client, mode):
    api, conn = client
    response = api.post('/api/evaluations', headers=ADMIN,
                        json={'model_id': 9, 'job_ids': ['j1'], 'decode': mode})
    assert response.status_code == 200, response.text
    assert response.json()['decode'] == mode


def test_the_default_matches_the_one_the_dialog_sends(client):
    api, _ = client
    response = api.post('/api/evaluations', headers=ADMIN, json={'model_id': 9, 'job_ids': ['j1']})
    assert response.status_code == 200, response.text
    assert response.json()['decode'] == decode.DEFAULT_DECODE == 'beam'


def test_a_mode_nobody_offers_is_still_refused(client):
    api, _ = client
    response = api.post('/api/evaluations', headers=ADMIN,
                        json={'model_id': 9, 'job_ids': ['j1'], 'decode': 'telepathy'})
    assert response.status_code == 400
