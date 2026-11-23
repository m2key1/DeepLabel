"""A dataset's runs and taking one back (#39): every queued start is a run, the revisions it
wrote carry it, and Revert puts back what it replaced - the reverting person's own later
edits kept, refused when a colleague has edited what it changed since."""
import json

import pytest
from fastapi.testclient import TestClient

from app import store
from app.deps import get_db
from app.main import app

SECRET = 'test-secret'


def headers(user: str, role: str) -> dict:
    return {'X-Frontend-Secret': SECRET, 'X-Auth-User': user, 'X-Auth-Role': role,
            'X-Auth-Caps': 'pipeline.layout pipeline.lines pipeline.ocr'}


# Alice made the dataset and so manages it; Bob reviews it.
ALICE, BOB = headers('alice', 'reviewer'), headers('bob', 'reviewer')
LOW = '[[0, 0.4], [1, 0.4], [1, 0.5], [0, 0.5]]'


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    monkeypatch.setattr('app.config.JOBS_DIR', tmp_path / 'jobs')
    conn = store.connect(tmp_path / 'app.db')
    conn.executescript("""
        INSERT INTO jobs (id, name, owner, status, task) VALUES ('j1', 'Volume', 'alice', 'done', 'text');
        INSERT INTO job_assignees (job_id, username, role) VALUES ('j1', 'bob', 'reviewer');
        INSERT INTO pages (id, job_id, idx, filename, source_file, status) VALUES (1, 'j1', 0, 'a.png', '/a.png', 'done');
        INSERT INTO elements (id, page_id, order_idx, class_name, bbox, kind) VALUES
            (1, 1, 0, 'Paragraph', '[0, 0, 1, 1]', 'content');
        INSERT INTO lines (id, element_id, order_idx, polygon, text) VALUES
            (1, 1, 0, '[[0, 0], [1, 0], [1, 0.1], [0, 0.1]]', 'Johann Muller'),
            (2, 1, 1, '[[0, 0.2], [1, 0.2], [1, 0.3], [0, 0.3]]', 'Pfarrer zu Ebersdorf');
    """)
    for line_id in (1, 2):
        store.log_line(conn, line_id, 'model:first', 'create')
    conn.commit()
    app.dependency_overrides[get_db] = lambda: conn
    yield TestClient(app), conn
    app.dependency_overrides.clear()
    conn.close()


def a_run(conn, write, author='model:second') -> int:
    """What the worker does with a queued dataset: the run it was queued for starts, the
    runner writes under it, and the dataset ends."""
    conn.execute("UPDATE jobs SET status = 'queued' WHERE id = 'j1'")
    run_id = store.begin_run(conn, 'j1')
    token = store.revision_run.set(run_id)
    try:
        write(author)
    finally:
        store.revision_run.reset(token)
    store.set_job_state(conn, 'j1', status='done')
    conn.commit()
    return run_id


def reread(conn, readings: dict):
    def write(author):
        for line_id, text in readings.items():
            conn.execute('UPDATE lines SET text = ? WHERE id = ?', (text, line_id))
            store.log_line(conn, line_id, author, 'update')
    return write


def texts(conn) -> dict:
    return {r['id']: (r['text'], r['corrected_text'], r['deleted'])
            for r in conn.execute('SELECT id, text, corrected_text, deleted FROM lines ORDER BY id')}


def correct(api, line_id: int, text: str, who=ALICE):
    res = api.patch(f'/api/lines/{line_id}', headers=who, json={'corrected_text': text})
    assert res.status_code == 200, res.text


class TestTheHistory:
    def test_each_queued_start_is_a_run_with_what_it_changed(self, client):
        api, conn = client
        first = a_run(conn, reread(conn, {1: 'Johann Miller'}))
        second = a_run(conn, reread(conn, {1: 'Johann Müller', 2: 'Pfarrer zu Ebersdorff'}))
        runs = api.get('/api/jobs/j1/runs', headers=ALICE).json()['runs']
        assert [(r['id'], r['status'], r['changed']) for r in runs] == [
            (second, 'done', {'lines': 2, 'boxes': 0}), (first, 'done', {'lines': 1, 'boxes': 0})]
        assert conn.execute('SELECT COUNT(*) FROM revisions WHERE run_id = ?', (second,)).fetchone()[0] == 2

    def test_a_rerun_is_its_own_run_with_what_it_discarded(self, client):
        api, conn = client
        res = api.post('/api/jobs/j1/rerun', headers=ALICE, json={'from_phase': 'ocr', 'keep_checked': False})
        assert res.status_code == 200, res.text
        latest = api.get('/api/jobs/j1/runs', headers=ALICE).json()['runs'][0]
        assert {k: latest[k] for k in ('reason', 'started_by', 'status', 'changed', 'revertable')} == {
            'reason': 'rerun:ocr', 'started_by': 'alice', 'status': 'queued',
            'changed': {'lines': 2, 'boxes': 0}, 'revertable': False}

    def test_a_restart_carries_on_the_same_run(self, client):
        api, conn = client
        conn.execute("UPDATE jobs SET status = 'queued' WHERE id = 'j1'")
        conn.execute("UPDATE jobs SET status = 'running' WHERE id = 'j1'")
        run_id = conn.execute("SELECT run_id FROM jobs WHERE id = 'j1'").fetchone()[0]
        conn.execute("UPDATE jobs SET status = 'queued' WHERE status = 'running'")
        assert conn.execute("SELECT run_id FROM jobs WHERE id = 'j1'").fetchone()[0] == run_id
        assert conn.execute('SELECT COUNT(*) FROM runs').fetchone()[0] == 1


class TestRevert:
    def test_a_reread_is_taken_back_and_says_so_first(self, client):
        api, conn = client
        run_id = a_run(conn, reread(conn, {1: 'Johann Miller', 2: 'Pfarrer zu Ebersdorff'}))

        preview = api.get(f'/api/jobs/j1/runs/{run_id}/revert', headers=ALICE).json()
        assert preview == {'restore': {'lines': 2, 'boxes': 0}, 'remove': {'lines': 0, 'boxes': 0},
                           'kept': {'lines': 0, 'boxes': 0}, 'refused': None}
        res = api.post(f'/api/jobs/j1/runs/{run_id}/revert', headers=ALICE)
        assert res.status_code == 200, res.text
        assert texts(conn) == {1: ('Johann Muller', None, 0), 2: ('Pfarrer zu Ebersdorf', None, 0)}
        run = api.get('/api/jobs/j1/runs', headers=ALICE).json()['runs'][0]
        assert (run['reverted_by'], run['revertable']) == ('alice', False)
        assert api.post(f'/api/jobs/j1/runs/{run_id}/revert', headers=ALICE).status_code == 409

    def test_lines_a_detection_made_go_and_the_ones_it_replaced_come_back(self, client):
        api, conn = client

        def redetect(author):
            conn.execute('UPDATE lines SET deleted = 1 WHERE id IN (1, 2)')
            for line_id in (1, 2):
                store.log_line(conn, line_id, author, 'delete')
            new = conn.execute("INSERT INTO lines (element_id, order_idx, polygon, text) "
                               "VALUES (1, 0, '[[0, 0], [1, 0], [1, 0.3], [0, 0.3]]', 'Johann Muller Pfarrer')").lastrowid
            store.log_line(conn, new, author, 'create')
        run_id = a_run(conn, redetect, author='system:rerun@alice')

        assert api.get(f'/api/jobs/j1/runs/{run_id}/revert', headers=ALICE).json()['remove'] == {'lines': 1, 'boxes': 0}
        assert api.post(f'/api/jobs/j1/runs/{run_id}/revert', headers=ALICE).status_code == 200
        assert texts(conn) == {1: ('Johann Muller', None, 0), 2: ('Pfarrer zu Ebersdorf', None, 0),
                               3: ('Johann Muller Pfarrer', None, 1)}

    def test_your_own_correction_since_is_kept_over_the_reading_put_back(self, client):
        api, conn = client
        run_id = a_run(conn, reread(conn, {1: 'Johann Miller', 2: 'Pfarrer zu Ebersdorff'}))
        correct(api, 2, 'Pfarrer zu Ebersdorf.')

        assert api.get(f'/api/jobs/j1/runs/{run_id}/revert', headers=ALICE).json()['kept'] == {'lines': 1, 'boxes': 0}
        assert api.post(f'/api/jobs/j1/runs/{run_id}/revert', headers=ALICE).status_code == 200
        assert texts(conn) == {1: ('Johann Muller', None, 0), 2: ('Pfarrer zu Ebersdorf', 'Pfarrer zu Ebersdorf.', 0)}

    def test_a_line_you_checked_since_keeps_the_reading_you_checked(self, client):
        api, conn = client
        run_id = a_run(conn, reread(conn, {1: 'Johann Miller', 2: 'Pfarrer zu Ebersdorff'}))
        res = api.patch('/api/lines/1', headers=ALICE, json={'checked': True})
        assert res.status_code == 200, res.text

        assert api.get(f'/api/jobs/j1/runs/{run_id}/revert', headers=ALICE).json()['kept'] == {'lines': 1, 'boxes': 0}
        assert api.post(f'/api/jobs/j1/runs/{run_id}/revert', headers=ALICE).status_code == 200
        assert texts(conn) == {1: ('Johann Miller', None, 0), 2: ('Pfarrer zu Ebersdorf', None, 0)}

    def test_a_colleagues_edit_since_refuses_it_and_nothing_changes(self, client):
        api, conn = client
        run_id = a_run(conn, reread(conn, {1: 'Johann Miller', 2: 'Pfarrer zu Ebersdorff'}))
        correct(api, 1, 'Johann Müller', who=BOB)

        preview = api.get(f'/api/jobs/j1/runs/{run_id}/revert', headers=ALICE).json()
        assert preview['refused'] == 'bob has edited 1 line this run changed since'
        res = api.post(f'/api/jobs/j1/runs/{run_id}/revert', headers=ALICE)
        assert (res.status_code, res.json()['detail']) == (409, 'bob has edited 1 line this run changed since')
        assert texts(conn)[2] == ('Pfarrer zu Ebersdorff', None, 0)

    def test_a_later_run_over_the_same_lines_is_taken_back_first(self, client):
        api, conn = client
        first = a_run(conn, reread(conn, {1: 'Johann Miller'}))
        a_run(conn, reread(conn, {1: 'Johann Müller'}))
        res = api.post(f'/api/jobs/j1/runs/{first}/revert', headers=ALICE)
        assert (res.status_code, res.json()['detail']) == (409, 'a later run changed 1 line this run changed; revert that one first')
        assert texts(conn)[1] == ('Johann Müller', None, 0)

    def test_only_a_manager_reverts_a_run(self, client):
        api, conn = client
        run_id = a_run(conn, reread(conn, {1: 'Johann Miller'}))
        assert api.post(f'/api/jobs/j1/runs/{run_id}/revert', headers=BOB).status_code == 403
        assert texts(conn)[1] == ('Johann Miller', None, 0)

    def test_nothing_is_reverted_while_the_dataset_is_busy(self, client):
        api, conn = client
        run_id = a_run(conn, reread(conn, {1: 'Johann Miller'}))
        conn.execute("UPDATE jobs SET status = 'queued' WHERE id = 'j1'")
        conn.commit()
        assert api.post(f'/api/jobs/j1/runs/{run_id}/revert', headers=ALICE).status_code == 409


class TestWhatARunLastChanged:
    @pytest.fixture
    def two_pages(self, client):
        api, conn = client
        conn.executescript("""
            INSERT INTO pages (id, job_id, idx, filename, source_file, status) VALUES (2, 'j1', 1, 'b.png', '/b.png', 'done');
            INSERT INTO elements (id, page_id, order_idx, class_name, bbox, kind) VALUES
                (2, 2, 0, 'Paragraph', '[0, 0, 1, 1]', 'content');
            INSERT INTO lines (id, element_id, order_idx, polygon, text) VALUES
                (3, 2, 0, '[[0, 0], [1, 0], [1, 0.1], [0, 0.1]]', 'in der Gemeinde');
        """)
        conn.commit()
        return api, conn

    def test_the_page_table_lists_the_pages_it_changed_that_nobody_has_touched_since(self, two_pages):
        api, conn = two_pages
        run_id = a_run(conn, reread(conn, {1: 'Johann Miller', 3: 'in der Gemeinde.'}))
        pages = lambda: api.get('/api/jobs/j1/page-rows', headers=ALICE, params={'filter': f'run:{run_id}'}).json()
        assert ([r['id'] for r in pages()['rows']], pages()['matched']) == ([1, 2], 2)
        correct(api, 3, 'in der Gemeinde')
        assert ([r['id'] for r in pages()['rows']], pages()['matched']) == ([1], 1)

    def test_review_walks_the_lines_it_changed_that_nobody_has_touched_since(self, two_pages):
        api, conn = two_pages
        run_id = a_run(conn, reread(conn, {1: 'Johann Miller', 3: 'in der Gemeinde.'}))
        correct(api, 1, 'Johann Müller')
        queue = api.get('/api/jobs/j1/review', headers=ALICE, params={'run': run_id}).json()
        assert [(line['id'], line['page_id']) for line in queue['lines']] == [(3, 2)]


class TestWhatTheReviewFound:
    def test_a_line_whose_last_word_was_a_pipeline_create_comes_back(self, client):
        # Line detection logs a new line with a partial snapshot, without `deleted`: a revert
        # still has to see that the run took the line away.
        api, conn = client
        conn.execute(f"INSERT INTO lines (id, element_id, order_idx, polygon, text) VALUES (5, 1, 2, '{LOW}', NULL)")
        store.log_revision(conn, 'line', 5, 'j1', 'model:lines', 'create',
                           {'id': 5, 'element_id': 1, 'order_idx': 2, 'polygon': json.loads(LOW), 'text': None,
                            'corrected_text': None, 'confidence': None, 'checked': False})
        conn.commit()

        def redetect(author):
            conn.execute('UPDATE lines SET deleted = 1 WHERE id = 5')
            store.log_line(conn, 5, author, 'delete')
            new = conn.execute(f"INSERT INTO lines (element_id, order_idx, polygon, text) VALUES (1, 2, '{LOW}', NULL)").lastrowid
            store.log_line(conn, new, author, 'create')
        run_id = a_run(conn, redetect, author='system:rerun@alice')

        preview = api.get(f'/api/jobs/j1/runs/{run_id}/revert', headers=ALICE).json()
        assert (preview['restore'], preview['remove']) == ({'lines': 1, 'boxes': 0}, {'lines': 1, 'boxes': 0})
        assert api.post(f'/api/jobs/j1/runs/{run_id}/revert', headers=ALICE).status_code == 200
        assert {i: deleted for i, (_, _, deleted) in texts(conn).items() if i >= 5} == {5: 0, 6: 1}

    def test_pages_a_revert_empties_go_back_to_be_processed_again(self, client):
        api, conn = client
        conn.execute("INSERT INTO pages (id, job_id, idx, filename, source_file, status) VALUES (3, 'j1', 2, 'c.png', '/c.png', 'ingested')")
        conn.commit()

        def first_reading(author):
            box = conn.execute("INSERT INTO elements (page_id, order_idx, class_name, bbox, kind) "
                               "VALUES (3, 0, 'Paragraph', '[0, 0, 1, 1]', 'content')").lastrowid
            store.log_element(conn, box, author, 'create')
            line = conn.execute("INSERT INTO lines (element_id, order_idx, polygon, text) VALUES (?, 0, '[[0, 0], [1, 0], [1, 0.1], [0, 0.1]]', 'Taufbuch')",
                                (box,)).lastrowid
            store.log_line(conn, line, author, 'create')
            conn.execute("UPDATE pages SET status = 'done' WHERE id = 3")
        run_id = a_run(conn, first_reading)

        assert api.post(f'/api/jobs/j1/runs/{run_id}/revert', headers=ALICE).status_code == 200
        assert dict(conn.execute('SELECT id, status FROM pages ORDER BY id').fetchall()) == {1: 'done', 3: 'ingested'}

    def test_a_colleagues_edit_while_the_run_was_still_going_refuses_it(self, client):
        api, conn = client

        def read_then_align(author):
            conn.execute("UPDATE lines SET text = 'Johann Miller' WHERE id = 1")
            store.log_line(conn, 1, author, 'update')
            # Bob's request carries no run, as no request does.
            outside = store.revision_run.set(None)
            correct(api, 1, 'Johann Müller', who=BOB)
            store.revision_run.reset(outside)
            conn.execute("UPDATE lines SET confidence = 0.5 WHERE id = 1")
            store.log_line(conn, 1, author, 'update')
        run_id = a_run(conn, read_then_align)

        res = api.post(f'/api/jobs/j1/runs/{run_id}/revert', headers=ALICE)
        assert (res.status_code, res.json()['detail']) == (409, 'bob has edited 1 line this run changed since')

    def test_a_box_holding_a_line_you_kept_stays_with_it(self, client):
        api, conn = client
        made = {}

        def new_box(author):
            made['box'] = conn.execute("INSERT INTO elements (page_id, order_idx, class_name, bbox, kind) "
                                       "VALUES (1, 1, 'Paragraph', '[0, 0.5, 1, 1]', 'content')").lastrowid
            store.log_element(conn, made['box'], author, 'create')
            made['line'] = conn.execute("INSERT INTO lines (element_id, order_idx, polygon, text) "
                                        "VALUES (?, 0, '[[0, 0.6], [1, 0.6], [1, 0.7], [0, 0.7]]', 'Pfarrer')", (made['box'],)).lastrowid
            store.log_line(conn, made['line'], author, 'create')
        run_id = a_run(conn, new_box)
        correct(api, made['line'], 'Pfarrer zu Linz')

        preview = api.get(f'/api/jobs/j1/runs/{run_id}/revert', headers=ALICE).json()
        assert (preview['remove'], preview['kept']) == ({'lines': 0, 'boxes': 0}, {'lines': 1, 'boxes': 1})
        assert api.post(f'/api/jobs/j1/runs/{run_id}/revert', headers=ALICE).status_code == 200
        box = conn.execute('SELECT deleted FROM elements WHERE id = ?', (made['box'],)).fetchone()[0]
        assert (box, texts(conn)[made['line']]) == (0, ('Pfarrer', 'Pfarrer zu Linz', 0))

    @pytest.mark.parametrize('on_the_way', [[], ['ingesting'], ['uploading', 'ingesting']])
    def test_a_new_dataset_opens_one_run_as_it_is_queued(self, client, on_the_way):
        # Made as 'queued' by the column's default, then queued at once or after its pages.
        api, conn = client
        conn.execute("INSERT INTO jobs (id, name, owner) VALUES ('j2', 'New', 'alice')")
        for status in [*on_the_way, 'queued']:
            conn.execute("UPDATE jobs SET status = ? WHERE id = 'j2'", (status,))
        assert [tuple(r) for r in conn.execute("SELECT r.id = j.run_id, r.status FROM runs r JOIN jobs j ON j.id = r.job_id "
                                               "WHERE r.job_id = 'j2'")] == [(1, 'queued')]
