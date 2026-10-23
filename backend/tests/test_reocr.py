"""An imported dataset arrives with every pipeline phase off, so asking it to re-read
lines used to flag them and queue a job that had no OCR phase to honour the request:
the lines spin forever and nothing ever retried them.
"""
import pytest
from fastapi.testclient import TestClient

from app import store
from app.deps import get_db
from app.main import app

SECRET = 'test-secret'
ADMIN = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'root', 'X-Auth-Role': 'admin'}


@pytest.fixture
def conn(tmp_path, monkeypatch):
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    connection = store.connect(tmp_path / 'app.db')
    connection.execute("INSERT INTO jobs (id, name, owner, status, run_layout, run_lines, run_ocr) "
                       "VALUES ('imported', 'HSA', 'root', 'done', 0, 0, 0)")
    connection.execute("INSERT INTO pages (id, job_id, idx, filename, source_file, status) "
                       "VALUES (1, 'imported', 0, 'p1.png', '/nonexistent.png', 'layout_done')")
    connection.execute("INSERT INTO elements (id, page_id, order_idx, class_name, bbox, kind) "
                       "VALUES (1, 1, 0, 'Paragraph', '[0,0,1,1]', 'content')")
    connection.execute("INSERT INTO lines (id, element_id, order_idx, polygon, text, checked) "
                       "VALUES (1, 1, 0, '[[0,0],[1,0],[1,1],[0,1]]', 'imported text', 0)")
    connection.execute("INSERT INTO lines (id, element_id, order_idx, polygon, text, checked) "
                       "VALUES (2, 1, 1, '[[0,0],[1,0],[1,1],[0,1]]', 'verified text', 1)")
    connection.commit()
    app.dependency_overrides[get_db] = lambda: connection
    yield connection
    app.dependency_overrides.clear()
    connection.close()


def test_reocr_turns_the_phase_on_for_an_imported_dataset(conn):
    response = TestClient(app).post('/api/jobs/imported/reocr', json={'scope': 'unchecked'},
                                    headers=ADMIN)
    assert response.status_code == 200
    job = conn.execute("SELECT run_ocr, status FROM jobs WHERE id = 'imported'").fetchone()
    assert job['run_ocr'] == 1
    assert job['status'] == 'queued'
    # phase_ocr only selects pages that reached line detection, which never runs here.
    assert conn.execute('SELECT status FROM pages WHERE id = 1').fetchone()['status'] == 'lines_done'
    flags = conn.execute('SELECT id, needs_ocr FROM lines ORDER BY id').fetchall()
    assert [(r['id'], r['needs_ocr']) for r in flags] == [(1, 1), (2, 0)]


def test_reocr_leaves_a_dataset_that_still_owes_line_detection_alone(conn):
    conn.execute("UPDATE jobs SET run_lines = 1 WHERE id = 'imported'")
    conn.commit()
    TestClient(app).post('/api/jobs/imported/reocr', json={'scope': 'unchecked'}, headers=ADMIN)
    # The lines phase advances these itself; forcing them would skip the detection.
    assert conn.execute('SELECT status FROM pages WHERE id = 1').fetchone()['status'] == 'layout_done'


def test_reocr_of_one_line_turns_the_phase_on_too(conn):
    """The per-line re-read has the same problem: it flags the line and leaves the
    rest to the batch worker, which only re-queues datasets that OCR at all."""
    response = TestClient(app).post('/api/lines/1/reocr', headers=ADMIN)
    assert response.status_code == 200
    job = conn.execute("SELECT run_ocr FROM jobs WHERE id = 'imported'").fetchone()
    assert job['run_ocr'] == 1
    assert conn.execute('SELECT status FROM pages WHERE id = 1').fetchone()['status'] == 'lines_done'
    assert conn.execute('SELECT needs_ocr FROM lines WHERE id = 1').fetchone()['needs_ocr'] == 1


def test_reocr_of_one_line_leaves_a_dataset_that_still_owes_line_detection_alone(conn):
    conn.execute("UPDATE jobs SET run_lines = 1 WHERE id = 'imported'")
    conn.commit()
    TestClient(app).post('/api/lines/1/reocr', headers=ADMIN)
    assert conn.execute('SELECT status FROM pages WHERE id = 1').fetchone()['status'] == 'layout_done'
