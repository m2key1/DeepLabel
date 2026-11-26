"""Search across every dataset someone can open (#41): a trigram index over line text kept
current as lines change, with the Transcript's fuzzy, exact and pattern matching on top,
ranked by how well each line answers and grouped by dataset."""
import sqlite3

import pytest
from fastapi.testclient import TestClient

from app import store
from app.deps import get_db
from app.main import app

SECRET = 'test-secret'


def headers(user: str, role: str = 'member') -> dict:
    return {'X-Frontend-Secret': SECRET, 'X-Auth-User': user, 'X-Auth-Role': role}


ALICE = headers('alice')
ADMIN = headers('root', 'admin')


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    conn = store.connect(tmp_path / 'app.db')
    # Alice owns the first two volumes, the second in her workspace; Bob's is his alone.
    conn.executescript("""
        INSERT INTO groups (id, name, owner) VALUES (5, 'Letters', 'alice');
        INSERT INTO group_assignees (group_id, username) VALUES (5, 'alice');
        INSERT INTO jobs (id, name, owner, status, task, group_id) VALUES
            ('j1', 'Volume A', 'alice', 'done', 'text', NULL),
            ('j2', 'Volume B', 'alice', 'done', 'text', 5),
            ('j3', 'Volume C', 'bob', 'done', 'text', NULL);
        INSERT INTO pages (id, job_id, idx, filename, source_file, status) VALUES
            (1, 'j1', 0, 'a.png', '/a.png', 'done'), (2, 'j1', 1, 'b.png', '/b.png', 'done'),
            (3, 'j2', 0, 'c.png', '/c.png', 'done'), (4, 'j3', 0, 'd.png', '/d.png', 'done');
        INSERT INTO elements (id, page_id, order_idx, class_name, bbox, kind) VALUES
            (1, 1, 0, 'Paragraph', '[0, 0, 1, 1]', 'content'), (2, 2, 0, 'Paragraph', '[0, 0, 1, 1]', 'content'),
            (3, 3, 0, 'Paragraph', '[0, 0, 1, 1]', 'content'), (4, 4, 0, 'Paragraph', '[0, 0, 1, 1]', 'content');
        INSERT INTO lines (id, element_id, order_idx, polygon, text, corrected_text, checked) VALUES
            (10, 1, 0, '[]', 'Johann Müller, Pfarrer', NULL, 0),
            (11, 1, 1, '[]', 'in der Gemeinde', NULL, 0),
            (20, 2, 0, '[]', 'Anna Mülller geboren', NULL, 0),
            (30, 3, 0, '[]', 'Maria Mueller', NULL, 1),
            (31, 3, 1, '[]', 'Franz Huber', 'Franz Müller', 1),
            (40, 4, 0, '[]', 'Josef Müller', NULL, 0);
    """)
    conn.commit()
    app.dependency_overrides[get_db] = lambda: conn
    yield TestClient(app), conn
    app.dependency_overrides.clear()
    conn.close()


def search(api, who=ALICE, **params) -> dict:
    res = api.get('/api/search', headers=who, params=params)
    assert res.status_code == 200, res.text
    return res.json()


def found(answer: dict) -> list[int]:
    return [hit['line_id'] for hit in answer['hits']]


class TestFinding:
    def test_a_name_is_found_in_every_dataset_one_can_open_whatever_its_spelling(self, client):
        api, _ = client
        answer = search(api, q='Müller')
        # Volume B holds two exact answers, so it leads; the misreading in Volume A comes
        # after its exact line. Bob's volume is not Alice's to search.
        assert [(d['id'], d['name'], d['hits']) for d in answer['datasets']] == [
            ('j2', 'Volume B', 2), ('j1', 'Volume A', 2)]
        assert found(answer) == [30, 31, 10, 20]
        assert answer['total'] == 4
        first = answer['hits'][0]
        assert {k: first[k] for k in ('job_id', 'job_name', 'page_id', 'page_idx', 'text', 'words')} == {
            'job_id': 'j2', 'job_name': 'Volume B', 'page_id': 3, 'page_idx': 0,
            'text': 'Maria Mueller', 'words': ['mueller']}
        assert first['crop'].startswith('/api/lines/30/crop?b=')

    def test_an_admin_searches_every_dataset(self, client):
        api, _ = client
        assert [d['id'] for d in search(api, ADMIN, q='Müller')['datasets']] == ['j2', 'j1', 'j3']

    def test_exact_finds_only_the_spelling_asked_for(self, client):
        api, _ = client
        assert found(search(api, q='Müller,', mode='exact')) == [10]

    def test_a_pattern_is_the_readers_own(self, client):
        api, _ = client
        # Equally good answers: the datasets in the order of their names.
        assert found(search(api, q=r'^(Anna|Maria) ', mode='regex')) == [20, 30]

    def test_a_query_too_short_to_index_asks_for_more(self, client):
        api, _ = client
        assert search(api, q='Mu') == {'usable': True, 'too_short': True, 'total': 0, 'datasets': [], 'hits': []}


class TestNarrowing:
    def test_by_workspace_by_dataset_and_to_checked_lines(self, client):
        api, _ = client
        assert found(search(api, q='Müller', group_id=5)) == [30, 31]
        assert found(search(api, q='Müller', job_id='j1')) == [10, 20]
        assert found(search(api, q='Müller', checked=True)) == [30, 31]

    def test_a_dataset_one_cannot_open_finds_nothing_rather_than_saying_so(self, client):
        api, _ = client
        assert found(search(api, q='Müller', job_id='j3')) == []

    def test_results_come_a_screenful_at_a_time(self, client):
        api, _ = client
        answer = search(api, q='Müller', offset=1, limit=2)
        assert (found(answer), answer['total']) == ([31, 10], 4)


class TestTheIndexFollowsTheLines:
    def test_a_correction_is_found_by_its_new_text_and_not_its_old(self, client):
        api, conn = client
        conn.execute("UPDATE lines SET corrected_text = 'in der Pfarrgemeinde' WHERE id = 11")
        conn.commit()
        assert found(search(api, q='Pfarrgemeinde')) == [11]
        assert found(search(api, q='der Gemeinde', mode='exact')) == []

    def test_a_new_line_is_found_and_a_removed_one_is_not(self, client):
        api, conn = client
        conn.execute("INSERT INTO lines (id, element_id, order_idx, polygon, text) VALUES (12, 1, 2, '[]', 'Taufbuch')")
        conn.execute('UPDATE lines SET deleted = 1 WHERE id = 20')
        conn.execute('DELETE FROM lines WHERE id = 10')
        conn.commit()
        assert found(search(api, q='Taufbuch')) == [12]
        assert found(search(api, q='Müller', job_id='j1')) == []
        assert conn.execute('SELECT COUNT(*) FROM line_search WHERE rowid = 10').fetchone()[0] == 0

    def test_a_line_changed_outside_the_app_is_still_indexed(self, client):
        # A repair in the sqlite3 shell has none of the app's own functions to call.
        api, conn = client
        raw = sqlite3.connect(conn.execute('PRAGMA database_list').fetchone()['file'])
        raw.execute("UPDATE lines SET corrected_text = 'Josef GRÜNWALD' WHERE id = 11")
        raw.commit()
        raw.close()
        assert found(search(api, q='Grünwald')) == [11]
        assert found(search(api, q='Gruenwald', mode='exact')) == []
        assert found(search(api, q='Grünwald', mode='exact')) == [11]

    def test_a_deleted_page_is_not_searched(self, client):
        api, conn = client
        conn.execute('UPDATE pages SET deleted = 1 WHERE id = 3')
        conn.commit()
        assert found(search(api, q='Müller')) == [10, 20]


class TestTheIndexFoldsLikeTheQuery:
    def test_a_line_with_space_runs_or_carriage_returns_is_found_exactly(self, client):
        """#169: the index once kept a long run of spaces or a carriage return that the query's
        fold takes out, and the per-row matcher wanted the spaces as typed, so an exact search
        missed those lines."""
        api, conn = client
        conn.executemany('INSERT INTO lines (id, element_id, order_idx, polygon, text) VALUES (?, 1, ?, ?, ?)',
                         [(50, 2, '[]', 'Johann     Müller, Pfarrer'), (51, 3, '[]', 'Johann\r\nMüller, Pfarrer')])
        conn.commit()
        assert found(search(api, q='Johann Müller, Pfarrer', mode='exact')) == [10, 50, 51]

    def test_a_correction_with_an_accent_is_found_exactly(self, client):
        """A correction is stored decomposed; the index puts each letter back together with its
        accent, as the query's fold does, so exact search finds it (#169)."""
        api, _ = client
        for line_id, text in ((11, 'Josef Grünwald'), (20, 'Anna Bréton')):
            res = api.patch(f'/api/lines/{line_id}', headers=ALICE, json={'corrected_text': text})
            assert res.status_code == 200, res.text

        assert found(search(api, q='Grünwald', mode='exact')) == [11]
        assert found(search(api, q='Bréton', mode='case')) == [20]
