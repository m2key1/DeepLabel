"""Test data is marked per page: a page is test data or not, and a dataset is a quick way
to mark many. What is marked here is what training leaves out and a run's test set is
scored on, so who may mark it and how new pages arrive is pinned down.
"""
import io

import pytest
from PIL import Image
from fastapi.testclient import TestClient

from app import eval_material, preflight, store, train_snapshot
from app.deps import get_db
from app.main import app

SECRET = 'test-secret'
OWNER = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'alice', 'X-Auth-Role': 'member',
         'X-Auth-Caps': 'pipeline.layout pipeline.lines pipeline.ocr'}
SHARED = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'bob', 'X-Auth-Role': 'member'}
ADMIN = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'root', 'X-Auth-Role': 'admin'}


def png() -> bytes:
    buf = io.BytesIO()
    Image.new('RGB', (2, 2), 'white').save(buf, 'PNG')
    return buf.getvalue()


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    monkeypatch.setattr('app.config.JOBS_DIR', tmp_path / 'jobs')
    conn = store.connect(tmp_path / 'app.db')
    conn.executescript("""
        INSERT INTO jobs (id, name, owner, status) VALUES ('j1', 'Zollbuecher', 'alice', 'done'),
                                                          ('j2', 'Other', 'alice', 'done');
        INSERT INTO job_assignees (job_id, username) VALUES ('j1', 'bob');
        INSERT INTO pages (id, job_id, idx, filename, source_file, status) VALUES
            (1, 'j1', 0, 'a.png', '/a.png', 'done'), (2, 'j1', 1, 'b.png', '/b.png', 'done'),
            (3, 'j1', 2, 'c.png', '/c.png', 'done'), (4, 'j2', 0, 'd.png', '/d.png', 'done');
    """)
    conn.commit()
    app.dependency_overrides[get_db] = lambda: conn
    yield TestClient(app), conn
    app.dependency_overrides.clear()
    conn.close()


def marked(conn, job_id='j1') -> list[int]:
    return [r[0] for r in conn.execute(
        'SELECT id FROM pages WHERE job_id = ? AND is_test = 1 ORDER BY id', (job_id,))]


def switch(conn, job_id='j1') -> int:
    return conn.execute('SELECT new_pages_test FROM jobs WHERE id = ?', (job_id,)).fetchone()[0]


class TestMarking:
    def test_the_owner_marks_single_pages(self, client):
        api, conn = client
        response = api.post('/api/jobs/j1/test-pages', json={'page_ids': [1, 3], 'test': True}, headers=OWNER)

        assert response.status_code == 200, response.text
        assert response.json() == {'test_pages': 2, 'pages': 3, 'new_pages_test': False}
        assert marked(conn) == [1, 3]
        assert switch(conn) == 0

    def test_unmarking_single_pages_leaves_the_rest(self, client):
        api, conn = client
        api.post('/api/jobs/j1/test-pages', json={'page_ids': [1, 2, 3], 'test': True}, headers=OWNER)

        api.post('/api/jobs/j1/test-pages', json={'page_ids': [2], 'test': False}, headers=OWNER)

        assert marked(conn) == [1, 3]

    def test_mark_all_pages_marks_every_page_and_turns_the_switch_on(self, client):
        api, conn = client
        response = api.post('/api/jobs/j1/test-pages', json={'test': True}, headers=OWNER)

        assert response.json() == {'test_pages': 3, 'pages': 3, 'new_pages_test': True}
        assert marked(conn) == [1, 2, 3]
        assert switch(conn) == 1

    def test_unmark_all_pages_clears_them_and_turns_the_switch_off(self, client):
        api, conn = client
        api.post('/api/jobs/j1/test-pages', json={'test': True}, headers=OWNER)

        api.post('/api/jobs/j1/test-pages', json={'test': False}, headers=OWNER)

        assert (marked(conn), switch(conn)) == ([], 0)

    def test_a_page_of_another_dataset_is_not_touched(self, client):
        api, conn = client
        api.post('/api/jobs/j1/test-pages', json={'page_ids': [1, 4], 'test': True}, headers=OWNER)

        assert (marked(conn), marked(conn, 'j2')) == ([1], [])

    def test_someone_it_is_shared_with_may_not_mark(self, client):
        api, conn = client
        response = api.post('/api/jobs/j1/test-pages', json={'test': True}, headers=SHARED)

        assert response.status_code == 403
        assert marked(conn) == []

    def test_an_admin_may(self, client):
        api, conn = client
        assert api.post('/api/jobs/j1/test-pages', json={'page_ids': [2], 'test': True},
                        headers=ADMIN).status_code == 200
        assert marked(conn) == [2]


class TestTheSwitch:
    def test_the_owner_turns_it_on_without_marking_anything(self, client):
        api, conn = client
        response = api.patch('/api/jobs/j1', json={'new_pages_test': True}, headers=OWNER)

        assert response.status_code == 200, response.text
        assert response.json()['new_pages_test'] is True
        assert (switch(conn), marked(conn)) == (1, [])

    def test_someone_it_is_shared_with_may_not_turn_it(self, client):
        api, conn = client
        assert api.patch('/api/jobs/j1', json={'new_pages_test': True}, headers=SHARED).status_code == 403
        assert switch(conn) == 0

    def test_pages_added_while_it_is_on_arrive_as_test_pages(self, client):
        api, conn = client
        api.patch('/api/jobs/j1', json={'new_pages_test': True}, headers=OWNER)

        api.post('/api/jobs/j1/pages/upload', files=[('files', ('e.png', png(), 'image/png'))], headers=OWNER)

        new = conn.execute("SELECT is_test FROM pages WHERE job_id = 'j1' AND filename LIKE '%e.png'").fetchone()
        assert new['is_test'] == 1

    def test_an_upload_can_say_otherwise_for_its_own_pages(self, client):
        api, conn = client
        api.patch('/api/jobs/j1', json={'new_pages_test': True}, headers=OWNER)

        api.post('/api/jobs/j1/pages/upload', data={'as_test': 'false'},
                 files=[('files', ('e.png', png(), 'image/png'))], headers=OWNER)

        new = conn.execute("SELECT is_test FROM pages WHERE job_id = 'j1' AND filename LIKE '%e.png'").fetchone()
        assert (new['is_test'], switch(conn)) == (0, 1)

    def test_a_dataset_created_as_test_pages_keeps_the_switch_on(self, client):
        api, conn = client
        response = api.post('/api/jobs', data={'name': 'Held out', 'as_test': 'true'},
                            files=[('files', ('a.png', png(), 'image/png'))], headers=OWNER)

        job_id = response.json()['job_id']
        assert switch(conn, job_id) == 1
        assert conn.execute('SELECT is_test FROM pages WHERE job_id = ?', (job_id,)).fetchone()[0] == 1


class TestWhatTheDatasetShows:
    def test_the_list_counts_test_pages(self, client):
        api, conn = client
        api.post('/api/jobs/j1/test-pages', json={'page_ids': [1, 2], 'test': True}, headers=OWNER)

        rows = {job['id']: job for job in api.get('/api/jobs', headers=OWNER).json()}

        assert (rows['j1']['test_pages'], rows['j1']['pages_total']) == (2, 3)
        assert rows['j2']['test_pages'] == 0
        assert rows['j1']['new_pages_test'] is False

    def test_each_page_says_whether_it_is_test_data(self, client):
        api, _ = client
        api.post('/api/jobs/j1/test-pages', json={'page_ids': [2], 'test': True}, headers=OWNER)

        pages = api.get('/api/jobs/j1', headers=OWNER).json()['pages']

        assert [(p['id'], p['is_test']) for p in pages] == [(1, False), (2, True), (3, False)]

    def test_the_list_shows_a_marking_at_once_though_no_row_was_added(self, client):
        """The list holds its counts until a row is added; marking adds none."""
        api, _ = client
        api.get('/api/jobs', headers=OWNER)

        api.post('/api/jobs/j1/test-pages', json={'test': True}, headers=OWNER)

        rows = {job['id']: job for job in api.get('/api/jobs', headers=OWNER).json()}
        assert rows['j1']['test_pages'] == 3


@pytest.fixture
def volumes(tmp_path, monkeypatch):
    """Two OCR datasets: 'train' with scans h1 to h4, 'held' with h5, h6 and a copy of h4.
    Each page has two checked lines, ids from the page id times ten."""
    from tests.test_train_snapshot import seed_ocr_pages
    monkeypatch.setattr('app.config.TRAININGS_DIR', tmp_path / 'trainings')
    monkeypatch.setattr(preflight, 'input_size', lambda conn, request: (None, None))
    monkeypatch.setattr(preflight, 'default_epochs', lambda conn, task, base_model_id: None)
    conn = store.connect(tmp_path / 'app.db')
    scan = tmp_path / 'scan.png'
    Image.new('RGB', (400, 300), 'white').save(scan)
    seed_ocr_pages(conn, 'train', scan, ['h1', 'h2', 'h3', 'h4'], 2, 1, 10)
    seed_ocr_pages(conn, 'held', scan, ['h5', 'h6', 'h4'], 2, 5, 50)
    conn.execute("UPDATE jobs SET name = 'Zollbuecher' WHERE id = 'held'")
    conn.commit()
    yield conn
    conn.close()


def mark(conn, *page_ids):
    conn.executemany('UPDATE pages SET is_test = 1 WHERE id = ?', [(p,) for p in page_ids])
    conn.commit()


def trained_lines(conn, tmp_path, job_ids, **options) -> set[int]:
    from tests.test_train_snapshot import snapshot_sides
    train_snapshot.build(conn, 7, 'ocr', job_ids, **options)
    return set(snapshot_sides(tmp_path / 'trainings' / '7' / 'snapshot'))


class TestTrainingLeavesTestPagesOut:
    def test_a_test_page_is_never_cut_for_training(self, volumes, tmp_path):
        mark(volumes, 2)

        assert trained_lines(volumes, tmp_path, ['train'], val_fraction=0.25) == {10, 11, 14, 15, 16, 17}

    def test_a_page_with_the_same_scan_as_a_test_page_is_left_out(self, volumes, tmp_path):
        mark(volumes, 7)

        assert trained_lines(volumes, tmp_path, ['train'], val_fraction=0.0) == {10, 11, 12, 13, 14, 15}

    def test_a_holdout_validation_set_leaves_its_test_pages_out_too(self, volumes, tmp_path):
        mark(volumes, 5)

        lines = trained_lines(volumes, tmp_path, ['train'], split_strategy='holdout', valid_job_ids=['held'])

        assert lines == {10, 11, 12, 13, 14, 15, 16, 17, 52, 53, 54, 55}

    def test_the_validation_fraction_is_taken_of_the_pages_that_can_train(self, volumes, tmp_path):
        """h2 ranks first, so were the test page still counted it would take the one
        validation place and leave the split with nothing to validate on."""
        from tests.test_train_snapshot import snapshot_sides
        mark(volumes, 2)
        train_snapshot.build(volumes, 7, 'ocr', ['train'], val_fraction=1 / 3)

        sides = snapshot_sides(tmp_path / 'trainings' / '7' / 'snapshot')
        assert {line for line, side in sides.items() if side == 'valid'} == {16, 17}


class TestTheRunsTestSet:
    def test_a_layout_run_is_scored_on_the_test_pages_alone(self, volumes, tmp_path):
        volumes.execute("UPDATE pages SET layout_checked = 1")
        volumes.commit()
        mark(volumes, 5, 6)

        counts = train_snapshot.build(volumes, 7, 'layout', ['train'], val_fraction=0.0,
                                      test_job_ids=['held'])

        assert counts == {'train': 4, 'val': 0, 'test': 2}

    def test_a_dataset_may_train_on_some_pages_and_test_on_others(self, volumes, tmp_path):
        mark(volumes, 4)

        counts = train_snapshot.build(volumes, 7, 'lines', ['train'], val_fraction=0.0,
                                      test_job_ids=['train'])

        assert counts == {'train': 3, 'val': 0, 'test': 1}

    def test_an_ocr_runs_test_evaluation_reads_only_test_pages(self, volumes):
        mark(volumes, 5)

        lines = [crop.line_id for batch in eval_material.job_batches(volumes, ['held'], test_pages_only=True)
                 for crop in batch]

        assert lines == [50, 51]


class TestThePreflight:
    def test_it_counts_the_test_set_by_its_test_pages(self, volumes):
        mark(volumes, 5)

        split = preflight.compute(volumes, {'task': 'ocr', 'dataset_job_ids': ['train'],
                                            'val_fraction': 0.0, 'test_job_ids': ['held']})['split']

        assert split['totals']['test'] == {'pages': 1, 'items': 2}
        assert split['totals']['train'] == {'pages': 4, 'items': 8}

    def test_it_reports_the_pages_left_out_and_where_their_test_pages_are(self, volumes):
        mark(volumes, 7)

        result = preflight.compute(volumes, {'task': 'ocr', 'dataset_job_ids': ['train'], 'val_fraction': 0.0})

        assert result['split']['left_out'] == [{'job_id': 'held', 'name': 'Zollbuecher', 'pages': 1}]
        assert result['split']['totals']['train'] == {'pages': 3, 'items': 6}
        [finding] = [f for f in result['findings'] if f['code'] == 'left_out']
        assert finding['message'] == '1 page left out: same scan as test pages in Zollbuecher'


@pytest.fixture
def scoring(volumes, monkeypatch):
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    volumes.execute("UPDATE jobs SET owner = 'alice'")
    volumes.execute("INSERT INTO models (id, task, name, checkpoint) VALUES (9, 'ocr', 'Reader', '/c')")
    volumes.commit()
    app.dependency_overrides[get_db] = lambda: volumes
    yield TestClient(app), volumes
    app.dependency_overrides.clear()


def evaluate(api, job_ids, **body):
    return api.post('/api/evaluations', json={'model_id': 9, 'job_ids': job_ids, **body}, headers=OWNER)


class TestEvaluating:
    def test_a_dataset_with_test_pages_is_scored_on_them_by_default(self, scoring):
        api, conn = scoring
        mark(conn, 5)

        response = evaluate(api, ['held'])

        assert response.status_code == 200, response.text
        assert response.json()['source'] == {'jobs': ['held'], 'test_pages': True}

    def test_all_pages_can_be_asked_for_instead(self, scoring):
        api, conn = scoring
        mark(conn, 5)

        assert evaluate(api, ['held'], pages='all').json()['source'] == {'jobs': ['held']}

    def test_a_dataset_without_test_pages_is_scored_on_all_of_them(self, scoring):
        api, _ = scoring
        assert evaluate(api, ['held']).json()['source'] == {'jobs': ['held']}

    def test_test_pages_without_checked_lines_are_refused(self, scoring):
        api, conn = scoring
        mark(conn, 5)
        conn.execute('UPDATE lines SET checked = 0 WHERE id IN (50, 51)')
        conn.commit()

        response = evaluate(api, ['held'], pages='test')

        assert response.status_code == 400
        assert response.json()['detail'] == 'the test pages of the selected datasets contain no checked lines'

    def test_the_list_says_it_was_scored_on_test_pages(self, scoring):
        api, conn = scoring
        mark(conn, 5)
        evaluate(api, ['held'])

        [row] = api.get('/api/evaluations', headers=OWNER).json()['evaluations']

        assert row['source_label'] == 'test pages of Zollbuecher'


class TestThePageTable:
    def test_rows_carry_the_flag_and_a_chip_lists_the_test_pages(self, client):
        api, _ = client
        api.get('/api/jobs/j1/page-rows', headers=OWNER)

        api.post('/api/jobs/j1/test-pages', json={'page_ids': [3], 'test': True}, headers=OWNER)

        body = api.get('/api/jobs/j1/page-rows?filter=test-pages', headers=OWNER).json()
        assert [(row['id'], row['is_test']) for row in body['rows']] == [(3, True)]
        assert body['counts']['test-pages'] == 1
