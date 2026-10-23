"""API tokens are how a script authenticates: it has no session cookie, and the only
alternative was forging the identity headers the frontend sets, which needs a secret
that grants any username and any role.
"""
import pytest
from fastapi.testclient import TestClient

from app import auth, config, store


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(config, 'DB_PATH', tmp_path / 'auth.db')
    from app.main import app
    conn = store.connect(config.DB_PATH)
    store.upsert_user(conn, 'sub-admin', 'root', 'admin')
    store.upsert_user(conn, 'sub-member', 'alice', 'member')
    conn.close()
    yield TestClient(app)


def _session(username: str) -> dict:
    conn = store.connect(config.DB_PATH)
    user = conn.execute('SELECT * FROM users WHERE username = ?', (username,)).fetchone()
    token = auth.new_token()
    store.create_session(conn, user['id'], token, auth.session_expiry())
    conn.close()
    return {config.SESSION_COOKIE: token}


def _mint(client, username, **body) -> str:
    response = client.post('/api/tokens', json={'name': 'script', **body},
                           cookies=_session(username))
    assert response.status_code == 200, response.text
    return response.json()['token']


def test_a_token_authenticates_like_a_session(client):
    token = _mint(client, 'alice')
    response = client.get('/validate', headers={'Authorization': f'Bearer {token}'})
    assert response.status_code == 200
    assert response.headers['X-Auth-User'] == 'alice'
    assert response.headers['X-Auth-Role'] == 'member'
    assert 'X-Auth-Readonly' not in response.headers


def test_a_readonly_token_is_flagged_for_the_backend(client):
    token = _mint(client, 'alice', readonly=True)
    response = client.get('/validate', headers={'Authorization': f'Bearer {token}'})
    assert response.status_code == 200
    assert response.headers['X-Auth-Readonly'] == '1'
    # The role is untouched, so a read-only token still reads everything its owner can.
    assert response.headers['X-Auth-Role'] == 'member'


def test_the_response_carries_no_stored_secret(client):
    created = client.post('/api/tokens', json={'name': 'script'}, cookies=_session('alice')).json()
    assert created['token'].startswith('dlp_')
    assert 'token_hash' not in created


def test_the_raw_token_is_never_stored_or_listed(client):
    token = _mint(client, 'alice')
    conn = store.connect(config.DB_PATH)
    rows = conn.execute('SELECT * FROM api_tokens').fetchall()
    conn.close()
    assert len(rows) == 1
    assert token not in dict(rows[0]).values()
    assert rows[0]['token_hash'] == auth.hash_api_token(token)
    listed = client.get('/api/tokens', cookies=_session('alice')).json()['tokens']
    assert 'token' not in listed[0] and 'token_hash' not in listed[0]
    assert listed[0]['prefix'] == token[:12]


def test_unknown_expired_and_revoked_tokens_are_refused(client):
    assert client.get('/validate', headers={'Authorization': 'Bearer dlp_nope'}).status_code == 401
    assert client.get('/validate', headers={'Authorization': 'Basic x'}).status_code == 401

    stale = _mint(client, 'alice')
    conn = store.connect(config.DB_PATH)
    conn.execute("UPDATE api_tokens SET expires_at = datetime('now', '-1 day')")
    conn.commit()
    conn.close()
    assert client.get('/validate', headers={'Authorization': f'Bearer {stale}'}).status_code == 401

    live = _mint(client, 'alice')
    listed = client.get('/api/tokens', cookies=_session('alice')).json()['tokens']
    token_id = next(t['id'] for t in listed if t['prefix'] == live[:12])
    assert client.delete(f'/api/tokens/{token_id}', cookies=_session('alice')).status_code == 200
    assert client.get('/validate', headers={'Authorization': f'Bearer {live}'}).status_code == 401


def test_an_expired_token_is_listed_as_expired_and_counted_apart(client):
    """It still shows in its owner's list, so the count beside the account has to say
    where it went rather than leave the two disagreeing."""
    _mint(client, 'alice', name='stale')
    _mint(client, 'alice', name='live')
    conn = store.connect(config.DB_PATH)
    conn.execute("UPDATE api_tokens SET expires_at = datetime('now', '-1 day') WHERE name = 'stale'")
    conn.commit()
    conn.close()

    own = client.get('/api/tokens', cookies=_session('alice')).json()['tokens']
    every = client.get('/api/admin/tokens', cookies=_session('root')).json()['tokens']
    assert {t['name']: t['expired'] for t in own} == {'stale': True, 'live': False}
    assert {t['name']: t['expired'] for t in every} == {'stale': True, 'live': False}
    users = client.get('/api/users', cookies=_session('root')).json()['users']
    alice = next(u for u in users if u['username'] == 'alice')
    assert (alice['tokens'], alice['expired_tokens']) == (1, 1)


def test_a_token_that_never_expires_is_never_expired(client):
    _mint(client, 'alice', name='forever')

    own = client.get('/api/tokens', cookies=_session('alice')).json()['tokens']
    assert [(t['name'], t['expired']) for t in own] == [('forever', False)]


def test_deactivating_a_user_kills_their_tokens(client):
    token = _mint(client, 'alice')
    conn = store.connect(config.DB_PATH)
    user = conn.execute("SELECT id FROM users WHERE username = 'alice'").fetchone()
    store.set_user_active(conn, user['id'], False)
    conn.commit()
    conn.close()
    assert client.get('/validate', headers={'Authorization': f'Bearer {token}'}).status_code == 401


def test_everyone_including_an_admin_sees_only_their_own(client):
    """/api/tokens backs the personal Settings page, so it is scoped to the caller for
    every role - an admin opening Settings must not be shown other people's tokens."""
    _mint(client, 'alice')
    _mint(client, 'root')
    alice = client.get('/api/tokens', cookies=_session('alice')).json()['tokens']
    assert [t['username'] for t in alice] == ['alice']
    admin = client.get('/api/tokens', cookies=_session('root')).json()['tokens']
    assert [t['username'] for t in admin] == ['root']


def test_the_admin_endpoint_lists_every_token(client):
    """Revoking a leaked token someone else owns stays possible, from the Admin page."""
    _mint(client, 'alice')
    _mint(client, 'root')
    listed = client.get('/api/admin/tokens', cookies=_session('root')).json()['tokens']
    assert sorted(t['username'] for t in listed) == ['alice', 'root']
    assert all('token_hash' not in t for t in listed)


def test_the_admin_endpoint_is_closed_to_members(client):
    _mint(client, 'alice')
    assert client.get('/api/admin/tokens', cookies=_session('alice')).status_code == 403


def test_only_an_admin_revokes_someone_elses(client):
    _mint(client, 'alice')
    _mint(client, 'root')
    listed = client.get('/api/admin/tokens', cookies=_session('root')).json()['tokens']
    admin_token_id = next(t['id'] for t in listed if t['username'] == 'root')
    assert client.delete(f'/api/tokens/{admin_token_id}', cookies=_session('alice')).status_code == 404
    assert client.delete(f'/api/tokens/{admin_token_id}', cookies=_session('root')).status_code == 200


def test_anonymous_callers_cannot_mint_tokens(client):
    assert client.post('/api/tokens', json={'name': 'x'}).status_code == 401
    assert client.get('/api/tokens').status_code == 401


def _bearer(token: str) -> dict:
    return {'Authorization': f'Bearer {token}'}


def test_a_token_answers_who_it_is(client):
    response = client.get('/api/me', headers=_bearer(_mint(client, 'alice')))
    assert response.status_code == 200
    assert response.json()['user'] == 'alice'
    assert response.json()['role'] == 'member'


def test_a_token_reads_and_writes_its_owners_settings(client):
    token = _mint(client, 'alice')
    patched = client.patch('/api/settings', json={'hotkeys': {'save': 's'}}, headers=_bearer(token))
    assert patched.status_code == 200
    assert client.get('/api/settings', cookies=_session('alice')).json() == {'hotkeys': {'save': 's'}}
    assert client.get('/api/settings', headers=_bearer(token)).json() == {'hotkeys': {'save': 's'}}
    assert client.get('/api/settings', cookies=_session('root')).json() == {}


def test_a_readonly_token_reads_settings_but_is_refused_writes(client):
    token = _mint(client, 'alice', readonly=True)
    assert client.get('/api/settings', headers=_bearer(token)).status_code == 200
    for write in (client.put, client.patch):
        refused = write('/api/settings', json={'hotkeys': {}}, headers=_bearer(token))
        assert refused.status_code == 403
        assert refused.json()['detail'] == 'read-only API token'
    refused = client.delete('/api/users/me/avatar', headers=_bearer(token))
    assert refused.status_code == 403
    assert client.get('/api/settings', cookies=_session('alice')).json() == {}


def test_a_token_cannot_mint_list_or_revoke_tokens(client):
    """A leaked token must not be able to outlive its revocation by minting a successor."""
    token = _mint(client, 'alice')
    for request in (lambda: client.post('/api/tokens', json={'name': 'next'}, headers=_bearer(token)),
                    lambda: client.get('/api/tokens', headers=_bearer(token)),
                    lambda: client.delete('/api/tokens/1', headers=_bearer(token))):
        refused = request()
        assert refused.status_code == 403
        assert refused.json()['detail'] == 'needs a signed-in session, not an API token'
    assert len(client.get('/api/tokens', cookies=_session('alice')).json()['tokens']) == 1


def test_an_admin_token_cannot_administer_accounts(client):
    token = _mint(client, 'root')
    conn = store.connect(config.DB_PATH)
    alice = conn.execute("SELECT id FROM users WHERE username = 'alice'").fetchone()['id']
    conn.close()
    refused = [client.get('/api/users', headers=_bearer(token)),
               client.patch(f'/api/users/{alice}', json={'role': 'admin'}, headers=_bearer(token)),
               client.delete(f'/api/users/{alice}/sessions', headers=_bearer(token)),
               client.get(f'/api/users/{alice}/audit', headers=_bearer(token)),
               client.post('/api/users/invitations', json={'email': 'a@b.cd'}, headers=_bearer(token)),
               client.get('/api/admin/tokens', headers=_bearer(token))]
    assert [r.status_code for r in refused] == [403] * 6
    assert client.get('/api/users', cookies=_session('root')).status_code == 200
    roles = {u['username']: u['role'] for u in client.get('/api/users', cookies=_session('root')).json()['users']}
    assert roles['alice'] == 'member'


def test_a_token_reads_the_people_pickers(client):
    names = client.get('/api/users/names', headers=_bearer(_mint(client, 'alice')))
    assert names.status_code == 200
    assert sorted(u['username'] for u in names.json()['users']) == ['alice', 'root']


def test_an_unknown_token_is_not_authenticated(client):
    assert client.get('/api/me', headers=_bearer('dlp_nope')).status_code == 401
    assert client.get('/api/tokens', headers=_bearer('dlp_nope')).status_code == 401
