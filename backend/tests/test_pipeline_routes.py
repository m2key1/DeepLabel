"""Asking the pipeline to do something again. Each of the three says what it would cost
before it does it, and each destroys something: re-detection replaces lines, a re-run
throws a phase's output away. The counts in the preview are what a person decides on, so
they are asserted against the same state the operation then acts on.
"""
import json

import pytest
from fastapi.testclient import TestClient

from app import candidates, config, store
from app.deps import get_db
from app.main import app

SECRET = 'test-secret'
ADMIN = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'root', 'X-Auth-Role': 'admin'}
# The auth service resolves a role and its exceptions into this set; the backend only
# ever reads it. A member who owns the dataset runs the pipeline over it by default.
MEMBER_CAPS = 'pipeline.layout pipeline.lines pipeline.ocr train.local'
ALICE = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'alice', 'X-Auth-Role': 'member',
         'X-Auth-Caps': MEMBER_CAPS}
BOB = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'bob', 'X-Auth-Role': 'member',
       'X-Auth-Caps': MEMBER_CAPS}
# The same person with line detection taken away by an admin.
ALICE_NO_LINES = {**ALICE, 'X-Auth-Caps': 'pipeline.layout pipeline.ocr train.local'}

POLY = '[[0,0],[1,0],[1,1],[0,1]]'
BBOX = '[0.0,0.0,1.0,0.5]'


@pytest.fixture
def conn(tmp_path, monkeypatch):
    monkeypatch.setattr('app.config.JOBS_DIR', tmp_path / 'jobs')
    connection = store.connect(tmp_path / 'app.db')
    connection.executescript(f"""
        INSERT INTO jobs (id, name, owner, status) VALUES ('j1', 'Volume', 'alice', 'done');
        INSERT INTO pages (id, job_id, idx, filename, source_file, status, layout_checked)
            VALUES (1, 'j1', 0, 'p1.png', '/p1.png', 'done', 0);
        INSERT INTO elements (id, page_id, order_idx, class_name, raw_class_name, bbox, kind,
                              lines_bbox)
            VALUES (1, 1, 0, 'Paragraph', 'Paragraph', '{BBOX}', 'content', '{BBOX}');
        INSERT INTO lines (id, element_id, order_idx, polygon, text, corrected_text, checked)
            VALUES (1, 1, 0, '{POLY}', 'Machine read', 'Corrected by hand', 1),
                   (2, 1, 1, '{POLY}', 'Second line', NULL, 0);
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


def make_stale(conn, element_id=1):
    """What a moved box looks like: the lines were found against different geometry."""
    conn.execute("UPDATE elements SET lines_bbox = '[0.0,0.0,0.5,0.5]' WHERE id = ?",
                 (element_id,))
    conn.commit()


def job(conn):
    return conn.execute("SELECT * FROM jobs WHERE id = 'j1'").fetchone()


def lines(conn):
    return conn.execute('SELECT * FROM lines ORDER BY id').fetchall()


def live_lines(conn):
    return conn.execute('SELECT * FROM lines WHERE deleted = 0 ORDER BY id').fetchall()


def detect_again(conn):
    """What the runner and then the next edit do after a re-run from line detection: a
    line is found in the same place as before, and the pool is matched against it."""
    conn.execute("UPDATE jobs SET status = 'done' WHERE id = 'j1'")
    conn.execute("UPDATE pages SET status = 'done' WHERE id = 1")
    cur = conn.execute('INSERT INTO lines (element_id, order_idx, polygon, text) VALUES (1, 0, ?, ?)',
                       (POLY, 'Machine read'))
    conn.commit()
    candidates.rematch_page(conn, 1)
    return conn.execute('SELECT * FROM lines WHERE id = ?', (cur.lastrowid,)).fetchone()


class TestRedetectPreview:
    def test_a_dataset_whose_boxes_have_not_moved_has_nothing_stale(self, client):
        assert client.get('/api/jobs/j1/redetect', headers=ALICE).json()['elements'] == 0

    def test_a_moved_box_is_counted_with_what_re_detecting_it_would_cost(self, client, conn):
        make_stale(conn)

        preview = client.get('/api/jobs/j1/redetect', headers=ALICE).json()

        assert preview['elements'] == 1
        assert preview['pages'] == 1
        assert preview['corrected'] == 1, 'the correction re-detection would replace'

    def test_lines_a_person_touched_are_counted_apart(self, client, conn):
        make_stale(conn)
        store.log_line(conn, 1, 'alice', 'update')
        store.log_line(conn, 2, 'model:ocr@best.pt', 'update')
        conn.commit()

        assert client.get('/api/jobs/j1/redetect', headers=ALICE).json()['hand_edited'] == 1

    def test_lines_only_alignment_or_an_llm_touched_are_not_hand_edited(self, client, conn):
        make_stale(conn)
        store.log_line(conn, 1, 'align:gt@1.00', 'update')
        store.log_line(conn, 1, 'realign:text@0.91', 'update')
        store.log_line(conn, 2, 'llm:claude', 'update')
        conn.commit()

        assert client.get('/api/jobs/j1/redetect', headers=ALICE).json()['hand_edited'] == 0
        store.log_line(conn, 2, 'alice', 'update')
        conn.commit()
        assert client.get('/api/jobs/j1/redetect', headers=ALICE).json()['hand_edited'] == 1

    def test_a_stranger_is_not_told_the_dataset_exists(self, client):
        assert client.get('/api/jobs/j1/redetect', headers=BOB).status_code == 404

    def test_a_dataset_that_does_not_exist_is_a_404(self, client):
        assert client.get('/api/jobs/nope/redetect', headers=ADMIN).status_code == 404


class TestRedetect:
    def test_it_queues_the_dataset_and_says_what_it_covers(self, client, conn):
        make_stale(conn)

        response = client.post('/api/jobs/j1/redetect', headers=ADMIN)

        assert response.status_code == 200, response.text
        assert response.json()['elements'] == 1
        assert job(conn)['status'] == 'queued'

    def test_the_stale_boxes_forget_what_their_lines_were_found_against(self, client, conn):
        """phase_relines keys on NULL, so this is what makes the request honoured even
        where automatic re-detection is switched off."""
        make_stale(conn)

        client.post('/api/jobs/j1/redetect', headers=ADMIN)

        assert conn.execute('SELECT lines_bbox FROM elements WHERE id = 1').fetchone()[0] is None

    def test_naming_a_page_redoes_it_however_little_its_boxes_moved(self, client, conn):
        response = client.post('/api/jobs/j1/redetect', json={'page_id': 1}, headers=ADMIN)

        assert response.status_code == 200
        assert conn.execute('SELECT lines_bbox FROM elements WHERE id = 1').fetchone()[0] is None

    def test_a_page_from_another_dataset_is_refused(self, client):
        response = client.post('/api/jobs/j1/redetect', json={'page_id': 99}, headers=ADMIN)

        assert response.status_code == 404
        assert 'page not in job' in response.json()['detail']

    def test_a_dataset_with_nothing_stale_is_told_so(self, client):
        response = client.post('/api/jobs/j1/redetect', headers=ADMIN)

        assert response.status_code == 400
        assert 'no elements need' in response.json()['detail']

    def test_a_dataset_already_working_is_refused(self, client, conn):
        make_stale(conn)
        conn.execute("UPDATE jobs SET status = 'running' WHERE id = 'j1'")
        conn.commit()

        assert client.post('/api/jobs/j1/redetect', headers=ADMIN).status_code == 409

    def test_the_owner_may_do_it_without_being_an_admin(self, client, conn):
        make_stale(conn)

        assert client.post('/api/jobs/j1/redetect', headers=ALICE).status_code == 200

    def test_somebody_it_was_taken_away_from_may_not(self, client, conn):
        make_stale(conn)

        response = client.post('/api/jobs/j1/redetect', headers=ALICE_NO_LINES)

        assert response.status_code == 403
        assert response.json()['detail'] == 'not permitted: pipeline.lines'

    def test_a_stranger_may_not_either_however_much_they_may_do(self, client, conn):
        make_stale(conn)

        assert client.post('/api/jobs/j1/redetect', headers=BOB).status_code == 404


class TestWhatTheDatasetWrites:
    def test_it_offers_the_characters_no_keyboard_has(self, client, conn):
        conn.execute("UPDATE lines SET text = 'K. K. Finanz-Ministerium \u204a' WHERE id = 1")
        conn.execute("UPDATE lines SET corrected_text = 'Staats-Haupt-Kassen-Pru\u0308f.' "
                     'WHERE id = 2')
        conn.commit()

        response = client.get('/api/jobs/j1/characters', headers=ALICE)

        assert response.status_code == 200
        assert response.json() == {'characters': ['\u204a', 'u\u0308']}

    def test_a_dataset_that_does_not_exist_is_a_404(self, client):
        assert client.get('/api/jobs/nope/characters', headers=ALICE).status_code == 404

    def test_a_stranger_is_not_told_what_it_writes(self, client, conn):
        conn.execute("UPDATE jobs SET owner = 'someone else' WHERE id = 'j1'")
        conn.commit()

        assert client.get('/api/jobs/j1/characters', headers=BOB).status_code == 404


class TestReocrPreview:
    def test_it_counts_what_a_re_read_would_cover(self, client):
        preview = client.get('/api/jobs/j1/reocr', headers=ALICE).json()

        assert (preview['unchecked'], preview['checked']) == (1, 1)
        assert preview['lines'] == 0, 'nothing is waiting for text'

    def test_a_line_left_without_text_is_what_pending_means(self, client, conn):
        conn.execute('UPDATE lines SET text = NULL WHERE id = 2')
        conn.commit()

        assert client.get('/api/jobs/j1/reocr', headers=ALICE).json()['lines'] == 1

    def test_it_names_the_models_that_wrote_the_text_that_is_there(self, client, conn):
        store.log_line(conn, 1, 'model:ocr@best_model.pt', 'ocr')
        store.log_line(conn, 2, 'model:ocr@older.pt', 'ocr')
        conn.execute("UPDATE revisions SET job_id = 'j1'")
        conn.commit()

        authors = client.get('/api/jobs/j1/reocr', headers=ALICE).json()['authors']

        # The revision-log author as stored, not a shortened one: what to call a model is
        # one rule, and it lives where every other reader chip is drawn.
        assert sorted(a['author'] for a in authors) == [
            'model:ocr@best_model.pt', 'model:ocr@older.pt']

    def test_a_dataset_that_does_not_exist_is_a_404(self, client):
        assert client.get('/api/jobs/nope/reocr', headers=ADMIN).status_code == 404


class TestReocr:
    def test_re_reading_the_unchecked_lines_marks_them_and_queues_the_dataset(self, client, conn):
        response = client.post('/api/jobs/j1/reocr', json={'scope': 'unchecked'}, headers=ALICE)

        assert response.status_code == 200, response.text
        assert [row['needs_ocr'] for row in lines(conn)] == [0, 1], 'the checked line is left'
        assert job(conn)['status'] == 'queued'

    def test_a_dataset_where_everything_is_checked_has_nothing_to_re_read(self, client, conn):
        conn.execute('UPDATE lines SET checked = 1')
        conn.commit()

        response = client.post('/api/jobs/j1/reocr', json={'scope': 'unchecked'}, headers=ALICE)

        assert response.status_code == 400
        assert 'no unchecked lines' in response.json()['detail']

    def test_the_pending_scope_covers_only_lines_left_without_text(self, client, conn):
        conn.execute('UPDATE lines SET text = NULL WHERE id = 2')
        conn.commit()

        response = client.post('/api/jobs/j1/reocr', headers=ALICE)

        assert response.status_code == 200
        assert response.json()['lines'] == 1

    def test_nothing_edited_means_nothing_to_re_read(self, client):
        response = client.post('/api/jobs/j1/reocr', headers=ALICE)

        assert response.status_code == 400
        assert 'no edited lines' in response.json()['detail']

    def test_a_scope_nobody_offers_is_refused(self, client):
        response = client.post('/api/jobs/j1/reocr', json={'scope': 'everything'}, headers=ALICE)

        assert response.status_code == 400
        assert 'pending or unchecked' in response.json()['detail']

    def test_a_dataset_already_working_is_refused(self, client, conn):
        conn.execute("UPDATE jobs SET status = 'running' WHERE id = 'j1'")
        conn.commit()

        assert client.post('/api/jobs/j1/reocr', json={'scope': 'unchecked'},
                           headers=ALICE).status_code == 409

    def test_an_admin_may_re_read_any_of_them(self, client):
        assert client.post('/api/jobs/j1/reocr', json={'scope': 'unchecked'},
                           headers=ADMIN).status_code == 200


class TestWhoMayReRead:
    """Re-reading used to be the owner's alone. It is a capability now, so a dataset
    shared with somebody is theirs to re-read - and taking the capability away stops
    them whether they own it or not."""

    def test_a_dataset_shared_with_somebody_is_theirs_to_re_read(self, client, conn):
        conn.execute("INSERT INTO job_assignees (job_id, username) VALUES ('j1', 'bob')")
        conn.commit()

        response = client.post('/api/jobs/j1/reocr', json={'scope': 'unchecked'}, headers=BOB)

        assert response.status_code == 200, response.text

    def test_without_it_the_owner_is_refused_too(self, client):
        no_ocr = {**ALICE, 'X-Auth-Caps': 'pipeline.layout pipeline.lines train.local'}

        response = client.post('/api/jobs/j1/reocr', json={'scope': 'unchecked'}, headers=no_ocr)

        assert response.status_code == 403
        assert response.json()['detail'] == 'not permitted: pipeline.ocr'

    def test_a_dataset_nobody_shared_is_still_out_of_reach(self, client):
        assert client.post('/api/jobs/j1/reocr', json={'scope': 'unchecked'},
                           headers=BOB).status_code == 404


class TestRerunPreview:
    def test_it_says_what_a_re_run_would_throw_away(self, client):
        preview = client.get('/api/jobs/j1/rerun', headers=ALICE).json()

        assert preview['lines'] == 2
        assert preview['corrected'] == 1
        assert preview['checked'] == 1

    def test_it_counts_the_pages_someone_has_signed_off(self, client, conn):
        conn.execute('UPDATE pages SET layout_checked = 1 WHERE id = 1')
        conn.commit()

        assert client.get('/api/jobs/j1/rerun', headers=ALICE).json()['layout_checked'] == 1

    def test_it_counts_the_boxes_a_person_edited(self, client, conn):
        store.log_element(conn, 1, 'alice', 'update')
        conn.commit()

        assert client.get('/api/jobs/j1/rerun', headers=ALICE).json()['elements_edited'] == 1

    def test_a_box_only_the_pipeline_touched_is_not_counted_as_edited(self, client, conn):
        store.log_element(conn, 1, 'system:run@alice', 'update')
        store.log_element(conn, 1, 'llm:claude', 'update')
        conn.commit()

        assert client.get('/api/jobs/j1/rerun', headers=ALICE).json()['elements_edited'] == 0
        store.log_element(conn, 1, 'alice', 'update')
        conn.commit()
        assert client.get('/api/jobs/j1/rerun', headers=ALICE).json()['elements_edited'] == 1


class TestRerun:
    def test_re_running_the_reading_empties_the_lines_nobody_has_read(self, client, conn):
        response = client.post('/api/jobs/j1/rerun', json={'from_phase': 'ocr'}, headers=ADMIN)

        assert response.status_code == 200, response.text
        rows = lines(conn)
        assert len(rows) == 2, 'the line rows survive - only what was read of them goes'
        # Line 1 is checked and carries a correction; line 2 is what the model left.
        assert [row['id'] for row in rows] == [1, 2]
        assert rows[1]['text'] is None
        assert conn.execute('SELECT status FROM pages WHERE id = 1').fetchone()[0] == 'lines_done'

    def test_a_line_somebody_checked_is_left_as_it_was(self, client, conn):
        """The whole point of checking one. A re-read that cleared it took the reading,
        the correction and the sign-off with it, and said nothing."""
        client.post('/api/jobs/j1/rerun', json={'from_phase': 'ocr'}, headers=ADMIN)

        kept = lines(conn)[0]
        assert kept['checked'] == 1
        assert kept['corrected_text'] == 'Corrected by hand'
        assert kept['text'] == 'Machine read'
        assert kept['needs_ocr'] == 0, 'and it is not queued to be read again either'

    def test_asking_for_everything_clears_the_checked_lines_too(self, client, conn):
        response = client.post('/api/jobs/j1/rerun',
                               json={'from_phase': 'ocr', 'keep_checked': False}, headers=ADMIN)

        assert response.status_code == 200, response.text
        rows = lines(conn)
        assert [row['text'] for row in rows] == [None, None]
        assert [row['checked'] for row in rows] == [0, 0]
        assert [row['corrected_text'] for row in rows] == [None, None]

    def test_what_a_re_read_clears_stays_in_the_history(self, client, conn):
        """A re-read that fails or is cancelled leaves the lines blank. The history must
        still hold the reading, the correction and the check it cleared."""
        client.post('/api/jobs/j1/rerun', json={'from_phase': 'ocr', 'keep_checked': False}, headers=ADMIN)

        history = [(row['target_id'], row['author'], row['action'], json.loads(row['snapshot']))
                   for row in conn.execute("SELECT * FROM revisions WHERE target_type = 'line' ORDER BY id")]
        before = {line_id: snap for line_id, _, action, snap in history if action == 'origin'}
        assert (before[1]['text'], before[1]['corrected_text'], before[1]['checked']) == \
            ('Machine read', 'Corrected by hand', 1)
        assert before[2]['text'] == 'Second line'
        cleared = [(line_id, author, snap['text'], snap['checked'])
                   for line_id, author, action, snap in history if action == 'update']
        assert cleared == [(1, 'system:rerun@root', None, 0), (2, 'system:rerun@root', None, 0)]

    def test_re_running_line_detection_takes_the_lines_out_of_play(self, client, conn):
        client.post('/api/jobs/j1/rerun', json={'from_phase': 'lines'}, headers=ADMIN)

        assert live_lines(conn) == []
        assert conn.execute('SELECT status FROM pages WHERE id = 1').fetchone()[0] == 'layout_done'

    def test_re_running_line_detection_keeps_the_rows_and_their_history(self, client, conn):
        """Detection that finds fewer lines than it replaced must not take the corrections
        with it. The rows stay, soft-deleted, so what was on them can be put back."""
        client.post('/api/jobs/j1/rerun', json={'from_phase': 'lines'}, headers=ADMIN)

        rows = lines(conn)
        assert [row['id'] for row in rows] == [1, 2]
        assert [row['deleted'] for row in rows] == [1, 1]
        assert rows[0]['corrected_text'] == 'Corrected by hand'
        assert rows[0]['checked'] == 1
        assert conn.execute(
            "SELECT COUNT(*) c FROM revisions WHERE target_type = 'line' "
            "AND action = 'delete'").fetchone()['c'] == 2

    def test_what_a_re_run_overwrites_is_kept_in_the_pool_first(self, client, conn):
        client.post('/api/jobs/j1/rerun', json={'from_phase': 'lines'}, headers=ADMIN)

        held = conn.execute('SELECT source, text FROM candidates ORDER BY source').fetchall()
        assert ('human', 'Corrected by hand') in [(r['source'], r['text']) for r in held]

    def test_re_detecting_without_the_text_pools_nothing_to_re_offer(self, client, conn):
        """The other half of the choice: a detection pass that is meant to start clean,
        where re-offering the old readings on new lines would be noise."""
        client.post('/api/jobs/j1/rerun',
                    json={'from_phase': 'lines', 'keep_text': False}, headers=ADMIN)

        assert conn.execute('SELECT COUNT(*) c FROM candidates').fetchone()['c'] == 0
        assert live_lines(conn) == [], 'the lines still go - only the pooling is off'

    def test_starting_clean_sets_aside_what_the_pool_held_for_the_pages(self, client, conn):
        """The pool still holds what an earlier careful re-run captured, attached to the
        lines the clean one has just taken out of play. Left there, the next rematch - which
        any edit of the page's geometry triggers - would put the old correction and its check
        onto the line detected in the same place, and the clean run would be undone."""
        client.post('/api/jobs/j1/rerun', json={'from_phase': 'lines'}, headers=ADMIN)
        redetected = detect_again(conn)
        assert (redetected['corrected_text'], redetected['checked']) == ('Corrected by hand', 1), \
            'the careful re-run re-offers the correction, as promised'

        response = client.post('/api/jobs/j1/rerun',
                               json={'from_phase': 'lines', 'keep_text': False}, headers=ADMIN)

        assert response.status_code == 200, response.text
        fresh = detect_again(conn)
        assert (fresh['corrected_text'], fresh['checked']) == (None, 0)
        assert conn.execute('SELECT COUNT(*) c FROM candidates WHERE page_id = 1 AND dismissed = 0'
                            ).fetchone()['c'] == 0

    def test_re_running_line_detection_retires_the_unassigned_bucket(self, client, conn):
        """Detection files the lines it finds outside every box into a fresh orphan bucket,
        so the old one would otherwise stand empty beside it."""
        conn.executescript(f"""
            INSERT INTO elements (id, page_id, order_idx, class_name, bbox, kind)
                VALUES (2, 1, 1, 'Unassigned', '{BBOX}', 'orphan');
            INSERT INTO lines (id, element_id, order_idx, polygon, text)
                VALUES (3, 2, 0, '{POLY}', 'Outside every box');
        """)

        client.post('/api/jobs/j1/rerun', json={'from_phase': 'lines'}, headers=ADMIN)

        assert [tuple(r) for r in conn.execute('SELECT kind, deleted FROM elements ORDER BY id')] == [
            ('content', 0), ('orphan', 1)]
        assert conn.execute(
            "SELECT author FROM revisions WHERE target_type = 'element' AND target_id = 2 "
            "AND action = 'delete'").fetchone()['author'] == 'system:rerun@root'

    def test_re_running_layout_soft_deletes_the_boxes_and_keeps_their_history(self, client, conn):
        client.post('/api/jobs/j1/rerun', json={'from_phase': 'layout'}, headers=ADMIN)

        assert conn.execute('SELECT deleted FROM elements WHERE id = 1').fetchone()[0] == 1
        assert conn.execute(
            "SELECT COUNT(*) c FROM revisions WHERE target_type = 'element' "
            "AND action = 'delete'").fetchone()['c'] == 1
        assert conn.execute('SELECT status FROM pages WHERE id = 1').fetchone()[0] == 'ingested'

    def test_a_page_someone_signed_off_is_not_re_detected_by_accident(self, client, conn):
        conn.execute('UPDATE pages SET layout_checked = 1 WHERE id = 1')
        conn.commit()

        response = client.post('/api/jobs/j1/rerun', json={'from_phase': 'layout'}, headers=ADMIN)

        assert response.status_code == 409
        assert 'layout complete' in response.json()['detail']
        assert conn.execute('SELECT deleted FROM elements WHERE id = 1').fetchone()[0] == 0

    def test_forcing_it_goes_ahead_and_clears_the_sign_off(self, client, conn):
        conn.execute('UPDATE pages SET layout_checked = 1 WHERE id = 1')
        conn.commit()

        response = client.post('/api/jobs/j1/rerun',
                               json={'from_phase': 'layout', 'force': True}, headers=ADMIN)

        assert response.status_code == 200
        assert conn.execute('SELECT layout_checked FROM pages WHERE id = 1').fetchone()[0] == 0

    def test_re_aligning_throws_nothing_away(self, client, conn):
        """Alignment re-matches transcriptions against the text already on hand."""
        client.post('/api/jobs/j1/rerun', json={'from_phase': 'align'}, headers=ADMIN)

        rows = lines(conn)
        assert [row['text'] for row in rows] == ['Machine read', 'Second line']
        assert rows[0]['corrected_text'] == 'Corrected by hand'
        assert conn.execute('SELECT COUNT(*) c FROM candidates').fetchone()['c'] == 0

    @pytest.mark.parametrize('phase, switched_on', [
        # A layout re-run drops every line too, so it cannot run without line detection.
        # Reading stays the owner's choice: a line-detection set is not read afterwards.
        ('layout', (1, 1, 0)),
        ('lines', (0, 1, 0)),
        ('ocr', (0, 0, 1)),
        # Alignment and the reference cut run only inside the reading pass.
        ('align', (0, 0, 1)),
        ('reference', (0, 0, 1)),
    ])
    def test_asking_for_a_phase_switches_on_it_and_what_it_cannot_run_without(
            self, client, conn, phase, switched_on):
        """A switched-off phase would otherwise have its output cleared and never run, the
        same as running it on one page switches it on."""
        conn.execute("UPDATE jobs SET run_layout = 0, run_lines = 0, run_ocr = 0 WHERE id = 'j1'")
        conn.commit()

        response = client.post('/api/jobs/j1/rerun', json={'from_phase': phase}, headers=ADMIN)

        assert response.status_code == 200, response.text
        flags = job(conn)
        assert (flags['run_layout'], flags['run_lines'], flags['run_ocr']) == switched_on

    def test_starting_over_without_layout_drops_the_boxes_and_leaves_layout_off(self, client, conn):
        """With layout switched off, a layout re-run would switch it back on. Starting over
        takes the boxes away instead, and the lines are detected across the whole page."""
        conn.execute("UPDATE jobs SET run_layout = 0, line_mode = 'per_page' WHERE id = 'j1'")
        conn.commit()
        crops = config.job_dir('j1') / 'crops'
        crops.mkdir(parents=True)

        response = client.post('/api/jobs/j1/rerun', json={'from_phase': 'start'}, headers=ADMIN)

        assert response.status_code == 200, response.text
        assert conn.execute('SELECT deleted FROM elements WHERE id = 1').fetchone()[0] == 1
        assert conn.execute(
            "SELECT author FROM revisions WHERE target_type = 'element' AND target_id = 1 "
            "AND action = 'delete'").fetchone()['author'] == 'system:rerun@root'
        assert live_lines(conn) == []
        assert conn.execute('SELECT status FROM pages WHERE id = 1').fetchone()[0] == 'ingested'
        assert not crops.exists()
        flags = job(conn)
        assert (flags['status'], flags['run_layout'], flags['run_lines'], flags['run_ocr'],
                flags['line_mode']) == ('queued', 0, 1, 1, 'per_page')

    def test_starting_over_switches_line_detection_on_but_not_layout(self, client, conn):
        conn.execute("UPDATE jobs SET run_layout = 0, run_lines = 0, run_ocr = 0 WHERE id = 'j1'")
        conn.commit()

        client.post('/api/jobs/j1/rerun', json={'from_phase': 'start'}, headers=ADMIN)

        flags = job(conn)
        assert (flags['run_layout'], flags['run_lines'], flags['run_ocr']) == (0, 1, 0)

    def test_starting_over_past_a_layout_sign_off_needs_force(self, client, conn):
        conn.execute("UPDATE jobs SET run_layout = 0 WHERE id = 'j1'")
        conn.execute('UPDATE pages SET layout_checked = 1 WHERE id = 1')
        conn.commit()

        refused = client.post('/api/jobs/j1/rerun', json={'from_phase': 'start'}, headers=ADMIN)
        assert refused.status_code == 409
        assert conn.execute('SELECT deleted FROM elements WHERE id = 1').fetchone()[0] == 0

        forced = client.post('/api/jobs/j1/rerun', json={'from_phase': 'start', 'force': True},
                             headers=ADMIN)
        assert forced.status_code == 200, forced.text
        assert conn.execute('SELECT layout_checked FROM pages WHERE id = 1').fetchone()[0] == 0

    def test_starting_over_with_layout_on_detects_the_boxes_again(self, client, conn):
        client.post('/api/jobs/j1/rerun', json={'from_phase': 'start'}, headers=ADMIN)

        assert conn.execute('SELECT deleted FROM elements WHERE id = 1').fetchone()[0] == 1
        assert job(conn)['run_layout'] == 1

    def test_starting_over_asks_for_the_layout_permission(self, client):
        no_layout = {**ALICE, 'X-Auth-Caps': 'pipeline.lines pipeline.ocr'}

        response = client.post('/api/jobs/j1/rerun', json={'from_phase': 'start'}, headers=no_layout)

        assert response.status_code == 403

    def test_a_reading_switched_on_reaches_pages_no_line_detection_will_advance(self, client, conn):
        conn.executescript("""
            UPDATE jobs SET run_lines = 0, run_ocr = 0 WHERE id = 'j1';
            INSERT INTO pages (id, job_id, idx, filename, source_file, status)
                VALUES (2, 'j1', 1, 'p2.png', '/p2.png', 'layout_done');
        """)

        client.post('/api/jobs/j1/rerun', json={'from_phase': 'ocr'}, headers=ADMIN)

        assert [r['status'] for r in conn.execute('SELECT status FROM pages ORDER BY id')] == [
            'lines_done', 'lines_done']

    def test_a_deleted_page_is_never_handed_back_to_the_runner(self, client, conn):
        conn.execute('UPDATE pages SET deleted = 1 WHERE id = 1')
        conn.commit()

        client.post('/api/jobs/j1/rerun', json={'from_phase': 'lines'}, headers=ADMIN)

        assert len(lines(conn)) == 2, 'its lines are left alone'

    def test_a_phase_nobody_offers_is_refused_with_the_list(self, client):
        response = client.post('/api/jobs/j1/rerun', json={'from_phase': 'magic'}, headers=ADMIN)

        assert response.status_code == 400
        assert 'align' in response.json()['detail']

    def test_a_dataset_already_working_is_refused(self, client, conn):
        conn.execute("UPDATE jobs SET status = 'running' WHERE id = 'j1'")
        conn.commit()

        assert client.post('/api/jobs/j1/rerun', json={'from_phase': 'ocr'},
                           headers=ADMIN).status_code == 409

    def test_the_owner_may_re_run_the_reading_without_being_an_admin(self, client):
        assert client.post('/api/jobs/j1/rerun', json={'from_phase': 'ocr'},
                           headers=ALICE).status_code == 200

    def test_throwing_the_checked_readings_away_is_a_permission_of_its_own(self, client, conn):
        response = client.post('/api/jobs/j1/rerun',
                               json={'from_phase': 'ocr', 'keep_checked': False}, headers=ALICE)

        assert response.status_code == 403
        assert response.json()['detail'] == 'not permitted: pipeline.discard'
        assert conn.execute('SELECT checked FROM lines WHERE id = 1').fetchone()['checked'] == 1

    def test_somebody_else_s_dataset_is_not_theirs_to_re_run(self, client):
        assert client.post('/api/jobs/j1/rerun', json={'from_phase': 'ocr'},
                           headers=BOB).status_code == 404

    def test_a_dataset_shared_with_a_member_is_still_the_owner_s_to_re_run(self, client, conn):
        conn.execute("INSERT INTO job_assignees (job_id, username) VALUES ('j1', 'bob')")
        conn.commit()

        response = client.post('/api/jobs/j1/rerun', json={'from_phase': 'ocr'}, headers=BOB)

        assert response.status_code == 403
        assert response.json()['detail'] == 'only the owner or an admin may re-run Volume'
        assert job(conn)['status'] == 'done'
        assert [line['text'] for line in lines(conn)] == ['Machine read', 'Second line']

    def test_a_dataset_that_does_not_exist_is_a_404(self, client):
        assert client.post('/api/jobs/nope/rerun', json={'from_phase': 'ocr'},
                           headers=ADMIN).status_code == 404
