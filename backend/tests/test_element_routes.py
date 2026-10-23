"""Editing the boxes on a page: class, geometry, review state, and the two operations that
move lines between boxes. A split or a merge that loses a line loses transcription work, so
where every line ends up is the assertion, not how many boxes came back.
"""
import json

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app import candidates, store
from app.deps import get_db
from app.main import app

SECRET = 'test-secret'
ADMIN = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'root', 'X-Auth-Role': 'admin'}
ALICE = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'alice', 'X-Auth-Role': 'member'}
BOB = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'bob', 'X-Auth-Role': 'member'}
VIEWER = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'vera', 'X-Auth-Role': 'viewer'}


def quad(x0, y0, x1, y1):
    return json.dumps([[x0, y0], [x1, y0], [x1, y1], [x0, y1]])


@pytest.fixture
def scan(tmp_path):
    path = tmp_path / 'p1.png'
    Image.new('RGB', (400, 200), 'white').save(path)
    return path


@pytest.fixture
def conn(tmp_path, scan, monkeypatch):
    monkeypatch.setattr('app.config.JOBS_DIR', tmp_path / 'jobs')
    connection = store.connect(tmp_path / 'app.db')
    connection.executescript(f"""
        INSERT INTO jobs (id, name, owner, status) VALUES ('j1', 'Volume', 'alice', 'done');
        INSERT INTO pages (id, job_id, idx, filename, source_file, status, width, height)
            VALUES (1, 'j1', 0, 'p1.png', '{scan}', 'done', 400, 200);
        INSERT INTO elements (id, page_id, order_idx, class_name, raw_class_name, bbox, kind)
            VALUES (1, 1, 0, 'Paragraph', 'Paragraph', '[0.0,0.0,1.0,0.5]', 'content'),
                   (2, 1, 1, 'Paragraph', 'Paragraph', '[0.0,0.5,1.0,1.0]', 'content');
        INSERT INTO lines (id, element_id, order_idx, polygon, text) VALUES
            (1, 1, 0, '{quad(0.05, 0.05, 0.4, 0.15)}', 'Left of the cut'),
            (2, 1, 1, '{quad(0.6, 0.05, 0.95, 0.15)}', 'Right of the cut'),
            (3, 2, 0, '{quad(0.05, 0.6, 0.4, 0.7)}', 'In the second box');
    """)
    connection.commit()
    yield connection
    connection.close()


@pytest.fixture
def client(conn, monkeypatch):
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    app.dependency_overrides[get_db] = lambda: conn
    yield TestClient(app)
    app.dependency_overrides.clear()


def element(conn, element_id):
    return conn.execute('SELECT * FROM elements WHERE id = ?', (element_id,)).fetchone()


def lines_of(conn, element_id):
    return [r['text'] for r in conn.execute(
        'SELECT text FROM lines WHERE element_id = ? AND deleted = 0 ORDER BY order_idx',
        (element_id,))]


class TestEditingOne:
    def test_its_class_can_be_changed(self, client, conn):
        response = client.patch('/api/elements/1', json={'class_name': 'Header'}, headers=ALICE)

        assert response.status_code == 200, response.text
        assert element(conn, 1)['class_name'] == 'Header'

    def test_a_class_nobody_defined_is_refused_by_name(self, client):
        response = client.patch('/api/elements/1', json={'class_name': 'Nonsense'}, headers=ALICE)

        assert response.status_code == 400
        assert 'Nonsense' in response.json()['detail']

    def test_its_box_can_be_moved(self, client, conn):
        client.patch('/api/elements/1', json={'bbox': [0.1, 0.1, 0.9, 0.4]}, headers=ALICE)

        assert json.loads(element(conn, 1)['bbox']) == [0.1, 0.1, 0.9, 0.4]

    def test_a_box_outside_the_page_is_refused(self, client):
        assert client.patch('/api/elements/1', json={'bbox': [0.1, 0.1, 2.0, 0.4]},
                            headers=ALICE).status_code == 400

    def test_checking_a_box_checks_the_lines_under_it(self, client, conn):
        """The box is a container for review: ticking it is ticking its contents."""
        client.patch('/api/elements/1', json={'checked': True}, headers=ALICE)

        assert element(conn, 1)['checked'] == 1
        assert [r['checked'] for r in conn.execute(
            'SELECT checked FROM lines WHERE element_id = 1')] == [1, 1]

    def test_unchecking_it_takes_the_lines_back_with_it(self, client, conn):
        client.patch('/api/elements/1', json={'checked': True}, headers=ALICE)

        client.patch('/api/elements/1', json={'checked': False}, headers=ALICE)

        assert [r['checked'] for r in conn.execute(
            'SELECT checked FROM lines WHERE element_id = 1')] == [0, 0]

    def test_checking_a_box_makes_the_lines_the_models_settled_the_persons(self, client, conn):
        conn.execute("UPDATE lines SET checked = 1, check_source = 'llm' WHERE id IN (1, 3)")
        conn.commit()

        client.patch('/api/elements/1', json={'checked': True}, headers=ALICE)

        assert [tuple(r) for r in conn.execute(
            'SELECT id, checked, check_source FROM lines ORDER BY id')] == [
            (1, 1, None), (2, 1, None), (3, 1, 'llm')]

    def test_unchecking_a_box_leaves_no_machine_check_behind(self, client, conn):
        conn.execute("UPDATE lines SET checked = 1, check_source = 'llm' WHERE id IN (1, 3)")
        conn.commit()

        client.patch('/api/elements/1', json={'checked': False}, headers=ALICE)

        assert [tuple(r) for r in conn.execute(
            'SELECT id, checked, check_source FROM lines ORDER BY id')] == [
            (1, 0, None), (2, 0, None), (3, 1, 'llm')]

    def test_the_edit_is_written_to_the_history(self, client):
        client.patch('/api/elements/1', json={'class_name': 'Header'}, headers=ALICE)

        history = client.get('/api/elements/1/revisions', headers=ALICE).json()

        # Newest first: the edit, and before it how the row stood when the pipeline left it.
        assert [r['action'] for r in history] == ['update', 'origin']
        assert [r['author'] for r in history] == ['alice', 'alice']
        assert history[1]['snapshot']['class_name'] == 'Paragraph'

    def test_an_element_that_does_not_exist_is_a_404(self, client):
        assert client.patch('/api/elements/99', json={'checked': True},
                            headers=ALICE).status_code == 404


class TestTwoPeopleAtOnce:
    def test_an_edit_against_a_stale_revision_is_refused(self, client, conn):
        conn.execute("INSERT INTO job_assignees (job_id, username) VALUES ('j1', 'bob')")
        conn.commit()
        client.patch('/api/elements/1', json={'class_name': 'Header'}, headers=ALICE)

        stale = client.patch('/api/elements/1', json={'class_name': 'Table', 'revision': 0},
                             headers=BOB)

        assert stale.status_code == 409
        assert stale.json()['detail']['author'] == 'alice', 'it names who got there first'
        assert element(conn, 1)['class_name'] == 'Header', 'the first edit stands'

    def test_an_edit_carrying_the_current_revision_goes_through(self, client, conn):
        current = client.patch('/api/elements/1', json={'class_name': 'Header'},
                               headers=ALICE).json()

        again = client.patch('/api/elements/1',
                             json={'class_name': 'Table', 'revision': current['revision']},
                             headers=ALICE)

        assert again.status_code == 200
        assert element(conn, 1)['class_name'] == 'Table'


class TestDrawingAndRemoving:
    def test_a_hand_drawn_box_arrives_reviewed(self, client, conn):
        """A person drew it, so nobody needs to confirm it afterwards."""
        response = client.post('/api/pages/1/elements',
                               json={'class_name': 'Header', 'bbox': [0.1, 0.1, 0.3, 0.2]},
                               headers=ALICE)

        assert response.status_code == 200, response.text
        assert element(conn, response.json()['id'])['checked'] == 1

    def test_it_is_read_where_it_stands(self, client, conn):
        new_id = client.post('/api/pages/1/elements',
                             json={'class_name': 'Header', 'bbox': [0.1, 0.45, 0.9, 0.5]},
                             headers=ALICE).json()['id']

        assert reading_order(conn) == [(1, 0), (new_id, 1), (2, 2)]

    def test_a_class_nobody_defined_cannot_be_drawn(self, client):
        assert client.post('/api/pages/1/elements',
                           json={'class_name': 'Nonsense', 'bbox': [0.1, 0.1, 0.3, 0.2]},
                           headers=ALICE).status_code == 400

    def test_nothing_can_be_drawn_on_a_deleted_page(self, client, conn):
        conn.execute('UPDATE pages SET deleted = 1 WHERE id = 1')
        conn.commit()

        response = client.post('/api/pages/1/elements',
                               json={'class_name': 'Header', 'bbox': [0.1, 0.1, 0.3, 0.2]},
                               headers=ALICE)

        assert response.status_code == 409

    def test_deleting_is_soft_so_it_can_be_taken_back(self, client, conn):
        assert client.delete('/api/elements/1', headers=ALICE).status_code == 200

        assert element(conn, 1)['deleted'] == 1
        assert client.patch('/api/elements/1', json={'deleted': False},
                            headers=ALICE).status_code == 200
        assert element(conn, 1)['deleted'] == 0

    def test_deleting_one_that_does_not_exist_is_a_404(self, client):
        assert client.delete('/api/elements/99', headers=ALICE).status_code == 404

    def test_deleting_a_box_deletes_the_lines_under_it(self, client, conn):
        client.delete('/api/elements/1', headers=ALICE)

        assert [(r['id'], r['deleted']) for r in conn.execute(
            'SELECT id, deleted FROM lines ORDER BY id')] == [(1, 1), (2, 1), (3, 0)]

    def test_deleting_a_box_hands_its_lines_readings_back(self, client, conn):
        """As deleting a line does: a reading stays in the pool, waiting for a line,
        rather than attached to one nobody can see."""
        for line_id, text in ((1, 'Left of the cut'), (2, 'Right of the cut'), (3, 'In the second box')):
            candidates.add(conn, 1, 'llm:reader', text, line_id=line_id, order_idx=line_id)
        conn.commit()

        client.delete('/api/elements/1', headers=ALICE)

        assert [(r['text'], r['line_id']) for r in conn.execute(
            'SELECT text, line_id FROM candidates ORDER BY id')] == [
            ('Left of the cut', None), ('Right of the cut', None), ('In the second box', 3)]

    def test_deleting_a_box_takes_its_lines_out_of_the_training_data(self, client, monkeypatch):
        queued = []
        monkeypatch.setattr('app.training.enqueue', queued.append)

        client.delete('/api/elements/1', headers=ALICE)

        assert queued == [1, 2]


def reading_order(conn):
    return [(r['id'], r['order_idx']) for r in conn.execute(
        'SELECT id, order_idx FROM elements WHERE deleted = 0 ORDER BY order_idx, id')]


def undo(client, span):
    return client.post('/api/pages/1/revert', headers=ALICE,
                       json={'from_revision': span['from'], 'to_revision': span['to'], 'direction': 'undo'})


class TestTheOrderFollowsTheEdit:
    """Element 1 stands above element 2. Every edit of a box works the order out again
    in the same write, so nothing reads a page whose numbers lag behind its boxes."""

    def test_a_box_drawn_above_the_others_is_read_first(self, client, conn):
        conn.execute("UPDATE elements SET bbox = '[0.0,0.2,1.0,0.5]' WHERE id = 1")
        conn.commit()

        new_id = client.post('/api/pages/1/elements', json={'class_name': 'Header', 'bbox': [0.1, 0.05, 0.9, 0.15]},
                             headers=ALICE).json()['id']

        assert reading_order(conn) == [(new_id, 0), (1, 1), (2, 2)]

    def test_moving_a_box_below_another_swaps_them(self, client, conn):
        client.patch('/api/elements/1', json={'bbox': [0.0, 0.6, 1.0, 0.9]}, headers=ALICE)

        assert reading_order(conn) == [(2, 0), (1, 1)]

    def test_the_renumbering_is_the_systems_and_inside_the_edits_span(self, client, conn):
        span = client.patch('/api/elements/1', json={'bbox': [0.0, 0.6, 1.0, 0.9]}, headers=ALICE).json()['span']

        renumbered = conn.execute(
            "SELECT id, author, json_extract(snapshot, '$.order_idx') AS order_idx FROM revisions "
            "WHERE target_type = 'element' AND target_id = 2 AND action = 'update'").fetchall()
        assert [(r['author'], r['order_idx']) for r in renumbered] == [('system:reading-order', 0)]
        assert span['from'] < renumbered[0]['id'] <= span['to']

    def test_undoing_the_move_puts_the_order_back(self, client, conn):
        span = client.patch('/api/elements/1', json={'bbox': [0.0, 0.6, 1.0, 0.9]}, headers=ALICE).json()['span']

        assert undo(client, span).status_code == 200
        assert reading_order(conn) == [(1, 0), (2, 1)]

    def test_deleting_a_box_closes_the_gap_it_leaves(self, client, conn):
        client.delete('/api/elements/1', headers=ALICE)

        assert reading_order(conn) == [(2, 0)]

    def test_a_box_reclassed_as_a_column_takes_the_box_inside_it(self, client, conn):
        # A column numbers among the containers; the paragraph now inside it reads first.
        new_id = client.post('/api/pages/1/elements', json={'class_name': 'Paragraph', 'bbox': [0.1, 0.6, 0.9, 0.7]},
                             headers=ALICE).json()['id']
        client.patch('/api/elements/2', json={'class_name': 'Column'}, headers=ALICE)

        assert reading_order(conn) == [(1, 0), (2, 0), (new_id, 1)]

    def test_a_box_merged_away_leaves_no_gap(self, client, conn):
        third = client.post('/api/pages/1/elements', json={'class_name': 'Paragraph', 'bbox': [0.1, 0.45, 0.9, 0.5]},
                            headers=ALICE).json()['id']

        client.post('/api/elements/merge', json={'ids': [2, third]}, headers=ALICE)

        assert reading_order(conn) == [(1, 0), (third, 1)]


class TestSplitting:
    def test_a_vertical_cut_sends_each_line_to_the_side_it_sits_on(self, client, conn):
        response = client.post('/api/elements/1/split', json={'cut_x': 0.5}, headers=ALICE)

        assert response.status_code == 200, response.text
        left, right = response.json()['elements']
        assert lines_of(conn, left['id']) == ['Left of the cut']
        assert lines_of(conn, right['id']) == ['Right of the cut']

    def test_a_horizontal_cut_divides_the_box_in_two(self, client, conn):
        response = client.post('/api/elements/1/split', json={'cut_y': 0.25}, headers=ALICE)

        left, right = response.json()['elements']
        assert json.loads(element(conn, left['id'])['bbox']) == [0.0, 0.0, 1.0, 0.25]
        assert json.loads(element(conn, right['id'])['bbox']) == [0.0, 0.25, 1.0, 0.5]

    def test_the_original_keeps_its_id_so_its_history_stays_attached(self, client, conn):
        response = client.post('/api/elements/1/split', json={'cut_x': 0.5}, headers=ALICE)

        assert response.json()['elements'][0]['id'] == 1

    def test_both_halves_remember_what_their_lines_were_found_against(self, client, conn):
        """Otherwise the next line-detection pass calls them stale and wipes the lines
        the split just reassigned."""
        response = client.post('/api/elements/1/split', json={'cut_x': 0.5}, headers=ALICE)

        for half in response.json()['elements']:
            row = element(conn, half['id'])
            assert row['lines_bbox'] == row['bbox']

    def test_the_new_half_stands_right_after_the_one_it_came_from(self, client, conn):
        new_id = client.post('/api/elements/1/split', json={'cut_x': 0.5},
                             headers=ALICE).json()['elements'][1]['id']

        assert [(r['id'], r['order_idx']) for r in conn.execute(
            'SELECT id, order_idx FROM elements ORDER BY order_idx')] == [(1, 0), (new_id, 1), (2, 2)]

    def test_neither_half_claims_a_review_nobody_gave(self, client, conn):
        halves = client.post('/api/elements/1/split', json={'cut_x': 0.5},
                             headers=ALICE).json()['elements']

        assert [element(conn, h['id'])['checked'] for h in halves] == [0, 0]

    def test_a_reviewed_box_stays_reviewed_in_both_halves(self, client, conn):
        conn.execute('UPDATE elements SET checked = 1 WHERE id = 1')
        conn.commit()

        halves = client.post('/api/elements/1/split', json={'cut_x': 0.5},
                             headers=ALICE).json()['elements']

        assert [element(conn, h['id'])['checked'] for h in halves] == [1, 1]

    def test_a_cut_outside_the_box_is_refused(self, client):
        response = client.post('/api/elements/1/split', json={'cut_x': 1.5}, headers=ALICE)

        assert response.status_code == 400
        assert 'inside the box' in response.json()['detail']

    def test_a_horizontal_cut_outside_the_box_is_refused_too(self, client):
        assert client.post('/api/elements/1/split', json={'cut_y': 0.9},
                           headers=ALICE).status_code == 400

    def test_it_takes_exactly_one_cut(self, client):
        assert client.post('/api/elements/1/split', json={}, headers=ALICE).status_code == 400
        assert client.post('/api/elements/1/split', json={'cut_x': 0.5, 'cut_y': 0.25},
                           headers=ALICE).status_code == 400

    def test_a_deleted_element_cannot_be_split(self, client, conn):
        conn.execute('UPDATE elements SET deleted = 1 WHERE id = 1')
        conn.commit()

        assert client.post('/api/elements/1/split', json={'cut_x': 0.5},
                           headers=ALICE).status_code == 404


class TestMerging:
    def test_the_lines_of_both_end_up_in_one_box_in_reading_order(self, client, conn):
        response = client.post('/api/elements/merge', json={'ids': [1, 2]}, headers=ALICE)

        assert response.status_code == 200, response.text
        assert lines_of(conn, response.json()['id']) == [
            'Left of the cut', 'Right of the cut', 'In the second box']

    def test_the_box_that_remains_covers_both(self, client, conn):
        kept = client.post('/api/elements/merge', json={'ids': [1, 2]}, headers=ALICE).json()

        assert json.loads(element(conn, kept['id'])['bbox']) == [0.0, 0.0, 1.0, 1.0]

    def test_the_one_first_in_reading_order_is_the_one_kept(self, client, conn):
        kept = client.post('/api/elements/merge', json={'ids': [2, 1]}, headers=ALICE).json()

        assert kept['id'] == 1
        assert element(conn, 2)['deleted'] == 1

    def test_merging_needs_two(self, client):
        assert client.post('/api/elements/merge', json={'ids': [1]},
                           headers=ALICE).status_code == 400

    def test_boxes_on_different_pages_cannot_be_merged(self, client, conn):
        conn.execute("INSERT INTO pages (id, job_id, idx, filename, source_file, status) "
                     "VALUES (2, 'j1', 1, 'p2.png', '/p2.png', 'done')")
        conn.execute("INSERT INTO elements (id, page_id, order_idx, class_name, bbox, kind) "
                     "VALUES (3, 2, 0, 'Paragraph', '[0,0,1,1]', 'content')")
        conn.commit()

        response = client.post('/api/elements/merge', json={'ids': [1, 3]}, headers=ALICE)

        assert response.status_code == 400
        assert 'share a page' in response.json()['detail']

    def test_a_box_that_does_not_exist_is_a_404(self, client):
        assert client.post('/api/elements/merge', json={'ids': [1, 99]},
                           headers=ALICE).status_code == 404


class TestTheCrop:
    def test_the_crop_is_cut_from_the_scan_and_served(self, client):
        response = client.get('/api/elements/1/crop', headers=ALICE)

        assert response.status_code == 200
        assert response.headers['content-type'] == 'image/jpeg'

    def test_it_is_kept_so_the_second_look_costs_nothing(self, client, tmp_path):
        client.get('/api/elements/1/crop', headers=ALICE)

        assert (tmp_path / 'jobs' / 'j1' / 'crops' / 'element_1.jpg').exists()

    def test_moving_the_box_throws_the_stale_crop_away(self, client, tmp_path):
        client.get('/api/elements/1/crop', headers=ALICE)
        cached = tmp_path / 'jobs' / 'j1' / 'crops' / 'element_1.jpg'
        assert cached.exists()

        client.patch('/api/elements/1', json={'bbox': [0.1, 0.1, 0.9, 0.4]}, headers=ALICE)

        assert not cached.exists()

    def test_a_scan_that_is_gone_says_so_rather_than_serving_nothing(self, client, scan):
        scan.unlink()

        response = client.get('/api/elements/1/crop', headers=ALICE)

        assert response.status_code == 404
        assert 'source image missing' in response.json()['detail']

    def test_an_element_that_does_not_exist_is_a_404(self, client):
        assert client.get('/api/elements/99/crop', headers=ALICE).status_code == 404


class TestWhoMayEdit:
    def test_a_stranger_is_not_told_the_element_exists(self, client):
        assert client.patch('/api/elements/1', json={'checked': True},
                            headers=BOB).status_code == 404
        assert client.get('/api/elements/1/crop', headers=BOB).status_code == 404

    def test_someone_it_was_shared_with_may_edit_it(self, client, conn):
        conn.execute("INSERT INTO job_assignees (job_id, username) VALUES ('j1', 'bob')")
        conn.commit()

        assert client.patch('/api/elements/1', json={'checked': True},
                            headers=BOB).status_code == 200

    def test_someone_who_may_only_look_cannot_change_anything(self, client):
        response = client.patch('/api/elements/1', json={'checked': True}, headers=VIEWER)

        assert response.status_code == 403
        assert response.json()['detail'] == 'read-only account'


class TestPolygonElements:
    """A polygon dataset's elements are outlines, reshaped like a line; its box is their
    bounds, and a box dataset keeps any outline on file for when it switches back."""

    def _element(self, conn, element_id):
        row = conn.execute('SELECT bbox, polygon FROM elements WHERE id = ?', (element_id,)).fetchone()
        return json.loads(row['bbox']), json.loads(row['polygon']) if row['polygon'] else None

    def _polygons(self, client):
        assert client.patch('/api/jobs/j1', json={'layout_shape': 'polygon'}, headers=ALICE).status_code == 200

    def test_switching_on_gives_every_box_its_four_corners_and_off_keeps_them(self, client, conn):
        self._polygons(client)
        assert self._element(conn, 1) == ([0.0, 0.0, 1.0, 0.5], [[0.0, 0.0], [1.0, 0.0], [1.0, 0.5], [0.0, 0.5]])
        page = client.get('/api/jobs/j1/pages/1', headers=ALICE).json()
        assert page['elements'][0]['polygon'] == [[0.0, 0.0], [1.0, 0.0], [1.0, 0.5], [0.0, 0.5]]
        assert client.get('/api/jobs/j1', headers=ALICE).json()['layout_shape'] == 'polygon'

        client.patch('/api/jobs/j1', json={'layout_shape': 'box'}, headers=ALICE)
        assert self._element(conn, 1)[1] == [[0.0, 0.0], [1.0, 0.0], [1.0, 0.5], [0.0, 0.5]]

    def test_only_the_owner_switches_and_only_to_a_shape_there_is(self, client):
        assert client.patch('/api/jobs/j1', json={'layout_shape': 'polygon'}, headers=BOB).status_code in (403, 404)
        assert client.patch('/api/jobs/j1', json={'layout_shape': 'circle'}, headers=ALICE).status_code == 400

    def test_a_reshaped_outline_makes_its_bounds_the_box(self, client, conn):
        self._polygons(client)
        outline = [[0.1, 0.1], [0.8, 0.05], [0.9, 0.4], [0.2, 0.45], [0.05, 0.3]]

        response = client.patch('/api/elements/1', json={'polygon': outline}, headers=ALICE)

        assert response.status_code == 200, response.text
        assert self._element(conn, 1) == ([0.05, 0.05, 0.9, 0.45], outline)
        assert response.json()['polygon'] == outline
        # Undone, the outline it had comes back.
        span = response.json()['span']
        client.post('/api/pages/1/revert', json={'from_revision': span['from'], 'to_revision': span['to'],
                                                 'direction': 'undo'}, headers=ALICE)
        assert self._element(conn, 1)[1] == [[0.0, 0.0], [1.0, 0.0], [1.0, 0.5], [0.0, 0.5]]

    def test_an_outline_of_two_points_is_refused(self, client):
        self._polygons(client)
        assert client.patch('/api/elements/1', json={'polygon': [[0, 0], [1, 1]]}, headers=ALICE).status_code == 400

    def test_a_box_moved_in_box_mode_carries_its_kept_outline_with_it(self, client, conn):
        self._polygons(client)
        client.patch('/api/jobs/j1', json={'layout_shape': 'box'}, headers=ALICE)

        client.patch('/api/elements/1', json={'bbox': [0.0, 0.0, 0.5, 0.5]}, headers=ALICE)

        assert self._element(conn, 1)[1] == [[0.0, 0.0], [0.5, 0.0], [0.5, 0.5], [0.0, 0.5]]

    def test_drawing_in_polygon_mode_takes_a_box_or_an_outline(self, client, conn):
        self._polygons(client)
        boxed = client.post('/api/pages/1/elements', json={'class_name': 'Paragraph', 'bbox': [0.1, 0.1, 0.2, 0.2]},
                            headers=ALICE).json()
        drawn = client.post('/api/pages/1/elements', json={
            'class_name': 'Paragraph', 'polygon': [[0.3, 0.3], [0.5, 0.35], [0.4, 0.45]]}, headers=ALICE).json()

        assert boxed['polygon'] == [[0.1, 0.1], [0.2, 0.1], [0.2, 0.2], [0.1, 0.2]]
        assert drawn['bbox'] == [0.3, 0.3, 0.5, 0.45]
        assert client.post('/api/pages/1/elements', json={'class_name': 'Paragraph'},
                           headers=ALICE).status_code == 400

    def test_a_split_cuts_the_outline_and_a_merge_wraps_both(self, client, conn):
        self._polygons(client)
        client.patch('/api/elements/1', json={'polygon': [[0.0, 0.0], [1.0, 0.0], [0.6, 0.5], [0.0, 0.5]]},
                     headers=ALICE)

        halves = client.post('/api/elements/1/split', json={'cut_x': 0.5}, headers=ALICE).json()['elements']

        left, right = (self._element(conn, h['id']) for h in halves)
        assert left == ([0.0, 0.0, 0.5, 0.5], [[0.0, 0.0], [0.5, 0.0], [0.5, 0.5], [0.0, 0.5]])
        assert right[0] == [0.5, 0.0, 1.0, 0.5]
        assert len(right[1]) == 4 and [1.0, 0.0] in right[1]

        client.post('/api/elements/merge', json={'ids': [h['id'] for h in halves]}, headers=ALICE)
        merged = self._element(conn, halves[0]['id'])
        assert merged[0] == [0.0, 0.0, 1.0, 0.5]
        assert sorted(map(tuple, merged[1])) == [(0.0, 0.0), (0.0, 0.5), (0.6, 0.5), (1.0, 0.0)]
