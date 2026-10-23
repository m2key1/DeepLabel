"""Running a phase on one page, whether or not it has run there before. A dataset built
with detection off had no way to be given any; one seeded with placeholder text had no way
to be given real. What each phase would replace is said before it is queued, and whatever
it overwrites goes to the page's pool first.
"""
import pytest
from fastapi.testclient import TestClient

from app import store
from app.deps import get_db
from app.main import app

SECRET = 'test-secret'
ADMIN = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'root', 'X-Auth-Role': 'admin'}
MEMBER_CAPS = 'pipeline.layout pipeline.lines pipeline.ocr train.local'
ALICE = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'alice', 'X-Auth-Role': 'member',
         'X-Auth-Caps': MEMBER_CAPS}
BOB = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'bob', 'X-Auth-Role': 'member',
       'X-Auth-Caps': MEMBER_CAPS}
# Alice, once an admin has taken layout detection from her.
ALICE_NO_LAYOUT = {**ALICE, 'X-Auth-Caps': 'pipeline.lines pipeline.ocr train.local'}

POLY = '[[0,0],[1,0],[1,1],[0,1]]'


@pytest.fixture
def scan(tmp_path):
    """Every phase opens the page image, so an ingested page has one on disk."""
    path = tmp_path / 'p1.png'
    path.write_bytes(b'not really a png, but it is there')
    return path


@pytest.fixture
def conn(tmp_path, scan):
    connection = store.connect(tmp_path / 'app.db')
    connection.executescript(f"""
        INSERT INTO jobs (id, name, owner, status, run_layout, run_lines, run_ocr)
            VALUES ('j1', 'Seeded', 'alice', 'done', 0, 0, 0);
        INSERT INTO pages (id, job_id, idx, filename, source_file, status)
            VALUES (1, 'j1', 0, 'p1.png', '{scan}', 'done');
        INSERT INTO elements (id, page_id, order_idx, class_name, bbox, kind, lines_bbox)
            VALUES (1, 1, 0, 'Paragraph', '[0,0,1,1]', 'content', '[0,0,1,1]');
        INSERT INTO lines (id, element_id, order_idx, polygon, text, corrected_text, checked)
            VALUES (1, 1, 0, '{POLY}', 'Column 1, entry 1', NULL, 0),
                   (2, 1, 1, '{POLY}', 'Column 1, entry 2', 'Corrected by hand', 1),
                   (3, 1, 2, '{POLY}', 'Column 1, entry 3', NULL, 0);
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


def run(client, phase, headers=ALICE):
    return client.post('/api/pages/1/run', json={'phase': phase}, headers=headers)


def job(conn):
    return conn.execute("SELECT * FROM jobs WHERE id = 'j1'").fetchone()


def page(conn):
    return conn.execute('SELECT * FROM pages WHERE id = 1').fetchone()


def test_the_cost_of_each_phase_is_said_before_anything_runs(client):
    assert client.get('/api/pages/1/run', headers=ALICE).json() == {
        'layout': {'elements': 1, 'lines': 3, 'corrections': 1},
        'lines': {'lines': 3, 'corrections': 1},
        'ocr': {'unchecked': 2, 'checked': 1},
    }



class TestWhatEachPhaseTouches:
    """The counts are what each phase really replaces: layout takes every box and every
    line on the page, line detection only what is inside the content boxes, and a re-read
    never the lines of a container - a box reclassed to Table keeps its lines but is not
    read."""

    @pytest.fixture(autouse=True)
    def table(self, conn):
        conn.executescript(f"""
            INSERT INTO elements (id, page_id, order_idx, class_name, bbox, kind)
                VALUES (5, 1, 1, 'Table', '[0,0,1,1]', 'container');
            INSERT INTO lines (id, element_id, order_idx, polygon, text, corrected_text, checked)
                VALUES (5, 5, 0, '{POLY}', 'Table row 1', 'Row one', 1),
                       (6, 5, 1, '{POLY}', 'Table row 2', NULL, 0);
        """)
        conn.commit()

    def test_each_phase_counts_only_what_it_replaces(self, client):
        assert client.get('/api/pages/1/run', headers=ALICE).json() == {
            'layout': {'elements': 2, 'lines': 5, 'corrections': 2},
            'lines': {'lines': 3, 'corrections': 1},
            'ocr': {'unchecked': 2, 'checked': 1},
        }

    def test_line_detection_leaves_the_lines_outside_every_box_out_of_its_count(self, client, conn):
        conn.executescript(f"""
            INSERT INTO elements (id, page_id, order_idx, class_name, bbox, kind)
                VALUES (6, 1, 2, 'Unassigned', '[0,0,1,1]', 'orphan');
            INSERT INTO lines (id, element_id, order_idx, polygon, text, checked)
                VALUES (7, 6, 0, '{POLY}', 'Stray line', 0);
        """)
        conn.commit()

        costs = client.get('/api/pages/1/run', headers=ALICE).json()

        assert costs['lines'] == {'lines': 3, 'corrections': 1}
        assert costs['layout'] == {'elements': 2, 'lines': 6, 'corrections': 2}
        assert costs['ocr'] == {'unchecked': 3, 'checked': 1}

class TestLayout:
    def test_it_replaces_the_boxes_and_sends_the_page_back_to_detection(self, client, conn):
        response = run(client, 'layout')

        assert response.json() == {'ok': True, 'phase': 'layout', 'elements': 1, 'lines': 3,
                                   'corrections': 1}
        assert page(conn)['status'] == 'ingested'
        assert conn.execute('SELECT deleted FROM elements WHERE id = 1').fetchone()[0] == 1
        # Every phase after it runs too - fresh boxes need lines, fresh lines need reading.
        assert (job(conn)['run_layout'], job(conn)['run_lines'], job(conn)['run_ocr']) == (1, 1, 1)
        assert job(conn)['status'] == 'queued'

    def test_the_page_stops_counting_as_reviewed(self, client, conn):
        conn.execute('UPDATE pages SET layout_checked = 1 WHERE id = 1')
        conn.commit()

        run(client, 'layout')

        assert page(conn)['layout_checked'] == 0

    def test_what_it_overwrites_is_kept(self, client, conn):
        run(client, 'layout')

        held = conn.execute('SELECT source, text FROM candidates ORDER BY source').fetchall()
        assert ('human', 'Corrected by hand') in [(r['source'], r['text']) for r in held]
        assert 'Column 1, entry 1' in [r['text'] for r in held]


class TestLines:
    def test_it_points_the_detector_at_every_box_without_touching_the_page(self, client, conn):
        response = run(client, 'lines')

        assert response.json() == {'ok': True, 'phase': 'lines', 'lines': 3, 'corrections': 1}
        assert conn.execute('SELECT lines_bbox FROM elements WHERE id = 1').fetchone()[0] is None
        # The boxes stay: this replaces what is inside them, not the layout itself.
        assert conn.execute('SELECT deleted FROM elements WHERE id = 1').fetchone()[0] == 0
        assert page(conn)['status'] == 'done'
        assert (job(conn)['run_lines'], job(conn)['run_ocr']) == (1, 1)

    def test_corrections_are_kept_for_the_lines_that_replace_them(self, client, conn):
        run(client, 'lines')

        assert conn.execute(
            "SELECT COUNT(*) c FROM candidates WHERE source = 'human'").fetchone()['c'] == 1


class TestMapDataset:
    @pytest.mark.parametrize('phase', ['layout', 'lines', 'ocr'])
    def test_a_map_page_run_switches_on_no_text_phase(self, client, conn, phase):
        conn.execute("UPDATE jobs SET task = 'map_segmentation' WHERE id = 'j1'")
        conn.commit()

        assert run(client, phase).status_code == 200
        assert (job(conn)['run_layout'], job(conn)['run_lines'], job(conn)['run_ocr']) == (0, 0, 0)
        assert job(conn)['status'] == 'queued'


class TestOcr:
    def test_it_re_reads_the_unchecked_lines_and_leaves_the_verified_one(self, client, conn):
        response = run(client, 'ocr')

        assert response.json() == {'ok': True, 'phase': 'ocr', 'unchecked': 2, 'checked': 1}
        marked = dict(conn.execute('SELECT id, needs_ocr FROM lines').fetchall())
        assert marked == {1: 1, 2: 0, 3: 1}, 'the checked line is not re-read'
        assert job(conn)['run_ocr'] == 1
        assert job(conn)['status'] == 'queued'

    def test_a_dataset_that_never_ran_lines_still_reaches_the_reading_phase(self, client, conn):
        conn.execute("UPDATE pages SET status = 'layout_done' WHERE id = 1")
        conn.commit()

        run(client, 'ocr')

        assert page(conn)['status'] == 'lines_done'

    def test_a_page_where_everything_is_checked_has_nothing_to_re_read(self, client, conn):
        conn.execute('UPDATE lines SET checked = 1')
        conn.commit()

        response = run(client, 'ocr')

        assert response.status_code == 400
        assert 'already checked' in response.json()['detail']
        assert job(conn)['status'] == 'done'


    def test_a_page_with_no_lines_says_so_rather_than_that_they_are_checked(self, client, conn):
        conn.execute('DELETE FROM lines')
        conn.commit()

        response = run(client, 'ocr')

        assert response.status_code == 400
        assert response.json()['detail'] == 'there are no lines on this page'
        assert job(conn)['status'] == 'done'


class TestRefusals:
    def test_an_unknown_phase_is_refused(self, client):
        assert run(client, 'everything').status_code == 400

    def test_a_dataset_already_working_is_refused(self, client, conn):
        conn.execute("UPDATE jobs SET status = 'running' WHERE id = 'j1'")
        conn.commit()
        assert run(client, 'layout').status_code == 409

    def test_a_page_still_waiting_to_be_ingested_is_refused(self, client, conn):
        conn.execute("UPDATE pages SET status = 'pending' WHERE id = 1")
        conn.commit()
        assert run(client, 'layout').status_code == 409

    def test_someone_elses_dataset_is_not_theirs_to_queue(self, client):
        assert run(client, 'layout', headers=BOB).status_code == 404

    def test_an_assignee_may_look_but_not_queue(self, client, conn):
        conn.execute("INSERT INTO job_assignees (job_id, username) VALUES ('j1', 'bob')")
        conn.commit()

        assert client.get('/api/pages/1/run', headers=BOB).status_code == 200
        refused = run(client, 'layout', headers=BOB)
        assert refused.status_code == 403
        assert refused.json()['detail'] == 'only the owner or an admin may re-run Seeded'

    def test_an_admin_may_run_any_page(self, client, conn):
        assert run(client, 'ocr', headers=ADMIN).status_code == 200
        assert job(conn)['status'] == 'queued'

    def test_a_phase_taken_from_the_owner_is_refused_on_their_own_page(self, client, conn):
        """The same capability the whole-dataset re-run asks for: one page at a time is
        not a way round it."""
        response = run(client, 'layout', headers=ALICE_NO_LAYOUT)

        assert response.status_code == 403
        assert response.json()['detail'] == 'not permitted: pipeline.layout'
        assert job(conn)['status'] == 'done'
        assert conn.execute('SELECT COUNT(*) c FROM elements WHERE deleted = 0').fetchone()['c'] == 1

    def test_a_phase_the_owner_still_holds_runs_on_the_same_page(self, client, conn):
        assert run(client, 'ocr', headers=ALICE_NO_LAYOUT).status_code == 200
        assert job(conn)['status'] == 'queued'


class TestTheImageIsGone:
    """Every phase opens the page image. Queueing a page whose scan is missing empties
    the page, loads a detection model, and dies in the runner minutes later - so the
    page is refused while it can still be refused, and left as it was.
    """

    @pytest.fixture(autouse=True)
    def gone(self, scan):
        scan.unlink()

    @pytest.mark.parametrize('phase', ['layout', 'lines', 'ocr'])
    def test_the_page_is_refused_with_a_reason(self, client, phase):
        response = run(client, phase)

        assert response.status_code == 409
        assert 'image' in response.json()['detail']

    def test_nothing_is_thrown_away_and_nothing_is_queued(self, client, conn):
        run(client, 'layout')

        assert conn.execute('SELECT deleted FROM elements WHERE id = 1').fetchone()[0] == 0
        assert conn.execute('SELECT COUNT(*) c FROM candidates').fetchone()['c'] == 0
        assert (job(conn)['status'], page(conn)['status']) == ('done', 'done')

    def test_a_page_whose_image_is_there_still_runs(self, client, scan):
        scan.write_bytes(b'back again')

        assert run(client, 'layout').status_code == 200


class TestRunningManyPagesAtOnce:
    """The dataset page ticks a set of pages - the ones layout found nothing on, say - and
    asks for one phase across all of them. It queues the dataset once, and a page the phase
    has nothing to do on is reported rather than failing the whole batch."""

    @pytest.fixture(autouse=True)
    def second_page(self, conn, scan):
        conn.executescript(f"""
            INSERT INTO pages (id, job_id, idx, filename, source_file, status)
                VALUES (2, 'j1', 1, 'p2.png', '{scan}', 'done');
            INSERT INTO elements (id, page_id, order_idx, class_name, bbox, kind, lines_bbox)
                VALUES (2, 2, 0, 'Paragraph', '[0,0,1,1]', 'content', '[0,0,1,1]');
            INSERT INTO lines (id, element_id, order_idx, polygon, text, checked)
                VALUES (4, 2, 0, '{POLY}', 'Column 2, entry 1', 0);
        """)
        conn.commit()

    def run_pages(self, client, phase, page_ids, headers=ALICE):
        return client.post('/api/jobs/j1/pages/run',
                           json={'phase': phase, 'page_ids': page_ids}, headers=headers)

    def test_every_page_given_is_staged_and_the_dataset_is_queued_once(self, client, conn):
        response = self.run_pages(client, 'ocr', [1, 2])

        assert response.json() == {'ok': True, 'phase': 'ocr', 'pages': 2, 'skipped': []}
        assert [r['id'] for r in conn.execute(
            'SELECT id FROM lines WHERE needs_ocr = 1 ORDER BY id')] == [1, 3, 4]
        assert job(conn)['status'] == 'queued'

    def test_line_detection_forgets_what_every_chosen_page_was_detected_against(self, client, conn):
        assert self.run_pages(client, 'lines', [1, 2]).json()['pages'] == 2

        assert [r['lines_bbox'] for r in conn.execute(
            'SELECT lines_bbox FROM elements ORDER BY id')] == [None, None]

    def test_a_page_the_phase_has_nothing_to_do_on_is_skipped_not_refused(self, client, conn):
        conn.execute('UPDATE lines SET checked = 1 WHERE element_id = 2')
        conn.commit()

        body = self.run_pages(client, 'ocr', [1, 2]).json()

        assert body['pages'] == 1
        assert body['skipped'] == [{'page_id': 2, 'reason': 'every line on this page is already checked'}]
        assert [r['id'] for r in conn.execute(
            'SELECT id FROM lines WHERE needs_ocr = 1 ORDER BY id')] == [1, 3]

    def test_a_batch_with_nothing_to_do_is_refused_and_writes_nothing(self, client, conn):
        conn.execute('UPDATE lines SET checked = 1')
        conn.commit()

        response = self.run_pages(client, 'ocr', [1, 2])

        assert response.status_code == 400
        assert response.json()['detail'] == 'every line on this page is already checked'
        assert job(conn)['status'] == 'done'
        assert conn.execute('SELECT COUNT(*) c FROM candidates').fetchone()['c'] == 0

    def test_a_page_of_another_dataset_is_refused_rather_than_ignored(self, client, conn):
        conn.executescript("""
            INSERT INTO jobs (id, name, owner, status) VALUES ('j2', 'Elsewhere', 'alice', 'done');
            INSERT INTO pages (id, job_id, idx, filename, source_file, status)
                VALUES (9, 'j2', 0, 'x.png', '/x.png', 'done');
        """)
        conn.commit()

        response = self.run_pages(client, 'ocr', [1, 9])

        assert response.status_code == 404
        assert response.json()['detail'] == 'no such page in this dataset: 9'
        assert conn.execute('SELECT COUNT(*) c FROM lines WHERE needs_ocr = 1').fetchone()['c'] == 0

    def test_the_same_page_twice_is_staged_once(self, client):
        assert self.run_pages(client, 'ocr', [1, 1]).json()['pages'] == 1

    def test_an_empty_selection_is_refused(self, client):
        response = self.run_pages(client, 'ocr', [])

        assert response.status_code == 400
        assert response.json()['detail'] == 'no pages given'

    def test_an_unknown_phase_is_refused(self, client):
        response = self.run_pages(client, 'align', [1])

        assert response.status_code == 400
        assert response.json()['detail'] == 'phase must be layout, lines or ocr'

    def test_a_phase_taken_from_the_owner_is_refused_for_a_selection_too(self, client, conn):
        response = self.run_pages(client, 'layout', [1, 2], headers=ALICE_NO_LAYOUT)

        assert response.status_code == 403
        assert response.json()['detail'] == 'not permitted: pipeline.layout'
        assert job(conn)['status'] == 'done'
        assert self.run_pages(client, 'ocr', [1, 2], headers=ALICE_NO_LAYOUT).status_code == 200

    def test_an_assignee_may_not_queue_a_batch_either(self, client, conn):
        conn.execute("INSERT INTO job_assignees (job_id, username) VALUES ('j1', 'bob')")
        conn.commit()

        assert self.run_pages(client, 'ocr', [1, 2], headers=BOB).status_code == 403

    def test_a_dataset_already_running_is_refused(self, client, conn):
        conn.execute("UPDATE jobs SET status = 'running' WHERE id = 'j1'")
        conn.commit()

        response = self.run_pages(client, 'ocr', [1, 2])

        assert response.status_code == 409
        assert response.json()['detail'] == 'the dataset is already queued or running'


class TestAPageLayoutFoundNothingOn:
    """A per-crop dataset falls back to detecting across the whole scan where layout found
    no box, and those lines live in one invisible orphan bucket. Asking for line detection
    there pointed phase_relines at elements that do not exist, so it queued the dataset and
    changed nothing."""

    @pytest.fixture(autouse=True)
    def no_boxes(self, conn):
        """What the fallback leaves: no content element, one orphan bucket holding the
        lines it scraped off the page."""
        conn.executescript(f"""
            UPDATE elements SET deleted = 1 WHERE id = 1;
            INSERT INTO elements (id, page_id, order_idx, class_name, bbox, kind)
                VALUES (2, 1, 1, 'Unassigned', '[0,0,1,1]', 'orphan');
            UPDATE lines SET element_id = 2;
        """)
        conn.commit()

    def orphans(self, conn):
        return [r['id'] for r in conn.execute(
            "SELECT id FROM elements WHERE kind = 'orphan' AND deleted = 0")]

    def test_the_lines_layout_would_replace_are_counted_though_there_is_no_box(self, client):
        assert client.get('/api/pages/1/run', headers=ALICE).json() == {
            'layout': {'elements': 0, 'lines': 3, 'corrections': 1},
            'lines': {'lines': 3, 'corrections': 1},
            'ocr': {'unchecked': 2, 'checked': 1},
        }

    def test_line_detection_sends_the_page_back_to_the_line_phase(self, client, conn):
        assert run(client, 'lines').status_code == 200

        # 'layout_done' is what phase_lines selects, and with no boxes it detects across
        # the whole scan - the only thing that can find lines here.
        assert page(conn)['status'] == 'layout_done'

    def test_the_bucket_it_would_duplicate_is_dropped_first(self, client, conn):
        assert self.orphans(conn) == [2]

        run(client, 'lines')

        assert self.orphans(conn) == []

    def test_what_those_lines_said_is_kept_to_be_offered_again(self, client, conn):
        run(client, 'lines')

        assert sorted(r['text'] for r in conn.execute('SELECT text FROM candidates')) == [
            'Column 1, entry 1', 'Column 1, entry 2', 'Column 1, entry 3', 'Corrected by hand']

    def test_a_re_read_still_only_marks_the_lines(self, client, conn):
        """Nothing to re-detect there - the lines are already where they are."""
        assert run(client, 'ocr').status_code == 200

        assert self.orphans(conn) == [2]
        assert [r['id'] for r in conn.execute(
            'SELECT id FROM lines WHERE needs_ocr = 1 ORDER BY id')] == [1, 3]

    def test_a_page_that_does_have_boxes_is_untouched_by_this(self, client, conn):
        """The orphan bucket is only dropped where there was no element to re-detect."""
        conn.executescript("""
            UPDATE elements SET deleted = 0 WHERE id = 1;
            UPDATE lines SET element_id = 1;
        """)
        conn.commit()

        run(client, 'lines')

        assert self.orphans(conn) == [2]
        assert page(conn)['status'] == 'done'
