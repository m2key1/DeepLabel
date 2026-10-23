import pytest
from fastapi.testclient import TestClient

from app import auth, config, store


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(config, 'DB_PATH', tmp_path / 'auth.db')
    monkeypatch.setattr(config, 'AVATAR_DIR', tmp_path / 'avatars')
    from app.main import app
    conn = store.connect(config.DB_PATH)
    store.upsert_user(conn, 'sub-root', 'root', 'admin')
    store.upsert_user(conn, 'sub-bob', 'bob', 'member', email='bob@example.org', display_name='Bob Berger')
    store.upsert_user(conn, 'sub-carol', 'carol', 'viewer', email='carol@example.org')
    conn.execute("UPDATE users SET created_at = '2026-03-04 05:06:07', avatar = 'abc123' WHERE username = 'bob'")
    conn.commit()
    conn.close()
    yield TestClient(app)


def _session(username: str) -> dict:
    conn = store.connect(config.DB_PATH)
    user = conn.execute('SELECT id FROM users WHERE username = ?', (username,)).fetchone()
    token = auth.new_token()
    store.create_session(conn, user['id'], token, auth.session_expiry())
    conn.close()
    return {config.SESSION_COOKIE: token}


BOB_PUBLIC = {'username': 'bob', 'display_name': 'Bob Berger', 'avatar': '/api/users/bob/avatar?v=abc123',
              'role': 'member', 'created_at': '2026-03-04 05:06:07'}


def test_a_colleague_sees_the_person_but_not_their_email(client):
    r = client.get('/api/people/bob', cookies=_session('carol'))

    assert r.status_code == 200
    assert r.json() == BOB_PUBLIC


def test_the_person_sees_their_own_email(client):
    assert client.get('/api/people/bob', cookies=_session('bob')).json() == {**BOB_PUBLIC, 'email': 'bob@example.org'}


def test_an_admin_sees_the_email(client):
    assert client.get('/api/people/bob', cookies=_session('root')).json() == {**BOB_PUBLIC, 'email': 'bob@example.org'}


def test_no_picture_reads_as_an_empty_address(client):
    body = client.get('/api/people/carol', cookies=_session('bob')).json()

    assert body['avatar'] == ''
    assert body['role'] == 'viewer'
    assert 'email' not in body


def test_an_unknown_name_is_not_found(client):
    assert client.get('/api/people/nobody', cookies=_session('bob')).status_code == 404


def test_nobody_signed_out_may_ask(client):
    assert client.get('/api/people/bob').status_code == 401
