"""Admins invite people from the Admin page: the auth service asks Authentik for an account
and a recovery link, and the admin sends the link on themselves."""
import functools
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from app import auth, authentik, config, store

ISSUER = 'https://idp.example.org:10000/application/o/deeplabel/'
TOKEN = 'ak-service-token'


class FakeAuthentik:
    def __init__(self, users=()):
        self.users = {u['pk']: u for u in users}
        self.requests: list[tuple[str, str, dict | None]] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        assert request.url.host == 'idp.example.org' and request.url.port == 10000
        assert request.headers['Authorization'] == f'Bearer {TOKEN}'
        body = json.loads(request.content) if request.content else None
        self.requests.append((request.method, request.url.path, body))
        if request.method == 'GET' and request.url.path == '/api/v3/core/users/':
            email = request.url.params['email']
            return httpx.Response(200, json={'results': [u for u in self.users.values() if u['email'] == email]})
        if request.method == 'POST' and request.url.path == '/api/v3/core/users/':
            pk = max(self.users, default=10) + 1
            self.users[pk] = {**body, 'pk': pk, 'is_active': True, 'is_superuser': False}
            return httpx.Response(201, json=self.users[pk])
        pk = int(request.url.path.split('/')[-3])
        return httpx.Response(200, json={'link': f'https://idp.example.org:10000/if/flow/recovery/?flow_token=t{pk}'})


def _authentik_user(pk, email, **overrides):
    return {'pk': pk, 'username': email, 'email': email, 'name': '', 'type': 'external',
            'is_active': True, 'is_superuser': False, **overrides}


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(config, 'DB_PATH', tmp_path / 'auth.db')
    monkeypatch.setattr(config, 'OIDC_ISSUER', ISSUER)
    monkeypatch.setattr(config, 'AUTHENTIK_API_TOKEN', TOKEN)
    from app.main import app
    conn = store.connect(config.DB_PATH)
    store.upsert_user(conn, 'sub-admin', 'root', 'admin')
    store.upsert_user(conn, 'sub-alice', 'alice', 'member', email='alice@example.org')
    conn.close()
    # The app's own client is a subclass taken at import, so only Authentik's calls land here.
    yield TestClient(app, raise_server_exceptions=False)


@pytest.fixture
def fake(monkeypatch):
    def install(*users):
        backend = FakeAuthentik(users)
        monkeypatch.setattr(authentik.httpx, 'Client',
                            functools.partial(httpx.Client, transport=httpx.MockTransport(backend)))
        return backend
    return install


def _session(username: str) -> dict:
    conn = store.connect(config.DB_PATH)
    user = conn.execute('SELECT * FROM users WHERE username = ?', (username,)).fetchone()
    token = auth.new_token()
    store.create_session(conn, user['id'], token, auth.session_expiry())
    conn.close()
    return {config.SESSION_COOKIE: token}


def _invite(client, email, name='', as_user='root'):
    return client.post('/api/users/invitations', json={'email': email, 'name': name},
                       cookies=_session(as_user))


def test_an_unknown_email_gets_a_new_external_account_and_a_link(client, fake):
    backend = fake()
    resp = _invite(client, ' julia@example.org ', 'Julia D')
    assert resp.status_code == 200
    assert resp.json() == {'link': 'https://idp.example.org:10000/if/flow/recovery/?flow_token=t11',
                           'created': True, 'valid_days': 7}
    assert backend.requests == [
        ('GET', '/api/v3/core/users/', None),
        ('POST', '/api/v3/core/users/', {'username': 'julia@example.org', 'email': 'julia@example.org',
                                         'name': 'Julia D', 'type': 'external', 'path': 'users'}),
        ('POST', '/api/v3/core/users/11/recovery/', {'token_duration': 'days=7'}),
    ]


def test_a_known_email_gets_a_fresh_link_and_the_reset_is_in_their_audit(client, fake):
    backend = fake(_authentik_user(5, 'alice@example.org'))
    resp = _invite(client, 'alice@example.org')
    assert resp.json() == {'link': 'https://idp.example.org:10000/if/flow/recovery/?flow_token=t5',
                           'created': False, 'valid_days': 7}
    assert [r[:2] for r in backend.requests] == [('GET', '/api/v3/core/users/'),
                                                 ('POST', '/api/v3/core/users/5/recovery/')]
    conn = store.connect(config.DB_PATH)
    alice_id = store.get_user_by_email(conn, 'alice@example.org')['id']
    conn.close()
    audit = client.get(f'/api/users/{alice_id}/audit', cookies=_session('root')).json()['entries']
    assert [(e['actor'], e['field'], e['old_value'], e['new_value']) for e in audit] == [
        ('root', 'password_link', '', 'issued')]


@pytest.mark.parametrize('account, reason', [
    (_authentik_user(1, 'ops@example.org', type='internal'), 'managed in Authentik itself'),
    (_authentik_user(1, 'ops@example.org', is_superuser=True), 'managed in Authentik itself'),
    (_authentik_user(1, 'ops@example.org', is_active=False), 'deactivated in Authentik'),
])
def test_no_link_for_an_account_deeplabel_does_not_own(client, fake, account, reason):
    backend = fake(account)
    resp = _invite(client, 'ops@example.org')
    assert resp.status_code == 409
    assert reason in resp.json()['detail']
    assert [r[:2] for r in backend.requests] == [('GET', '/api/v3/core/users/')]


def test_members_cannot_invite(client, fake):
    backend = fake()
    assert _invite(client, 'julia@example.org', as_user='alice').status_code == 403
    assert backend.requests == []


def test_a_malformed_email_never_reaches_authentik(client, fake):
    backend = fake()
    resp = _invite(client, 'julia at example')
    assert (resp.status_code, resp.json()['detail']) == (400, 'not an email address')
    assert backend.requests == []


def test_an_authentik_error_is_reported_as_a_bad_gateway(client, monkeypatch):
    def down(request):
        raise httpx.ConnectError('connection refused')
    monkeypatch.setattr(authentik.httpx, 'Client',
                        functools.partial(httpx.Client, transport=httpx.MockTransport(down)))
    resp = _invite(client, 'julia@example.org')
    assert resp.status_code == 502
    assert resp.json()['detail'] == 'Authentik could not be reached: connection refused'


def test_without_a_token_inviting_is_off_and_the_page_is_told(client, fake, monkeypatch):
    backend = fake()
    assert client.get('/api/users', cookies=_session('root')).json()['invitations'] is True
    monkeypatch.setattr(config, 'AUTHENTIK_API_TOKEN', '')
    assert client.get('/api/users', cookies=_session('root')).json()['invitations'] is False
    assert _invite(client, 'julia@example.org').status_code == 503
    assert backend.requests == []
