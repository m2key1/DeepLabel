"""One page as the viewer loads it, its review flags, and removing pages. Deleting is soft
and purging is not: a purged page has no scan to come back to, which is why restoring one
has to be refused rather than quietly producing a dataset that breaks the exporter.
"""
import json

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app import store
from app.deps import get_db
from app.main import app

SECRET = 'test-secret'
ADMIN = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'root', 'X-Auth-Role': 'admin'}
ALICE = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'alice', 'X-Auth-Role': 'member'}
BOB = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'bob', 'X-Auth-Role': 'member'}

POLY = '[[0,0],[1,0],[1,1],[0,1]]'


@pytest.fixture
def scans(tmp_path):
    """Inside the job directory, which is what makes them the app's to unlink: a
    path-ingested dataset points at the user's own archival scans and purge leaves those
    alone."""
    uploads = tmp_path / 'jobs' / 'j1' / 'uploads'
    uploads.mkdir(parents=True)
    paths = []
    for name in ('p1.png', 'p2.png'):
        path = uploads / name
        Image.new('RGB', (120, 60), 'white').save(path)
        paths.append(path)
    return paths


@pytest.fixture
def conn(tmp_path, scans, monkeypatch):
    monkeypatch.setattr('app.config.JOBS_DIR', tmp_path / 'jobs')
    connection = store.connect(tmp_path / 'app.db')
    connection.executescript(f"""
        INSERT INTO jobs (id, name, owner, status) VALUES ('j1', 'Volume', 'alice', 'done');
        INSERT INTO pages (id, job_id, idx, filename, source_file, status, width, height) VALUES
            (1, 'j1', 0, 'p1.png', '{scans[0]}', 'done', 120, 60),
            (2, 'j1', 1, 'p2.png', '{scans[1]}', 'done', 120, 60);
        INSERT INTO elements (id, page_id, order_idx, class_name, raw_class_name, bbox, kind)
            VALUES (1, 1, 0, 'Paragraph', 'Paragraph', '[0.0,0.0,1.0,0.5]', 'content');
        INSERT INTO lines (id, element_id, order_idx, polygon, text)
            VALUES (1, 1, 0, '{POLY}', 'A line');
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


def page(conn, page_id):
    return conn.execute('SELECT * FROM pages WHERE id = ?', (page_id,)).fetchone()


class TestLoadingOne:
    def test_a_page_arrives_with_its_boxes_and_lines(self, client):
        response = client.get('/api/jobs/j1/pages/1', headers=ALICE)

        assert response.status_code == 200, response.text
        body = response.json()
        assert body['id'] == 1
        assert [e['id'] for e in body['elements']] == [1]
        assert [ln['text'] for ln in body['elements'][0]['lines']] == ['A line']

    def test_it_carries_where_a_live_view_starts_listening(self, client):
        assert 'job_revision' in client.get('/api/jobs/j1/pages/1', headers=ALICE).json()

    def test_deleted_boxes_are_not_part_of_the_page(self, client, conn):
        conn.execute('UPDATE elements SET deleted = 1 WHERE id = 1')
        conn.commit()

        assert client.get('/api/jobs/j1/pages/1', headers=ALICE).json()['elements'] == []

    def test_a_page_from_another_dataset_is_a_404(self, client, conn):
        conn.execute("INSERT INTO jobs (id, name, owner, status) VALUES ('j2', 'Other', 'alice', 'done')")
        conn.commit()

        assert client.get('/api/jobs/j2/pages/1', headers=ALICE).status_code == 404

    def test_a_stranger_is_not_told_the_dataset_exists(self, client):
        assert client.get('/api/jobs/j1/pages/1', headers=BOB).status_code == 404


class TestWhatWasEverReadHere:
    def test_the_pool_is_served_for_the_page(self, client, conn):
        conn.execute("INSERT INTO candidates (page_id, source, author, text, order_idx) "
                     "VALUES (1, 'llm', 'llm:Reader', 'A reading', 0)")
        conn.commit()

        body = client.get('/api/pages/1/candidates', headers=ALICE).json()

        assert [c['text'] for c in body['candidates']] == ['A reading']

    def test_a_page_nobody_has_read_holds_nothing(self, client):
        assert client.get('/api/pages/1/candidates', headers=ALICE).json()['candidates'] == []

    def test_a_stranger_is_not_told_the_page_exists(self, client):
        assert client.get('/api/pages/1/candidates', headers=BOB).status_code == 404


class TestSayingWhichLineAReadingIsFor:
    """The last resort when a language model's transcription matched nothing: a person
    points at the line. The pool's own rules are covered in test_candidates; this is the
    route around them."""

    @pytest.fixture
    def reading(self, conn):
        cur = conn.execute(
            "INSERT INTO candidates (page_id, source, author, text, order_idx, llm_model_id) "
            "VALUES (1, 'llm', 'llm:GLM', 'A reading', 0, 7)")
        conn.commit()
        return cur.lastrowid

    def attach(self, client, candidate_id, line_id, headers=ALICE):
        return client.patch(f'/api/candidates/{candidate_id}', json={'line_id': line_id},
                            headers=headers)

    def test_it_lands_on_the_line_and_the_page_comes_back_with_it(self, client, conn, reading):
        body = self.attach(client, reading, 1).json()

        assert conn.execute('SELECT line_id FROM candidates WHERE id = ?',
                            (reading,)).fetchone()['line_id'] == 1
        assert [(c['id'], c['line_id']) for c in body['candidates']] == [(reading, 1)]

    def test_it_can_be_taken_off_again(self, client, conn, reading):
        self.attach(client, reading, 1)

        body = self.attach(client, reading, None).json()

        assert [(c['id'], c['line_id']) for c in body['candidates']] == [(reading, None)]

    def test_a_line_on_another_page_is_refused(self, client, conn, reading):
        conn.executescript(f"""
            INSERT INTO elements (id, page_id, order_idx, class_name, bbox, kind)
                VALUES (2, 2, 0, 'Paragraph', '[0,0,1,1]', 'content');
            INSERT INTO lines (id, element_id, order_idx, polygon) VALUES (2, 2, 0, '{POLY}');
        """)
        conn.commit()

        response = self.attach(client, reading, 2)

        assert response.status_code == 404
        assert response.json()['detail'] == 'no such line on this page'

    def test_a_deleted_line_is_refused(self, client, conn, reading):
        conn.execute('UPDATE lines SET deleted = 1 WHERE id = 1')
        conn.commit()

        assert self.attach(client, reading, 1).status_code == 404

    def test_a_reading_the_model_has_replaced_is_refused(self, client, conn, reading):
        """A dismissed reading is one its model no longer gives; attaching it would have it
        vote again under a reading nobody made."""
        conn.execute('UPDATE candidates SET dismissed = 1 WHERE id = ?', (reading,))
        conn.commit()

        response = self.attach(client, reading, 1)

        assert response.status_code == 409
        assert 'superseded' in response.json()['detail']

    def test_a_reading_that_is_not_there_is_a_404(self, client):
        assert self.attach(client, 999, 1).status_code == 404

    def test_a_stranger_is_not_told_the_reading_exists(self, client, reading):
        assert self.attach(client, reading, 1, headers=BOB).status_code == 404


class TestReviewFlags:
    def test_marking_the_layout_reviewed_sticks(self, client, conn):
        response = client.patch('/api/pages/1', json={'layout_checked': True}, headers=ALICE)

        assert response.status_code == 200
        assert response.json()['layout_checked'] is True
        assert page(conn, 1)['layout_checked'] == 1

    def test_marking_the_lines_reviewed_sticks(self, client, conn):
        client.patch('/api/pages/1', json={'lines_checked': True}, headers=ALICE)

        assert page(conn, 1)['lines_checked'] == 1

    def test_the_change_is_written_to_the_history(self, client, conn):
        client.patch('/api/pages/1', json={'layout_checked': True}, headers=ALICE)

        row = conn.execute(
            "SELECT author, snapshot FROM revisions WHERE target_type = 'page'").fetchone()
        assert row['author'] == 'alice'
        assert json.loads(row['snapshot'])['layout_checked'] is True

    def test_a_deleted_page_is_not_reviewed(self, client, conn):
        conn.execute('UPDATE pages SET deleted = 1 WHERE id = 1')
        conn.commit()

        assert client.patch('/api/pages/1', json={'layout_checked': True},
                            headers=ALICE).status_code == 409

    def test_a_duplicate_is_not_reviewed(self, client, conn):
        """It was never rendered and every export skips it, so a tick on it would count
        towards a review nobody could have done."""
        conn.execute("UPDATE pages SET status = 'duplicate' WHERE id = 2")
        conn.commit()

        assert client.patch('/api/pages/2', json={'layout_checked': True},
                            headers=ALICE).status_code == 409
        assert page(conn, 2)['layout_checked'] == 0
        assert client.patch('/api/pages/1', json={'layout_checked': True},
                            headers=ALICE).status_code == 200

    def test_a_page_that_does_not_exist_is_a_404(self, client):
        assert client.patch('/api/pages/99', json={'layout_checked': True},
                            headers=ALICE).status_code == 404


class TestRemovingPages:
    def test_pages_are_removed_in_bulk_and_softly(self, client, conn):
        response = client.patch('/api/jobs/j1/pages', json={'page_ids': [1, 2], 'deleted': True},
                                headers=ALICE)

        assert response.status_code == 200, response.text
        assert response.json()['updated'] == 2
        assert [page(conn, i)['deleted'] for i in (1, 2)] == [1, 1]

    def test_the_dataset_recounts_what_is_left(self, client):
        response = client.patch('/api/jobs/j1/pages', json={'page_ids': [1], 'deleted': True},
                                headers=ALICE)

        assert response.json()['pages_total'] == 1

    def test_a_removed_page_can_be_brought_back(self, client, conn):
        client.patch('/api/jobs/j1/pages', json={'page_ids': [1], 'deleted': True}, headers=ALICE)

        response = client.patch('/api/jobs/j1/pages', json={'page_ids': [1], 'deleted': False},
                                headers=ALICE)

        assert response.status_code == 200
        assert page(conn, 1)['deleted'] == 0

    def test_a_page_whose_scan_is_gone_cannot_be_brought_back(self, client, conn, scans):
        """It would come back as a dataset entry with no image, which breaks the exporter."""
        client.patch('/api/jobs/j1/pages', json={'page_ids': [1], 'deleted': True}, headers=ALICE)
        scans[0].unlink()

        response = client.patch('/api/jobs/j1/pages', json={'page_ids': [1], 'deleted': False},
                                headers=ALICE)

        assert response.status_code == 409
        assert 'purged' in response.json()['detail']
        assert page(conn, 1)['deleted'] == 1

    def test_asking_for_no_pages_changes_nothing(self, client):
        response = client.patch('/api/jobs/j1/pages', json={'page_ids': [], 'deleted': True},
                                headers=ALICE)

        assert response.json() == {'updated': 0, 'pages_total': 2}

    def test_a_dataset_still_working_is_refused(self, client, conn):
        conn.execute("UPDATE jobs SET status = 'running' WHERE id = 'j1'")
        conn.commit()

        assert client.patch('/api/jobs/j1/pages', json={'page_ids': [1], 'deleted': True},
                            headers=ALICE).status_code == 409

    def test_a_dataset_that_does_not_exist_is_a_404(self, client):
        assert client.patch('/api/jobs/nope/pages', json={'page_ids': [1], 'deleted': True},
                            headers=ADMIN).status_code == 404


class TestPurging:
    def test_the_preview_lists_what_would_be_unlinked(self, client):
        client.patch('/api/jobs/j1/pages', json={'page_ids': [1], 'deleted': True}, headers=ALICE)

        preview = client.get('/api/jobs/j1/purge', headers=ALICE).json()

        assert preview['pages'] == 1
        assert preview['bytes'] > 0

    def test_a_dataset_with_nothing_deleted_has_nothing_to_purge(self, client):
        assert client.get('/api/jobs/j1/purge', headers=ALICE).json()['pages'] == 0

    def test_purging_unlinks_the_scans_of_the_deleted_pages_only(self, client, scans):
        client.patch('/api/jobs/j1/pages', json={'page_ids': [1], 'deleted': True}, headers=ALICE)

        response = client.post('/api/jobs/j1/purge', headers=ADMIN)

        assert response.status_code == 200, response.text
        assert not scans[0].exists()
        assert scans[1].exists(), 'the page nobody deleted keeps its scan'

    def test_a_scan_the_dataset_does_not_own_is_left_alone(self, client, conn, tmp_path):
        """A dataset ingested from a path points at somebody's archive."""
        outside = tmp_path / 'archive.png'
        Image.new('RGB', (120, 60), 'white').save(outside)
        conn.execute('UPDATE pages SET source_file = ? WHERE id = 1', (str(outside),))
        conn.commit()
        client.patch('/api/jobs/j1/pages', json={'page_ids': [1], 'deleted': True}, headers=ALICE)

        client.post('/api/jobs/j1/purge', headers=ADMIN)

        assert outside.exists()

    def test_it_is_an_admins_call(self, client):
        client.patch('/api/jobs/j1/pages', json={'page_ids': [1], 'deleted': True}, headers=ALICE)

        assert client.post('/api/jobs/j1/purge', headers=ALICE).status_code == 403


class TestRenditions:
    def test_a_rendition_that_has_not_been_made_says_so(self, client):
        response = client.get('/api/pages/1/rendition', params={'kind': 'screen'}, headers=ALICE)

        assert response.status_code == 404
        assert 'not ready' in response.json()['detail']

    def test_a_rendition_that_exists_is_served(self, client, tmp_path):
        renditions = tmp_path / 'jobs' / 'j1' / 'renditions'
        renditions.mkdir(parents=True, exist_ok=True)
        Image.new('RGB', (10, 10), 'white').save(renditions / '1_thumb.jpg')

        response = client.get('/api/pages/1/rendition', headers=ALICE)

        assert response.status_code == 200
        assert response.headers['content-type'] == 'image/jpeg'

    def test_the_full_size_is_the_scan_itself(self, client):
        response = client.get('/api/pages/1/rendition', params={'kind': 'full'}, headers=ALICE)

        assert response.status_code == 200

    def test_the_full_size_of_a_page_still_waiting_to_be_extracted_is_not_the_pdf(self, client, conn,
                                                                                  tmp_path):
        """Between creating a dataset and extracting it, a PDF page names an image that
        does not exist yet - handing back the PDF would be worse than a 404."""
        book = tmp_path / 'book.pdf'
        book.write_bytes(b'%PDF-1.4')
        conn.execute('UPDATE pages SET source_file = ? WHERE id = 1', (str(book),))
        conn.commit()

        response = client.get('/api/pages/1/rendition', params={'kind': 'full'}, headers=ALICE)

        assert response.status_code == 404
        assert 'source image missing' in response.json()['detail']

    def test_a_size_nobody_offers_is_refused(self, client):
        assert client.get('/api/pages/1/rendition', params={'kind': 'poster'},
                          headers=ALICE).status_code == 400

    def test_a_page_that_does_not_exist_is_a_404(self, client):
        assert client.get('/api/pages/99/rendition', headers=ALICE).status_code == 404

    def test_a_stranger_is_not_served_the_image(self, client):
        assert client.get('/api/pages/1/rendition', headers=BOB).status_code == 404


class TestTurningAPage:
    """A scan the wrong way up is turned once and for good: the image, the boxes and the
    lines all come back as if it had been scanned that way."""

    @pytest.fixture(autouse=True)
    def blobs_of_their_own(self, tmp_path, monkeypatch, conn):
        monkeypatch.setattr('app.config.BLOBS_DIR', tmp_path / 'blobs')
        conn.execute("UPDATE pages SET content_hash = 'digest-of-p1' WHERE id = 1")
        conn.commit()

    def test_a_half_turn_turns_the_page_and_what_is_drawn_on_it(self, client, conn):
        response = client.post('/api/pages/1/turn', json={'degrees': 180}, headers=ALICE)

        assert response.status_code == 200, response.text
        assert response.json()['rotation'] == 180
        assert json.loads(conn.execute('SELECT bbox FROM elements WHERE id = 1').fetchone()['bbox']) \
            == [0.0, 0.5, 1.0, 1.0]

    def test_a_quarter_turn_swaps_the_page_over(self, client, conn):
        response = client.post('/api/pages/1/turn', json={'degrees': 90}, headers=ALICE)

        assert (response.json()['width'], response.json()['height']) == (60, 120)
        assert (page(conn, 1)['width'], page(conn, 1)['height']) == (60, 120)

    def test_a_turn_that_is_not_a_quarter_is_refused_with_the_reason(self, client):
        response = client.post('/api/pages/1/turn', json={'degrees': 45}, headers=ALICE)

        assert response.status_code == 409
        assert response.json()['detail'] == 'a page turns by 90, 180 or 270 degrees'

    def test_someone_who_may_only_look_cannot_turn_it(self, client):
        viewer = {**ALICE, 'X-Auth-User': 'carol', 'X-Auth-Role': 'viewer'}

        assert client.post('/api/pages/1/turn', json={'degrees': 90}, headers=viewer).status_code == 403

    def test_a_stranger_is_not_told_the_page_exists(self, client):
        assert client.post('/api/pages/1/turn', json={'degrees': 90}, headers=BOB).status_code == 404
