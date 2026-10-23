"""Training is granted per person and per target: an admin can allow someone the local
GPU, the cluster, both, or neither. The grants and the SLURM account a person's jobs are
charged to ride to the backend on /validate, the same way a read-only token does.
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
    store.upsert_user(conn, MEMBER_SUBJECT, 'alice', 'member')
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


def _headers(client, username: str) -> dict:
    response = client.get('/validate', cookies=_session(username))
    assert response.status_code == 200
    return response.headers


def test_a_member_may_train_locally_but_not_on_the_cluster_by_default(client):
    headers = _headers(client, 'alice')
    assert headers['X-Auth-Train-Local'] == '1'
    assert 'X-Auth-Train-Cluster' not in headers


def test_an_admin_always_has_both(client):
    headers = _headers(client, 'root')
    assert headers['X-Auth-Train-Local'] == '1'
    assert headers['X-Auth-Train-Cluster'] == '1'


def test_the_two_targets_are_granted_independently(client):
    alice = _user_id('alice')
    # Cluster without local: the shared local GPU stays free for whoever needs it.
    client.patch(f'/api/users/{alice}', json={'train_local': False, 'train_cluster': True},
                 cookies=_session('root'))
    headers = _headers(client, 'alice')
    assert 'X-Auth-Train-Local' not in headers
    assert headers['X-Auth-Train-Cluster'] == '1'

    client.patch(f'/api/users/{alice}', json={'train_cluster': False}, cookies=_session('root'))
    headers = _headers(client, 'alice')
    assert 'X-Auth-Train-Local' not in headers
    assert 'X-Auth-Train-Cluster' not in headers


def test_a_member_cannot_grant_themselves_either_target(client):
    alice = _user_id('alice')
    assert client.patch(f'/api/users/{alice}', json={'train_cluster': True},
                        cookies=_session('alice')).status_code == 403
    assert 'X-Auth-Train-Cluster' not in _headers(client, 'alice')


def test_the_grants_are_listed_for_admins(client):
    users = client.get('/api/users', cookies=_session('root')).json()['users']
    assert {u['username']: (u['train_local'], u['train_cluster']) for u in users} == {
        'root': (1, 0), 'alice': (1, 0)}


def test_the_slurm_account_is_set_per_user_and_reaches_the_backend(client):
    alice = _user_id('alice')
    patched = client.patch(f'/api/users/{alice}', json={'slurm_account': 'p_cluster'},
                           cookies=_session('root'))
    assert patched.status_code == 200
    assert patched.json()['slurm_account'] == 'p_cluster'
    assert _headers(client, 'alice')['X-Auth-Slurm-Account'] == 'p_cluster'


def test_no_account_sends_no_header_so_the_cluster_default_applies(client):
    assert 'X-Auth-Slurm-Account' not in _headers(client, 'alice')


@pytest.mark.parametrize('bad', ['has space', 'semi;colon', 'new\nline', 'quote"s', '$(whoami)'])
def test_a_slurm_account_that_could_break_the_sbatch_script_is_refused(client, bad):
    """The value is interpolated into '#SBATCH --account=' on the cluster and into an
    HTTP header on the way there, so only account-name characters are accepted."""
    alice = _user_id('alice')
    assert client.patch(f'/api/users/{alice}', json={'slurm_account': bad},
                        cookies=_session('root')).status_code == 400
    assert 'X-Auth-Slurm-Account' not in _headers(client, 'alice')


def test_an_earlier_cluster_grant_survives_the_rename(tmp_path):
    """cluster_access became train_cluster. A database written before that keeps its
    grants, and gains the local one every member already had in practice."""
    import sqlite3

    db = tmp_path / 'legacy.db'
    legacy = sqlite3.connect(db)
    legacy.executescript("""
        CREATE TABLE users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            subject TEXT UNIQUE NOT NULL,
            username TEXT NOT NULL DEFAULT '',
            email TEXT NOT NULL DEFAULT '',
            display_name TEXT NOT NULL DEFAULT '',
            role TEXT NOT NULL DEFAULT 'member',
            active INTEGER NOT NULL DEFAULT 1,
            cluster_access INTEGER NOT NULL DEFAULT 0,
            settings TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            last_login_at TEXT
        );
        INSERT INTO users (subject, username, cluster_access) VALUES ('sub-a', 'granted', 1);
        INSERT INTO users (subject, username, cluster_access) VALUES ('sub-b', 'plain', 0);
    """)
    legacy.commit()
    legacy.close()

    conn = store.connect(db)
    rows = {r['username']: r for r in conn.execute('SELECT * FROM users')}
    conn.close()
    assert (rows['granted']['train_cluster'], rows['plain']['train_cluster']) == (1, 0)
    assert (rows['granted']['train_local'], rows['plain']['train_local']) == (1, 1)
    assert rows['granted']['slurm_account'] == ''
    assert rows['granted']['last_seen_at'] is None, 'the column is added, empty until next used'
