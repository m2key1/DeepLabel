"""The Users page shows more than a role: who a person is, when they were last here,
how many sessions and tokens they hold, and every change an admin made to their account.
"""
import pytest
from fastapi.testclient import TestClient

from app import auth, config, store

ADMIN_SUBJECT, MEMBER_SUBJECT = 'sub-admin', 'sub-member'


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(config, 'DB_PATH', tmp_path / 'auth.db')
    from app.main import app
    conn = store.connect(config.DB_PATH)
    store.upsert_user(conn, ADMIN_SUBJECT, 'root', 'admin')
    store.upsert_user(conn, MEMBER_SUBJECT, 'alice', 'member', email='alice@example.org',
                      display_name='Alice Adler')
    conn.close()
    yield TestClient(app)


def _session(username: str) -> dict:
    conn = store.connect(config.DB_PATH)
    user = conn.execute('SELECT * FROM users WHERE username = ?', (username,)).fetchone()
    token = auth.new_token()
    store.create_session(conn, user['id'], token, auth.session_expiry())
    conn.close()
    return {config.SESSION_COOKIE: token}


def _user(client, username: str) -> dict:
    users = client.get('/api/users', cookies=_session('root')).json()['users']
    return next(u for u in users if u['username'] == username)


def _audit(client, user_id: int) -> list[dict]:
    return client.get(f'/api/users/{user_id}/audit', cookies=_session('root')).json()['entries']


class TestAccountSummary:
    def test_carries_profile_and_usage(self, client):
        alice_cookie = _session('alice')
        conn = store.connect(config.DB_PATH)
        alice_id = conn.execute("SELECT id FROM users WHERE username = 'alice'").fetchone()['id']
        store.create_api_token(conn, alice_id, 'notebook', 'hash-1', 'dlp_abc', False, None)
        store.create_api_token(conn, alice_id, 'expired', 'hash-2', 'dlp_def', False, '2000-01-01 00:00:00')
        conn.close()

        alice = _user(client, 'alice')
        assert alice['email'] == 'alice@example.org'
        assert alice['display_name'] == 'Alice Adler'
        assert alice['sessions'] == 1
        assert alice['tokens'] == 1, 'an expired token no longer counts'
        assert alice['last_login_at'] is not None
        assert client.get('/api/me', cookies=alice_cookie).status_code == 200

    def test_using_the_account_is_what_last_seen_means(self, client):
        """A session outlives its login by weeks, so somebody here this minute can have a
        login from last month - or, for a session predating the column, none at all."""
        cookie = _session('alice')
        conn = store.connect(config.DB_PATH)
        conn.execute("UPDATE users SET last_login_at = NULL WHERE username = 'alice'")
        conn.commit()
        conn.close()
        assert _user(client, 'alice')['last_seen_at'] is None

        assert client.get('/api/me', cookies=cookie).status_code == 200
        alice = _user(client, 'alice')
        assert alice['last_seen_at'] is not None
        assert alice['last_login_at'] is None, 'using the account is not signing in again'

    def test_last_seen_is_written_at_most_once_a_minute(self, client):
        cookie = _session('alice')
        client.get('/api/me', cookies=cookie)
        first = _user(client, 'alice')['last_seen_at']
        conn = store.connect(config.DB_PATH)
        conn.execute("UPDATE users SET last_seen_at = '2020-01-01 00:00:00' WHERE username = 'alice'")
        conn.commit()
        conn.close()
        client.get('/api/me', cookies=cookie)
        assert _user(client, 'alice')['last_seen_at'] != '2020-01-01 00:00:00', 'a stale time is refreshed'

        stamped = _user(client, 'alice')['last_seen_at']
        client.get('/api/me', cookies=cookie)
        assert _user(client, 'alice')['last_seen_at'] == stamped, 'a fresh time is left alone'
        assert first is not None

    def test_never_used_reads_as_such(self, client):
        assert _user(client, 'alice')['last_seen_at'] is None

    def test_never_logged_in_reads_as_such(self, client):
        assert _user(client, 'alice')['last_login_at'] is None
        assert _user(client, 'alice')['sessions'] == 0

    def test_login_refreshes_the_profile_the_provider_reports(self, client):
        conn = store.connect(config.DB_PATH)
        store.upsert_user(conn, MEMBER_SUBJECT, 'alice', email='alice@new.example.org', display_name='')
        conn.close()
        alice = _user(client, 'alice')
        assert alice['email'] == 'alice@new.example.org'
        assert alice['display_name'] == 'Alice Adler', 'an empty claim never blanks a stored value'

    def test_members_cannot_read_accounts(self, client):
        assert client.get('/api/users', cookies=_session('alice')).status_code == 403


class TestSignOutEverywhere:
    def test_revokes_every_session_and_logs_it(self, client):
        first, second = _session('alice'), _session('alice')
        alice = _user(client, 'alice')
        assert alice['sessions'] == 2

        response = client.delete(f"/api/users/{alice['id']}/sessions", cookies=_session('root'))
        assert response.status_code == 200
        assert response.json() == {'revoked': 2}
        for cookie in (first, second):
            assert client.get('/validate', cookies=cookie).status_code == 401
        assert _user(client, 'alice')['sessions'] == 0
        entry = _audit(client, alice['id'])[0]
        assert (entry['actor'], entry['field'], entry['old_value'], entry['new_value']) == ('root', 'sessions', '2', '0')

    def test_api_tokens_survive(self, client):
        alice = _user(client, 'alice')
        conn = store.connect(config.DB_PATH)
        store.create_api_token(conn, alice['id'], 'notebook', 'hash-1', 'dlp_abc', False, None)
        conn.close()
        client.delete(f"/api/users/{alice['id']}/sessions", cookies=_session('root'))
        assert _user(client, 'alice')['tokens'] == 1

    def test_not_for_yourself(self, client):
        root = _user(client, 'root')
        response = client.delete(f"/api/users/{root['id']}/sessions", cookies=_session('root'))
        assert response.status_code == 400
        assert client.get('/api/users', cookies=_session('root')).status_code == 200


class TestAudit:
    def test_every_admin_change_is_attributed(self, client):
        alice = _user(client, 'alice')
        root = _session('root')
        client.patch(f"/api/users/{alice['id']}", json={'role': 'viewer'}, cookies=root)
        client.patch(f"/api/users/{alice['id']}", json={'slurm_account': 'proj1'}, cookies=root)
        client.patch(f"/api/users/{alice['id']}", json={'active': False}, cookies=root)

        entries = [(e['actor'], e['field'], e['old_value'], e['new_value']) for e in _audit(client, alice['id'])]
        assert entries == [
            ('root', 'active', '1', '0'),
            ('root', 'slurm_account', '', 'proj1'),
            ('root', 'role', 'member', 'viewer'),
        ]

    def test_a_no_op_patch_logs_nothing(self, client):
        alice = _user(client, 'alice')
        client.patch(f"/api/users/{alice['id']}", json={'role': 'member', 'train_cluster': False},
                     cookies=_session('root'))
        assert _audit(client, alice['id']) == []

    def test_a_rename_at_login_is_logged(self, client):
        alice = _user(client, 'alice')
        conn = store.connect(config.DB_PATH)
        store.upsert_user(conn, MEMBER_SUBJECT, 'alice.adler')
        conn.close()
        entry = _audit(client, alice['id'])[0]
        assert (entry['actor'], entry['field'], entry['old_value'], entry['new_value']) == ('login', 'username', 'alice', 'alice.adler')

    def test_patch_returns_the_full_summary(self, client):
        alice = _user(client, 'alice')
        updated = client.patch(f"/api/users/{alice['id']}", json={'role': 'viewer'}, cookies=_session('root')).json()
        assert updated['role'] == 'viewer'
        assert updated['email'] == 'alice@example.org'
        assert 'sessions' in updated and 'tokens' in updated

    def test_members_cannot_read_the_log(self, client):
        alice = _user(client, 'alice')
        assert client.get(f"/api/users/{alice['id']}/audit", cookies=_session('alice')).status_code == 403


class TestMigration:
    def test_a_pre_profile_database_gains_the_columns(self, tmp_path):
        import sqlite3
        db = tmp_path / 'old.db'
        raw = sqlite3.connect(db)
        raw.execute("CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, subject TEXT UNIQUE NOT NULL, "
                    "username TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT 'member', "
                    "active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')))")
        raw.execute("INSERT INTO users (subject, username) VALUES ('s', 'old')")
        raw.commit()
        raw.close()
        conn = store.connect(db)
        store.connect(db).close()  # a second open must not re-add the columns
        row = store.get_user(conn, 1)
        assert (row['email'], row['display_name'], row['last_login_at']) == ('', '', None)
        conn.close()
