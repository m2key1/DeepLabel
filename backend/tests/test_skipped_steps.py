"""A step a dataset skipped is remembered (#138): which steps have not run on its pages since
they were switched on, and a re-run of just those pages, so the ones that did go through
keep what they have."""
import pytest
from fastapi.testclient import TestClient

from app import store
from app.deps import get_db
from app.main import app

SECRET = 'test-secret'
MANAGER = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'alice', 'X-Auth-Role': 'member',
           'X-Auth-Caps': 'pipeline.layout pipeline.lines pipeline.ocr'}


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    monkeypatch.setattr('app.config.JOBS_DIR', tmp_path / 'jobs')
    conn = store.connect(tmp_path / 'app.db')
    # Page 1 went through layout; page 2 was passed by while layout was off. Each has a
    # line of text, page 3 waits for its lines and page 4 for its reading.
    conn.executescript("""
        INSERT INTO jobs (id, name, owner, status, task, run_layout, run_lines, run_ocr)
            VALUES ('j1', 'Volume', 'alice', 'done', 'text', 0, 1, 1);
        INSERT INTO pages (id, job_id, idx, filename, source_file, status, layout_skipped) VALUES
            (1, 'j1', 0, 'a.png', '/a.png', 'done', 0),
            (2, 'j1', 1, 'b.png', '/b.png', 'done', 1),
            (3, 'j1', 2, 'c.png', '/c.png', 'layout_done', 0),
            (4, 'j1', 3, 'd.png', '/d.png', 'lines_done', 0);
        INSERT INTO elements (id, page_id, order_idx, class_name, bbox, kind) VALUES
            (1, 1, 0, 'Paragraph', '[0, 0, 1, 1]', 'content'),
            (2, 2, 0, 'Paragraph', '[0, 0, 1, 1]', 'content'),
            (4, 4, 0, 'Paragraph', '[0, 0, 1, 1]', 'content');
        INSERT INTO lines (id, element_id, order_idx, polygon, text) VALUES
            (1, 1, 0, '[]', 'kept'), (2, 2, 0, '[]', 'whole page'), (4, 4, 0, '[]', NULL);
    """)
    conn.commit()
    app.dependency_overrides[get_db] = lambda: conn
    yield TestClient(app), conn
    app.dependency_overrides.clear()
    conn.close()


def not_run(api) -> dict:
    res = api.get('/api/jobs/j1/steps-not-run', headers=MANAGER)
    assert res.status_code == 200, res.text
    return res.json()


class TestWhatHasNotRun:
    def test_a_step_switched_off_is_not_offered(self, client):
        api, conn = client
        assert not_run(api) == {'layout': 0, 'lines': 1, 'ocr': 1}

    def test_switching_layout_on_shows_the_pages_it_passed_by(self, client):
        api, conn = client
        conn.execute("UPDATE jobs SET run_layout = 1 WHERE id = 'j1'")
        conn.commit()
        assert not_run(api) == {'layout': 1, 'lines': 1, 'ocr': 1}

    def test_nothing_is_offered_while_the_dataset_is_busy(self, client):
        api, conn = client
        conn.execute("UPDATE jobs SET run_layout = 1, status = 'running' WHERE id = 'j1'")
        conn.commit()
        assert not_run(api) == {'layout': 0, 'lines': 0, 'ocr': 0}


class TestRunningOnlyWhatIsMissing:
    def test_layout_is_redone_on_the_pages_it_passed_by_and_nowhere_else(self, client):
        api, conn = client
        conn.execute("UPDATE jobs SET run_layout = 1 WHERE id = 'j1'")
        conn.commit()
        res = api.post('/api/jobs/j1/rerun', headers=MANAGER, json={'from_phase': 'layout', 'only_missing': True})
        assert res.status_code == 200, res.text

        pages = dict(conn.execute('SELECT id, status FROM pages ORDER BY id').fetchall())
        assert pages == {1: 'done', 2: 'ingested', 3: 'layout_done', 4: 'lines_done'}
        assert dict(conn.execute('SELECT id, deleted FROM lines ORDER BY id').fetchall()) == {1: 0, 2: 1, 4: 0}
        assert dict(conn.execute('SELECT id, deleted FROM elements ORDER BY id').fetchall()) == {1: 0, 2: 1, 4: 0}
        assert store.get_job(conn, 'j1')['status'] == 'queued'

    def test_lines_and_reading_left_out_are_picked_up_without_redoing_anything(self, client):
        api, conn = client
        res = api.post('/api/jobs/j1/rerun', headers=MANAGER, json={'from_phase': 'lines', 'only_missing': True})
        assert res.status_code == 200, res.text

        assert dict(conn.execute('SELECT id, status FROM pages ORDER BY id').fetchall()) == {
            1: 'done', 2: 'done', 3: 'layout_done', 4: 'lines_done'}
        assert dict(conn.execute('SELECT id, deleted FROM lines ORDER BY id').fetchall()) == {1: 0, 2: 0, 4: 0}
        assert store.get_job(conn, 'j1')['status'] == 'queued'
