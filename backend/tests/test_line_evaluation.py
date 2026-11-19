"""A line model evaluated on lines-checked pages: detected the way each dataset reads,
counted against the checked outlines, and shown page by page."""
import json

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app import eval_run, evaluator, store
from app.deps import get_db
from app.main import app

SECRET = 'test-secret'
ALICE = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'alice', 'X-Auth-Role': 'member'}
BOB = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'bob', 'X-Auth-Role': 'member'}


def box(x0, y0, x1, y1):
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]


ROW1 = box(0.1, 0.10, 0.9, 0.14)
ROW2 = box(0.1, 0.20, 0.9, 0.24)
EXTRA = box(0.1, 0.60, 0.9, 0.64)


class Detector:
    """A line model that finds the same lines in whatever it is sent, normalised to it."""

    author = 'model:lines@stand-in'

    def __init__(self, lines):
        self.lines = lines
        self.sent = []

    def detect(self, images, scope):
        self.sent.append((scope, len(images)))
        return [self.lines for _ in images]


@pytest.fixture
def conn(tmp_path, monkeypatch):
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    monkeypatch.setattr('app.config.EVALS_DIR', tmp_path / 'evaluations')
    (tmp_path / 'evaluations').mkdir()
    scan = tmp_path / 'p1.png'
    Image.new('RGB', (200, 100), 'white').save(scan)
    connection = store.connect(tmp_path / 'app.db')
    connection.executescript(f"""
        INSERT INTO jobs (id, name, owner, status) VALUES ('j1', 'Volume', 'alice', 'done'),
                                                          ('j2', 'Private', 'bob', 'done');
        INSERT INTO pages (id, job_id, idx, filename, source_file, status, lines_checked) VALUES
            (1, 'j1', 0, 'p1.png', '{scan}', 'done', 1),
            (2, 'j1', 1, 'p2.png', '{scan}', 'done', 0),
            (3, 'j2', 0, 'q1.png', '{scan}', 'done', 1);
        INSERT INTO elements (id, page_id, order_idx, class_name, bbox, kind) VALUES
            (1, 1, 0, 'Paragraph', '[0,0,1,1]', 'content'),
            (2, 1, 1, 'Pagenumber', '[0.9,0.9,1,1]', 'content'),
            (3, 2, 0, 'Paragraph', '[0,0,1,1]', 'content'),
            (4, 3, 0, 'Paragraph', '[0,0,1,1]', 'content');
        INSERT INTO lines (id, element_id, order_idx, polygon) VALUES
            (1, 1, 0, '{json.dumps(ROW1)}'), (2, 1, 1, '{json.dumps(ROW2)}'),
            (3, 2, 0, '{json.dumps(box(0.9, 0.9, 1, 1))}'),
            (4, 3, 0, '{json.dumps(ROW1)}'), (5, 4, 0, '{json.dumps(ROW1)}');
        INSERT INTO models (id, task, name, checkpoint) VALUES
            (9, 'lines', 'Lines', '/l.pt'), (10, 'layout', 'Regions', '/r.pt');
    """)
    connection.commit()
    yield connection
    connection.close()


@pytest.fixture
def client(conn):
    app.dependency_overrides[get_db] = lambda: conn
    yield TestClient(app)
    app.dependency_overrides.clear()


def running(conn, jobs):
    cur = conn.execute("INSERT INTO evaluations (model_id, source, decode, status, owner) VALUES (9, ?, '', 'running', 'alice')",
                       (json.dumps({'jobs': jobs}),))
    conn.commit()
    return evaluator.get_evaluation(conn, cur.lastrowid)


def test_each_lines_checked_page_is_read_as_its_dataset_reads_and_counted(conn):
    evaluation = running(conn, ['j1'])
    detector = Detector([ROW1, EXTRA])

    eval_run.score_lines(conn, evaluation, lambda: detector, evaluator.pages_path(evaluation['id']))

    # One lines-checked page, read in its paragraph's crop; the page number, read as one
    # box, is never sent and not counted.
    assert detector.sent == [('crop', 1)]
    done = evaluator.payload(conn.execute('SELECT * FROM evaluations WHERE id = ?', (evaluation['id'],)).fetchone())
    assert (done['status'], done['line_count'], done['cer']) == ('done', 2, None)
    metrics = done['metrics']
    assert {key: metrics[key] for key in ('truth', 'detected', 'found', 'missed', 'extra')} == {
        'truth': 2, 'detected': 2, 'found': 1, 'missed': 1, 'extra': 1}
    assert metrics['f1'] == pytest.approx(0.5)
    [page] = [json.loads(line) for line in evaluator.pages_path(evaluation['id']).read_text().splitlines()]
    assert (page['truth'], page['detected']) == (2, 2)
    assert [(line['line_id'], line['kind']) for line in page['outlines']['truth']] == [(1, 'found'), (2, 'missed')]
    assert [line['kind'] for line in page['outlines']['detected']] == ['found', 'extra']


def test_a_dataset_without_layout_is_read_on_the_whole_page(conn):
    conn.execute("UPDATE jobs SET line_mode = 'per_page' WHERE id = 'j1'")
    conn.commit()
    evaluation = running(conn, ['j1'])
    detector = Detector([ROW1, ROW2])

    eval_run.score_lines(conn, evaluation, lambda: detector, evaluator.pages_path(evaluation['id']))

    assert detector.sent == [('page', 1)]
    assert evaluator.payload(conn.execute('SELECT * FROM evaluations WHERE id = ?',
                                          (evaluation['id'],)).fetchone())['metrics']['f1'] == pytest.approx(1.0)


def test_no_lines_checked_page_is_an_error_not_a_score(conn):
    conn.execute('UPDATE pages SET lines_checked = 0')
    conn.commit()
    evaluation = running(conn, ['j1'])

    eval_run.score_lines(conn, evaluation, lambda: Detector([]), evaluator.pages_path(evaluation['id']))

    row = evaluator.get_evaluation(conn, evaluation['id'])
    assert (row['status'], row['error']) == ('error', 'no lines-checked pages to evaluate on')


class TestTheRoutes:
    def test_a_line_model_is_evaluated_on_lines_checked_pages_without_a_decoding(self, client):
        created = client.post('/api/evaluations', headers=ALICE, json={'model_id': 9, 'job_ids': ['j1']})
        assert created.status_code == 200, created.text
        assert (created.json()['decode'], created.json()['source']) == ('', {'jobs': ['j1']})

    @pytest.mark.parametrize('model, status', [(10, 400), (99, 404)])
    def test_other_models_are_refused(self, client, model, status):
        assert client.post('/api/evaluations', headers=ALICE,
                           json={'model_id': model, 'job_ids': ['j1']}).status_code == status

    def test_a_dataset_with_no_lines_checked_page_is_refused(self, client, conn):
        conn.execute('UPDATE pages SET lines_checked = 0')
        conn.commit()
        refused = client.post('/api/evaluations', headers=ALICE, json={'model_id': 9, 'job_ids': ['j1']})
        assert (refused.status_code, refused.json()['detail']) == (400, 'the selected datasets contain no lines-checked pages')

    def test_the_pages_come_worst_first_without_outlines_and_each_with_its_own(self, client, conn):
        conn.execute("UPDATE pages SET lines_checked = 1 WHERE id = 2")
        conn.commit()
        evaluation = running(conn, ['j1', 'j2'])
        eval_run.score_lines(conn, evaluation, lambda: Detector([ROW1]), evaluator.pages_path(evaluation['id']))

        pages = client.get(f'/api/evaluations/{evaluation["id"]}/pages', headers=ALICE).json()['pages']
        # Page 1 found one of its two lines, page 2 its only one; bob's page stays hidden.
        assert [(p['page_id'], p['filename'], p['f1']) for p in pages] == [
            (1, 'p1.png', pytest.approx(2 / 3)), (2, 'p2.png', pytest.approx(1.0))]
        assert 'outlines' not in pages[0]
        assert (pages[0]['truth'], pages[0]['found'], pages[0]['missed']) == (2, 1, 1)
        page = client.get(f'/api/evaluations/{evaluation["id"]}/pages/1', headers=ALICE).json()
        assert [line['kind'] for line in page['outlines']['truth']] == ['found', 'missed']
        assert client.get(f'/api/evaluations/{evaluation["id"]}/pages/3', headers=ALICE).status_code == 404
        assert [p['page_id'] for p in client.get(f'/api/evaluations/{evaluation["id"]}/pages',
                                                  headers=BOB).json()['pages']] == [3]
