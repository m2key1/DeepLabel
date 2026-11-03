"""Log out ends the Authentik session too. Dropping only DeepLabel's own session left the
provider's alive, and the next request signed the user straight back in without a prompt."""
import sqlite3
from urllib.parse import parse_qs, urlsplit

import pytest
from fastapi.testclient import TestClient

from app import auth, config, store

HOST = 'https://deeplabel.example.ts.net'
END_SESSION = 'https://idp.example.org/application/o/deeplabel/end-session/'


class FakeOAuth:
    def __init__(self, metadata):
        self.metadata = metadata

    async def authorize_access_token(self, request):
        return {'id_token': 'the-id-token', 'userinfo': {'sub': 'u-1', 'preferred_username': 'anna'}}

    async def load_server_metadata(self):
        return self.metadata


@pytest.fixture
def signed_in(tmp_path, monkeypatch):
    def sign_in(metadata):
        monkeypatch.setattr(config, 'DB_PATH', tmp_path / 'auth.db')
        monkeypatch.setattr(config, 'DEV_AUTH', False)
        monkeypatch.setattr(config, 'OIDC_REDIRECT_URI', f'{HOST}/api/auth/callback')
        monkeypatch.setattr(auth, 'oauth', lambda: FakeOAuth(metadata))
        from app.main import app
        client = TestClient(app, base_url=HOST, follow_redirects=False)
        assert client.get('/api/auth/callback').status_code == 303
        assert client.get('/api/me').status_code == 200
        return client
    return sign_in


def test_logout_sends_the_browser_to_the_providers_end_session_and_back_to_sign_in(signed_in):
    client = signed_in({'end_session_endpoint': END_SESSION})

    response = client.post('/api/logout')

    redirect = urlsplit(response.json()['redirect'])
    assert f'{redirect.scheme}://{redirect.netloc}{redirect.path}' == END_SESSION
    assert parse_qs(redirect.query) == {'id_token_hint': ['the-id-token'],
                                        'post_logout_redirect_uri': [f'{HOST}/api/login']}
    assert client.get('/api/me').status_code == 401


def test_a_provider_without_an_end_session_address_falls_back_to_sign_in(signed_in):
    client = signed_in({})

    assert client.post('/api/logout').json()['redirect'] == '/api/login'
    assert client.get('/api/me').status_code == 401


def test_dev_auth_keeps_the_local_logout(tmp_path, monkeypatch):
    monkeypatch.setattr(config, 'DB_PATH', tmp_path / 'auth.db')
    monkeypatch.setattr(config, 'DEV_AUTH', True)
    from app.main import app
    client = TestClient(app, follow_redirects=False)
    client.get('/api/login')

    assert client.post('/api/logout').json()['redirect'] == '/api/login'
    assert client.get('/api/me').status_code == 401


def test_sessions_from_before_keep_working_and_gain_the_id_token_column(tmp_path):
    db = tmp_path / 'auth.db'
    old = sqlite3.connect(db)
    old.executescript("""
        CREATE TABLE sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL,
                               created_at TEXT NOT NULL DEFAULT (datetime('now')), expires_at TEXT NOT NULL);
        INSERT INTO sessions (token, user_id, expires_at) VALUES ('old', 1, '2999-01-01');
    """)
    old.close()

    conn = store.connect(db)

    assert [tuple(r) for r in conn.execute('SELECT token, id_token FROM sessions')] == [('old', None)]
    store.connect(db).close()
