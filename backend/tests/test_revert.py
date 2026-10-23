import json
import threading
import time

import pytest
from fastapi.testclient import TestClient

from app import caches, candidates, revert as revert_module, store
from app.deps import get_db
from app.main import app

SECRET = 'test-secret'
ALICE = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'alice', 'X-Auth-Role': 'member'}
BOB = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'bob', 'X-Auth-Role': 'member'}
MALLORY = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'mallory', 'X-Auth-Role': 'member'}

LINE_1 = [[0, 0], [1, 0], [1, 0.2], [0, 0.2]]
LINE_2 = [[0, 0.25], [1, 0.25], [1, 0.45], [0, 0.45]]
LINE_4 = [[0, 0.55], [1, 0.55], [1, 0.75], [0, 0.75]]
RESHAPED = [[0.1, 0], [0.9, 0], [0.9, 0.2], [0.1, 0.2]]
TRIANGLE = [[0.1, 0.1], [0.2, 0.1], [0.2, 0.2]]


@pytest.fixture
def stack(tmp_path, monkeypatch):
    """Alice's dataset, shared with Bob. Page 1 holds two elements the pipeline wrote -
    the upper one with lines 1 and 2, the lower one with line 4 - and one region; page 2
    has a line of its own; page 3 carries nothing. Nothing has been edited, so no row has
    a revision yet."""
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    monkeypatch.setattr('app.config.DB_PATH', tmp_path / 'app.db')
    monkeypatch.setattr('app.config.JOBS_DIR', tmp_path / 'jobs')
    monkeypatch.setattr('app.config.SAVE_OCR_DATA', False)
    conn = store.connect(tmp_path / 'app.db')
    conn.execute("INSERT INTO jobs (id, name, owner, status, task) "
                 "VALUES ('j', 'Shared', 'alice', 'done', 'map_segmentation')")
    conn.execute("INSERT INTO job_assignees (job_id, username) VALUES ('j', 'bob')")
    for page_id, idx in ((1, 0), (2, 1), (3, 2)):
        conn.execute("INSERT INTO pages (id, job_id, idx, filename, source_file, status) "
                     "VALUES (?, 'j', ?, ?, '/nonexistent.png', 'done')", (page_id, idx, f'p{page_id}.png'))
    conn.execute("INSERT INTO elements (id, page_id, order_idx, class_name, bbox, kind) "
                 "VALUES (1, 1, 0, 'Paragraph', '[0,0,1,0.5]', 'content')")
    conn.execute("INSERT INTO elements (id, page_id, order_idx, class_name, bbox, kind) "
                 "VALUES (2, 2, 0, 'Paragraph', '[0,0,1,1]', 'content')")
    conn.execute("INSERT INTO elements (id, page_id, order_idx, class_name, bbox, kind) "
                 "VALUES (3, 1, 1, 'Paragraph', '[0,0.5,1,1]', 'content')")
    conn.executemany("INSERT INTO lines (id, element_id, order_idx, polygon, text) VALUES (?, ?, ?, ?, ?)", [
        (1, 1, 0, json.dumps(LINE_1), 'first'),
        (2, 1, 1, json.dumps(LINE_2), 'second'),
        (3, 2, 0, '[[0,0],[1,0],[1,1],[0,1]]', 'other page'),
        (4, 3, 0, json.dumps(LINE_4), 'fourth'),
    ])
    store.seed_job_classes(conn, 'j', [{'id': 1, 'name': 'water', 'color': [0, 0, 255], 'priority': 0}])
    conn.execute("INSERT INTO regions (id, page_id, order_idx, class_id, points, holes, kind) "
                 "VALUES (1, 1, 0, 1, ?, '[]', 'polygon')", (json.dumps(TRIANGLE),))
    conn.commit()
    app.dependency_overrides[get_db] = lambda: conn
    yield TestClient(app), conn
    app.dependency_overrides.clear()
    conn.close()


def revert(client, page_id, span, direction, headers=ALICE):
    return client.post(f'/api/pages/{page_id}/revert', headers=headers,
                       json={'from_revision': span['from'], 'to_revision': span['to'],
                             'direction': direction})


def undo(client, page_id, span, headers=ALICE):
    return revert(client, page_id, span, 'undo', headers)


def redo(client, page_id, span, headers=ALICE):
    return revert(client, page_id, span, 'redo', headers)


def actions(conn, kind, target_id):
    return [r['action'] for r in conn.execute(
        'SELECT action FROM revisions WHERE target_type = ? AND target_id = ? ORDER BY id',
        (kind, target_id))]


def line(conn, line_id):
    return conn.execute('SELECT * FROM lines WHERE id = ?', (line_id,)).fetchone()


def element(conn, element_id):
    return conn.execute('SELECT * FROM elements WHERE id = ?', (element_id,)).fetchone()


def region(conn, region_id):
    return conn.execute('SELECT * FROM regions WHERE id = ?', (region_id,)).fetchone()


def patch_line(client, line_id, headers=ALICE, **body):
    return client.patch(f'/api/lines/{line_id}', json=body, headers=headers)


class TestEveryWriteAnswersWithItsSpan:
    def test_a_line_edit_brackets_exactly_what_it_logged(self, stack):
        client, conn = stack
        assert store.revision_mark(conn) == 0
        saved = patch_line(client, 1, corrected_text='First').json()
        # The row had no history: its starting point is logged first, then the edit.
        assert saved['span'] == {'from': 1, 'to': 2}
        assert store.revision_mark(conn) == 2

    def test_creates_deletes_splits_and_merges_answer_the_same_way(self, stack):
        client, conn = stack
        created = client.post('/api/pages/1/elements', headers=ALICE,
                              json={'class_name': 'Header', 'bbox': [0, 0.8, 1, 0.9]}).json()
        assert created['span'] == {'from': 0, 'to': 1}
        deleted = client.delete('/api/lines/2', headers=ALICE).json()
        assert deleted == {'id': 2, 'deleted': True, 'revision': 3, 'span': {'from': 2, 'to': 3}}
        split = client.post('/api/lines/1/split', json={'cut_x': 0.5}, headers=ALICE).json()
        assert split['span'] == {'from': 4, 'to': 6}
        merged = client.post('/api/elements/merge', json={'ids': [1, 3]}, headers=ALICE).json()
        # Both elements and every line they hold gain an origin before the merge itself.
        assert merged['span']['to'] == store.revision_mark(conn)
        assert merged['span']['from'] < merged['span']['to']
        drawn = client.post('/api/pages/1/regions', headers=ALICE,
                            json={'class_id': 1, 'points': TRIANGLE}).json()
        assert drawn['span']['to'] == store.revision_mark(conn)
        gone = client.delete(f"/api/regions/{drawn['id']}", headers=ALICE).json()
        assert gone['span'] == {'from': drawn['span']['to'], 'to': drawn['span']['to'] + 1}

    def test_the_first_edit_of_a_pipeline_row_keeps_its_starting_point(self, stack):
        client, conn = stack
        patch_line(client, 1, polygon=RESHAPED)
        assert actions(conn, 'line', 1) == ['origin', 'update']
        origin = json.loads(conn.execute(
            "SELECT snapshot FROM revisions WHERE target_type = 'line' AND target_id = 1 "
            'ORDER BY id LIMIT 1').fetchone()['snapshot'])
        assert (origin['polygon'], origin['text']) == (LINE_1, 'first')
        # A second edit does not log the starting point again.
        patch_line(client, 1, corrected_text='First')
        assert actions(conn, 'line', 1) == ['origin', 'update', 'update']


class TestUndo:
    def test_a_reshape_goes_back_to_the_polygon_it_had(self, stack):
        client, conn = stack
        span = patch_line(client, 1, polygon=RESHAPED).json()['span']
        crop = caches.line_crop_path('j', 1)
        crop.parent.mkdir(parents=True)
        crop.write_bytes(b'stale')

        res = undo(client, 1, span)

        assert res.status_code == 200, res.text
        assert json.loads(line(conn, 1)['polygon']) == LINE_1
        assert not crop.exists()
        assert actions(conn, 'line', 1) == ['origin', 'update', 'revert']
        body = res.json()
        assert [e['id'] for e in body['elements']] == [1]
        assert body['elements'][0]['lines'][0]['polygon'] == LINE_1
        assert body['regions'] == [] and body['removed_elements'] == [] and body['removed_regions'] == []
        assert body['span'] == {'from': span['to'], 'to': span['to'] + 1}

    def test_a_line_merge_gives_both_lines_their_text_back(self, stack):
        client, conn = stack
        conn.execute('UPDATE lines SET checked = 1 WHERE id = 2')
        conn.commit()
        merged = client.post('/api/lines/merge', json={'ids': [1, 2]}, headers=ALICE).json()
        assert merged['id'] == 1 and merged['text'] is None
        assert line(conn, 2)['deleted'] == 1

        assert undo(client, 1, merged['span']).status_code == 200

        first, second = line(conn, 1), line(conn, 2)
        assert (first['text'], first['deleted'], first['order_idx']) == ('first', 0, 0)
        assert (second['text'], second['deleted'], second['order_idx'], second['checked']) == ('second', 0, 1, 1)
        assert json.loads(first['polygon']) == LINE_1

    def test_undoing_a_line_merge_offers_the_halves_readings_on_them_again(self, stack):
        """The merge set the readings aside; taking it back offers them
        where they were, and redoing it sets them aside once more."""
        client, conn = stack
        for line_id, text in ((1, 'first'), (2, 'second')):
            candidates.add(conn, 1, 'llm:reader', text, line_id=line_id, order_idx=line_id - 1)
        conn.commit()
        merged = client.post('/api/lines/merge', json={'ids': [1, 2]}, headers=ALICE).json()
        assert self._readings(conn) == [(None, 1), (None, 1)]

        assert undo(client, 1, merged['span']).status_code == 200
        assert self._readings(conn) == [(1, 0), (2, 0)]

        assert redo(client, 1, merged['span']).status_code == 200
        assert self._readings(conn) == [(None, 1), (None, 1)]

    def _readings(self, conn):
        return [(r['line_id'], r['dismissed']) for r in conn.execute(
            "SELECT line_id, dismissed FROM candidates WHERE source = 'llm' ORDER BY id")]

    def test_an_element_merge_brings_the_loser_back_with_its_lines(self, stack):
        client, conn = stack
        merged = client.post('/api/elements/merge', json={'ids': [1, 3]}, headers=ALICE).json()
        assert merged['id'] == 1
        assert line(conn, 4)['element_id'] == 1 and element(conn, 3)['deleted'] == 1

        res = undo(client, 1, merged['span'])

        assert res.status_code == 200, res.text
        lower = element(conn, 3)
        assert (lower['deleted'], json.loads(lower['bbox']), lower['lines_bbox']) == (0, [0, 0.5, 1, 1], None)
        assert json.loads(element(conn, 1)['bbox']) == [0, 0, 1, 0.5]
        assert line(conn, 4)['element_id'] == 3 and line(conn, 4)['order_idx'] == 0
        assert sorted(e['id'] for e in res.json()['elements']) == [1, 3]

    def test_undoing_a_create_takes_it_off_the_page(self, stack):
        client, conn = stack
        drawn = client.post('/api/pages/3/lines', json={'polygon': LINE_1}, headers=ALICE).json()
        bucket = line(conn, drawn['id'])['element_id']
        assert element(conn, bucket)['kind'] == 'orphan'

        res = undo(client, 3, drawn['span'])

        assert res.status_code == 200, res.text
        assert line(conn, drawn['id'])['deleted'] == 1 and element(conn, bucket)['deleted'] == 1
        assert res.json()['elements'] == [] and res.json()['removed_elements'] == [bucket]
        assert client.get('/api/jobs/j/pages/3', headers=ALICE).json()['elements'] == []

        assert redo(client, 3, drawn['span']).status_code == 200
        assert line(conn, drawn['id'])['deleted'] == 0 and element(conn, bucket)['deleted'] == 0

    def test_undoing_a_delete_brings_the_line_back_where_it_was(self, stack):
        client, conn = stack
        span = client.delete('/api/lines/1', headers=ALICE).json()['span']
        assert line(conn, 2)['order_idx'] == 0

        assert undo(client, 1, span).status_code == 200

        first = line(conn, 1)
        assert (first['deleted'], first['text'], first['order_idx']) == (0, 'first', 0)
        assert line(conn, 2)['order_idx'] == 1

    def test_undoing_a_box_delete_brings_its_lines_and_their_readings_back(self, stack):
        client, conn = stack
        for line_id, text in ((1, 'first'), (2, 'second')):
            candidates.add(conn, 1, 'llm:reader', text, line_id=line_id, order_idx=line_id)
        conn.commit()
        span = client.delete('/api/elements/1', headers=ALICE).json()['span']
        assert [line(conn, i)['deleted'] for i in (1, 2)] == [1, 1]

        assert undo(client, 1, span).status_code == 200

        assert element(conn, 1)['deleted'] == 0
        assert [(line(conn, i)['deleted'], line(conn, i)['order_idx']) for i in (1, 2)] == [(0, 0), (0, 1)]
        assert [r['line_id'] for r in conn.execute('SELECT line_id FROM candidates ORDER BY id')] == [1, 2]

    def test_a_line_deleted_before_its_box_stays_deleted_when_the_box_comes_back(self, stack):
        client, conn = stack
        client.delete('/api/lines/2', headers=ALICE)
        span = client.delete('/api/elements/1', headers=ALICE).json()['span']

        assert undo(client, 1, span).status_code == 200

        assert (line(conn, 1)['deleted'], line(conn, 2)['deleted']) == (0, 1)

    def test_undoing_a_split_puts_the_reading_order_back(self, stack):
        client, conn = stack
        split = client.post('/api/elements/1/split', json={'cut_y': 0.22}, headers=ALICE).json()
        new_id = split['elements'][1]['id']
        assert (element(conn, new_id)['order_idx'], element(conn, 3)['order_idx']) == (1, 2)

        assert undo(client, 1, split['span']).status_code == 200

        assert element(conn, new_id)['deleted'] == 1
        assert (element(conn, 1)['order_idx'], element(conn, 3)['order_idx']) == (0, 1)


class TestRedo:
    def test_redo_puts_the_edit_back(self, stack):
        client, conn = stack
        span = patch_line(client, 1, polygon=RESHAPED).json()['span']
        undo(client, 1, span)

        assert redo(client, 1, span).status_code == 200

        assert json.loads(line(conn, 1)['polygon']) == RESHAPED
        assert actions(conn, 'line', 1) == ['origin', 'update', 'revert', 'revert']


class TestSomeoneElse:
    def test_a_span_holding_their_edit_is_refused(self, stack):
        client, conn = stack
        mine = patch_line(client, 1, polygon=RESHAPED).json()['span']
        theirs = patch_line(client, 2, BOB, corrected_text='Bobs reading').json()['span']

        res = undo(client, 1, {'from': mine['from'], 'to': theirs['to']})

        assert res.status_code == 409
        detail = res.json()['detail']
        assert (detail['code'], detail['author']) == ('conflict', 'bob')
        assert detail['message'] == 'changed by bob since you loaded it'
        assert detail['revision'] == theirs['to']
        assert json.loads(line(conn, 1)['polygon']) == RESHAPED
        assert 'revert' not in actions(conn, 'line', 1) + actions(conn, 'line', 2)

    def test_their_later_edit_of_a_touched_line_is_refused(self, stack):
        client, conn = stack
        mine = patch_line(client, 1, polygon=RESHAPED).json()['span']
        patch_line(client, 1, BOB, corrected_text='Bobs reading')

        res = undo(client, 1, mine)

        assert res.status_code == 409
        assert res.json()['detail']['author'] == 'bob'
        assert line(conn, 1)['corrected_text'] == 'Bobs reading'

    def test_their_edit_landing_while_the_undo_is_checked_is_not_overwritten(self, stack, tmp_path, monkeypatch):
        """Each request gets its own connection, as in production. The undo is held back
        after its checks, and Bob saves the line meanwhile."""
        client, conn = stack

        def own_connection():
            request_conn = store.connect(tmp_path / 'app.db')
            try:
                yield request_conn
            finally:
                request_conn.close()

        app.dependency_overrides[get_db] = own_connection
        mine = patch_line(client, 1, polygon=RESHAPED).json()['span']
        real_refuse_missing_classes = revert_module._refuse_missing_classes

        def slow_refuse_missing_classes(*args):
            real_refuse_missing_classes(*args)
            time.sleep(0.5)

        monkeypatch.setattr(revert_module, '_refuse_missing_classes', slow_refuse_missing_classes)
        statuses = {}
        undoing = threading.Thread(target=lambda: statuses.update(undo=undo(client, 1, mine).status_code))
        undoing.start()
        time.sleep(0.2)
        statuses['bob'] = patch_line(client, 1, BOB, corrected_text='Bobs reading').status_code
        undoing.join()

        assert statuses == {'undo': 200, 'bob': 200}
        assert line(conn, 1)['corrected_text'] == 'Bobs reading'
        assert json.loads(line(conn, 1)['polygon']) == LINE_1
        assert actions(conn, 'line', 1) == ['origin', 'update', 'revert', 'update']

    def test_a_machine_writing_afterwards_does_not_stand_in_the_way(self, stack):
        client, conn = stack
        mine = patch_line(client, 1, polygon=RESHAPED).json()['span']
        conn.execute("UPDATE lines SET text = 'machine read' WHERE id = 1")
        store.log_line(conn, 1, 'model:ocr@later', 'update')
        conn.commit()

        assert undo(client, 1, mine).status_code == 200

        first = line(conn, 1)
        assert (json.loads(first['polygon']), first['text']) == (LINE_1, 'first')

    def test_a_turned_scan_refuses_spans_from_before_the_turn(self, stack):
        client, conn = stack
        mine = patch_line(client, 1, polygon=RESHAPED).json()['span']
        store.log_revision(conn, 'page', 1, 'j', 'alice', 'update', {'id': 1, 'rotation': 90})
        conn.commit()

        res = undo(client, 1, mine)

        assert res.status_code == 409
        assert res.json()['detail']['message'] == 'the scan was turned since'
        assert json.loads(line(conn, 1)['polygon']) == RESHAPED

    def test_a_page_flag_inside_the_span_is_refused(self, stack):
        client, _ = stack
        mine = patch_line(client, 1, polygon=RESHAPED).json()['span']
        client.patch('/api/pages/1', json={'layout_checked': True}, headers=ALICE)

        res = undo(client, 1, {'from': mine['from'], 'to': mine['to'] + 1})

        assert res.status_code == 409
        assert res.json()['detail']['message'] == 'the page itself changed in this span'


class TestYourOwnLaterEdits:
    def test_undoing_a_reshape_keeps_the_text_corrected_afterwards(self, stack):
        client, conn = stack
        reshape = patch_line(client, 1, polygon=RESHAPED).json()['span']
        patch_line(client, 1, corrected_text='Corrected later')

        assert undo(client, 1, reshape).status_code == 200
        first = line(conn, 1)
        assert (json.loads(first['polygon']), first['corrected_text'], first['checked']) == (LINE_1, 'Corrected later', 1)

        assert redo(client, 1, reshape).status_code == 200
        first = line(conn, 1)
        assert (json.loads(first['polygon']), first['corrected_text'], first['checked']) == (RESHAPED, 'Corrected later', 1)

    def test_a_correction_taken_back_and_put_back_keeps_its_author_with_it(self, stack):
        client, conn = stack
        correction = patch_line(client, 1, corrected_text='Typed by hand').json()['span']

        assert undo(client, 1, correction).status_code == 200
        assert (line(conn, 1)['corrected_text'], line(conn, 1)['corrected_by']) == (None, None)

        assert redo(client, 1, correction).status_code == 200
        assert (line(conn, 1)['corrected_text'], line(conn, 1)['corrected_by']) == ('Typed by hand', 'alice')

    def test_two_reshapes_are_taken_back_one_after_the_other(self, stack):
        client, conn = stack
        moved = [[0.2, 0], [0.8, 0], [0.8, 0.2], [0.2, 0.2]]
        first = patch_line(client, 1, polygon=RESHAPED).json()['span']
        second = patch_line(client, 1, polygon=moved).json()['span']

        assert undo(client, 1, second).status_code == 200
        assert json.loads(line(conn, 1)['polygon']) == RESHAPED
        assert undo(client, 1, first).status_code == 200
        assert json.loads(line(conn, 1)['polygon']) == LINE_1

    def test_a_later_correction_of_what_the_span_changed_refuses_the_undo(self, stack):
        client, conn = stack
        patch_line(client, 1, corrected_text='The whole line')
        split = client.post('/api/lines/1/split', json={'cut_x': 0.5}, headers=ALICE).json()
        left, right = (ln['id'] for ln in split['lines'])
        corrected = patch_line(client, left, corrected_text='The left half').json()['span']

        res = undo(client, 1, split['span'])

        assert res.status_code == 409
        detail = res.json()['detail']
        assert (detail['message'], detail['author'], detail['revision']) == (
            'its corrected text was changed since', 'alice', corrected['to'])
        assert (line(conn, left)['corrected_text'], line(conn, right)['deleted']) == ('The left half', 0)
        assert 'revert' not in actions(conn, 'line', left) + actions(conn, 'line', right)

    def test_a_check_given_since_is_not_carried_onto_the_text_it_did_not_approve(self, stack):
        client, conn = stack
        corrected = patch_line(client, 1, corrected_text='First, read', checked=False).json()['span']
        checked = patch_line(client, 1, checked=True).json()['span']

        res = undo(client, 1, corrected)

        assert res.status_code == 409
        detail = res.json()['detail']
        assert (detail['message'], detail['author'], detail['revision']) == (
            'it was checked since', 'alice', checked['to'])
        assert (line(conn, 1)['corrected_text'], line(conn, 1)['checked']) == ('First, read', 1)
        assert 'revert' not in actions(conn, 'line', 1)

    def test_a_drawn_line_corrected_since_is_not_taken_off_the_page(self, stack):
        client, conn = stack
        drawn = client.post('/api/pages/1/lines', json={'polygon': RESHAPED}, headers=ALICE).json()
        patch_line(client, drawn['id'], corrected_text='Drawn and read')

        res = undo(client, 1, drawn['span'])

        assert res.status_code == 409
        assert (line(conn, drawn['id'])['deleted'], line(conn, drawn['id'])['corrected_text']) == (0, 'Drawn and read')

    def test_checking_an_element_afterwards_keeps_its_lines_checked(self, stack):
        client, conn = stack
        reshape = patch_line(client, 1, polygon=RESHAPED).json()['span']
        client.patch('/api/elements/1', json={'checked': True}, headers=ALICE)

        assert undo(client, 1, reshape).status_code == 200

        assert (json.loads(line(conn, 1)['polygon']), line(conn, 1)['checked']) == (LINE_1, 1)


class TestCheckingAnElement:
    def test_logs_every_line_it_checks_and_skips_the_deleted(self, stack):
        client, conn = stack
        client.delete('/api/lines/2', headers=ALICE)

        span = client.patch('/api/elements/1', json={'checked': True}, headers=ALICE).json()['span']

        assert (line(conn, 1)['checked'], line(conn, 2)['checked']) == (1, 0)
        assert actions(conn, 'line', 1) == ['origin', 'update']
        assert actions(conn, 'line', 2) == ['origin', 'delete']
        assert undo(client, 1, span).status_code == 200
        assert (element(conn, 1)['checked'], line(conn, 1)['checked']) == (0, 0)


class TestTheLog:
    def test_a_revert_reaches_the_page_and_moves_the_cursor(self, stack):
        client, conn = stack
        span = patch_line(client, 1, polygon=RESHAPED).json()['span']
        undo(client, 1, span)

        newest, changes = store.page_changes_since(conn, 1, 'j', span['to'])

        assert newest == span['to'] + 1
        assert [(c['kind'], c['id'], c['author'], c['action']) for c in changes] == [('line', 1, 'alice', 'revert')]
        # A starting point is a record, not a change: nobody is told about it.
        _, everything = store.page_changes_since(conn, 1, 'j', 0)
        assert [c['action'] for c in everything] == ['update', 'revert']

    def test_an_empty_span_is_nothing_to_revert(self, stack):
        client, _ = stack
        patch_line(client, 1, polygon=RESHAPED)
        assert undo(client, 1, {'from': 2, 'to': 2}).status_code == 404
        assert undo(client, 1, {'from': 0, 'to': 2}, headers=MALLORY).status_code == 404


class TestRegions:
    def test_a_region_edit_and_its_delete_come_back(self, stack):
        client, conn = stack
        moved = [[0.3, 0.3], [0.4, 0.3], [0.4, 0.4]]
        span = client.patch('/api/regions/1', json={'points': moved}, headers=ALICE).json()['span']
        assert undo(client, 1, span).status_code == 200
        assert json.loads(region(conn, 1)['points']) == TRIANGLE
        assert redo(client, 1, span).status_code == 200
        assert json.loads(region(conn, 1)['points']) == moved

        gone = client.delete('/api/regions/1', headers=ALICE).json()['span']
        res = undo(client, 1, gone)
        assert res.status_code == 200
        assert region(conn, 1)['deleted'] == 0
        assert [r['id'] for r in res.json()['regions']] == [1]

    def test_a_drawn_region_is_taken_back_and_put_back(self, stack):
        client, conn = stack
        drawn = client.post('/api/pages/1/regions', headers=ALICE,
                            json={'class_id': 1, 'points': [[0.5, 0.5], [0.6, 0.5], [0.6, 0.6]]}).json()
        res = undo(client, 1, drawn['span'])
        assert res.status_code == 200
        assert region(conn, drawn['id'])['deleted'] == 1
        assert res.json()['removed_regions'] == [drawn['id']] and res.json()['regions'] == []
        assert redo(client, 1, drawn['span']).status_code == 200
        assert region(conn, drawn['id'])['deleted'] == 0

    def test_someone_elses_region_edit_in_the_span_is_refused(self, stack):
        client, conn = stack
        mine = client.patch('/api/regions/1', json={'checked': True}, headers=ALICE).json()['span']
        theirs = client.patch('/api/regions/1', json={'checked': False}, headers=BOB).json()['span']
        res = undo(client, 1, {'from': mine['from'], 'to': theirs['to']})
        assert res.status_code == 409 and res.json()['detail']['author'] == 'bob'
        assert region(conn, 1)['checked'] == 0

    def test_a_class_removed_since_cannot_be_put_back(self, stack):
        client, conn = stack
        client.post('/api/jobs/j/map-classes', json={'name': 'road', 'color': [255, 0, 0]}, headers=ALICE)
        to_road = client.patch('/api/regions/1', json={'class_id': 2}, headers=ALICE).json()['span']
        back = client.patch('/api/regions/1', json={'class_id': 1}, headers=ALICE).json()['span']
        assert client.delete('/api/jobs/j/map-classes/2?mode=delete', headers=ALICE).status_code == 200

        res = undo(client, 1, back)

        assert res.status_code == 409
        assert res.json()['detail']['message'] == 'class 2 no longer exists in this dataset'
        assert region(conn, 1)['class_id'] == 1
        # Putting the earlier edit back again would want the class too.
        assert redo(client, 1, to_road).status_code == 409


class TestABoxWhoseClassWasRemoved:
    """An undo never brings a box back under a class the dataset no longer
    has. Merged away, the box keeps the class it was merged into; deleted with its boxes,
    the undo is refused and says which class."""

    @pytest.fixture
    def layout(self, tmp_path, monkeypatch):
        from app import layout_templates
        monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
        monkeypatch.setattr('app.config.DB_PATH', tmp_path / 'app.db')
        monkeypatch.setattr('app.config.JOBS_DIR', tmp_path / 'jobs')
        monkeypatch.setattr('app.config.SAVE_OCR_DATA', False)
        conn = store.connect(tmp_path / 'app.db')
        conn.execute("INSERT INTO jobs (id, name, owner, status, task) VALUES ('t', 'Register', 'alice', 'done', 'text')")
        layout_templates.copy_into(conn, 't')
        stamp = layout_templates.add_class(conn, 't', 'Stamp')
        seal = layout_templates.add_class(conn, 't', 'Seal')
        conn.execute("INSERT INTO pages (id, job_id, idx, filename, source_file, status) "
                     "VALUES (10, 't', 0, 'p.png', '/nonexistent.png', 'done')")
        conn.execute("INSERT INTO elements (id, page_id, order_idx, class_name, bbox, kind) "
                     "VALUES (10, 10, 0, 'Stamp', '[0,0,0.5,0.5]', 'content')")
        conn.execute("INSERT INTO elements (id, page_id, order_idx, class_name, bbox, kind) "
                     "VALUES (11, 10, 1, 'Seal', '[0.5,0.5,1,1]', 'content')")
        conn.commit()
        app.dependency_overrides[get_db] = lambda: conn
        paragraph = next(c['id'] for c in layout_templates.job_classes(conn, 't') if c['name'] == 'Paragraph')
        yield TestClient(app), conn, {'stamp': stamp, 'seal': seal, 'paragraph': paragraph}
        app.dependency_overrides.clear()
        conn.close()

    def test_a_box_merged_away_comes_back_under_the_class_it_was_merged_into(self, layout):
        client, conn, ids = layout
        moved = client.patch('/api/elements/10', headers=ALICE, json={'bbox': [0.1, 0.1, 0.4, 0.4]}).json()
        assert client.delete(f"/api/jobs/t/layout-classes/{ids['stamp']}?into={ids['paragraph']}",
                             headers=ALICE).status_code == 200

        response = undo(client, 10, moved['span'])

        assert response.status_code == 200, response.text
        box = element(conn, 10)
        assert (box['class_name'], json.loads(box['bbox']), box['deleted']) == ('Paragraph', [0, 0, 0.5, 0.5], 0)

    def test_a_box_deleted_with_its_class_is_not_brought_back(self, layout):
        client, conn, ids = layout
        moved = client.patch('/api/elements/11', headers=ALICE, json={'bbox': [0.6, 0.6, 0.9, 0.9]}).json()
        assert client.delete(f"/api/jobs/t/layout-classes/{ids['seal']}", headers=ALICE).status_code == 200

        response = undo(client, 10, moved['span'])

        assert response.status_code == 409
        assert 'Seal' in response.json()['detail']['message']
        assert element(conn, 11)['deleted'] == 1
