"""A transcription check: a dataset's checked lines read with a model to find wrong ground
truth. It is stored as an evaluation but never counts as a score of the model."""
import pytest
from fastapi.testclient import TestClient

from app import store
from app.deps import get_db
from app.main import app

SECRET = 'test-secret'
ALICE = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'alice', 'X-Auth-Role': 'member'}
BOB = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'bob', 'X-Auth-Role': 'member'}
VIEWER = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'alice', 'X-Auth-Role': 'viewer'}
BOX = '[[0,0],[1,0],[1,1],[0,1]]'


@pytest.fixture
def conn(tmp_path, monkeypatch):
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    connection = store.connect(tmp_path / 'app.db')
    connection.executescript(f"""
        INSERT INTO jobs (id, name, owner, status) VALUES
            ('j1', 'Volume', 'alice', 'done'), ('j3', 'Unchecked', 'alice', 'done');
        INSERT INTO pages (id, job_id, idx, filename, source_file, status) VALUES
            (1, 'j1', 0, 'p1.png', '/p1.png', 'done'), (3, 'j3', 0, 'q1.png', '/q1.png', 'done');
        INSERT INTO elements (id, page_id, order_idx, class_name, bbox, kind) VALUES
            (1, 1, 0, 'Paragraph', '[0,0,1,1]', 'content'), (3, 3, 0, 'Paragraph', '[0,0,1,1]', 'content');
        INSERT INTO lines (id, element_id, order_idx, polygon, text, checked) VALUES
            (1, 1, 0, '{BOX}', 'Wels', 1), (2, 1, 1, '{BOX}', 'Wien', 1), (3, 3, 0, '{BOX}', 'Graz', 0);
        INSERT INTO models (id, task, name, checkpoint) VALUES
            (9, 'ocr', 'Kurrent', '/k.pt'), (10, 'layout', 'Regions', '/r.pt');
        INSERT INTO evaluations (id, model_id, source, decode, status, owner, cer, line_count) VALUES
            (7, 9, '{{"jobs": ["j1"], "test_pages": true}}', 'rescored', 'done', 'alice', 0.2, 2);
    """)
    connection.commit()
    yield connection
    connection.close()


@pytest.fixture
def client(conn):
    app.dependency_overrides[get_db] = lambda: conn
    yield TestClient(app)
    app.dependency_overrides.clear()


def start(client, job='j1', model=9, headers=ALICE):
    return client.post(f'/api/jobs/{job}/checks', json={'model_id': model}, headers=headers)


def test_a_check_reads_every_checked_line_of_the_dataset_in_the_mode_automatic_reads_with(client, conn):
    check = start(client).json()
    row = conn.execute('SELECT * FROM evaluations WHERE id = ?', (check['id'],)).fetchone()
    assert (row['model_id'], row['decode'], row['status'], row['owner']) == (9, 'rescored', 'queued', 'alice')
    # All pages, not only the test pages: wrong ground truth hides in what a model trains on.
    assert check['source'] == {'jobs': ['j1'], 'check': True}


def test_a_check_is_listed_on_its_dataset_and_never_as_a_score_of_the_model(client):
    check = start(client).json()
    assert [ev['id'] for ev in client.get('/api/evaluations', headers=ALICE).json()['evaluations']] == [7]
    checks = client.get('/api/jobs/j1/checks', headers=ALICE).json()['checks']
    assert [(c['id'], c['model_name'], c['status']) for c in checks] == [(check['id'], 'Kurrent', 'queued')]
    # The check opens on the evaluation page like any evaluation.
    assert client.get(f'/api/evaluations/{check["id"]}', headers=ALICE).json()['source']['check'] is True


def test_a_check_s_score_is_no_one_s_best(client, conn):
    conn.execute("INSERT INTO trainings (id, task, name, owner, status, model_id) "
                 "VALUES (1, 'ocr', 'Run', 'alice', 'done', 9)")
    conn.commit()
    check = start(client).json()
    conn.execute("UPDATE evaluations SET status = 'done', cer = 0.01 WHERE id = ?", (check['id'],))
    conn.commit()
    assert client.get('/api/people/alice/profile', headers=ALICE).json()['stats']['best_cer'] == 0.2


@pytest.mark.parametrize('job, model, headers, status', [
    ('j3', 9, ALICE, 400),   # no checked line to read
    ('j1', 10, ALICE, 400),  # not an OCR model
    ('j1', 99, ALICE, 404),
    ('j1', 9, BOB, 404),     # no access: the dataset does not show it exists
    ('j1', 9, VIEWER, 403),  # reading a dataset with a model is a member's job
])
def test_a_check_is_refused_when_it_has_nothing_to_read_or_no_right_to(client, job, model, headers, status):
    assert start(client, job, model, headers).status_code == status
