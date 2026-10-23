"""The review queue: the lines of a dataset worth a person's eyes, in reading order. The
OCR model's doubt puts a line there; so does an agreement between language models that
nobody has checked, however sure the OCR model was - an unchecked line is review work.
"""
import pytest
from fastapi.testclient import TestClient

from app import store
from app.deps import get_db
from app.main import app

SECRET = 'test-secret'
ALICE = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'alice', 'X-Auth-Role': 'member'}
BOX = '[[0,0],[1,0],[1,1],[0,1]]'


@pytest.fixture
def conn(tmp_path, monkeypatch):
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    connection = store.connect(tmp_path / 'app.db')
    connection.executescript(f"""
        INSERT INTO jobs (id, name, owner, status) VALUES ('j1', 'Volume', 'alice', 'done');
        INSERT INTO pages (id, job_id, idx, filename, source_file, status) VALUES
            (1, 'j1', 0, 'p1.png', '/p1.png', 'done'),
            (2, 'j1', 1, 'p2.png', '/p2.png', 'done');
        INSERT INTO elements (id, page_id, order_idx, class_name, bbox, kind) VALUES
            (1, 1, 0, 'Paragraph', '[0,0,1,1]', 'content'),
            (2, 2, 0, 'Paragraph', '[0,0,1,1]', 'content');
        INSERT INTO lines (id, element_id, order_idx, polygon, text, confidence, corrected_text, corrected_by, checked) VALUES
            (1, 1, 0, '{BOX}', 'Sure',             0.97, NULL,      NULL,               0),
            (2, 1, 1, '{BOX}', 'Doubtful',         0.55, NULL,      NULL,               0),
            (3, 1, 2, '{BOX}', 'Settled and sure', 0.95, 'Settled', 'llm:consensus@2',  0),
            (4, 1, 3, '{BOX}', 'Settled, checked', 0.95, 'Settled', 'llm:consensus@2',  1),
            (5, 2, 0, '{BOX}', 'Corrected, sure',  0.95, 'By hand', 'alice',            0),
            (6, 2, 1, '{BOX}', 'Doubtful, checked', 0.55, NULL,     NULL,               1),
            (7, 2, 2, '{BOX}', 'Settled later',    0.99, 'Settled', 'llm:consensus@3',  0);
    """)
    connection.commit()
    yield connection
    connection.close()


@pytest.fixture
def client(conn):
    app.dependency_overrides[get_db] = lambda: conn
    yield TestClient(app)
    app.dependency_overrides.clear()


def queued(client, **params):
    response = client.get('/api/jobs/j1/review', params=params, headers=ALICE)
    assert response.status_code == 200, response.text
    return response.json()


def test_a_settled_line_above_the_bar_is_queued_until_a_person_checks_it(client):
    ids = [l['id'] for l in queued(client)['lines']]

    assert 3 in ids
    assert 7 in ids


def test_a_settled_line_a_person_checked_is_not(client):
    assert 4 not in [l['id'] for l in queued(client)['lines']]


def test_the_queue_is_the_doubtful_and_the_settled_in_reading_order(client):
    body = queued(client)

    assert [l['id'] for l in body['lines']] == [2, 3, 7]
    assert body['total'] == 3
    assert [l['page_idx'] for l in body['lines']] == [0, 0, 1]


def test_a_line_the_model_was_sure_of_and_nobody_settled_is_not_review_work(client):
    ids = [l['id'] for l in queued(client)['lines']]

    assert 1 not in ids
    assert 5 not in ids


def test_showing_checked_lines_too_brings_back_the_doubtful_ones_only(client):
    """A checked settled line was never flagged for the OCR model's doubt, so there is
    nothing to show again."""
    assert [l['id'] for l in queued(client, include_checked='true')['lines']] == [2, 3, 6, 7]
