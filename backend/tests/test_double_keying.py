"""Double-keying (#37, decision 364): with the dataset's switch on, two people type each page,
neither seeing the other's text. When both have handed it in, the lines they typed alike are
checked and the rest wait for a Reviewer, with both versions offered on the line."""
import json
import unicodedata

import pytest
from fastapi.testclient import TestClient

from app import page_rows, store
from app.deps import get_db
from app.main import app

SECRET = 'test-secret'


def person(name: str, role: str) -> dict:
    return {'X-Frontend-Secret': SECRET, 'X-Auth-User': name, 'X-Auth-Role': role, 'X-Auth-Caps': ''}


ANNA = person('anna', 'manager')
BEN = person('ben', 'annotator')
LENA = person('lena', 'annotator')
MIA = person('mia', 'annotator')
RITA = person('rita', 'reviewer')

POLY = json.dumps([[0.1, 0.1], [0.9, 0.1], [0.9, 0.3], [0.1, 0.3]])
KEYING_ONLY = 'You are keying this page: type its text only'


@pytest.fixture
def client(tmp_path, monkeypatch):
    """Anna's workspace holds her Taufbuch, double-keyed, and her Sterbebuch, keyed once; Ben, Lena
    and Mia are in it, and Rita was given the Taufbuch alone, as its Reviewer. Page 1 of the
    Taufbuch is Lena's and Ben's, page 2 Lena's alone, page 3 nobody's. Page 1 reads four lines,
    the last of them already checked."""
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    monkeypatch.setattr('app.config.JOBS_DIR', tmp_path / 'jobs')
    page_rows.forget_counts()
    conn = store.connect(tmp_path / 'app.db')
    conn.executescript(f"""
        INSERT INTO groups (id, name, owner, sandbox_of) VALUES (1, 'Pfarre Gars', 'anna', NULL);
        INSERT INTO group_assignees (group_id, username) VALUES (1, 'anna'), (1, 'ben'), (1, 'lena'), (1, 'mia');
        INSERT INTO jobs (id, name, owner, status, group_id, double_keying) VALUES
            ('j1', 'Taufbuch', 'anna', 'done', 1, 1);
        INSERT INTO jobs (id, name, owner, status, group_id) VALUES ('j2', 'Sterbebuch', 'anna', 'done', 1);
        INSERT INTO job_assignees (job_id, username) VALUES ('j1', 'rita');
        INSERT INTO pages (id, job_id, idx, filename, source_file, status, width, height, reference_text) VALUES
            (11, 'j1', 0, 'p1.png', '/nonexistent/p1.png', 'done', 1000, 1400, 'Johann Maier, Maria Hofer'),
            (12, 'j1', 1, 'p2.png', '/nonexistent/p2.png', 'done', 1000, 1400, NULL),
            (13, 'j1', 2, 'p3.png', '/nonexistent/p3.png', 'done', 1000, 1400, NULL),
            (21, 'j2', 0, 'p1.png', '/nonexistent/s1.png', 'done', 1000, 1400, NULL);
        INSERT INTO elements (id, page_id, order_idx, class_name, bbox) VALUES
            (101, 11, 0, 'Paragraph', '[0, 0, 1, 1]'),
            (102, 12, 0, 'Paragraph', '[0, 0, 1, 1]');
        INSERT INTO lines (id, element_id, order_idx, polygon, text, confidence, checked) VALUES
            (1001, 101, 0, '{POLY}', 'Johann Maier', 0.91, 0),
            (1002, 101, 1, '{POLY}', 'Maria Hofer', 0.88, 0),
            (1003, 101, 2, '{POLY}', 'Wien', 0.97, 0),
            (1004, 101, 3, '{POLY}', 'Anton Gruber', 0.95, 1),
            (1005, 102, 0, '{POLY}', 'Theresia Huber', 0.9, 0);
        INSERT INTO page_assignees (page_id, username) VALUES (11, 'lena'), (11, 'ben'), (12, 'lena');
        INSERT INTO candidates (page_id, line_id, source, author, text, llm_model_id) VALUES
            (11, 1001, 'llm', 'llm:gpt', 'Johann Mair', 7);
    """)
    conn.commit()
    app.dependency_overrides[get_db] = lambda: conn
    yield TestClient(app), conn
    app.dependency_overrides.clear()
    page_rows.forget_counts()
    conn.close()


def key(api, headers, line_id, text):
    response = api.patch(f'/api/lines/{line_id}', headers=headers, json={'corrected_text': text})
    assert response.status_code == 200, response.text
    return response.json()


def hand_in(api, headers, page_id):
    return api.post(f'/api/pages/{page_id}/hand-in', headers=headers)


def lines_seen(api, headers, page_id=11, job_id='j1') -> dict[int, tuple]:
    """Each line as the page viewer shows it to this person: (text, correction, confidence)."""
    response = api.get(f'/api/jobs/{job_id}/pages/{page_id}', headers=headers)
    assert response.status_code == 200, response.text
    return {line['id']: (line['text'], line['corrected_text'], line['confidence'])
            for element in response.json()['elements'] for line in element['lines']}


def readings_seen(api, headers, page_id=11) -> list[tuple]:
    response = api.get(f'/api/pages/{page_id}/candidates', headers=headers)
    assert response.status_code == 200, response.text
    return sorted((c['line_id'], c['author'], c['text']) for c in response.json()['candidates'])


def line(conn, line_id) -> tuple:
    row = conn.execute('SELECT corrected_text, corrected_by, checked, check_source FROM lines WHERE id = ?',
                       (line_id,)).fetchone()
    return tuple(row)


def nfd(text: str) -> str:
    return unicodedata.normalize('NFD', text)


def keyers(conn, page_id) -> list[str]:
    return [row[0] for row in conn.execute('SELECT username FROM page_assignees WHERE page_id = ? ORDER BY username',
                                           (page_id,))]


def state_of(conn, page_id) -> str | None:
    return store.page_review(conn, page_id)['state']


def table(api, headers, page_filter) -> list[int]:
    response = api.get('/api/jobs/j1/page-rows', headers=headers, params={'filter': page_filter})
    assert response.status_code == 200, response.text
    return [row['idx'] + 1 for row in response.json()['rows']]


class TestTheSwitches:
    def test_a_dataset_is_keyed_once_unless_its_manager_says_otherwise(self, client):
        api, _ = client

        job = api.get('/api/jobs/j2', headers=ANNA).json()

        assert (job['double_keying'], job['keying_from_empty']) == (False, False)

    def test_a_manager_turns_double_keying_on_from_empty_lines(self, client):
        api, _ = client

        response = api.put('/api/jobs/j2/keying', headers=ANNA, json={'double_keying': True, 'from_empty': True})

        assert response.status_code == 200, response.text
        assert response.json() == {'double_keying': True, 'from_empty': True}
        job = api.get('/api/jobs/j2', headers=ANNA).json()
        assert (job['double_keying'], job['keying_from_empty']) == (True, True)

    def test_only_a_manager_switches_it(self, client):
        api, conn = client

        response = api.put('/api/jobs/j1/keying', headers=RITA, json={'double_keying': False, 'from_empty': False})

        assert response.status_code == 403
        assert conn.execute("SELECT double_keying FROM jobs WHERE id = 'j1'").fetchone()[0] == 1


    def test_it_is_not_turned_off_under_keyers_typing(self, client):
        api, conn = client
        key(api, LENA, 1001, 'Johann Mayer')

        response = api.put('/api/jobs/j1/keying', headers=ANNA, json={'double_keying': False, 'from_empty': False})

        assert response.status_code == 409
        assert response.json()['detail'] == '1 page is being keyed: let its keyers finish, or take it back first'
        assert conn.execute("SELECT double_keying FROM jobs WHERE id = 'j1'").fetchone()[0] == 1

    def test_it_turns_off_while_nobody_has_typed(self, client):
        api, conn = client

        response = api.put('/api/jobs/j1/keying', headers=ANNA, json={'double_keying': False, 'from_empty': False})

        assert response.status_code == 200, response.text
        assert conn.execute("SELECT double_keying FROM jobs WHERE id = 'j1'").fetchone()[0] == 0


class TestAssigningTwoKeyers:
    def test_a_page_is_given_two_keyers(self, client):
        api, conn = client

        response = api.put('/api/jobs/j1/assignments', headers=ANNA,
                           json={'assignee': 'mia', 'second_keyer': 'ben', 'numbers': [3]})

        assert response.status_code == 200, response.text
        assert response.json()['people'] == [{'username': 'anna', 'pages': []},
                                             {'username': 'ben', 'pages': [1, 3]},
                                             {'username': 'lena', 'pages': [1, 2]},
                                             {'username': 'mia', 'pages': [3]},
                                             {'username': 'rita', 'pages': []}]
        assert keyers(conn, 13) == ['ben', 'mia']

    def test_only_a_double_keyed_dataset_takes_a_second_keyer(self, client):
        api, conn = client

        response = api.put('/api/jobs/j2/assignments', headers=ANNA,
                           json={'assignee': 'mia', 'second_keyer': 'ben', 'numbers': [1]})

        assert response.status_code == 400
        assert response.json()['detail'] == 'Only a double-keyed dataset gives a page a second keyer'
        assert conn.execute('SELECT COUNT(*) FROM page_assignees WHERE page_id = 21').fetchone()[0] == 0

    def test_the_two_keyers_are_two_people(self, client):
        api, _ = client

        response = api.put('/api/jobs/j1/assignments', headers=ANNA,
                           json={'assignee': 'mia', 'second_keyer': 'mia', 'numbers': [3]})

        assert response.status_code == 400
        assert response.json()['detail'] == 'Two different people key a page'

    def test_the_keyer_who_stays_keeps_their_typing_and_hand_in(self, client):
        api, conn = client
        key(api, LENA, 1001, 'Johann Mayer')
        key(api, BEN, 1002, 'Maria Hofner')
        hand_in(api, LENA, 11)

        response = api.put('/api/jobs/j1/assignments', headers=ANNA,
                           json={'assignee': 'lena', 'second_keyer': 'mia', 'numbers': [1]})

        assert response.status_code == 200, response.text
        assert keyers(conn, 11) == ['lena', 'mia']
        assert [tuple(row) for row in conn.execute('SELECT line_id, username, text FROM keyings ORDER BY line_id')] == [
            (1001, 'lena', 'Johann Mayer')]
        assert conn.execute("SELECT handed_in_at IS NOT NULL FROM page_assignees "
                            "WHERE page_id = 11 AND username = 'lena'").fetchone()[0] == 1

    def test_the_page_table_names_both_keyers(self, client):
        api, _ = client

        rows = api.get('/api/jobs/j1/page-rows', headers=ANNA).json()['rows']

        assert [(row['assignee'], row['second_assignee']) for row in rows] == [
            ('ben', 'lena'), ('lena', None), (None, None)]
        assert table(api, ANNA, 'assigned:lena') == [1, 2]
        assert table(api, ANNA, 'assigned:ben') == [1]

    def test_the_viewer_steps_through_the_pages_i_key_second_too(self, client):
        """The dataset names one keyer per page, the first by name; `mine` is what Next keeps to (#162)."""
        api, _ = client

        pages = api.get('/api/jobs/j1', headers=LENA).json()['pages']

        assert [(page['idx'], page['assignee'], page['mine']) for page in pages] == [
            (0, 'ben', True), (1, 'lena', True), (2, None, False)]


class TestKeyingBlind:
    def test_a_keyers_typing_is_kept_apart_from_the_line(self, client):
        api, conn = client

        shown = key(api, LENA, 1001, 'Johann Mayer')

        assert shown['corrected_text'] == 'Johann Mayer'
        assert line(conn, 1001) == (None, None, 0, None)
        assert [tuple(row) for row in conn.execute('SELECT line_id, username, text FROM keyings')] == [
            (1001, 'lena', 'Johann Mayer')]

    def test_each_keyer_sees_their_own_typing_and_nobody_else_sees_any(self, client):
        api, _ = client
        key(api, LENA, 1001, 'Johann Mayer')
        key(api, BEN, 1001, 'Johan Maier')

        assert lines_seen(api, LENA)[1001] == ('Johann Maier', 'Johann Mayer', 0.91)
        assert lines_seen(api, BEN)[1001] == ('Johann Maier', 'Johan Maier', 0.91)
        assert lines_seen(api, RITA)[1001] == ('Johann Maier', None, 0.91)
        assert lines_seen(api, ANNA)[1001] == ('Johann Maier', None, 0.91)

    def test_keyers_start_from_empty_lines_when_the_dataset_says_so(self, client):
        api, conn = client
        conn.execute("UPDATE jobs SET keying_from_empty = 1 WHERE id = 'j1'")
        key(api, LENA, 1001, 'Johann Mayer')

        seen = lines_seen(api, LENA)

        assert seen == {1001: ('', 'Johann Mayer', None), 1002: ('', None, None),
                        1003: ('', None, None), 1004: ('', None, None)}
        assert lines_seen(api, RITA)[1002] == ('Maria Hofer', None, 0.88)

    def test_readings_and_the_corpus_text_are_hidden_from_a_keyer(self, client):
        api, _ = client

        assert readings_seen(api, LENA) == []
        assert readings_seen(api, RITA) == [(1001, 'llm:gpt', 'Johann Mair')]
        assert api.get('/api/jobs/j1/pages/11', headers=LENA).json()['reference'] is None
        assert api.get('/api/jobs/j1/pages/11', headers=RITA).json()['reference']['text'] == 'Johann Maier, Maria Hofer'

    def test_search_and_the_transcript_leave_out_the_pages_one_keys(self, client):
        api, conn = client
        conn.execute("UPDATE jobs SET keying_from_empty = 1 WHERE id = 'j1'")

        def found(headers) -> dict:
            corpus = api.get('/api/search', headers=headers, params={'q': 'Johann Maier', 'mode': 'exact'})
            volume = api.get('/api/jobs/j1/transcript/search', headers=headers,
                             params={'q': 'Johann Maier', 'mode': 'exact'})
            index = api.get('/api/jobs/j1/transcript', headers=headers)
            return {'search': [hit['line_id'] for hit in corpus.json()['hits']],
                    'volume': [hit['line'] for hit in volume.json()['hits']],
                    'pages': [page['idx'] for page in index.json()['pages']],
                    'page 1': api.get('/api/jobs/j1/transcript/pages/0', headers=headers).status_code}

        assert found(LENA) == {'search': [], 'volume': [], 'pages': [2], 'page 1': 404}
        assert found(RITA) == {'search': [1001], 'volume': [1001], 'pages': [0, 1, 2], 'page 1': 200}

    def test_a_page_signed_off_is_searched_by_its_keyers_again(self, client):
        api, conn = client
        conn.execute("UPDATE page_assignees SET handed_in_at = datetime('now') WHERE page_id = 11")
        conn.execute("INSERT INTO page_reviews (page_id, state, by_user, at) "
                     "VALUES (11, 'signed_off', 'rita', datetime('now'))")

        response = api.get('/api/search', headers=LENA, params={'q': 'Johann Maier', 'mode': 'exact'})

        assert [hit['line_id'] for hit in response.json()['hits']] == [1001]

    def test_the_viewer_learns_who_keys_the_page(self, client):
        api, _ = client
        hand_in(api, LENA, 11)

        detail = api.get('/api/jobs/j1/pages/11', headers=BEN).json()

        assert detail['keying'] == {'keyers': ['ben', 'lena'], 'handed_in': ['lena'], 'from_empty': False,
                                    'open': True}
        assert api.get('/api/jobs/j2/pages/21', headers=BEN).json()['keying'] is None

    def test_several_lines_typed_at_once_go_to_the_keying(self, client):
        api, conn = client

        response = api.post('/api/lines/texts', headers=LENA, json=[{'id': 1001, 'text': 'Johann Mayer'},
                                                                   {'id': 1002, 'text': 'Maria Hofner'}])

        assert response.json() == {'written': [1001, 1002], 'failed': []}
        assert [line(conn, 1001), line(conn, 1002)] == [(None, None, 0, None)] * 2
        assert [tuple(row) for row in conn.execute('SELECT line_id, text FROM keyings ORDER BY line_id')] == [
            (1001, 'Johann Mayer'), (1002, 'Maria Hofner')]

    @pytest.mark.parametrize('method, url, body', [
        ('patch', '/api/lines/1001', {'polygon': [[0.1, 0.1], [0.8, 0.1], [0.8, 0.3], [0.1, 0.3]]}),
        ('patch', '/api/lines/1001', {'orientation': 90}),
        ('delete', '/api/lines/1001', None),
        ('post', '/api/lines/1001/split', {'cut_x': 0.5}),
        ('post', '/api/lines/merge', {'ids': [1001, 1002]}),
        ('post', '/api/lines/1001/reocr', None),
        ('post', '/api/pages/11/lines', {'polygon': [[0.1, 0.5], [0.9, 0.5], [0.9, 0.6], [0.1, 0.6]]}),
        ('patch', '/api/elements/101', {'bbox': [0, 0, 0.5, 0.5]}),
        ('delete', '/api/elements/101', None),
        ('post', '/api/pages/11/elements', {'bbox': [0.1, 0.1, 0.2, 0.2], 'class_name': 'Paragraph'}),
        ('post', '/api/elements/101/split', {'cut_x': 0.5}),
        ('post', '/api/elements/merge', {'ids': [101]}),
        ('post', '/api/pages/11/delete', {'elements': [{'id': 101}]}),
        ('patch', '/api/pages/11', {'reading_order': 'columns'}),
        ('post', '/api/pages/11/turn', {'degrees': 90}),
        ('post', '/api/pages/11/run', {'phase': 'ocr'}),
        ('post', '/api/pages/11/revert', {'from_revision': 1, 'to_revision': 2, 'direction': 'undo'}),
        ('delete', '/api/pages/11/llm/readings', None),
    ])
    def test_a_keyer_changes_the_text_only(self, client, method, url, body):
        api, conn = client
        before = conn.execute('SELECT COUNT(*), SUM(deleted) FROM lines').fetchone()[:]

        response = api.request(method.upper(), url, headers=LENA, json=body)

        assert response.status_code == 403, response.text
        assert response.json()['detail'] == KEYING_ONLY
        assert conn.execute('SELECT COUNT(*), SUM(deleted) FROM lines').fetchone()[:] == before

    def test_a_keyer_does_not_take_a_reading(self, client):
        api, conn = client
        reading = conn.execute('SELECT id FROM candidates').fetchone()[0]

        response = api.patch(f'/api/candidates/{reading}', headers=LENA, json={'line_id': 1002})

        assert response.status_code == 403
        assert response.json()['detail'] == KEYING_ONLY

    def test_a_reviewer_keying_a_page_does_not_check_its_lines(self, client):
        api, conn = client
        conn.execute("INSERT INTO page_assignees (page_id, username) VALUES (12, 'rita')")

        response = api.patch('/api/lines/1005', headers=RITA, json={'corrected_text': 'Theresia Hueber', 'checked': True})

        assert response.status_code == 403
        assert response.json()['detail'] == KEYING_ONLY
        assert line(conn, 1005) == (None, None, 0, None)

    def test_a_reviewer_not_keying_the_page_still_fixes_its_geometry(self, client):
        api, conn = client

        response = api.delete('/api/lines/1003', headers=RITA)

        assert response.status_code == 200, response.text
        assert conn.execute('SELECT deleted FROM lines WHERE id = 1003').fetchone()[0] == 1

    def test_a_page_keyed_once_is_edited_as_before(self, client):
        api, conn = client
        conn.execute("UPDATE jobs SET double_keying = 0 WHERE id = 'j1'")

        shown = key(api, LENA, 1001, 'Johann Mayer')

        assert shown['corrected_text'] == 'Johann Mayer'
        assert line(conn, 1001) == (nfd('Johann Mayer'), 'lena', 0, None)
        assert conn.execute('SELECT COUNT(*) FROM keyings').fetchone()[0] == 0


class TestComparingTheKeyings:
    def type_page(self, api):
        """Lena and Ben agree on the first two lines, Ben's spacing aside, and on the second Ben
        left the recognition as it was; they part on the case of the third and a letter of the
        fourth, which was checked before."""
        key(api, LENA, 1001, 'Johann Mayer')
        key(api, BEN, 1001, ' Johann  Mayer ')
        key(api, LENA, 1002, 'Maria Hofer')
        key(api, LENA, 1003, 'Wien')
        key(api, BEN, 1003, 'wien')
        key(api, BEN, 1004, 'Anton Grueber')

    def test_nothing_is_compared_until_both_keyers_are_in(self, client):
        api, conn = client
        self.type_page(api)

        response = hand_in(api, LENA, 11)

        assert response.json()['state'] == 'partly_handed_in'
        assert [line(conn, line_id) for line_id in (1001, 1003)] == [(None, None, 0, None)] * 2

    def test_lines_typed_alike_are_checked_and_the_rest_wait_for_the_reviewer(self, client):
        api, conn = client
        self.type_page(api)
        hand_in(api, LENA, 11)

        response = hand_in(api, BEN, 11)

        assert response.status_code == 200, response.text
        assert response.json()['state'] == 'handed_in'
        assert line(conn, 1001) == (nfd('Johann Mayer'), 'lena', 1, 'keyed')
        assert line(conn, 1002) == (None, None, 1, 'keyed')
        assert line(conn, 1003) == (None, None, 0, None)
        assert line(conn, 1004) == (None, None, 0, None)
        assert store.unchecked_lines(conn, 11) == 2

    def test_a_mismatch_carries_the_first_keying_and_offers_both(self, client):
        api, conn = client
        key(api, LENA, 1003, 'Wien.')
        key(api, BEN, 1003, 'wien')
        hand_in(api, BEN, 11)

        hand_in(api, LENA, 11)

        assert line(conn, 1003) == ('wien', 'ben', 0, None)
        assert readings_seen(api, RITA) == [(1001, 'llm:gpt', 'Johann Mair'),
                                            (1003, 'ben', 'wien'), (1003, 'lena', 'Wien.')]

    def test_a_line_drawn_after_the_first_hand_in_waits_for_the_reviewer(self, client):
        """The first keyer never saw it, so the two cannot have agreed on it (#169)."""
        api, conn = client
        hand_in(api, LENA, 11)
        conn.execute("UPDATE page_assignees SET handed_in_at = datetime('now', '-1 minute') "
                     "WHERE page_id = 11 AND username = 'lena'")
        drawn = api.post('/api/pages/11/lines', headers=ANNA,
                         json={'polygon': [[0.1, 0.5], [0.9, 0.5], [0.9, 0.6], [0.1, 0.6]]})
        assert drawn.status_code == 200, drawn.text
        new_line = drawn.json()['id']

        hand_in(api, BEN, 11)

        assert conn.execute('SELECT checked, check_source FROM lines WHERE id = ?', (new_line,)).fetchone()[:] == (0, None)
        assert line(conn, 1002) == (None, None, 1, 'keyed')

    def test_from_empty_lines_a_line_nobody_typed_is_agreed_empty(self, client):
        api, conn = client
        conn.execute("UPDATE jobs SET keying_from_empty = 1 WHERE id = 'j1'")
        key(api, LENA, 1001, 'Johann Mayer')
        key(api, BEN, 1001, 'Johann Mayer')
        key(api, LENA, 1002, 'Maria Hoffer')
        hand_in(api, LENA, 11)

        hand_in(api, BEN, 11)

        assert line(conn, 1001) == (nfd('Johann Mayer'), 'lena', 1, 'keyed')
        assert line(conn, 1002) == ('Maria Hoffer', 'lena', 0, None)
        assert line(conn, 1003) == ('', 'lena', 1, 'keyed')
        assert readings_seen(api, RITA)[1:] == [(1002, 'lena', 'Maria Hoffer')]

    def test_the_co_keyers_version_stays_hidden_until_the_page_is_signed_off(self, client):
        api, conn = client
        self.type_page(api)
        hand_in(api, LENA, 11)
        hand_in(api, BEN, 11)

        hidden = readings_seen(api, LENA)
        for line_id, text in ((1003, 'Wien'), (1004, 'Anton Gruber')):
            response = api.patch(f'/api/lines/{line_id}', headers=RITA,
                                 json={'corrected_text': text, 'checked': True, 'from_reading': True})
            assert response.status_code == 200, response.text
        signed = api.put('/api/pages/11/review', headers=RITA, json={'verdict': 'signed_off'})

        assert hidden == []
        assert signed.status_code == 200, signed.text
        assert readings_seen(api, LENA) == [(1001, 'llm:gpt', 'Johann Mair'),
                                            (1003, 'ben', 'wien'), (1003, 'lena', 'Wien'),
                                            (1004, 'ben', 'Anton Grueber'), (1004, 'lena', 'Anton Gruber')]

    def test_only_spacing_and_unicode_form_count_as_agreement(self):
        from app import keying

        assert keying.agree(' Johann  Mayer ', 'Johann Mayer')
        assert keying.agree(unicodedata.normalize('NFC', 'Müller'), nfd('Müller'))
        assert not keying.agree('Wien', 'wien')
        assert not keying.agree('„Wien“', '"Wien"')
        assert not keying.agree('1848–1850', '1848-1850')


class TestTheReviewStates:
    def test_one_keyer_in_is_partly_handed_in(self, client):
        api, conn = client

        hand_in(api, LENA, 11)

        assert state_of(conn, 11) == 'partly_handed_in'
        assert table(api, ANNA, 'partly-handed-in') == [1]
        assert table(api, ANNA, 'handed-in') == []

    def test_a_page_with_one_keyer_waits_for_a_second(self, client):
        api, conn = client
        key(api, LENA, 1005, 'Theresia Hueber')

        response = hand_in(api, LENA, 12)

        assert response.json()['state'] == 'partly_handed_in'
        assert line(conn, 1005) == (None, None, 0, None)

    def test_a_keyer_takes_their_hand_in_back_before_the_other_is_in(self, client):
        api, conn = client
        hand_in(api, LENA, 11)

        response = api.delete('/api/pages/11/hand-in', headers=LENA)

        assert response.status_code == 200, response.text
        assert state_of(conn, 11) is None

    def test_no_hand_in_is_taken_back_once_both_are_in(self, client):
        api, conn = client
        hand_in(api, LENA, 11)
        hand_in(api, BEN, 11)

        response = api.delete('/api/pages/11/hand-in', headers=LENA)

        assert response.status_code == 409
        assert response.json()['detail'] == 'Both keyings are in: the page is with the Reviewer'
        assert state_of(conn, 11) == 'handed_in'

    def test_no_sign_off_while_the_page_is_being_keyed(self, client):
        api, conn = client
        conn.execute('UPDATE lines SET checked = 1')

        response = api.put('/api/pages/11/review', headers=RITA, json={'verdict': 'signed_off'})

        assert response.status_code == 409
        assert response.json()['detail'] == 'The page is still being keyed'
        assert state_of(conn, 11) is None

    def test_a_double_keyed_page_is_not_sent_back(self, client):
        api, conn = client
        hand_in(api, LENA, 11)
        hand_in(api, BEN, 11)

        response = api.put('/api/pages/11/review', headers=RITA, json={'verdict': 'sent_back', 'note': 'Zeile 3'})

        assert response.status_code == 400
        assert response.json()['detail'] == 'A double-keyed page is not sent back: its Reviewer settles what the keyers disagree on'
        assert state_of(conn, 11) == 'handed_in'

    def test_once_both_are_in_each_keyer_sees_their_own_version_until_sign_off(self, client):
        api, conn = client
        key(api, LENA, 1003, 'Wien')
        key(api, BEN, 1003, 'wien')
        hand_in(api, LENA, 11)
        hand_in(api, BEN, 11)

        lena_saw, ben_saw = lines_seen(api, LENA)[1003], lines_seen(api, BEN)[1003]
        edit = api.patch('/api/lines/1001', headers=LENA, json={'corrected_text': 'Johann Mayr'})
        conn.execute('UPDATE lines SET checked = 1')
        api.put('/api/pages/11/review', headers=RITA, json={'verdict': 'signed_off'})

        assert (lena_saw, ben_saw) == (('Wien', 'Wien', 0.97), ('Wien', 'wien', 0.97))
        assert edit.status_code == 403
        assert edit.json()['detail'] == 'Both keyings are in: the page is with the Reviewer'
        assert line(conn, 1001)[0] is None
        assert lines_seen(api, BEN)[1003] == ('Wien', None, 0.97)
