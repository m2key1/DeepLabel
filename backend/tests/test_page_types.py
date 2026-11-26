"""Page types (#40): every text dataset has its own copy of five, renamed and switched as it
likes. A type switches steps off for its pages the way the dataset's own switches do for all
of them, and a page line detection found nothing on is offered as blank, never made one."""
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app import metadata, ocr_phase, page_rows, page_types, store, text_job
from app.deps import get_db
from app.main import app

SECRET = 'test-secret'
ALICE = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'alice', 'X-Auth-Role': 'member'}
BOB = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'bob', 'X-Auth-Role': 'member'}
RUNNER = {**ALICE, 'X-Auth-Caps': 'pipeline.layout pipeline.lines pipeline.ocr'}
TEXT, COVER, BLANK = 1, 2, 3
LINE = '[[0.1,0.1],[0.9,0.1],[0.9,0.2],[0.1,0.2]]'


@pytest.fixture
def conn(tmp_path, monkeypatch):
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    scan = tmp_path / 'p.png'
    Image.new('RGB', (400, 200), 'white').save(scan)
    connection = store.connect(tmp_path / 'app.db')
    # Page 1 is read, 2 waits for its reading, 3 is one line detection found nothing on.
    connection.executescript(f"""
        INSERT INTO jobs (id, name, owner, status, task) VALUES
            ('j1', 'Volume', 'alice', 'done', 'text'),
            ('j2', 'Other', 'alice', 'done', 'text'),
            ('m1', 'Map', 'alice', 'done', 'map_segmentation');
        INSERT INTO pages (id, job_id, idx, filename, source_file, status, width, height) VALUES
            (1, 'j1', 0, 'a.png', '{scan}', 'done', 400, 200),
            (2, 'j1', 1, 'b.png', '{scan}', 'lines_done', 400, 200),
            (3, 'j1', 2, 'c.png', '{scan}', 'lines_done', 400, 200),
            (9, 'j2', 0, 'z.png', '{scan}', 'done', 400, 200);
        INSERT INTO elements (id, page_id, order_idx, class_name, bbox, kind) VALUES
            (1, 1, 0, 'Paragraph', '[0,0,1,1]', 'content'),
            (2, 2, 0, 'Paragraph', '[0,0,1,1]', 'content');
        INSERT INTO lines (id, element_id, order_idx, polygon, text) VALUES
            (1, 1, 0, '{LINE}', 'read'), (2, 2, 0, '{LINE}', NULL);
    """)
    connection.commit()
    yield connection
    connection.close()


@pytest.fixture
def api(conn):
    app.dependency_overrides[get_db] = lambda: conn
    yield TestClient(app)
    app.dependency_overrides.clear()


def types_of(conn, job_id='j1'):
    return [(t['id'], t['name'], t['run_layout'], t['run_lines'], t['run_ocr']) for t in page_types.listed(conn, job_id)]


def page_type(conn, page_id):
    return conn.execute('SELECT page_type FROM pages WHERE id = ?', (page_id,)).fetchone()[0]


def assign(conn, type_id, *page_ids):
    conn.executemany('UPDATE pages SET page_type = ? WHERE id = ?', [(type_id, page_id) for page_id in page_ids])
    conn.commit()


class TestEveryDatasetHasItsOwn:
    def test_a_text_dataset_starts_with_five_and_covers_and_blanks_are_not_read(self, conn):
        assert types_of(conn) == [
            (1, 'Text', True, True, True), (2, 'Cover', True, True, False), (3, 'Blank', True, True, False),
            (4, 'Table', True, True, True), (5, 'Image', True, True, True)]

    def test_a_map_dataset_has_none(self, conn):
        assert types_of(conn, 'm1') == []

    def test_renaming_one_leaves_every_other_dataset_alone(self, api, conn):
        response = api.patch(f'/api/jobs/j1/page-types/{COVER}', json={'name': 'Einband'}, headers=ALICE)

        assert response.status_code == 200, response.text
        assert types_of(conn)[1] == (2, 'Einband', True, True, False)
        assert types_of(conn, 'j2')[1] == (2, 'Cover', True, True, False)

    def test_a_type_can_switch_a_step_back_on(self, api, conn):
        assert api.patch(f'/api/jobs/j1/page-types/{COVER}', json={'run_ocr': True}, headers=ALICE).status_code == 200
        assert types_of(conn)[1] == (2, 'Cover', True, True, True)

    def test_turning_line_detection_off_takes_reading_with_it(self, api, conn):
        """Reading reads the lines found, as a dataset's own switches have it: a type reading
        without them would hold its pages after layout, never read (#169)."""
        response = api.patch(f'/api/jobs/j1/page-types/{TEXT}', json={'run_lines': False}, headers=ALICE)

        assert (response.json()['run_lines'], response.json()['run_ocr']) == (False, False)
        assert types_of(conn)[0] == (1, 'Text', True, False, False)

    def test_reading_is_not_switched_on_without_lines(self, api, conn):
        api.patch(f'/api/jobs/j1/page-types/{TEXT}', json={'run_lines': False}, headers=ALICE)

        response = api.patch(f'/api/jobs/j1/page-types/{TEXT}', json={'run_ocr': True}, headers=ALICE)

        assert response.json()['run_ocr'] is False
        assert types_of(conn)[0] == (1, 'Text', True, False, False)

    def test_two_types_of_one_dataset_cannot_share_a_name(self, api):
        response = api.patch(f'/api/jobs/j1/page-types/{COVER}', json={'name': ' blank '}, headers=ALICE)

        assert (response.status_code, response.json()['detail']) == (409, 'this dataset already has a page type "blank"')

    def test_a_name_of_nothing_is_refused(self, api):
        assert api.patch(f'/api/jobs/j1/page-types/{COVER}', json={'name': '  '}, headers=ALICE).status_code == 400

    def test_somebody_who_cannot_manage_the_dataset_may_not(self, api, conn):
        assert api.patch(f'/api/jobs/j1/page-types/{COVER}', json={'name': 'Mine'}, headers=BOB).status_code == 404
        assert types_of(conn)[1][1] == 'Cover'

    def test_the_list_says_how_many_pages_each_has(self, api, conn):
        assign(conn, COVER, 1)

        listed = api.get('/api/jobs/j1/page-types', headers=ALICE).json()['types']

        assert [(t['name'], t['pages']) for t in listed] == \
            [('Text', 2), ('Cover', 1), ('Blank', 0), ('Table', 0), ('Image', 0)]


class TestSettingAType:
    def test_a_selection_takes_one(self, api, conn):
        response = api.post('/api/jobs/j1/pages/type', json={'page_ids': [1, 2], 'type_id': COVER}, headers=ALICE)

        assert response.status_code == 200, response.text
        assert (page_type(conn, 1), page_type(conn, 2), page_type(conn, 3)) == (COVER, COVER, None)

    def test_none_makes_a_page_text_again(self, api, conn):
        assign(conn, COVER, 1)

        api.post('/api/jobs/j1/pages/type', json={'page_ids': [1], 'type_id': None}, headers=ALICE)

        assert page_type(conn, 1) is None

    def test_a_type_the_dataset_does_not_have_is_refused(self, api, conn):
        response = api.post('/api/jobs/j1/pages/type', json={'page_ids': [1], 'type_id': 9}, headers=ALICE)

        assert response.status_code == 400
        assert page_type(conn, 1) is None

    def test_a_page_of_another_dataset_is_left_alone(self, api, conn):
        api.post('/api/jobs/j1/pages/type', json={'page_ids': [1, 9], 'type_id': COVER}, headers=ALICE)

        assert (page_type(conn, 1), page_type(conn, 9)) == (COVER, None)

    def test_somebody_who_cannot_manage_the_dataset_may_not(self, api, conn):
        response = api.post('/api/jobs/j1/pages/type', json={'page_ids': [1], 'type_id': COVER}, headers=BOB)

        assert response.status_code == 404
        assert page_type(conn, 1) is None


def reader(seen):
    def read(images, contexts):
        seen.extend(contexts)
        return ['text'] * len(images), [0.9] * len(images), [None] * len(images)
    return read


class TestStepsATypeSwitchesOff:
    def test_reading_passes_a_cover_by(self, conn):
        conn.execute("INSERT INTO elements (id, page_id, order_idx, class_name, bbox, kind) "
                     "VALUES (3, 3, 0, 'Paragraph', '[0,0,1,1]', 'content')")
        conn.execute(f"INSERT INTO lines (id, element_id, order_idx, polygon, text) VALUES (3, 3, 0, '{LINE}', NULL)")
        assign(conn, COVER, 3)
        seen = []

        ocr_phase.run(conn, 'j1', reader(seen), 'model:ocr@stub', None, chunk_lines=512)

        texts = dict(conn.execute('SELECT id, text FROM lines').fetchall())
        assert (texts[2], texts[3]) == ('text', None)
        assert len(seen) == 1

    def test_a_type_that_switches_layout_off_is_passed_by_as_if_the_dataset_had(self, conn):
        conn.execute("UPDATE pages SET status = 'ingested' WHERE job_id = 'j1'")
        conn.execute("UPDATE job_page_types SET run_layout = 0 WHERE job_id = 'j1' AND type_id = ?", (COVER,))
        assign(conn, COVER, 2)
        detected = []
        stage = SimpleNamespace(author='model:layout@stub', detect=lambda images, paths: (
            detected.extend(paths) or [SimpleNamespace(content=[], containers=[], ordered=True) for _ in images]))

        text_job.phase_layout(conn, 'j1', stage, batch_size=4)

        assert len(detected) == 2
        rows = {r['id']: (r['status'], r['layout_skipped']) for r in conn.execute("SELECT * FROM pages WHERE job_id = 'j1'")}
        assert rows == {1: ('layout_done', 0), 2: ('layout_done', 1), 3: ('layout_done', 0)}

    def test_line_detection_passes_it_by(self, conn):
        """No stage is touched: the one page waiting for its lines is of a type without them."""
        conn.execute("UPDATE pages SET status = 'done' WHERE job_id = 'j1'")
        conn.execute("UPDATE pages SET status = 'layout_done' WHERE id = 2")
        conn.execute("UPDATE job_page_types SET run_lines = 0 WHERE job_id = 'j1' AND type_id = ?", (COVER,))
        assign(conn, COVER, 2)

        text_job.phase_lines(conn, 'j1', object(), 'per_crop')

        assert conn.execute('SELECT status FROM pages WHERE id = 2').fetchone()[0] == 'layout_done'

    def test_a_step_a_type_switches_off_has_not_missed_its_pages(self, api, conn):
        """Otherwise the dataset would keep offering to run it there."""
        conn.execute("UPDATE pages SET status = 'lines_done' WHERE id = 1")
        assign(conn, COVER, 1)

        assert api.get('/api/jobs/j1/steps-not-run', headers=ALICE).json()['ocr'] == 2


class TestRunningAgain:
    """A re-run or a page run would clear what a type keeps, with nothing to redo it."""

    def test_re_detection_passes_a_type_without_lines_by(self, conn):
        conn.execute("UPDATE job_page_types SET run_lines = 0 WHERE job_id = 'j1' AND type_id = ?", (COVER,))
        conn.execute('UPDATE elements SET lines_bbox = NULL')
        assign(conn, COVER, 2)

        assert [e['page_id'] for e in text_job.stale_elements(conn, 'j1')] == [1]

    def test_re_reading_the_dataset_leaves_a_covers_text_and_status_alone(self, api, conn):
        conn.execute("UPDATE lines SET text = 'cover text' WHERE id = 2")
        conn.execute("UPDATE pages SET status = 'done' WHERE id = 2")
        assign(conn, COVER, 2)

        response = api.post('/api/jobs/j1/rerun', json={'from_phase': 'ocr'}, headers=RUNNER)

        assert response.status_code == 200, response.text
        assert conn.execute('SELECT text FROM lines WHERE id = 2').fetchone()[0] == 'cover text'
        assert conn.execute('SELECT text FROM lines WHERE id = 1').fetchone()[0] is None
        assert dict(conn.execute("SELECT id, status FROM pages WHERE id IN (1, 2)").fetchall()) == \
            {1: 'lines_done', 2: 'done'}

    def test_the_preview_counts_the_pages_the_re_run_takes(self, api, conn):
        assign(conn, COVER, 2)

        preview = api.get('/api/jobs/j1/rerun', params={'from_phase': 'ocr'}, headers=RUNNER).json()

        assert preview['lines'] == 1

    def test_reading_a_cover_on_its_own_is_refused_with_why(self, api, conn):
        assign(conn, COVER, 2)

        response = api.post('/api/jobs/j1/pages/run', json={'phase': 'ocr', 'page_ids': [2]}, headers=RUNNER)

        assert (response.status_code, response.json()['detail']) == \
            (400, 'a Cover page is not read - give it another type first')
        assert conn.execute('SELECT status FROM pages WHERE id = 2').fetchone()[0] == 'lines_done'


def row_of(conn, page_id, page_filter='all'):
    rows = page_rows.fetch(conn, 'j1', task='text', page_filter=page_filter)['rows']
    return next((r for r in rows if r['id'] == page_id), None)


class TestFoundNothing:
    def test_a_page_line_detection_found_nothing_on_is_offered_as_blank(self, conn):
        assert (row_of(conn, 3)['blank_offer'], row_of(conn, 2)['blank_offer'], row_of(conn, 1)['blank_offer']) == \
            (True, False, False)

    def test_it_is_offered_and_not_made_one(self, conn):
        page_rows.fetch(conn, 'j1', task='text')

        assert page_type(conn, 3) is None

    def test_a_page_somebody_gave_a_type_is_not_offered(self, conn):
        assign(conn, 1, 3)

        assert row_of(conn, 3)['blank_offer'] is False

    def test_a_deleted_page_is_not_offered(self, conn):
        conn.execute('UPDATE pages SET deleted = 1 WHERE id = 3')
        conn.commit()

        assert row_of(conn, 3, 'deleted')['blank_offer'] is False

    def test_the_table_lists_the_pages_offered(self, conn):
        listed = page_rows.fetch(conn, 'j1', task='text', page_filter='found-nothing')

        assert ([r['id'] for r in listed['rows']], listed['matched']) == ([3], 1)


class TestTheTableByType:
    def test_a_type_lists_its_pages_and_unset_ones_count_as_text(self, conn):
        assign(conn, COVER, 2)

        covers = page_rows.fetch(conn, 'j1', task='text', page_filter=f'type:{COVER}')
        text = page_rows.fetch(conn, 'j1', task='text', page_filter='type:1')

        assert ([r['id'] for r in covers['rows']], covers['matched']) == ([2], 1)
        assert [r['id'] for r in text['rows']] == [1, 3]
        assert row_of(conn, 2)['page_type'] == COVER

    def test_the_chips_count_each_type(self, conn):
        assign(conn, COVER, 2)
        page_rows.forget_counts()

        counts = page_rows.counts(conn, 'j1', task='text')

        assert (counts['type:1'], counts['type:2'], counts['type:3'], counts['found-nothing']) == (2, 1, 0, 1)

    def test_the_table_sorts_by_type_with_unset_pages_as_text(self, conn):
        assign(conn, COVER, 1)
        assign(conn, 1, 3)

        rows = page_rows.fetch(conn, 'j1', task='text', sort='type')['rows']

        assert [r['id'] for r in rows] == [2, 3, 1]
