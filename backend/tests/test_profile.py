from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from app import store
from app.deps import get_db
from app.main import app

SECRET = 'test-secret'


def headers(user: str, role: str = 'member') -> dict:
    return {'X-Frontend-Secret': SECRET, 'X-Auth-User': user, 'X-Auth-Role': role}


ADMIN = headers('root', 'admin')
BOB = headers('bob')
CAROL = headers('carol', 'viewer')

NOW = datetime.now(timezone.utc).replace(tzinfo=None)


def at(days_ago: int, hour: int) -> str:
    return (NOW - timedelta(days=days_ago)).strftime(f'%Y-%m-%d {hour:02d}:00:00')


def day(days_ago: int) -> str:
    return (NOW - timedelta(days=days_ago)).strftime('%Y-%m-%d')


def rev(conn, target_type, target_id, job_id, author, action, snapshot, when):
    store.log_revision(conn, target_type, target_id, job_id, author, action, snapshot)
    conn.execute('UPDATE revisions SET created_at = ? WHERE id = last_insert_rowid()', (when,))


def seed(conn):
    """Bob owns one dataset, is shared one by Alice directly and one through her group;
    Carol is shared only the direct one. Bob's revisions are written in time order, the
    way the log fills, one of them older than a year and one in a dataset since deleted."""
    group = conn.execute("INSERT INTO groups (name, owner) VALUES ('Parish books', 'alice')").lastrowid
    conn.execute('INSERT INTO group_assignees (group_id, username) VALUES (?, ?)', (group, 'bob'))
    for job_id, name, owner, group_id, task in [
            ('shared', 'Schematismus 1780', 'alice', None, 'text'),
            ('grouped', 'Baptisms 1801', 'alice', group, 'map_segmentation'),
            ('private', 'Private notes', 'alice', None, 'text'),
            ('own', 'Bobs own', 'bob', None, 'text')]:
        conn.execute('INSERT INTO jobs (id, name, owner, task, status, group_id) VALUES (?, ?, ?, ?, ?, ?)',
                     (job_id, name, owner, task, 'done', group_id))
    conn.execute("INSERT INTO job_assignees (job_id, username) VALUES ('shared', 'bob'), ('shared', 'carol')")

    for page_id, job_id in [(1, 'shared'), (2, 'own'), (3, 'grouped')]:
        conn.execute("INSERT INTO pages (id, job_id, idx, filename, source_file, status) "
                     "VALUES (?, ?, 0, 'p.jpg', 'p.jpg', 'done')", (page_id, job_id))
    conn.execute("INSERT INTO elements (id, page_id, order_idx, class_name, bbox) VALUES "
                 "(1, 1, 0, 'text', '[0,0,1,1]'), (2, 2, 0, 'text', '[0,0,1,1]')")
    for line_id, element_id, corrected_by, deleted in [
            (1, 1, 'bob', 0), (2, 1, 'bob', 0), (3, 1, 'alice', 0), (4, 2, 'bob', 1)]:
        conn.execute("INSERT INTO lines (id, element_id, order_idx, polygon, corrected_text, corrected_by, deleted) "
                     "VALUES (?, ?, 0, '[]', 'x', ?, ?)", (line_id, element_id, corrected_by, deleted))
    conn.execute("INSERT INTO regions (id, page_id, order_idx, class_id, points) VALUES "
                 "(1, 3, 0, 1, '[]'), (2, 3, 1, 1, '[]')")

    rev(conn, 'element', 1, 'shared', 'bob', 'update', {}, at(400, 9))
    rev(conn, 'line', 3, 'shared', 'alice', 'origin', {'checked': False}, at(30, 9))
    rev(conn, 'line', 3, 'shared', 'alice', 'update', {'checked': True}, at(30, 10))
    rev(conn, 'line', 1, 'shared', 'bob', 'origin', {'checked': False}, at(10, 9))
    rev(conn, 'line', 1, 'shared', 'bob', 'update', {'checked': True}, at(10, 10))
    rev(conn, 'region', 1, 'grouped', 'bob', 'create', {}, at(10, 11))
    rev(conn, 'region', 2, 'grouped', 'alice', 'create', {}, at(10, 12))
    rev(conn, 'page', 1, 'shared', 'bob', 'update', {'id': 1, 'layout_checked': True}, at(10, 13))
    rev(conn, 'line', 2, 'shared', 'bob', 'origin', {'checked': False}, at(3, 9))
    rev(conn, 'line', 2, 'shared', 'bob', 'update', {'checked': True}, at(3, 10))
    rev(conn, 'line', 2, 'shared', 'bob', 'update', {'checked': True}, at(3, 11))
    rev(conn, 'line', 3, 'shared', 'bob', 'update', {'checked': True}, at(3, 12))
    rev(conn, 'page', 1, 'shared', 'bob', 'update', {'id': 1, 'lines_checked': True}, at(3, 13))
    rev(conn, 'page', 2, 'own', 'bob', 'update', {'id': 2, 'reading_order': '1x2'}, at(3, 14))
    rev(conn, 'line', 4, 'own', 'bob', 'origin', {'checked': False}, at(1, 9))
    rev(conn, 'line', 4, 'own', 'bob', 'update', {'checked': True}, at(1, 10))
    rev(conn, 'line', 4, 'own', 'bob', 'update', {'checked': False}, at(1, 11))
    rev(conn, 'line', 4, 'own', 'bob', 'update', {'checked': True}, at(1, 12))
    rev(conn, 'page', 2, 'own', 'bob', 'update', {'id': 2, 'lines_checked': True}, at(1, 13))
    rev(conn, 'page', 3, 'grouped', 'bob', 'update', {'id': 3, 'layout_checked': False}, at(1, 14))
    rev(conn, 'region', 1, 'grouped', 'bob', 'update', {}, at(1, 15))
    rev(conn, 'line', 99, 'gone', 'bob', 'update', {'checked': False}, at(1, 16))
    rev(conn, 'line', 1, 'shared', 'model:ocr@base', 'update', {'checked': True}, at(1, 17))

    for model_id in (1, 2, 3):
        conn.execute("INSERT INTO models (id, task, name, checkpoint) VALUES (?, 'ocr', ?, 'x')",
                     (model_id, f'm{model_id}'))
    for owner, status, model_id in [('bob', 'done', 2), ('bob', 'error', None), ('bob', 'running', None),
                                    ('bob', 'done', 3), ('alice', 'done', 1)]:
        conn.execute("INSERT INTO trainings (task, name, owner, status, model_id) VALUES ('ocr', 't', ?, ?, ?)",
                     (owner, status, model_id))
    for owner, model_id, status, cer in [('bob', 2, 'done', 0.08), ('bob', 3, 'done', 0.05),
                                         ('bob', 1, 'done', 0.03), ('bob', 3, 'error', None),
                                         ('alice', 2, 'done', 0.04), ('alice', 2, 'running', 0.01)]:
        conn.execute('INSERT INTO evaluations (model_id, owner, status, cer) VALUES (?, ?, ?, ?)',
                     (model_id, owner, status, cer))
    conn.commit()


@pytest.fixture
def conn(tmp_path, monkeypatch):
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    conn = store.connect(tmp_path / 'app.db')
    seed(conn)
    yield conn
    conn.close()


@pytest.fixture
def client(conn):
    app.dependency_overrides[get_db] = lambda: conn
    yield TestClient(app)
    app.dependency_overrides.clear()


def profile(client, caller, username='bob') -> dict:
    r = client.get(f'/api/people/{username}/profile', headers=caller)
    assert r.status_code == 200
    return r.json()


BOB_STATS = {
    'lines_corrected': 2, 'lines_checked': 3, 'pages_signed_off': 2, 'regions_drawn': 1,
    'datasets_owned': 1, 'datasets_shared': 2,
    'trainings': {'started': 4, 'done': 2, 'failed': 1}, 'models_trained': 2,
    'evaluations': 4, 'best_cer': 0.04, 'last_active': None,
}


class TestCounts:
    def test_every_count_follows_its_definition(self, client):
        stats = profile(client, ADMIN)['stats']
        stats.pop('groups')
        assert stats == {**BOB_STATS, 'last_active': at(1, 16)}

    def test_a_colleague_reads_the_same_numbers(self, client):
        stats = profile(client, CAROL)['stats']
        stats.pop('groups')
        assert stats == {**BOB_STATS, 'last_active': at(1, 16)}

    def test_nobody_known_reads_as_zeroes(self, client):
        stats = profile(client, BOB, 'nobody')['stats']
        assert stats == {'lines_corrected': 0, 'lines_checked': 0, 'pages_signed_off': 0, 'regions_drawn': 0,
                         'datasets_owned': 0, 'datasets_shared': 0, 'groups': [],
                         'trainings': {'started': 0, 'done': 0, 'failed': 0}, 'models_trained': 0,
                         'evaluations': 0, 'best_cer': None, 'last_active': None}


class TestActivity:
    def test_edits_per_day_over_the_last_year_leave_out_origins_and_older_days(self, client):
        assert profile(client, CAROL)['activity'] == [
            {'day': day(10), 'edits': 3}, {'day': day(3), 'edits': 5}, {'day': day(1), 'edits': 7}]

    def test_reuses_the_contributor_series(self, client):
        daily = client.get('/api/contributors/bob/activity?days=365', headers=ADMIN).json()['daily']
        assert daily == [{'day': day(10), 'revisions': 3}, {'day': day(3), 'revisions': 5},
                         {'day': day(1), 'revisions': 7}]


class TestVisibility:
    def test_the_person_sees_every_dataset_they_worked_on_newest_first(self, client):
        assert profile(client, BOB)['recent_datasets'] == [
            {'id': 'grouped', 'name': 'Baptisms 1801', 'last_edit': at(1, 15)},
            {'id': 'own', 'name': 'Bobs own', 'last_edit': at(1, 13)},
            {'id': 'shared', 'name': 'Schematismus 1780', 'last_edit': at(3, 13)},
        ]

    def test_a_colleague_sees_only_the_datasets_they_may_open(self, client):
        body = profile(client, CAROL)
        assert body['recent_datasets'] == [{'id': 'shared', 'name': 'Schematismus 1780', 'last_edit': at(3, 13)}]
        assert 'Bobs own' not in str(body) and 'Baptisms 1801' not in str(body)

    def test_groups_are_listed_only_to_those_who_reach_them(self, client):
        assert profile(client, ADMIN)['stats']['groups'] == [{'id': 1, 'name': 'Parish books'}]
        assert profile(client, BOB)['stats']['groups'] == [{'id': 1, 'name': 'Parish books'}]
        assert profile(client, CAROL)['stats']['groups'] == []

    def test_signed_out_callers_are_refused(self, client):
        assert client.get('/api/people/bob/profile', headers={'X-Frontend-Secret': SECRET}).status_code == 401


class TestCost:
    @pytest.fixture(autouse=True)
    def _people(self):
        global contributors, people
        from app.routes import contributors, people

    def test_the_year_starts_at_the_first_revision_inside_it(self, conn):
        first = conn.execute("SELECT MIN(id) FROM revisions WHERE created_at >= ?", (at(365, 0),)).fetchone()[0]
        assert contributors.first_revision_since(conn, at(365, 0)) == first
        assert contributors.first_revision_since(conn, at(-1, 0)) == conn.execute('SELECT MAX(id) + 1 FROM revisions').fetchone()[0]

    def test_a_large_log_is_read_through_the_author_index_in_bounded_statements(self, tmp_path):
        conn = store.connect(tmp_path / 'large.db')
        conn.executemany(
            "INSERT INTO revisions (target_type, target_id, job_id, author, action, snapshot, created_at) "
            "VALUES ('line', ?, 'shared', ?, 'update', '{}', datetime('now', ?))",
            [(i, f'user{i % 50}', f'-{800 - i // 250} days') for i in range(200_000)])
        seed(conn)
        statements: list[str] = []
        conn.set_trace_callback(statements.append)
        try:
            body = people.person_profile(conn, 'bob')
        finally:
            conn.set_trace_callback(None)
        assert len(statements) <= 60, statements
        assert body['activity'] == [{'day': day(10), 'edits': 3}, {'day': day(3), 'edits': 5},
                                    {'day': day(1), 'edits': 7}]

        for sql in people.WINDOWED_QUERIES:
            plan = ' '.join(row['detail'] for row in conn.execute(f'EXPLAIN QUERY PLAN {sql}',
                                                                  {'user': 'bob', 'since': 1, 'cutoff': ''}))
            assert 'USING COVERING INDEX idx_revisions_person_days (author=? AND id>?)' in plan, plan
        conn.close()

    def test_a_second_view_within_the_ttl_is_not_counted_again(self, conn):
        people.person_profile(conn, 'bob')
        statements: list[str] = []
        conn.set_trace_callback(statements.append)
        try:
            people.person_profile(conn, 'bob')
        finally:
            conn.set_trace_callback(None)
        assert len(statements) <= 1, statements
