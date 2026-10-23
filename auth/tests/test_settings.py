"""Per-person settings are one JSON document, so a writer that sends the whole thing
overwrites whatever it had not heard about yet."""
import pytest
from fastapi.testclient import TestClient

from app import auth, config, store

SUBJECT = 'sub-settings'


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(config, 'DB_PATH', tmp_path / 'auth.db')
    from app.main import app
    conn = store.connect(config.DB_PATH)
    store.upsert_user(conn, SUBJECT, 'alice', 'member')
    conn.close()
    yield TestClient(app)


@pytest.fixture
def cookie():
    conn = store.connect(config.DB_PATH)
    user = conn.execute("SELECT id FROM users WHERE username = 'alice'").fetchone()
    token = auth.new_token()
    store.create_session(conn, user['id'], token, auth.session_expiry())
    conn.close()
    return {config.SESSION_COOKIE: token}


def test_a_patch_keeps_the_keys_it_does_not_mention(client, cookie):
    client.put('/api/settings', json={'keyboard': ['a'], 'collapsed_groups': []}, cookies=cookie)

    # A second tab changes the keyboard while the first still holds the older copy.
    client.patch('/api/settings', json={'keyboard': ['a', 'b']}, cookies=cookie)
    # The first tab folds a group. Sending only its own key cannot take the keyboard back.
    merged = client.patch('/api/settings', json={'collapsed_groups': [7]}, cookies=cookie)

    assert merged.json() == {'keyboard': ['a', 'b'], 'collapsed_groups': [7]}
    assert client.get('/api/settings', cookies=cookie).json() == merged.json()


def test_a_put_still_replaces_the_whole_document(client, cookie):
    client.put('/api/settings', json={'keyboard': ['a'], 'collapsed_groups': [7]}, cookies=cookie)
    client.put('/api/settings', json={'keyboard': ['z']}, cookies=cookie)
    assert client.get('/api/settings', cookies=cookie).json() == {'keyboard': ['z']}


def test_a_patch_replaces_a_value_rather_than_merging_into_it(client, cookie):
    """One level deep on purpose: an overlay set or a key list is one setting, and
    merging into it would leave no way to remove a member."""
    client.put('/api/settings', json={'page_overlays': {'lines': True, 'boxes': True}},
               cookies=cookie)
    client.patch('/api/settings', json={'page_overlays': {'lines': False}}, cookies=cookie)
    assert client.get('/api/settings', cookies=cookie).json() == {'page_overlays': {'lines': False}}


def test_a_patch_that_is_not_an_object_is_refused(client, cookie):
    client.put('/api/settings', json={'keyboard': ['a']}, cookies=cookie)
    assert client.patch('/api/settings', json=['a'], cookies=cookie).status_code == 422
    assert client.get('/api/settings', cookies=cookie).json() == {'keyboard': ['a']}


def test_settings_are_per_person(client, cookie):
    conn = store.connect(config.DB_PATH)
    store.upsert_user(conn, 'sub-other', 'bob', 'member')
    other = conn.execute("SELECT id FROM users WHERE username = 'bob'").fetchone()
    token = auth.new_token()
    store.create_session(conn, other['id'], token, auth.session_expiry())
    conn.close()

    client.patch('/api/settings', json={'keyboard': ['a']}, cookies=cookie)
    assert client.get('/api/settings', cookies={config.SESSION_COOKIE: token}).json() == {}
