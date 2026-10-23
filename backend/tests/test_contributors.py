"""The Users page asks the backend two things about a person: what they can reach, and
what they have done. Both are read off tables keyed by username - jobs, groups, the
assignee tables and the revision log - so they are pinned here with exact counts.
"""
import pytest
from fastapi.testclient import TestClient

from app import store
from app.deps import get_db
from app.main import app

SECRET = 'test-secret'
ADMIN = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'root', 'X-Auth-Role': 'admin'}
MEMBER = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'bob', 'X-Auth-Role': 'member'}


def _job(conn, job_id: str, name: str, owner: str, group_id: int | None = None, task: str = 'text'):
    conn.execute('INSERT INTO jobs (id, name, owner, task, status, group_id) VALUES (?, ?, ?, ?, ?, ?)',
                 (job_id, name, owner, task, 'done', group_id))


def _revision(conn, target_type: str, target_id: int, job_id: str, author: str, created_at: str):
    store.log_revision(conn, target_type, target_id, job_id, author, 'update', {})
    conn.execute('UPDATE revisions SET created_at = ? WHERE id = last_insert_rowid()', (created_at,))


@pytest.fixture
def client(tmp_path, monkeypatch):
    """Bob owns nothing. Alice shares one dataset with him directly and one through a
    group; a third dataset of hers stays private. Bob's edits span two datasets, one of
    which has since been deleted, and reach back further than the default window."""
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    conn = store.connect(tmp_path / 'app.db')
    group = conn.execute("INSERT INTO groups (name, owner) VALUES ('Parish books', 'alice')").lastrowid
    conn.execute('INSERT INTO group_assignees (group_id, username) VALUES (?, ?)', (group, 'bob'))
    _job(conn, 'shared', 'Schematismus 1780', 'alice')
    conn.execute("INSERT INTO job_assignees (job_id, username) VALUES ('shared', 'bob')")
    _job(conn, 'grouped', 'Baptisms 1801', 'alice', group_id=group, task='map_lines')
    _job(conn, 'private', 'Private notes', 'alice')
    _job(conn, 'own', 'Bobs own', 'bob')

    _revision(conn, 'line', 1, 'shared', 'bob', '2026-08-30 10:00:00')
    _revision(conn, 'line', 1, 'shared', 'bob', '2026-08-30 10:05:00')
    _revision(conn, 'line', 2, 'shared', 'bob', '2026-08-31 09:00:00')
    _revision(conn, 'element', 7, 'shared', 'bob', '2026-08-31 09:30:00')
    _revision(conn, 'line', 3, 'gone', 'bob', '2026-01-15 12:00:00')
    _revision(conn, 'line', 4, 'shared', 'alice', '2026-08-31 11:00:00')
    _revision(conn, 'line', 5, 'shared', 'model:ocr@base', '2026-08-29 08:00:00')
    conn.commit()

    app.dependency_overrides[get_db] = lambda: conn
    yield TestClient(app)
    app.dependency_overrides.clear()
    conn.close()


class TestAccess:
    def test_lists_every_reachable_dataset_with_the_reason(self, client):
        body = client.get('/api/contributors/bob/access', headers=ADMIN).json()
        assert body['datasets'] == [
            {'id': 'grouped', 'name': 'Baptisms 1801', 'task': 'map_lines', 'access': 'group'},
            {'id': 'own', 'name': 'Bobs own', 'task': 'text', 'access': 'owner'},
            {'id': 'shared', 'name': 'Schematismus 1780', 'task': 'text', 'access': 'shared'},
        ]
        assert body['groups'] == [{'id': 1, 'name': 'Parish books', 'access': 'shared'}]

    def test_the_owner_side_reads_as_owner(self, client):
        body = client.get('/api/contributors/alice/access', headers=ADMIN).json()
        assert [d['access'] for d in body['datasets']] == ['owner', 'owner', 'owner']
        assert body['groups'] == [{'id': 1, 'name': 'Parish books', 'access': 'owner'}]

    def test_an_unknown_name_reaches_nothing(self, client):
        assert client.get('/api/contributors/nobody/access', headers=ADMIN).json() == {'datasets': [], 'groups': []}

    def test_members_may_not_ask(self, client):
        assert client.get('/api/contributors/bob/access', headers=MEMBER).status_code == 403


class TestActivity:
    def test_counts_distinct_targets_not_revisions(self, client):
        totals = client.get('/api/contributors/bob/activity', headers=ADMIN).json()['totals']
        assert totals == {'lines': 3, 'elements': 1, 'regions': 0, 'revisions': 5,
                          'first_at': '2026-01-15 12:00:00', 'last_at': '2026-08-31 09:30:00'}

    def test_breaks_down_per_dataset_newest_first(self, client):
        datasets = client.get('/api/contributors/bob/activity', headers=ADMIN).json()['datasets']
        assert datasets == [
            {'id': 'shared', 'name': 'Schematismus 1780', 'lines': 2, 'elements': 1, 'regions': 0,
             'last_at': '2026-08-31 09:30:00'},
            {'id': 'gone', 'name': None, 'lines': 1, 'elements': 0, 'regions': 0,
             'last_at': '2026-01-15 12:00:00'},
        ]

    def test_daily_series_covers_only_the_window(self, client):
        daily = client.get('/api/contributors/bob/activity?days=3650', headers=ADMIN).json()['daily']
        assert daily == [
            {'day': '2026-01-15', 'revisions': 1},
            {'day': '2026-08-30', 'revisions': 2},
            {'day': '2026-08-31', 'revisions': 2},
        ]
        narrow = client.get('/api/contributors/bob/activity?days=1', headers=ADMIN).json()
        assert narrow['days'] == 1
        assert all(d['day'] != '2026-01-15' for d in narrow['daily'])

    def test_other_authors_never_leak_in(self, client):
        alice = client.get('/api/contributors/alice/activity', headers=ADMIN).json()['totals']
        assert (alice['lines'], alice['revisions']) == (1, 1)
        model = client.get('/api/contributors/model:ocr@base/activity', headers=ADMIN).json()['totals']
        assert model['revisions'] == 1

    def test_no_activity_reads_as_zeroes(self, client):
        body = client.get('/api/contributors/nobody/activity', headers=ADMIN).json()
        assert body['totals'] == {'lines': 0, 'elements': 0, 'regions': 0, 'revisions': 0,
                                  'first_at': None, 'last_at': None}
        assert body['daily'] == [] and body['datasets'] == []

    def test_rejects_an_empty_window(self, client):
        assert client.get('/api/contributors/bob/activity?days=0', headers=ADMIN).status_code == 400

    def test_members_may_not_ask(self, client):
        assert client.get('/api/contributors/bob/activity', headers=MEMBER).status_code == 403


def test_the_log_is_indexed_by_author(tmp_path):
    conn = store.connect(tmp_path / 'app.db')
    indexes = {row['name'] for row in conn.execute('PRAGMA index_list(revisions)')}
    assert 'idx_revisions_author' in indexes
    conn.close()
