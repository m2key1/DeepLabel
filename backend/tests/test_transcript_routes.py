"""The transcript reads a volume a page at a time: an index of the pages up front, each page's
text and outlines when it is opened, and a search run here rather than over a download of
the whole volume - which on 78k lines was 66 MB and arrived cut off."""
import pytest
from fastapi.testclient import TestClient

from app import store, text_search
from app.deps import get_db
from app.main import app

SECRET = 'test-secret'
ALICE = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'alice', 'X-Auth-Role': 'member'}
BOB = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'bob', 'X-Auth-Role': 'member'}
ROOT = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'root', 'X-Auth-Role': 'admin'}
POLY = '[[0,0],[1,0],[1,1],[0,1]]'


@pytest.fixture
def conn(tmp_path):
    connection = store.connect(tmp_path / 'app.db')
    connection.executescript(f"""
        INSERT INTO jobs (id, name, owner, status) VALUES ('j1', 'Volume I', 'alice', 'done'),
                                                          ('j2', 'Other', 'alice', 'done');
        INSERT INTO pages (id, job_id, idx, filename, source_file, status, width, height, rotation, deleted)
            VALUES (1, 'j1', 0, 'p1.png', '/p1.png', 'done', 800, 1100, 0, 0),
                   (2, 'j1', 1, 'p2.png', '/p2.png', 'done', 800, 1100, 90, 0),
                   (3, 'j1', 2, 'p3.png', '/p3.png', 'done', 800, 1100, 0, 0),
                   (4, 'j1', 3, 'gone.png', '/gone.png', 'done', 800, 1100, 0, 1),
                   (5, 'j2', 0, 'q1.png', '/q1.png', 'done', 800, 1100, 0, 0);
        INSERT INTO elements (id, page_id, order_idx, class_name, bbox, kind) VALUES
            (1, 1, 0, 'Paragraph', '[0,0,1,1]', 'content'),
            (2, 1, 1, 'Table', '[0,0,1,1]', 'container'),
            (3, 2, 0, 'Paragraph', '[0,0,1,1]', 'content'),
            (4, 3, 0, 'Header', '[0,0,1,1]', 'content'),
            (5, 3, 1, 'Paragraph', '[0,0,1,1]', 'content'),
            (6, 5, 0, 'Paragraph', '[0,0,1,1]', 'content');
        INSERT INTO lines (id, element_id, order_idx, polygon, text, corrected_text, checked, deleted) VALUES
            (1, 1, 0, '{POLY}', 'Pfarre Wien', NULL, 1, 0),
            (2, 1, 1, '{POLY}', 'Kaplan Hubr', 'Kaplan Huber', 0, 0),
            (3, 1, 2, '{POLY}', '', NULL, 0, 0),
            (4, 1, 3, '{POLY}', 'Huber deleted', NULL, 1, 1),
            (5, 2, 0, '{POLY}', 'Huber in a table', NULL, 1, 0),
            (6, 3, 0, '{POLY}', NULL, NULL, 0, 0),
            (7, 5, 0, '{POLY}', 'Franz Huber', NULL, 1, 0),
            (8, 4, 0, '{POLY}', 'Chronik', NULL, 0, 0),
            (9, 6, 0, '{POLY}', 'Huber elsewhere', NULL, 1, 0);
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


def search(client, q, mode='fuzzy', reviewed=False, headers=ALICE):
    return client.get('/api/jobs/j1/transcript/search', params={'q': q, 'mode': mode, 'reviewed': reviewed},
                      headers=headers)


class TestIndex:
    def test_lists_the_live_pages_with_what_the_reader_needs_to_turn_and_filter_them(self, client):
        body = client.get('/api/jobs/j1/transcript', headers=ALICE).json()
        assert body['job'] == {'id': 'j1', 'name': 'Volume I'}
        assert body['pages'] == [
            {'id': 1, 'idx': 0, 'filename': 'p1.png', 'width': 800, 'height': 1100, 'rotation': 0,
             'lines': 3, 'checked': 1, 'with_text': 2, 'checked_with_text': 1},
            {'id': 2, 'idx': 1, 'filename': 'p2.png', 'width': 800, 'height': 1100, 'rotation': 90,
             'lines': 1, 'checked': 0, 'with_text': 0, 'checked_with_text': 0},
            {'id': 3, 'idx': 2, 'filename': 'p3.png', 'width': 800, 'height': 1100, 'rotation': 0,
             'lines': 2, 'checked': 1, 'with_text': 2, 'checked_with_text': 1},
        ]

    def test_a_dataset_nobody_shared_stays_hidden(self, client):
        assert client.get('/api/jobs/j1/transcript', headers=BOB).status_code == 404

    def test_reading_is_not_exporting(self, client, conn):
        conn.execute('UPDATE jobs SET use_export = 0')
        conn.commit()
        assert client.get('/api/jobs/j1/export', headers=ROOT).status_code == 403
        assert client.get('/api/jobs/j1/transcript', headers=ROOT).status_code == 200
        assert client.get('/api/jobs/j1/transcript/pages/0', headers=ROOT).status_code == 200
        assert search(client, 'Huber', headers=ROOT).status_code == 200


class TestPage:
    def test_carries_the_elements_and_lines_of_that_page_in_reading_order(self, client):
        page = client.get('/api/jobs/j1/transcript/pages/0', headers=ALICE).json()
        assert (page['id'], page['idx'], page['rotation']) == (1, 0, 0)
        assert [(e['class_name'], e['kind'], [line['id'] for line in e['lines']]) for e in page['elements']] == \
            [('Paragraph', 'content', [1, 2, 3]), ('Table', 'container', [5])]
        assert page['elements'][0]['lines'][1] == {
            'id': 2, 'order_idx': 1, 'polygon': [[0, 0], [1, 0], [1, 1], [0, 1]],
            'text': 'Kaplan Hubr', 'corrected_text': 'Kaplan Huber', 'confidence': None, 'checked': False}

    def test_a_page_that_is_not_there_is_not_found(self, client):
        assert client.get('/api/jobs/j1/transcript/pages/3', headers=ALICE).status_code == 404
        assert client.get('/api/jobs/j1/transcript/pages/9', headers=ALICE).status_code == 404


class TestSearch:
    def test_finds_the_corrected_text_in_reading_order_and_skips_tables_and_deleted_lines(self, client):
        assert search(client, 'Huber').json() == {'usable': True, 'hits': [
            {'idx': 0, 'line': 2, 'words': ['huber']},
            {'idx': 2, 'line': 7, 'words': ['huber']},
        ]}

    def test_a_near_spelling_is_found(self, client):
        assert search(client, 'Hueber').json()['hits'] == [
            {'idx': 0, 'line': 2, 'words': ['huber']},
            {'idx': 2, 'line': 7, 'words': ['huber']},
        ]

    def test_reviewed_only_searches_the_reviewed_lines(self, client):
        assert search(client, 'Huber', reviewed=True).json()['hits'] == [{'idx': 2, 'line': 7, 'words': ['huber']}]

    def test_each_mode_answers_with_the_words_it_matched(self, client):
        assert search(client, 'franz H', mode='exact').json()['hits'] == [
            {'idx': 2, 'line': 7, 'words': ['Franz', 'Huber']}]
        assert search(client, 'franz', mode='case').json()['hits'] == []
        assert search(client, r'^Kap\w+', mode='regex').json()['hits'] == [
            {'idx': 0, 'line': 2, 'words': ['Kaplan']}]

    def test_an_unfinished_pattern_finds_nothing_rather_than_failing(self, client):
        assert search(client, 'Hub(er', mode='regex').json() == {'usable': False, 'hits': []}

    def test_a_pattern_that_runs_too_long_says_so(self, client, conn, monkeypatch):
        monkeypatch.setattr(text_search, 'PATTERN_SECONDS', 0.05)
        conn.execute("UPDATE lines SET text = ? WHERE id = 1", ('a' * 40 + 'b',))
        conn.commit()
        response = search(client, '(a|aa)+$', mode='regex')
        assert (response.status_code, response.json()['detail']) == \
            (400, 'the pattern took too long - make it more specific')

    def test_an_unknown_mode_is_refused(self, client):
        assert search(client, 'Huber', mode='soundex').status_code == 400

    def test_a_dataset_nobody_shared_stays_hidden(self, client):
        assert search(client, 'Huber', headers=BOB).status_code == 404
