"""What a person may do is their role's defaults, with per-person exceptions on top.
The effective set rides to the backend on /validate, next to the role, so the backend
never has to know which role implies what.
"""
import pytest
from fastapi.testclient import TestClient

from app import auth, config, store

ADMIN_SUBJECT, MEMBER_SUBJECT, VIEWER_SUBJECT = 'sub-admin', 'sub-member', 'sub-viewer'


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(config, 'DB_PATH', tmp_path / 'auth.db')
    from app.main import app
    conn = store.connect(config.DB_PATH)
    store.upsert_user(conn, ADMIN_SUBJECT, 'root', 'admin')
    store.upsert_user(conn, MEMBER_SUBJECT, 'alice', 'member')
    store.upsert_user(conn, VIEWER_SUBJECT, 'vera', 'viewer')
    conn.close()
    yield TestClient(app)


def _session(username: str) -> dict:
    conn = store.connect(config.DB_PATH)
    user = conn.execute('SELECT * FROM users WHERE username = ?', (username,)).fetchone()
    token = auth.new_token()
    store.create_session(conn, user['id'], token, auth.session_expiry())
    conn.close()
    return {config.SESSION_COOKIE: token}


def _user_id(username: str) -> int:
    conn = store.connect(config.DB_PATH)
    user_id = conn.execute('SELECT id FROM users WHERE username = ?', (username,)).fetchone()['id']
    conn.close()
    return user_id


def _caps(client, username: str) -> set:
    response = client.get('/validate', cookies=_session(username))
    assert response.status_code == 200
    return set(response.headers.get('X-Auth-Caps', '').split())


class TestRoleDefaults:
    def test_an_admin_may_do_everything_there_is(self, client):
        assert _caps(client, 'root') == set(store.CAPABILITIES)

    def test_a_member_runs_the_pipeline_but_discards_nothing(self, client):
        assert _caps(client, 'alice') == {
            'pipeline.layout', 'pipeline.lines', 'pipeline.ocr', 'train.local'}

    def test_a_viewer_may_do_none_of_it(self, client):
        assert _caps(client, 'vera') == set()


class TestOverrides:
    def test_one_capability_is_taken_from_a_member_and_the_rest_stand(self, client):
        client.patch(f'/api/users/{_user_id("alice")}',
                     json={'permissions': {'pipeline.lines': False}}, cookies=_session('root'))

        assert _caps(client, 'alice') == {'pipeline.layout', 'pipeline.ocr', 'train.local'}

    def test_one_is_granted_beyond_the_role_and_nothing_else_follows(self, client):
        client.patch(f'/api/users/{_user_id("alice")}',
                     json={'permissions': {'dataset.delete': True}}, cookies=_session('root'))

        assert _caps(client, 'alice') == {
            'pipeline.layout', 'pipeline.lines', 'pipeline.ocr', 'train.local', 'dataset.delete'}

    def test_only_what_differs_from_the_role_is_stored(self, client):
        """So a role's defaults can change later and everyone who never overrode one
        follows, which is the whole point of having roles under the exceptions."""
        user_id = _user_id('alice')
        client.patch(f'/api/users/{user_id}',
                     json={'permissions': {'pipeline.lines': False, 'pipeline.ocr': True}},
                     cookies=_session('root'))

        body = client.get('/api/users', cookies=_session('root')).json()
        alice = next(u for u in body['users'] if u['username'] == 'alice')
        assert alice['permissions'] == {'pipeline.lines': False}
        assert sorted(alice['capabilities']) == ['pipeline.layout', 'pipeline.ocr', 'train.local']

    def test_an_override_is_lifted_by_setting_it_back_to_the_role(self, client):
        user_id = _user_id('alice')
        client.patch(f'/api/users/{user_id}', json={'permissions': {'pipeline.lines': False}},
                     cookies=_session('root'))
        client.patch(f'/api/users/{user_id}', json={'permissions': {'pipeline.lines': True}},
                     cookies=_session('root'))

        assert _caps(client, 'alice') == {
            'pipeline.layout', 'pipeline.lines', 'pipeline.ocr', 'train.local'}

    def test_a_capability_nobody_offers_is_refused(self, client):
        response = client.patch(f'/api/users/{_user_id("alice")}',
                                json={'permissions': {'pipeline.everything': True}},
                                cookies=_session('root'))

        assert response.status_code == 400
        assert 'pipeline.everything' in response.json()['detail']

    def test_a_member_cannot_grant_themselves_anything(self, client):
        response = client.patch(f'/api/users/{_user_id("alice")}',
                                json={'permissions': {'dataset.delete': True}},
                                cookies=_session('alice'))

        assert response.status_code == 403
        assert _caps(client, 'alice') == {
            'pipeline.layout', 'pipeline.lines', 'pipeline.ocr', 'train.local'}

    def test_the_change_is_written_to_the_account_s_history(self, client):
        user_id = _user_id('alice')
        client.patch(f'/api/users/{user_id}', json={'permissions': {'pipeline.lines': False}},
                     cookies=_session('root'))

        audit = client.get(f'/api/users/{user_id}/audit', cookies=_session('root')).json()
        entry = next(e for e in audit['entries'] if e['field'] == 'pipeline.lines')
        assert (entry['old_value'], entry['new_value'], entry['actor']) == ('1', '0', 'root')


class TestViewersTakeNoExceptions:
    """The backend refuses a viewer every write before it looks at a capability, so a
    grant on a viewer would be a promise nothing keeps. Promote the account first."""

    def test_a_grant_to_a_viewer_is_refused_with_the_way_forward(self, client):
        response = client.patch(f'/api/users/{_user_id("vera")}',
                                json={'permissions': {'pipeline.ocr': True}}, cookies=_session('root'))

        assert response.status_code == 409
        assert response.json()['detail'] == (
            'vera is a viewer, and a viewer may not write at all - promote the account to '
            'member before granting it anything')
        assert _caps(client, 'vera') == set()
        assert _listed(client, 'vera')['permissions'] == {}
        audit = client.get(f'/api/users/{_user_id("vera")}/audit', cookies=_session('root')).json()
        assert audit['entries'] == []

    def test_a_training_grant_to_a_viewer_is_refused_too(self, client):
        response = client.patch(f'/api/users/{_user_id("vera")}', json={'train_cluster': True},
                                cookies=_session('root'))

        assert response.status_code == 409
        assert _caps(client, 'vera') == set()

    def test_demoting_and_granting_in_one_request_is_refused(self, client):
        response = client.patch(f'/api/users/{_user_id("alice")}',
                                json={'role': 'viewer', 'permissions': {'dataset.delete': True}},
                                cookies=_session('root'))

        assert response.status_code == 409
        assert _listed(client, 'alice')['role'] == 'member'

    def test_a_grant_stored_on_a_viewer_before_this_counts_for_nothing(self, client):
        conn = store.connect(config.DB_PATH)
        conn.execute("""UPDATE users SET permissions = '{"pipeline.ocr": true}' WHERE username = 'vera'""")
        conn.commit()
        conn.close()

        assert _caps(client, 'vera') == set()
        assert _listed(client, 'vera')['permissions'] == {}


class TestARoleChangeStartsFromTheRole:
    """Exceptions were granted against the role a person had; a new role is a new start."""

    def _make_exceptions(self, client):
        user_id = _user_id('alice')
        client.patch(f'/api/users/{user_id}',
                     json={'permissions': {'dataset.delete': True, 'pipeline.lines': False,
                                           'train.local': False, 'train.cluster': True}},
                     cookies=_session('root'))
        assert _listed(client, 'alice')['permissions'] == {
            'dataset.delete': True, 'pipeline.lines': False, 'train.local': False, 'train.cluster': True}
        return user_id

    def test_a_round_trip_through_another_role_comes_back_to_the_defaults(self, client):
        user_id = self._make_exceptions(client)

        client.patch(f'/api/users/{user_id}', json={'role': 'admin'}, cookies=_session('root'))
        client.patch(f'/api/users/{user_id}', json={'role': 'member'}, cookies=_session('root'))

        alice = _listed(client, 'alice')
        assert alice['permissions'] == {}
        assert (alice['train_local'], alice['train_cluster']) == (1, 0)
        assert _caps(client, 'alice') == {
            'pipeline.layout', 'pipeline.lines', 'pipeline.ocr', 'train.local'}

    def test_demoting_to_viewer_leaves_nothing_behind(self, client):
        user_id = self._make_exceptions(client)

        client.patch(f'/api/users/{user_id}', json={'role': 'viewer'}, cookies=_session('root'))

        conn = store.connect(config.DB_PATH)
        row = conn.execute('SELECT permissions, train_local, train_cluster FROM users WHERE id = ?',
                           (user_id,)).fetchone()
        conn.close()
        assert (row['permissions'], row['train_local'], row['train_cluster']) == ('{}', 1, 0)
        assert _caps(client, 'alice') == set()

    def test_the_history_says_which_exceptions_the_role_change_cleared(self, client):
        user_id = self._make_exceptions(client)

        client.patch(f'/api/users/{user_id}', json={'role': 'viewer'}, cookies=_session('root'))

        audit = client.get(f'/api/users/{user_id}/audit', cookies=_session('root')).json()['entries']
        assert [(e['field'], e['old_value'], e['new_value']) for e in audit[:2]] == [
            ('exceptions',
             '{"dataset.delete": true, "pipeline.lines": false, "train.cluster": true, "train.local": false}',
             '{}'),
            ('role', 'member', 'viewer'),
        ]

    def test_a_role_change_without_exceptions_logs_only_the_role(self, client):
        user_id = _user_id('alice')

        client.patch(f'/api/users/{user_id}', json={'role': 'admin'}, cookies=_session('root'))

        audit = client.get(f'/api/users/{user_id}/audit', cookies=_session('root')).json()['entries']
        assert [(e['field'], e['old_value'], e['new_value']) for e in audit] == [('role', 'member', 'admin')]

    def _store_dormant_grants(self, username, permissions, train_local, train_cluster):
        conn = store.connect(config.DB_PATH)
        conn.execute('UPDATE users SET permissions = ?, train_local = ?, train_cluster = ? '
                     'WHERE username = ?', (permissions, train_local, train_cluster, username))
        conn.commit()
        conn.close()
        return _user_id(username)

    def test_promoting_a_viewer_drops_the_grants_stored_on_the_account_and_names_them(self, client):
        """A viewer's stored grants were never in force and were made against a role that
        writes nothing, so the member it becomes starts from the member defaults."""
        user_id = self._store_dormant_grants(
            'vera', '{"dataset.delete": true, "pipeline.lines": false}', 0, 1)

        client.patch(f'/api/users/{user_id}', json={'role': 'member'}, cookies=_session('root'))

        vera = _listed(client, 'vera')
        assert vera['permissions'] == {}
        assert (vera['train_local'], vera['train_cluster']) == (1, 0)
        assert _caps(client, 'vera') == {
            'pipeline.layout', 'pipeline.lines', 'pipeline.ocr', 'train.local'}
        audit = client.get(f'/api/users/{user_id}/audit', cookies=_session('root')).json()['entries']
        assert [(e['field'], e['old_value'], e['new_value']) for e in audit] == [
            ('dormant_grants', '{"dataset.delete": true, "train.cluster": true, "train.local": false}', '{}'),
            ('role', 'viewer', 'member'),
        ]

    def test_demoting_an_admin_drops_the_training_grants_the_admin_role_ignored(self, client):
        client.patch(f'/api/users/{_user_id("alice")}', json={'role': 'admin'}, cookies=_session('root'))
        user_id = self._store_dormant_grants('alice', '{}', 1, 1)

        client.patch(f'/api/users/{user_id}', json={'role': 'member'}, cookies=_session('root'))

        alice = _listed(client, 'alice')
        assert (alice['train_local'], alice['train_cluster']) == (1, 0)
        assert _caps(client, 'alice') == {
            'pipeline.layout', 'pipeline.lines', 'pipeline.ocr', 'train.local'}
        audit = client.get(f'/api/users/{user_id}/audit', cookies=_session('root')).json()['entries']
        assert [(e['field'], e['old_value'], e['new_value']) for e in audit[:2]] == [
            ('dormant_grants', '{"train.cluster": true}', '{}'),
            ('role', 'admin', 'member'),
        ]

    def test_exceptions_sent_with_the_role_change_are_made_against_the_new_role(self, client):
        user_id = self._make_exceptions(client)

        client.patch(f'/api/users/{user_id}',
                     json={'role': 'admin', 'permissions': {'models.manage': False}},
                     cookies=_session('root'))

        assert _listed(client, 'alice')['permissions'] == {'models.manage': False}
        assert _caps(client, 'alice') == set(store.CAPABILITIES) - {'models.manage'}


class TestTheGrantsThatCameBefore:
    def test_the_training_grants_are_capabilities_now_and_still_their_own_headers(self, client):
        """A deployment whose nginx has not learned the new header yet keeps its grants."""
        client.patch(f'/api/users/{_user_id("alice")}', json={'train_cluster': True},
                     cookies=_session('root'))

        headers = client.get('/validate', cookies=_session('alice')).headers
        assert headers['X-Auth-Train-Cluster'] == '1'
        assert 'train.cluster' in set(headers['X-Auth-Caps'].split())

    def test_taking_the_local_grant_away_takes_the_capability_with_it(self, client):
        client.patch(f'/api/users/{_user_id("alice")}', json={'train_local': False},
                     cookies=_session('root'))

        headers = client.get('/validate', cookies=_session('alice')).headers
        assert 'X-Auth-Train-Local' not in headers
        assert 'train.local' not in set(headers['X-Auth-Caps'].split())

    def test_taking_local_training_away_in_the_matrix_takes_it_everywhere(self, client):
        """The matrix and the Training column are one grant: the set, the old header and
        the column the admin page reads all say the same."""
        client.patch(f'/api/users/{_user_id("alice")}',
                     json={'permissions': {'train.local': False}}, cookies=_session('root'))

        headers = client.get('/validate', cookies=_session('alice')).headers
        assert 'X-Auth-Train-Local' not in headers
        assert set(headers['X-Auth-Caps'].split()) == {'pipeline.layout', 'pipeline.lines', 'pipeline.ocr'}
        alice = _listed(client, 'alice')
        assert (alice['train_local'], alice['permissions']) == (0, {'train.local': False})

    def test_the_matrix_gives_back_what_the_training_column_took(self, client):
        user_id = _user_id('alice')
        client.patch(f'/api/users/{user_id}', json={'train_local': False}, cookies=_session('root'))
        client.patch(f'/api/users/{user_id}', json={'permissions': {'train.local': True}},
                     cookies=_session('root'))

        assert _caps(client, 'alice') == {
            'pipeline.layout', 'pipeline.lines', 'pipeline.ocr', 'train.local'}
        alice = _listed(client, 'alice')
        assert (alice['train_local'], alice['permissions']) == (1, {})

    def test_a_training_tick_in_the_matrix_is_one_entry_in_the_history(self, client):
        user_id = _user_id('alice')
        client.patch(f'/api/users/{user_id}', json={'permissions': {'train.cluster': True}},
                     cookies=_session('root'))

        audit = client.get(f'/api/users/{user_id}/audit', cookies=_session('root')).json()
        assert [(e['field'], e['old_value'], e['new_value']) for e in audit['entries']] == [
            ('train_cluster', '0', '1')]
        assert _listed(client, 'alice')['permissions'] == {'train.cluster': True}

    def test_a_training_exception_the_matrix_stored_beside_the_column_moves_into_it(self, client):
        """Before the column held it, the matrix wrote the exception where only the set
        read it while the backend trusted the column. What the admin chose there stands."""
        conn = store.connect(config.DB_PATH)
        conn.execute("""UPDATE users SET permissions = '{"pipeline.lines": false, "train.local": false}'
                        WHERE username = 'alice'""")
        conn.execute('PRAGMA user_version = 0')
        conn.commit()
        conn.close()

        conn = store.connect(config.DB_PATH)
        row = conn.execute("SELECT train_local, permissions FROM users WHERE username = 'alice'").fetchone()
        conn.close()
        assert (row['train_local'], row['permissions']) == (0, '{"pipeline.lines": false}')
        assert _caps(client, 'alice') == {'pipeline.layout', 'pipeline.ocr'}

    def test_a_stored_cluster_refusal_matching_the_role_leaves_the_column_grant_alone(self, client):
        """Stored while an admin, kept through a demotion to member: equal to the member
        default, it never counted, and the column granting the cluster did."""
        conn = store.connect(config.DB_PATH)
        conn.execute("""UPDATE users SET permissions = '{"train.cluster": false}', train_cluster = 1
                        WHERE username = 'alice'""")
        conn.execute('PRAGMA user_version = 0')
        conn.commit()
        conn.close()

        conn = store.connect(config.DB_PATH)
        row = conn.execute("SELECT train_cluster, permissions FROM users WHERE username = 'alice'").fetchone()
        conn.close()
        assert (row['train_cluster'], row['permissions']) == (1, '{}')
        assert _caps(client, 'alice') == {
            'pipeline.layout', 'pipeline.lines', 'pipeline.ocr', 'train.local', 'train.cluster'}

    def test_a_stored_local_grant_matching_the_role_leaves_the_column_refusal_alone(self, client):
        """The mirror case, from a viewer promoted to member: the column refusing local
        training counted, the stored grant equal to the member default did not."""
        conn = store.connect(config.DB_PATH)
        conn.execute("""UPDATE users SET permissions = '{"train.local": true}', train_local = 0
                        WHERE username = 'alice'""")
        conn.execute('PRAGMA user_version = 0')
        conn.commit()
        conn.close()

        conn = store.connect(config.DB_PATH)
        row = conn.execute("SELECT train_local, permissions FROM users WHERE username = 'alice'").fetchone()
        conn.close()
        assert (row['train_local'], row['permissions']) == (0, '{}')
        assert _caps(client, 'alice') == {'pipeline.layout', 'pipeline.lines', 'pipeline.ocr'}


def test_the_move_runs_once_rather_than_on_every_connect(tmp_path, monkeypatch):
    """Every /validate opens a connection, so a migration in connect() is a scan of the
    users on every request the app makes."""
    runs = []
    move = store._move_training_overrides_to_columns
    monkeypatch.setattr(store, '_move_training_overrides_to_columns',
                        lambda conn: (runs.append(1), move(conn)))

    for _ in range(3):
        store.connect(tmp_path / 'auth.db').close()

    assert len(runs) == 1


def _listed(client, username: str) -> dict:
    users = client.get('/api/users', cookies=_session('root')).json()['users']
    return next(u for u in users if u['username'] == username)
