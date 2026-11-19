"""Account roles as in Label Studio (#131, decisions 317, 318, 326): Admin, Manager,
Reviewer, Annotator and Viewer. Only what spends a shared resource stays a grant an admin
switches per person; a member account becomes a Manager."""
import sqlite3

import pytest
from fastapi.testclient import TestClient

from app import auth, config, store


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(config, 'DB_PATH', tmp_path / 'auth.db')
    from app.main import app
    conn = store.connect(config.DB_PATH)
    store.upsert_user(conn, 'sub-root', 'root', 'admin')
    store.upsert_user(conn, 'sub-alice', 'alice', 'manager')
    conn.commit()
    conn.close()
    yield TestClient(app)


def _session(username: str) -> dict:
    conn = store.connect(config.DB_PATH)
    user = conn.execute('SELECT * FROM users WHERE username = ?', (username,)).fetchone()
    token = auth.new_token()
    store.create_session(conn, user['id'], token, auth.session_expiry())
    conn.close()
    return {config.SESSION_COOKIE: token}


def _row(username: str) -> dict:
    conn = store.connect(config.DB_PATH)
    row = dict(conn.execute('SELECT role, train_local, train_cluster, permissions FROM users WHERE username = ?',
                            (username,)).fetchone())
    conn.close()
    return row


def test_the_roles_and_grants_an_admin_page_offers(client):
    response = client.get('/api/users', cookies=_session('root'))
    assert response.status_code == 200, response.text
    body = response.json()
    assert body['capabilities'] == ['models.manage', 'train.local', 'train.cluster', 'recognize']
    assert body['roles'] == {'admin': ['models.manage', 'recognize', 'train.cluster', 'train.local'],
                             'manager': ['train.local'], 'reviewer': [], 'annotator': [], 'viewer': []}


def test_a_member_account_becomes_a_manager_with_its_grants(tmp_path):
    """An auth database from before the roles were renamed: its member keeps the cluster
    grant an admin gave them, and a pending invitation for a member invites a Manager."""
    path = tmp_path / 'old.db'
    conn = store.connect(path)
    conn.execute("INSERT INTO users (subject, username, role, train_local, train_cluster) "
                 "VALUES ('sub-m', 'mia', 'member', 1, 1)")
    conn.execute("INSERT INTO invitations (email, role, invited_by) VALUES ('new@example.org', 'member', 'root')")
    conn.execute('PRAGMA user_version = 1')
    conn.commit()
    conn.close()

    conn = store.connect(path)
    mia = conn.execute("SELECT * FROM users WHERE username = 'mia'").fetchone()
    assert mia['role'] == 'manager'
    assert store.effective_caps(mia) == {'train.local', 'train.cluster'}
    assert conn.execute("SELECT role FROM invitations WHERE email = 'new@example.org'").fetchone()[0] == 'manager'
    conn.close()


def test_making_someone_an_annotator_starts_them_without_grants(client):
    response = client.patch(f'/api/users/{_user_id("alice")}', json={'role': 'annotator'}, cookies=_session('root'))
    assert response.status_code == 200, response.text
    assert response.json()['capabilities'] == []
    assert _row('alice') == {'role': 'annotator', 'train_local': 0, 'train_cluster': 0, 'permissions': '{}'}


def test_an_annotator_can_be_granted_training(client):
    client.patch(f'/api/users/{_user_id("alice")}', json={'role': 'annotator'}, cookies=_session('root'))
    response = client.patch(f'/api/users/{_user_id("alice")}', json={'permissions': {'train.cluster': True}},
                            cookies=_session('root'))
    assert response.status_code == 200, response.text
    assert response.json()['capabilities'] == ['train.cluster']


def test_the_role_reaches_the_backend(client):
    for role in ('manager', 'reviewer', 'annotator'):
        client.patch(f'/api/users/{_user_id("alice")}', json={'role': role}, cookies=_session('root'))
        response = client.get('/validate', cookies=_session('alice'))
        assert response.status_code == 200
        assert response.headers['X-Auth-Role'] == role


def test_dataset_powers_are_no_longer_grants(client):
    response = client.patch(f'/api/users/{_user_id("alice")}', json={'permissions': {'dataset.delete': True}},
                            cookies=_session('root'))
    assert response.status_code == 400
    assert response.json()['detail'] == 'no such capability: dataset.delete'


def _user_id(username: str) -> int:
    conn = sqlite3.connect(config.DB_PATH)
    user_id = conn.execute('SELECT id FROM users WHERE username = ?', (username,)).fetchone()[0]
    conn.close()
    return user_id


@pytest.mark.parametrize('role', ['annotator', 'reviewer'])
def test_a_new_account_of_a_lower_role_starts_with_that_roles_grants(tmp_path, role):
    """An account made with its role, as an invitation makes it, carries no exception the
    admin page would show as granted beyond the role."""
    conn = store.connect(tmp_path / 'auth.db')
    store.upsert_user(conn, 'sub-new', 'newcomer', role)
    newcomer = conn.execute("SELECT * FROM users WHERE username = 'newcomer'").fetchone()
    assert (store.effective_caps(newcomer), store.overrides_of(newcomer)) == (set(), {})
    conn.close()


def test_a_sign_up_approved_as_a_reviewer_starts_with_a_reviewers_grants(tmp_path):
    conn = store.connect(tmp_path / 'auth.db')
    store.upsert_user(conn, 'sub-mia', 'mia', 'viewer', pending=True)
    mia_id = conn.execute("SELECT id FROM users WHERE username = 'mia'").fetchone()[0]
    store.approve_user(conn, mia_id, 'reviewer')
    mia = conn.execute('SELECT * FROM users WHERE id = ?', (mia_id,)).fetchone()
    assert (mia['role'], store.effective_caps(mia), store.overrides_of(mia)) == ('reviewer', set(), {})
    conn.close()
