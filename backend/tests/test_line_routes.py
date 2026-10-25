"""One line at a time: correcting it, reshaping it, splitting and merging, drawing a new
one. Correcting a line is the whole point of the app, and every rule around it is about
not losing what a person typed - so what the pool keeps and what stays checked is asserted
alongside what came back.
"""
import io
import json

import pytest
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw

from app import caches, linecrop, store
from app.deps import get_db
from app.main import app

SECRET = 'test-secret'
ADMIN = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'root', 'X-Auth-Role': 'admin'}
ALICE = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'alice', 'X-Auth-Role': 'member'}
BOB = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'bob', 'X-Auth-Role': 'member'}
ALICE_READER = {**ALICE, 'X-Auth-Caps': 'pipeline.ocr'}

C_ACUTE = '\N{LATIN SMALL LETTER C WITH ACUTE}'
ACUTE = '\N{COMBINING ACUTE ACCENT}'
U_UMLAUT = '\N{LATIN SMALL LETTER U WITH DIAERESIS}'
DIAERESIS = '\N{COMBINING DIAERESIS}'


def quad(x0, y0, x1, y1):
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]


TOP = quad(0.1, 0.10, 0.9, 0.20)
BOTTOM = quad(0.1, 0.22, 0.9, 0.32)
# Not a rectangle, so the crop's corners hold something the line does not claim.
WEDGE = [[0.1, 0.1], [0.9, 0.1], [0.9, 0.3], [0.5, 0.3]]


def as_jpeg(img) -> bytes:
    buffer = io.BytesIO()
    img.save(buffer, 'JPEG', quality=90)
    return buffer.getvalue()


def recipe_of(client) -> str:
    page = client.get('/api/jobs/j1/pages/1', headers=ALICE).json()
    return page['elements'][0]['lines'][0]['crop_recipe']


@pytest.fixture
def scan(tmp_path):
    path = tmp_path / 'p1.png'
    Image.new('RGB', (400, 200), 'white').save(path)
    return path


@pytest.fixture
def conn(tmp_path, scan, monkeypatch):
    monkeypatch.setattr('app.config.JOBS_DIR', tmp_path / 'jobs')
    monkeypatch.setattr('app.config.SAVE_OCR_DATA', False)
    connection = store.connect(tmp_path / 'app.db')
    connection.executescript(f"""
        INSERT INTO jobs (id, name, owner, status, run_ocr) VALUES ('j1', 'Volume', 'alice', 'done', 1);
        INSERT INTO pages (id, job_id, idx, filename, source_file, status, width, height)
            VALUES (1, 'j1', 0, 'p1.png', '{scan}', 'done', 400, 200);
        INSERT INTO elements (id, page_id, order_idx, class_name, raw_class_name, bbox, kind)
            VALUES (1, 1, 0, 'Paragraph', 'Paragraph', '[0.0,0.0,1.0,0.5]', 'content');
        INSERT INTO lines (id, element_id, order_idx, polygon, text) VALUES
            (1, 1, 0, '{json.dumps(TOP)}', 'Frst line'),
            (2, 1, 1, '{json.dumps(BOTTOM)}', 'Second line');
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


def line(conn, line_id):
    return conn.execute('SELECT * FROM lines WHERE id = ?', (line_id,)).fetchone()


def live_lines(conn, element_id=1):
    return conn.execute(
        'SELECT * FROM lines WHERE element_id = ? AND deleted = 0 ORDER BY order_idx',
        (element_id,)).fetchall()


class TestCorrecting:
    def test_typing_a_correction_leaves_it_unchecked(self, client, conn):
        """Checking is its own, explicit step: a correction saved by leaving the line
        is not yet a review."""
        response = client.patch('/api/lines/1', json={'corrected_text': 'First line'},
                                headers=ALICE)

        assert response.status_code == 200, response.text
        assert line(conn, 1)['corrected_text'] == 'First line'
        assert line(conn, 1)['checked'] == 0

    def test_correcting_a_checked_line_unchecks_it(self, client, conn):
        """The check was given to the text that was there."""
        client.patch('/api/lines/1', json={'checked': True}, headers=ALICE)

        client.patch('/api/lines/1', json={'corrected_text': 'First line'}, headers=ALICE)

        assert line(conn, 1)['checked'] == 0

    def test_a_correction_and_its_check_can_be_saved_together(self, client, conn):
        client.patch('/api/lines/1', json={'corrected_text': 'First line', 'checked': True},
                     headers=ALICE)

        assert line(conn, 1)['checked'] == 1

    def test_a_typed_correction_is_stored_decomposed_like_the_model_writes(self, client, conn):
        client.patch('/api/lines/1', json={'corrected_text': f'Puci{C_ACUTE} Medo, Gf. 825'}, headers=ALICE)

        assert line(conn, 1)['corrected_text'] == f'Pucic{ACUTE} Medo, Gf. 825'

    def test_a_taken_reading_is_stored_decomposed(self, client, conn):
        client.patch('/api/lines/1', json={'corrected_text': f'Gr{U_UMLAUT}ße', 'from_reading': True},
                     headers=ALICE)

        assert line(conn, 1)['corrected_text'] == f'Gru{DIAERESIS}ße'

    def test_a_correction_can_be_saved_without_claiming_it_is_reviewed(self, client, conn):
        client.patch('/api/lines/1', json={'corrected_text': 'First line', 'checked': False},
                     headers=ALICE)

        assert line(conn, 1)['checked'] == 0

    def test_clearing_the_correction_hands_the_line_back_unchecked(self, client, conn):
        """A revert withdraws the person's judgement; approving the OCR text as it stands
        is a second, explicit click."""
        client.patch('/api/lines/1', json={'corrected_text': 'First line'}, headers=ALICE)

        client.patch('/api/lines/1', json={'corrected_text': None}, headers=ALICE)

        row = line(conn, 1)
        assert (row['checked'], row['check_source'], row['corrected_by']) == (0, None, None)

    def test_checking_it_on_its_own_leaves_the_text_alone(self, client, conn):
        client.patch('/api/lines/1', json={'checked': True}, headers=ALICE)

        row = line(conn, 1)
        assert (row['checked'], row['text'], row['corrected_text']) == (1, 'Frst line', None)

    def test_reviewing_a_line_cancels_a_pending_re_read(self, client, conn):
        conn.execute('UPDATE lines SET needs_ocr = 1 WHERE id = 1')
        conn.commit()

        client.patch('/api/lines/1', json={'checked': True}, headers=ALICE)

        assert line(conn, 1)['needs_ocr'] == 0

    def test_the_correction_is_written_to_the_history(self, client, conn):
        client.patch('/api/lines/1', json={'corrected_text': 'First line'}, headers=ALICE)

        assert conn.execute(
            "SELECT author FROM revisions WHERE target_type = 'line' AND target_id = 1"
        ).fetchone()['author'] == 'alice'

    def test_a_line_that_does_not_exist_is_a_404(self, client):
        assert client.patch('/api/lines/99', json={'checked': True},
                            headers=ALICE).status_code == 404

    def test_an_edit_against_a_stale_revision_is_refused(self, client, conn):
        conn.execute("INSERT INTO job_assignees (job_id, username) VALUES ('j1', 'bob')")
        conn.commit()
        client.patch('/api/lines/1', json={'corrected_text': 'Mine'}, headers=ALICE)

        clash = client.patch('/api/lines/1', json={'corrected_text': 'Theirs', 'revision': 0},
                             headers=BOB)

        assert clash.status_code == 409
        assert line(conn, 1)['corrected_text'] == 'Mine'



class TestTakingAReading:
    """Choosing a reading overwrites the correction like typing does, but it is the one
    gesture that must be reversible without retyping: the typed text it displaces joins the
    pool under the person's name. Typing over a correction offers nothing back."""

    def _held(self, conn, line_id=1):
        return [(r['source'], r['author'], r['text'], r['dismissed']) for r in conn.execute(
            'SELECT source, author, text, dismissed FROM candidates WHERE line_id = ? ORDER BY id',
            (line_id,))]

    def _offer(self, conn, text, author='llm:Reader'):
        conn.execute(
            'INSERT INTO candidates (page_id, line_id, source, author, text, order_idx, polygon) '
            "VALUES (1, 1, 'llm', ?, ?, 0, ?)", (author, text, json.dumps(TOP)))
        conn.commit()

    def test_taking_a_reading_offers_the_typed_correction_back(self, client, conn):
        self._offer(conn, 'First line')
        client.patch('/api/lines/1', json={'corrected_text': 'Typed by hand'}, headers=ALICE)

        response = client.patch('/api/lines/1', json={'corrected_text': 'First line', 'from_reading': True},
                                headers=ALICE)

        assert response.status_code == 200, response.text
        assert line(conn, 1)['corrected_text'] == 'First line'
        assert self._held(conn) == [('llm', 'llm:Reader', 'First line', 0),
                                    ('human', 'alice', 'Typed by hand', 0)]

    def test_typing_over_a_correction_offers_nothing_back(self, client, conn):
        client.patch('/api/lines/1', json={'corrected_text': 'Typed by hand'}, headers=ALICE)

        client.patch('/api/lines/1', json={'corrected_text': 'Typed over again'}, headers=ALICE)

        assert self._held(conn) == []

    def test_a_reading_put_back_is_not_offered_a_second_time(self, client, conn):
        """The line wears a reading; taking another displaces that reading, not typed text,
        and it is already on offer under its reader's name."""
        self._offer(conn, 'First line')
        self._offer(conn, 'Fírst line', author='llm:Other')
        client.patch('/api/lines/1', json={'corrected_text': 'First line', 'from_reading': True}, headers=ALICE)

        client.patch('/api/lines/1', json={'corrected_text': 'Fírst line', 'from_reading': True}, headers=ALICE)

        assert self._held(conn) == [('llm', 'llm:Reader', 'First line', 0),
                                    ('llm', 'llm:Other', 'Fírst line', 0)]

    def test_a_composed_correction_is_not_offered_back_by_its_own_decomposed_words(self, client, conn):
        """Corrections saved before text was decomposed on the way in are still composed."""
        conn.execute("UPDATE lines SET corrected_text = ?, corrected_by = 'alice' WHERE id = 1", (f'Puci{C_ACUTE}',))
        conn.commit()

        client.patch('/api/lines/1', json={'corrected_text': f'Puci{C_ACUTE}', 'from_reading': True}, headers=ALICE)

        assert line(conn, 1)['corrected_text'] == f'Pucic{ACUTE}'
        assert self._held(conn) == []

    def test_what_the_models_settled_is_not_offered_as_a_persons_word(self, client, conn):
        self._offer(conn, 'First line')
        conn.execute("UPDATE lines SET corrected_text = 'Frist line', corrected_by = 'llm:consensus@2' WHERE id = 1")
        conn.commit()

        client.patch('/api/lines/1', json={'corrected_text': 'First line', 'from_reading': True}, headers=ALICE)

        assert self._held(conn) == [('llm', 'llm:Reader', 'First line', 0)]

    def test_reverting_to_the_ocr_text_offers_the_typed_correction_back(self, client, conn):
        client.patch('/api/lines/1', json={'corrected_text': 'Typed by hand'}, headers=ALICE)

        response = client.patch('/api/lines/1', json={'corrected_text': None}, headers=ALICE)

        assert response.status_code == 200, response.text
        assert line(conn, 1)['corrected_text'] is None
        assert self._held(conn) == [('human', 'alice', 'Typed by hand', 0)]

    def test_reverting_what_the_models_settled_offers_nothing_back(self, client, conn):
        conn.execute("UPDATE lines SET corrected_text = 'Frist line', corrected_by = 'llm:consensus@2' WHERE id = 1")
        conn.commit()

        client.patch('/api/lines/1', json={'corrected_text': None}, headers=ALICE)

        assert line(conn, 1)['corrected_text'] is None
        assert self._held(conn) == []


class TestALineTheModelsSettled:
    """Language models agreeing check a line with check_source 'llm', which keeps it out of
    person-only training and the header CER. Once a person corrects, checks or unchecks it
    the line is theirs, and must not still read as machine-settled."""

    @pytest.fixture(autouse=True)
    def settled(self, conn):
        conn.execute("UPDATE lines SET corrected_text = 'First line', corrected_by = 'llm:consensus@2', "
                     "checked = 1, check_source = 'llm'")
        conn.commit()

    def source(self, conn, line_id):
        row = line(conn, line_id)
        return row['checked'], row['check_source']

    def test_a_correction_withdraws_the_machine_check(self, client, conn):
        client.patch('/api/lines/1', json={'corrected_text': 'First line!'}, headers=ALICE)

        assert self.source(conn, 1) == (0, None)
        assert self.source(conn, 2) == (1, 'llm')
        assert (line(conn, 1)['corrected_by'], line(conn, 2)['corrected_by']) == ('alice', 'llm:consensus@2')

    def test_clearing_the_correction_leaves_no_author_on_it(self, client, conn):
        client.patch('/api/lines/1', json={'corrected_text': None, 'checked': False}, headers=ALICE)

        row = line(conn, 1)
        assert (row['corrected_text'], row['corrected_by']) == (None, None)

    def test_checking_it_again_makes_it_the_persons(self, client, conn):
        client.patch('/api/lines/1', json={'checked': True}, headers=ALICE)

        assert self.source(conn, 1) == (1, None)

    def test_unchecking_it_leaves_no_machine_check_behind(self, client, conn):
        client.patch('/api/lines/1', json={'checked': False}, headers=ALICE)

        assert self.source(conn, 1) == (0, None)

    def test_reshaping_it_alone_does_not(self, client, conn):
        client.patch('/api/lines/1', json={'polygon': TOP}, headers=ALICE)

        assert self.source(conn, 1) == (1, 'llm')

    def test_splitting_it_leaves_no_machine_check_on_either_half(self, client, conn):
        halves = client.post('/api/lines/1/split', json={'cut_x': 0.5}, headers=ALICE).json()['lines']

        assert [self.source(conn, h['id']) for h in halves] == [(0, None), (0, None)]
        assert [line(conn, h['id'])['corrected_by'] for h in halves] == [None, None]

    def test_merging_leaves_no_machine_check_on_the_line_that_remains(self, client, conn):
        merged = client.post('/api/lines/merge', json={'ids': [1, 2]}, headers=ALICE).json()['id']

        assert self.source(conn, merged) == (0, None)
        assert line(conn, merged)['corrected_by'] is None

class TestReshaping:
    def test_a_reshape_keeps_the_reading_and_the_correction(self, client, conn):
        """A box tweak is usually over the same characters."""
        client.patch('/api/lines/1', json={'corrected_text': 'First line', 'checked': False},
                     headers=ALICE)

        client.patch('/api/lines/1', json={'polygon': quad(0.1, 0.10, 0.8, 0.20)}, headers=ALICE)

        row = line(conn, 1)
        assert (row['text'], row['corrected_text']) == ('Frst line', 'First line')

    def test_reshaping_an_untouched_line_asks_for_it_to_be_read_again(self, client, conn):
        client.patch('/api/lines/1', json={'polygon': quad(0.1, 0.10, 0.5, 0.20)}, headers=ALICE)

        assert line(conn, 1)['needs_ocr'] == 1

    def test_reshaping_a_line_somebody_verified_does_not(self, client, conn):
        conn.execute('UPDATE lines SET checked = 1 WHERE id = 1')
        conn.commit()

        client.patch('/api/lines/1', json={'polygon': quad(0.1, 0.10, 0.5, 0.20)}, headers=ALICE)

        assert line(conn, 1)['needs_ocr'] == 0

    def test_a_polygon_off_the_page_is_refused(self, client):
        assert client.patch('/api/lines/1', json={'polygon': quad(0.1, 0.1, 1.5, 0.2)},
                            headers=ALICE).status_code == 400

    def test_rotating_it_is_a_display_choice_and_asks_for_no_re_read(self, client, conn):
        client.patch('/api/lines/1', json={'orientation': 180}, headers=ALICE)

        row = line(conn, 1)
        assert (row['orientation'], row['needs_ocr']) == (180, 0)

    def test_orientation_wraps_rather_than_growing(self, client, conn):
        client.patch('/api/lines/1', json={'orientation': 450}, headers=ALICE)

        assert line(conn, 1)['orientation'] == 90


class TestRemovingAndRereading:
    def test_deleting_is_soft_and_closes_the_gap_in_reading_order(self, client, conn):
        assert client.delete('/api/lines/1', headers=ALICE).status_code == 200

        assert line(conn, 1)['deleted'] == 1
        assert [row['id'] for row in live_lines(conn)] == [2]
        assert [row['order_idx'] for row in live_lines(conn)] == [0]

    def test_deleting_against_a_stale_revision_is_refused(self, client, conn):
        """The brush judges a line by the shape it loaded. One a colleague reshaped since
        is theirs: left standing and named, like a reshape of it would be, not thrown away."""
        client.patch('/api/lines/1', json={'polygon': quad(0.1, 0.10, 0.8, 0.20)}, headers=ALICE)

        clash = client.delete('/api/lines/1?revision=0', headers=ALICE)

        assert clash.status_code == 409
        assert clash.json()['detail']['code'] == 'conflict'
        assert line(conn, 1)['deleted'] == 0
        assert [row['id'] for row in live_lines(conn)] == [1, 2]

    def test_deleting_with_the_revision_loaded_goes_through(self, client, conn):
        loaded = client.patch('/api/lines/1', json={'polygon': quad(0.1, 0.10, 0.8, 0.20)},
                              headers=ALICE).json()

        response = client.delete(f"/api/lines/1?revision={loaded['revision']}", headers=ALICE)

        assert response.status_code == 200
        assert response.json()['revision'] > loaded['revision']
        assert line(conn, 1)['deleted'] == 1

    def test_asking_for_one_line_to_be_read_again_marks_it(self, client, conn):
        response = client.post('/api/lines/1/reocr', headers=ALICE_READER)

        assert response.status_code == 200
        assert line(conn, 1)['needs_ocr'] == 1

    def test_it_turns_the_reading_phase_on_for_an_imported_dataset(self, client, conn):
        """Otherwise the line spins for good: the batch worker only re-queues datasets
        that read at all."""
        conn.execute("UPDATE jobs SET run_ocr = 0 WHERE id = 'j1'")
        conn.commit()

        client.post('/api/lines/1/reocr', headers=ALICE_READER)

        assert conn.execute("SELECT run_ocr FROM jobs WHERE id = 'j1'").fetchone()[0] == 1

    def test_a_deleted_line_cannot_be_queued_for_reading(self, client, conn):
        conn.execute('UPDATE lines SET deleted = 1 WHERE id = 1')
        conn.commit()

        assert client.post('/api/lines/1/reocr', headers=ALICE_READER).status_code == 404

    def test_reading_one_line_again_needs_the_ocr_capability_like_the_whole_dataset(self, client, conn):
        """Queueing the line also switches reading on for the dataset, a setting a member
        cannot change themselves."""
        conn.execute("UPDATE jobs SET run_ocr = 0 WHERE id = 'j1'")
        conn.commit()

        response = client.post('/api/lines/1/reocr', headers=ALICE)

        assert response.status_code == 403
        assert response.json()['detail'] == 'not permitted: pipeline.ocr'
        assert line(conn, 1)['needs_ocr'] == 0
        assert conn.execute("SELECT run_ocr FROM jobs WHERE id = 'j1'").fetchone()[0] == 0


class TestSplitting:
    def test_a_vertical_cut_makes_two_lines_of_one(self, client, conn):
        response = client.post('/api/lines/1/split', json={'cut_x': 0.5}, headers=ALICE)

        assert response.status_code == 200, response.text
        assert len(live_lines(conn)) == 3
        first, second = response.json()['lines']
        assert json.loads(line(conn, first['id'])['polygon'])[1][0] == pytest.approx(0.5)
        assert json.loads(line(conn, second['id'])['polygon'])[0][0] == pytest.approx(0.5)

    def test_a_horizontal_cut_does_too(self, client, conn):
        response = client.post('/api/lines/1/split', json={'cut_y': 0.15}, headers=ALICE)

        assert response.status_code == 200
        assert len(live_lines(conn)) == 3

    def test_a_drawn_cut_is_taken_as_the_line_through_two_points(self, client, conn):
        response = client.post('/api/lines/1/split',
                               json={'cut_line': [[0.5, 0.05], [0.5, 0.25]]}, headers=ALICE)

        assert response.status_code == 200, response.text
        assert len(live_lines(conn)) == 3

    def test_the_text_of_the_unsplit_line_goes_to_the_pool(self, client, conn):
        """It described a line that no longer exists, so it is offered rather than
        left on half of it as though it still applied."""
        client.patch('/api/lines/1', json={'corrected_text': 'First line'}, headers=ALICE)

        client.post('/api/lines/1/split', json={'cut_x': 0.5}, headers=ALICE)

        held = [r['text'] for r in conn.execute('SELECT text FROM candidates')]
        assert 'First line' in held
        assert line(conn, 1)['corrected_text'] is None
        assert line(conn, 1)['checked'] == 0

    def test_a_cut_that_would_leave_a_sliver_is_refused(self, client):
        response = client.post('/api/lines/1/split', json={'cut_x': 0.101}, headers=ALICE)

        assert response.status_code == 400
        assert 'sliver' in response.json()['detail']

    def test_a_cut_outside_the_line_is_refused(self, client):
        assert client.post('/api/lines/1/split', json={'cut_x': 0.95},
                           headers=ALICE).status_code == 400

    def test_it_takes_exactly_one_cut(self, client):
        assert client.post('/api/lines/1/split', json={}, headers=ALICE).status_code == 400
        assert client.post('/api/lines/1/split', json={'cut_x': 0.5, 'cut_y': 0.15},
                           headers=ALICE).status_code == 400

    def test_a_drawn_cut_must_be_two_points(self, client):
        assert client.post('/api/lines/1/split', json={'cut_line': [[0.5, 0.05]]},
                           headers=ALICE).status_code == 400


class TestMerging:
    def test_two_lines_become_one_box_over_both(self, client, conn):
        response = client.post('/api/lines/merge', json={'ids': [1, 2]}, headers=ALICE)

        assert response.status_code == 200, response.text
        assert len(live_lines(conn)) == 1
        merged = json.loads(line(conn, response.json()['id'])['polygon'])
        assert min(p[1] for p in merged) == pytest.approx(0.10, abs=0.01)
        assert max(p[1] for p in merged) == pytest.approx(0.32, abs=0.01)

    def test_the_topmost_line_is_the_one_that_remains(self, client, conn):
        kept = client.post('/api/lines/merge', json={'ids': [2, 1]}, headers=ALICE).json()

        assert kept['id'] == 1
        assert line(conn, 2)['deleted'] == 1

    def test_what_both_lines_said_is_kept_in_the_pool(self, client, conn):
        client.post('/api/lines/merge', json={'ids': [1, 2]}, headers=ALICE)

        held = {r['text'] for r in conn.execute('SELECT text FROM candidates')}
        assert {'Frst line', 'Second line'} <= held
        assert line(conn, 1)['text'] is None, 'the merged line is unread until it is read again'

    def test_merging_needs_two(self, client):
        assert client.post('/api/lines/merge', json={'ids': [1]},
                           headers=ALICE).status_code == 400

    def test_lines_under_different_boxes_cannot_be_merged(self, client, conn):
        conn.execute("INSERT INTO elements (id, page_id, order_idx, class_name, bbox, kind) "
                     "VALUES (2, 1, 1, 'Paragraph', '[0,0.5,1,1]', 'content')")
        conn.execute("INSERT INTO lines (id, element_id, order_idx, polygon) "
                     f"VALUES (3, 2, 0, '{json.dumps(quad(0.1, 0.6, 0.9, 0.7))}')")
        conn.commit()

        response = client.post('/api/lines/merge', json={'ids': [1, 3]}, headers=ALICE)

        assert response.status_code == 400
        assert 'share an element' in response.json()['detail']

    def test_a_line_that_does_not_exist_is_a_404(self, client):
        assert client.post('/api/lines/merge', json={'ids': [1, 99]},
                           headers=ALICE).status_code == 404

    def _reading(self, conn, text, line_id, order_idx):
        cur = conn.execute(
            "INSERT INTO candidates (page_id, line_id, source, author, llm_model_id, text, order_idx, "
            "similarity) VALUES (1, ?, 'llm', 'llm:Reader', 7, ?, ?, 1.0)", (line_id, text, order_idx))
        conn.commit()
        return cur.lastrowid

    def _read_once_by(self, conn, picked):
        """Model 7 has read the scan; the dataset reads with `picked`."""
        conn.execute("UPDATE pages SET content_hash = 'scan' WHERE id = 1")
        conn.execute("UPDATE jobs SET llm_model_ids = ? WHERE id = 'j1'", (json.dumps(picked),))
        conn.execute("INSERT INTO llm_reads (content_hash, llm_model_id, status, raw_text) "
                     "VALUES ('scan', 7, 'done', ?)", (json.dumps(['Frst line', 'Second line']),))
        conn.commit()

    def _readings(self, conn):
        return {r['id']: (r['line_id'], r['dismissed']) for r in conn.execute(
            "SELECT id, line_id, dismissed FROM candidates WHERE source = 'llm'")}

    def _read_status(self, conn):
        return conn.execute('SELECT status FROM llm_reads').fetchone()['status']

    def test_the_halves_readings_are_set_aside_and_no_model_is_asked_again(self, client, conn):
        """Half-readings joined would be guesswork. Neither reading stays
        on the merged line - not even the one that sat on the id it kept. A model reads the
        page image, which a merge does not change, so asking it again would buy the same
        answer twice."""
        first, second = self._reading(conn, 'Frst line', 1, 0), self._reading(conn, 'Second line', 2, 1)
        self._read_once_by(conn, picked=[7])

        assert client.post('/api/lines/merge', json={'ids': [1, 2]}, headers=ALICE).status_code == 200

        assert conn.execute(
            'SELECT COUNT(*) c FROM candidates WHERE line_id = 1 AND dismissed = 0').fetchone()['c'] == 0
        # On record for undo, offered on no line.
        assert self._readings(conn) == {first: (None, 1), second: (None, 1)}
        assert self._read_status(conn) == 'done'

    def test_a_dataset_reading_with_no_model_is_not_read_again(self, client, conn):
        first, second = self._reading(conn, 'Frst line', 1, 0), self._reading(conn, 'Second line', 2, 1)
        self._read_once_by(conn, picked=[])

        assert client.post('/api/lines/merge', json={'ids': [1, 2]}, headers=ALICE).status_code == 200

        assert self._readings(conn) == {first: (None, 1), second: (None, 1)}
        assert self._read_status(conn) == 'done'


class TestDrawingOne:
    def test_a_line_drawn_inside_a_box_belongs_to_it(self, client, conn):
        response = client.post('/api/pages/1/lines',
                               json={'polygon': quad(0.1, 0.35, 0.9, 0.45)}, headers=ALICE)

        assert response.status_code == 200, response.text
        assert line(conn, response.json()['id'])['element_id'] == 1

    def test_the_smallest_box_containing_it_wins(self, client, conn):
        conn.execute("INSERT INTO elements (id, page_id, order_idx, class_name, bbox, kind) "
                     "VALUES (2, 1, 1, 'Header', '[0.0,0.3,0.5,0.5]', 'content')")
        conn.commit()

        new_id = client.post('/api/pages/1/lines',
                             json={'polygon': quad(0.1, 0.35, 0.4, 0.45)},
                             headers=ALICE).json()['id']

        assert line(conn, new_id)['element_id'] == 2

    def test_a_line_outside_every_box_goes_to_the_pages_orphan_bucket(self, client, conn):
        new_id = client.post('/api/pages/1/lines',
                             json={'polygon': quad(0.1, 0.8, 0.9, 0.9)},
                             headers=ALICE).json()['id']

        bucket = conn.execute('SELECT kind FROM elements WHERE id = ?',
                              (line(conn, new_id)['element_id'],)).fetchone()
        assert bucket['kind'] == 'orphan'

    def test_the_page_keeps_one_bucket_however_many_strays_it_has(self, client, conn):
        for y in (0.8, 0.9):
            client.post('/api/pages/1/lines', json={'polygon': quad(0.1, y, 0.9, y + 0.05)},
                        headers=ALICE)

        assert conn.execute(
            "SELECT COUNT(*) c FROM elements WHERE kind = 'orphan'").fetchone()['c'] == 1

    def test_nothing_can_be_drawn_on_a_deleted_page(self, client, conn):
        conn.execute('UPDATE pages SET deleted = 1 WHERE id = 1')
        conn.commit()

        assert client.post('/api/pages/1/lines', json={'polygon': quad(0.1, 0.35, 0.9, 0.45)},
                           headers=ALICE).status_code == 409

    def test_a_page_that_does_not_exist_is_a_404(self, client):
        assert client.post('/api/pages/99/lines', json={'polygon': quad(0.1, 0.1, 0.9, 0.2)},
                           headers=ALICE).status_code == 404


class TestTheCrop:
    def test_the_deskewed_crop_is_cut_and_kept(self, client, tmp_path):
        response = client.get('/api/lines/1/crop', headers=ALICE)

        assert response.status_code == 200
        assert response.headers['content-type'] == 'image/jpeg'
        assert caches.line_crop_path('j1', 1).exists()

    def test_reshaping_the_line_throws_the_stale_crop_away(self, client, tmp_path):
        client.get('/api/lines/1/crop', headers=ALICE)
        cached = caches.line_crop_path('j1', 1)

        client.patch('/api/lines/1', json={'polygon': quad(0.1, 0.10, 0.5, 0.20)}, headers=ALICE)

        assert not cached.exists()

    def test_a_scan_that_is_gone_says_so(self, client, scan):
        scan.unlink()

        response = client.get('/api/lines/1/crop', headers=ALICE)

        assert response.status_code == 404
        assert 'source image missing' in response.json()['detail']

    def test_a_line_that_does_not_exist_is_a_404(self, client):
        assert client.get('/api/lines/99/crop', headers=ALICE).status_code == 404

    def test_a_crop_cut_before_masking_is_not_served_after_it(
            self, client, conn, scan, monkeypatch):
        """The cache has to be keyed on how the crop is cut. Turning masking on otherwise
        leaves every crop already on disk showing the neighbours' ink it paints out."""
        conn.execute('UPDATE lines SET polygon = ? WHERE id = 1', (json.dumps(WEDGE),))
        conn.commit()
        with Image.open(scan) as page:
            sheet = page.convert('RGB')
        ImageDraw.Draw(sheet).rectangle((45, 45, 120, 60), fill='black')
        sheet.save(scan)
        poly = [[x * sheet.width, y * sheet.height] for x, y in WEDGE]
        plain = as_jpeg(linecrop.crop_line(sheet, poly, mask=False))
        masked = as_jpeg(linecrop.crop_line(sheet, poly, mask=True))
        assert plain != masked, 'the wedge must actually have something to paint out'

        monkeypatch.setattr('app.config.LINE_CROP_MASK', False)
        assert client.get('/api/lines/1/crop', headers=ALICE).content == plain
        monkeypatch.setattr('app.config.LINE_CROP_MASK', True)

        assert client.get('/api/lines/1/crop', headers=ALICE).content == masked

    def test_the_line_says_how_its_crop_is_cut(self, client, monkeypatch):
        """A crop is cached in the browser for a year, so its URL carries the recipe - and
        only the server knows when it starts cutting them another way."""
        monkeypatch.setattr('app.config.LINE_CROP_MASK', False)
        assert recipe_of(client) == 'v2'

        monkeypatch.setattr('app.config.LINE_CROP_MASK', True)

        assert recipe_of(client) == 'v2-masked'


class TestWhoMayEdit:
    def test_a_stranger_is_not_told_the_line_exists(self, client):
        assert client.patch('/api/lines/1', json={'checked': True},
                            headers=BOB).status_code == 404
        assert client.get('/api/lines/1/crop', headers=BOB).status_code == 404

    def test_someone_it_was_shared_with_may_correct_it(self, client, conn):
        conn.execute("INSERT INTO job_assignees (job_id, username) VALUES ('j1', 'bob')")
        conn.commit()

        assert client.patch('/api/lines/1', json={'corrected_text': 'Theirs'},
                            headers=BOB).status_code == 200


class TestEditingLinesPutsTheReadingPoolRight:
    """A reading belongs to a line. Drawing one or throwing one away changes which readings
    have a home, and the panel must not be a page behind about it."""

    def _reading(self, conn, text, polygon=None, line_id=None):
        cur = conn.execute(
            'INSERT INTO candidates (page_id, line_id, source, author, llm_model_id, text, '
            'order_idx, polygon, similarity) VALUES (1,?,?,?,?,?,0,?,?)',
            (line_id, 'llm', 'Reader', 7, text,
             json.dumps(polygon) if polygon else None, 1.0 if line_id else None))
        conn.commit()
        return cur.lastrowid

    def _home(self, conn, candidate_id):
        return conn.execute('SELECT line_id FROM candidates WHERE id = ?',
                            (candidate_id,)).fetchone()['line_id']

    def test_deleting_a_line_sends_its_readings_back_to_the_pool(self, client, conn):
        held = self._reading(conn, 'Frst line', line_id=1)

        assert client.delete('/api/lines/1', headers=ALICE).status_code == 200

        # Homeless again, and so offered - rather than pointing at a line that is gone.
        assert self._home(conn, held) is None

    def test_drawing_a_line_takes_up_the_reading_that_was_waiting_for_it(self, client, conn):
        somewhere = quad(0.1, 0.60, 0.9, 0.70)
        held = self._reading(conn, 'A line nobody segmented', somewhere)
        assert self._home(conn, held) is None

        drawn = client.post('/api/pages/1/lines', json={'polygon': somewhere}, headers=ALICE)
        assert drawn.status_code == 200, drawn.text

        assert self._home(conn, held) == drawn.json()['id']


class TestWhoReadTheCurrentText:
    """Every training writes `<training>/output/model.ckpt`, so readings stored before the
    name went into the author say nothing at all about which model produced them."""

    def read(self, conn, line_id, author):
        conn.execute("INSERT INTO revisions (job_id, target_type, target_id, author, action, snapshot) "
                     "VALUES ('j1', 'line', ?, ?, 'update', '{}')", (line_id, author))
        conn.commit()

    def preview(self, client):
        return client.get('/api/jobs/j1/reocr', headers=ALICE).json()['authors']

    def test_a_nameless_reading_is_named_from_the_model_the_dataset_pins(self, client, conn):
        conn.execute("INSERT INTO models (id, task, name, checkpoint) "
                     "VALUES (9, 'ocr', 'letters-v11', '/data/trainings/17/output/model.ckpt')")
        conn.execute("UPDATE jobs SET model_ocr_id = 9 WHERE id = 'j1'")
        conn.commit()
        self.read(conn, 1, 'model:ocr@model.ckpt')
        self.read(conn, 2, 'model:ocr@letters-v11')

        # One reader, not two: the rows from before and after the name went in are summed.
        assert self.preview(client) == [{'author': 'model:ocr@letters-v11', 'lines': 2}]

    def test_a_nameless_reading_stays_nameless_where_the_dataset_pins_nothing(self, client, conn):
        self.read(conn, 1, 'model:ocr@model.ckpt')
        self.read(conn, 2, 'model:ocr@byte_20260902.pt')

        assert self.preview(client) == [
            {'author': 'model:ocr@model.ckpt', 'lines': 1},
            {'author': 'model:ocr@byte_20260902.pt', 'lines': 1}]

    def test_the_line_carries_the_same_name_the_dataset_gave_it(self, client, conn):
        conn.execute("INSERT INTO models (id, task, name, checkpoint) "
                     "VALUES (9, 'ocr', 'letters-v11', '/data/trainings/17/output/model.ckpt')")
        conn.execute("UPDATE jobs SET model_ocr_id = 9 WHERE id = 'j1'")
        conn.commit()
        self.read(conn, 1, 'model:ocr@model.ckpt#greedy')

        page = client.get('/api/jobs/j1/pages/1', headers=ALICE).json()
        assert page['elements'][0]['lines'][0]['text_author'] == 'model:ocr@letters-v11#greedy'


class TestHandWorkIsKnownToProvenance:
    def test_a_drawn_line_is_by_hand_and_a_detected_one_is_not(self, client, conn):
        new_id = client.post('/api/pages/1/lines', json={'polygon': quad(0.1, 0.35, 0.9, 0.45)},
                             headers=ALICE).json()['id']

        assert (line(conn, new_id)['by_hand'], line(conn, 2)['by_hand']) == (1, 0)

    def test_both_halves_of_a_split_are_by_hand_and_unread(self, client, conn):
        conn.execute("UPDATE lines SET ocr_model_id = 3, ocr_run_at = '2026-10-16' WHERE id = 1")
        conn.commit()

        halves = client.post('/api/lines/1/split', json={'cut_x': 0.5}, headers=ALICE).json()['lines']

        rows = [line(conn, half['id']) for half in halves]
        assert [(r['by_hand'], r['ocr_model_id'], r['ocr_run_at']) for r in rows] == [(1, None, None)] * 2

    def test_a_merged_line_is_by_hand_and_unread(self, client, conn):
        conn.execute('UPDATE lines SET ocr_model_id = 3')
        conn.commit()

        merged = client.post('/api/lines/merge', json={'ids': [1, 2]}, headers=ALICE).json()['id']

        assert (line(conn, merged)['by_hand'], line(conn, merged)['ocr_model_id']) == (1, None)
