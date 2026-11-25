"""Handing pages in and signing them off (#36, decision 356): an assignee hands their page in, and
a Reviewer signs off any page whose lines are all checked, or sends a handed-in one back with a
note. A line that loses its check afterwards, by whatever path, takes the sign-off back."""
import json

import pytest
from fastapi.testclient import TestClient

from app import page_rows, store, trainer
from app.deps import get_db
from app.main import app

SECRET = 'test-secret'


def person(name: str, role: str) -> dict:
    return {'X-Frontend-Secret': SECRET, 'X-Auth-User': name, 'X-Auth-Role': role, 'X-Auth-Caps': ''}


ANNA = person('anna', 'manager')
BEN = person('ben', 'annotator')
LENA = person('lena', 'annotator')
RITA = person('rita', 'reviewer')
VERA = person('vera', 'viewer')

POLY = json.dumps([[0.1, 0.1], [0.9, 0.1], [0.9, 0.3], [0.1, 0.3]])


@pytest.fixture
def client(tmp_path, monkeypatch):
    """Anna's workspace holds her Taufbuch, with Ben, Lena and Vera, a Viewer, in it; Rita was given
    the Taufbuch alone, as its Reviewer. Pages 1 and 2 are Lena's, page 3 is Ben's, 4 and 5 nobody's.
    Page 1 has a checked and an unchecked line, page 2 and page 4 one checked line each."""
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    monkeypatch.setattr('app.config.JOBS_DIR', tmp_path / 'jobs')
    page_rows.forget_counts()
    conn = store.connect(tmp_path / 'app.db')
    conn.executescript(f"""
        INSERT INTO groups (id, name, owner, sandbox_of) VALUES (1, 'Pfarre Gars', 'anna', NULL);
        INSERT INTO group_assignees (group_id, username) VALUES (1, 'anna'), (1, 'ben'), (1, 'lena'), (1, 'vera');
        INSERT INTO jobs (id, name, owner, status, group_id) VALUES ('j1', 'Taufbuch', 'anna', 'done', 1);
        INSERT INTO job_assignees (job_id, username) VALUES ('j1', 'rita');
        INSERT INTO pages (id, job_id, idx, filename, source_file, status, width, height) VALUES
            (11, 'j1', 0, 'p1.png', '/nonexistent/p1.png', 'done', 1000, 1400),
            (12, 'j1', 1, 'p2.png', '/nonexistent/p2.png', 'done', 1000, 1400),
            (13, 'j1', 2, 'p3.png', '/nonexistent/p3.png', 'done', 1000, 1400),
            (14, 'j1', 3, 'p4.png', '/nonexistent/p4.png', 'done', 1000, 1400),
            (15, 'j1', 4, 'p5.png', '/nonexistent/p5.png', 'done', 1000, 1400);
        INSERT INTO elements (id, page_id, order_idx, class_name, bbox) VALUES
            (101, 11, 0, 'Paragraph', '[0, 0, 1, 1]'),
            (102, 12, 0, 'Paragraph', '[0, 0, 1, 1]'),
            (104, 14, 0, 'Paragraph', '[0, 0, 1, 1]');
        INSERT INTO lines (id, element_id, order_idx, polygon, text, checked) VALUES
            (1001, 101, 0, '{POLY}', 'Johann Maier', 1),
            (1002, 101, 1, '{POLY}', 'Maria Hofer', 0),
            (1003, 102, 0, '{POLY}', 'Anton Gruber', 1),
            (1004, 104, 0, '{POLY}', 'Theresia Huber', 1);
        INSERT INTO page_assignees (page_id, username) VALUES (11, 'lena'), (12, 'lena'), (13, 'ben');
    """)
    conn.commit()
    app.dependency_overrides[get_db] = lambda: conn
    yield TestClient(app), conn
    app.dependency_overrides.clear()
    page_rows.forget_counts()
    conn.close()


def hand_in(api, headers, page_id):
    return api.post(f'/api/pages/{page_id}/hand-in', headers=headers)


def sign_off(api, headers, page_id):
    return api.put(f'/api/pages/{page_id}/review', headers=headers, json={'verdict': 'signed_off'})


def send_back(api, headers, page_id, note):
    return api.put(f'/api/pages/{page_id}/review', headers=headers, json={'verdict': 'sent_back', 'note': note})


def state_of(conn, page_id) -> str | None:
    return store.page_review(conn, page_id)['state']


def table(api, headers, page_filter) -> list[int]:
    response = api.get('/api/jobs/j1/page-rows', headers=headers, params={'filter': page_filter})
    assert response.status_code == 200, response.text
    return [row['idx'] + 1 for row in response.json()['rows']]


class TestHandingIn:
    def test_an_assignee_hands_their_page_in(self, client):
        api, _ = client

        response = hand_in(api, LENA, 11)

        assert response.status_code == 200, response.text
        review = response.json()
        assert (review['state'], review['by'], review['note']) == ('handed_in', 'lena', None)
        assert review['at']

    def test_only_the_pages_assignee_hands_it_in(self, client):
        api, conn = client

        not_hers = hand_in(api, LENA, 13)
        nobodys = hand_in(api, LENA, 14)
        not_his = hand_in(api, BEN, 11)

        assert [r.status_code for r in (not_hers, nobodys, not_his)] == [403, 403, 403]
        assert not_hers.json()['detail'] == 'Only the person this page is assigned to hands it in'
        assert [state_of(conn, page_id) for page_id in (11, 13, 14)] == [None, None, None]

    def test_an_assignee_takes_their_hand_in_back(self, client):
        api, conn = client
        hand_in(api, LENA, 11)

        response = api.delete('/api/pages/11/hand-in', headers=LENA)

        assert response.status_code == 200, response.text
        assert response.json()['state'] is None
        assert state_of(conn, 11) is None

    def test_a_viewer_does_not_hand_in_even_a_page_handed_to_them(self, client):
        api, conn = client
        conn.execute("INSERT INTO page_assignees (page_id, username) VALUES (14, 'vera')")

        response = hand_in(api, VERA, 14)

        assert response.status_code == 403
        assert state_of(conn, 14) is None

    def test_someone_else_does_not_take_a_hand_in_back(self, client):
        api, conn = client
        hand_in(api, LENA, 11)

        response = api.delete('/api/pages/11/hand-in', headers=BEN)

        assert response.status_code == 403
        assert response.json()['detail'] == 'Only the person this page is assigned to hands it in'
        assert state_of(conn, 11) == 'handed_in'

    def test_a_page_given_to_someone_else_starts_without_the_hand_in(self, client):
        api, conn = client
        hand_in(api, LENA, 11)

        api.put('/api/jobs/j1/assignments', headers=ANNA, json={'assignee': 'ben', 'page_ids': [11]})

        assert state_of(conn, 11) is None

    def test_a_signed_off_page_is_not_handed_in(self, client):
        api, conn = client
        sign_off(api, RITA, 12)

        response = hand_in(api, LENA, 12)

        assert response.status_code == 409
        assert response.json()['detail'] == 'This page is signed off already'
        assert state_of(conn, 12) == 'signed_off'

    def test_a_signed_off_pages_hand_in_is_not_taken_back(self, client):
        api, conn = client
        hand_in(api, LENA, 12)
        sign_off(api, RITA, 12)

        response = api.delete('/api/pages/12/hand-in', headers=LENA)

        assert response.status_code == 409
        api.delete('/api/pages/12/review', headers=RITA)
        assert state_of(conn, 12) == 'handed_in'


class TestSigningOff:
    def test_a_reviewer_signs_off_a_handed_in_page(self, client):
        api, conn = client
        hand_in(api, LENA, 12)

        response = sign_off(api, RITA, 12)

        assert response.status_code == 200, response.text
        assert (response.json()['state'], response.json()['by']) == ('signed_off', 'rita')
        assert state_of(conn, 12) == 'signed_off'

    def test_a_page_nobody_handed_in_is_signed_off_too(self, client):
        api, conn = client

        assert sign_off(api, RITA, 14).status_code == 200

        assert state_of(conn, 14) == 'signed_off'

    def test_a_manager_signs_off_as_a_reviewer_does(self, client):
        api, conn = client

        assert sign_off(api, ANNA, 12).status_code == 200

        assert store.page_review(conn, 12)['by'] == 'anna'

    def test_sign_off_waits_for_every_line_to_be_checked(self, client):
        api, conn = client
        hand_in(api, LENA, 11)

        response = sign_off(api, RITA, 11)

        assert response.status_code == 400
        assert response.json()['detail'] == '1 line on this page is not checked yet'
        assert state_of(conn, 11) == 'handed_in'

    def test_an_annotator_does_not_sign_off(self, client):
        api, conn = client
        hand_in(api, LENA, 12)

        response = sign_off(api, LENA, 12)

        assert response.status_code == 403
        assert state_of(conn, 12) == 'handed_in'

    def test_taking_a_sign_off_back_leaves_the_page_handed_in(self, client):
        api, conn = client
        hand_in(api, LENA, 12)
        sign_off(api, RITA, 12)

        response = api.delete('/api/pages/12/review', headers=RITA)

        assert response.status_code == 200, response.text
        assert response.json()['state'] == 'handed_in'
        assert state_of(conn, 12) == 'handed_in'


class TestSendingBack:
    def test_a_reviewer_sends_a_page_back_with_a_note_and_the_edits_stay(self, client):
        api, conn = client
        api.patch('/api/lines/1003', headers=LENA, json={'corrected_text': 'Anton Gruber, Bauer'})
        hand_in(api, LENA, 12)

        response = send_back(api, RITA, 12, 'Der Stand fehlt in Zeile 1')

        assert response.status_code == 200, response.text
        review = response.json()
        assert (review['state'], review['by'], review['note']) == ('sent_back', 'rita', 'Der Stand fehlt in Zeile 1')
        assert conn.execute('SELECT corrected_text FROM lines WHERE id = 1003').fetchone()[0] == 'Anton Gruber, Bauer'

    def test_handing_a_page_in_again_after_it_came_back(self, client):
        api, conn = client
        hand_in(api, LENA, 12)
        send_back(api, RITA, 12, 'Bitte nochmals lesen')

        assert hand_in(api, LENA, 12).status_code == 200

        assert state_of(conn, 12) == 'handed_in'

    def test_sending_back_needs_a_note(self, client):
        api, conn = client
        hand_in(api, LENA, 12)

        response = send_back(api, RITA, 12, '  ')

        assert response.status_code == 400
        assert response.json()['detail'] == 'Say what is to be done on the page'
        assert state_of(conn, 12) == 'handed_in'

    def test_a_page_nobody_has_is_not_sent_back(self, client):
        api, conn = client

        response = send_back(api, RITA, 14, 'Bitte nochmals lesen')

        assert response.status_code == 400
        assert response.json()['detail'] == 'Nobody has this page to send it back to'
        assert state_of(conn, 14) is None

    def test_a_send_back_goes_with_the_assignment(self, client):
        """It is said to the person who had the page: given to someone else, or to nobody, the
        page starts afresh rather than wait on a note nobody there is to answer."""
        api, conn = client
        for page_id in (11, 12):
            hand_in(api, LENA, page_id)
            send_back(api, RITA, page_id, 'Bitte nochmals lesen')

        api.put('/api/jobs/j1/assignments', headers=ANNA, json={'assignee': 'ben', 'page_ids': [11]})
        api.put('/api/jobs/j1/assignments', headers=ANNA, json={'assignee': None, 'page_ids': [12]})

        assert (state_of(conn, 11), state_of(conn, 12)) == (None, None)

    def test_a_send_back_lapses_with_its_assignee_leaving(self, client):
        api, conn = client
        hand_in(api, LENA, 12)
        send_back(api, RITA, 12, 'Bitte nochmals lesen')

        api.put('/api/groups/1/share', headers=ANNA, json={'usernames': ['anna', 'ben', 'vera']})

        assert state_of(conn, 12) is None

    def test_an_annotator_does_not_send_back(self, client):
        api, conn = client
        hand_in(api, LENA, 12)

        assert send_back(api, BEN, 12, 'Bitte nochmals lesen').status_code == 403

        assert state_of(conn, 12) == 'handed_in'


class TestASignOffLapses:
    def test_an_annotators_edit_takes_the_sign_off_back(self, client):
        api, conn = client
        hand_in(api, LENA, 12)
        sign_off(api, RITA, 12)

        response = api.patch('/api/lines/1003', headers=LENA, json={'corrected_text': 'Anton Gruber, Bauer'})

        assert response.status_code == 200, response.text
        assert state_of(conn, 12) == 'handed_in'

    def test_a_reviewers_checked_fix_keeps_it_signed_off(self, client):
        api, conn = client
        sign_off(api, RITA, 12)

        response = api.patch('/api/lines/1003', headers=RITA,
                             json={'corrected_text': 'Anton Gruber, Bauer', 'checked': True})

        assert response.status_code == 200, response.text
        assert state_of(conn, 12) == 'signed_off'

    def test_a_new_unchecked_line_takes_it_back_whatever_wrote_it(self, client):
        _, conn = client
        conn.execute("INSERT INTO page_reviews (page_id, state, by_user, at) VALUES (14, 'signed_off', 'rita', 'now')")

        conn.execute(f"INSERT INTO lines (element_id, order_idx, polygon, text) VALUES (104, 1, '{POLY}', 'neu')")

        assert state_of(conn, 14) is None

    def test_a_restored_unchecked_line_takes_it_back(self, client):
        _, conn = client
        conn.execute('UPDATE lines SET deleted = 1 WHERE id = 1002')
        conn.execute("INSERT INTO page_reviews (page_id, state, by_user, at) VALUES (11, 'signed_off', 'rita', 'now')")

        conn.execute('UPDATE lines SET deleted = 0 WHERE id = 1002')

        assert state_of(conn, 11) is None

    def test_a_restored_box_with_an_unchecked_line_takes_it_back(self, client):
        _, conn = client
        conn.execute('UPDATE elements SET deleted = 1 WHERE id = 101')
        conn.execute("INSERT INTO page_reviews (page_id, state, by_user, at) VALUES (11, 'signed_off', 'rita', 'now')")

        conn.execute('UPDATE elements SET deleted = 0 WHERE id = 101')

        assert state_of(conn, 11) is None

    def test_an_unchecked_line_moved_onto_the_page_takes_it_back(self, client):
        api, conn = client
        sign_off(api, RITA, 12)

        conn.execute('UPDATE lines SET element_id = 102 WHERE id = 1002')

        assert (state_of(conn, 12), state_of(conn, 11)) == (None, None)

    def test_deleting_a_line_keeps_it_signed_off(self, client):
        api, conn = client
        sign_off(api, RITA, 12)

        conn.execute('UPDATE lines SET deleted = 1 WHERE id = 1003')

        assert state_of(conn, 12) == 'signed_off'

    def test_a_lapse_on_one_page_leaves_the_others_signed_off(self, client):
        api, conn = client
        sign_off(api, RITA, 12)
        sign_off(api, RITA, 14)

        conn.execute('UPDATE lines SET checked = 0 WHERE id = 1004')

        assert (state_of(conn, 12), state_of(conn, 14)) == ('signed_off', None)


class TestThePageTable:
    def test_each_page_shows_its_review_and_the_chips_count_them(self, client):
        api, _ = client
        hand_in(api, LENA, 11)
        hand_in(api, LENA, 12)
        send_back(api, RITA, 12, 'Bitte nochmals lesen')
        sign_off(api, RITA, 14)

        response = api.get('/api/jobs/j1/page-rows', headers=ANNA)

        assert response.status_code == 200, response.text
        body = response.json()
        assert [(row['idx'] + 1, row['review'], row['review_note']) for row in body['rows']] == [
            (1, 'handed_in', None), (2, 'sent_back', 'Bitte nochmals lesen'), (3, None, None),
            (4, 'signed_off', None), (5, None, None)]
        assert {key: body['counts'][key] for key in ('handed-in', 'sent-back', 'signed-off')} == \
            {'handed-in': 1, 'sent-back': 1, 'signed-off': 1}
        assert table(api, ANNA, 'handed-in') == [1]
        assert table(api, ANNA, 'sent-back') == [2]
        assert table(api, ANNA, 'signed-off') == [4]

    def test_the_page_says_its_review(self, client):
        api, _ = client
        hand_in(api, LENA, 11)

        response = api.get('/api/jobs/j1/pages/11', headers=RITA)

        assert response.status_code == 200, response.text
        review = response.json()['review']
        assert (review['state'], review['by']) == ('handed_in', 'lena')


class TestTrainingOnSignedOffPages:
    def test_a_run_may_count_only_the_pages_a_reviewer_signed_off(self, client):
        api, _ = client
        sign_off(api, RITA, 12)

        assert trainer.eligible_counts(client[1], 'ocr', ['j1']) == {'j1': 3}
        assert trainer.eligible_counts(client[1], 'ocr', ['j1'], signed_off_only=True) == {'j1': 1}

    def test_signed_off_and_person_verified_narrow_together(self, client):
        api, conn = client
        sign_off(api, RITA, 12)
        sign_off(api, RITA, 14)
        conn.execute("UPDATE lines SET check_source = 'llm' WHERE id = 1004")

        assert trainer.eligible_counts(conn, 'ocr', ['j1'], True, signed_off_only=True) == {'j1': 1}

    def test_the_training_form_previews_the_signed_off_material(self, client):
        api, conn = client
        sign_off(api, RITA, 12)
        sign_off(api, RITA, 14)
        conn.execute("UPDATE lines SET check_source = 'llm' WHERE id = 1004")

        response = api.post('/api/trainings/preview', headers=ANNA, json={'task': 'ocr', 'job_ids': ['j1']})

        assert response.status_code == 200, response.text
        signed_off = response.json()['signed_off']
        assert signed_off == {'counts': {'j1': 2}, 'pages': {'j1': 2}, 'machine_settled': {'j1': 1},
                              'human_checked_pages': {'j1': 1}}
