"""A picture for an account.

The bytes that arrive are never the bytes that are served: whatever is uploaded is decoded
and re-encoded at a fixed size, which is what settles the format, the dimensions and
anything else the file was carrying. What is worth pinning here is that the refusals are
refusals, that a picture is only ever its owner's to set, and that the address changes when
the picture does - a cached one that never expires must not outlive what it shows.
"""
import io

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app import auth, avatars, config, store

SUBJECT = 'sub-avatar'
OTHER = 'sub-other'


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(config, 'DB_PATH', tmp_path / 'auth.db')
    monkeypatch.setattr(config, 'AVATAR_DIR', tmp_path / 'avatars')
    from app.main import app
    conn = store.connect(config.DB_PATH)
    store.upsert_user(conn, SUBJECT, 'alice', 'member')
    store.upsert_user(conn, OTHER, 'bob', 'member')
    conn.close()
    yield TestClient(app)


def cookie_for(username: str):
    conn = store.connect(config.DB_PATH)
    user = conn.execute('SELECT id FROM users WHERE username = ?', (username,)).fetchone()
    token = auth.new_token()
    store.create_session(conn, user['id'], token, auth.session_expiry())
    conn.close()
    return {config.SESSION_COOKIE: token}


def png(width=300, height=200, colour=(200, 30, 30)) -> bytes:
    out = io.BytesIO()
    Image.new('RGB', (width, height), colour).save(out, format='PNG')
    return out.getvalue()


def upload(client, data: bytes, who='alice', name='face.png', kind='image/png'):
    return client.put('/api/users/me/avatar', files={'file': (name, data, kind)},
                      cookies=cookie_for(who))


def test_a_picture_is_squared_off_and_kept_at_one_size(client):
    r = upload(client, png(300, 200))

    assert r.status_code == 200
    stored = Image.open(avatars.path_for(1))
    assert stored.size == (config.AVATAR_SIZE, config.AVATAR_SIZE)
    assert stored.format == 'PNG'


def test_the_address_carries_the_version_so_a_new_picture_is_a_new_address(client):
    first = upload(client, png(colour=(10, 10, 200))).json()['avatar']
    second = upload(client, png(colour=(10, 200, 10))).json()['avatar']

    assert first.startswith('/api/users/alice/avatar?v=')
    assert first != second, 'a cached picture that never expires must not outlive itself'


def test_anyone_signed_in_may_see_one(client):
    upload(client, png())

    seen = client.get('/api/users/alice/avatar', cookies=cookie_for('bob'))

    assert seen.status_code == 200
    assert seen.headers['content-type'] == 'image/png'
    assert 'immutable' in seen.headers['cache-control']


def test_a_stranger_may_not_see_one(client):
    upload(client, png())

    assert client.get('/api/users/alice/avatar').status_code == 401


def test_an_account_without_one_is_a_404_rather_than_a_placeholder(client):
    """The caller draws initials instead, and needs to know to, so this cannot be a
    stand-in picture that every account appears to have."""
    assert client.get('/api/users/bob/avatar', cookies=cookie_for('alice')).status_code == 404


def test_a_name_nobody_has_is_a_404(client):
    """Ninety-two datasets on this deployment are owned by a username with no account."""
    assert client.get('/api/users/nobody/avatar', cookies=cookie_for('alice')).status_code == 404


def test_removing_one_takes_the_file_with_it(client):
    upload(client, png())
    assert avatars.path_for(1).exists()

    r = client.delete('/api/users/me/avatar', cookies=cookie_for('alice'))

    assert r.status_code == 200
    assert r.json() == {'avatar': None}
    assert not avatars.path_for(1).exists()
    assert client.get('/api/users/alice/avatar', cookies=cookie_for('bob')).status_code == 404


def test_a_file_that_is_not_an_image_is_refused(client):
    r = upload(client, b'not a picture at all', name='face.png')

    assert r.status_code == 400
    assert r.json()['detail'] == 'that file is not an image the server can read'
    assert not avatars.path_for(1).exists()


def test_an_empty_file_is_refused(client):
    assert upload(client, b'').status_code == 400


def test_a_file_past_the_ceiling_is_refused_by_weight(client, monkeypatch):
    monkeypatch.setattr(config, 'AVATAR_MAX_BYTES', 512)

    r = upload(client, png(400, 400))

    assert r.status_code == 400
    assert 'larger than' in r.json()['detail']


def test_a_decompression_bomb_is_refused_rather_than_decoded(client, monkeypatch):
    """A few kilobytes on the wire that become gigabytes in memory. The byte ceiling does
    not catch one, so the pixel ceiling has to."""
    monkeypatch.setattr(avatars.Image, 'MAX_IMAGE_PIXELS', 100)

    r = upload(client, png(400, 400))

    assert r.status_code == 400
    assert r.json()['detail'] == 'the image has too many pixels to be a picture of a person'


def test_the_names_list_carries_the_picture(client):
    upload(client, png())

    listed = client.get('/api/users/names', cookies=cookie_for('bob')).json()['users']

    by_name = {u['username']: u for u in listed}
    assert by_name['alice']['avatar'].startswith('/api/users/alice/avatar?v=')
    # The one without a picture says so, rather than pointing at an address that 404s.
    assert by_name['bob']['avatar'] is None


def test_a_viewer_sees_every_picture_there_is(client):
    """Nothing about a picture is sensitive, and a viewer sees colleagues in the presence
    list like anyone else - drawn as initials only because the names list is closed to them."""
    conn = store.connect(config.DB_PATH)
    store.upsert_user(conn, 'sub-viewer', 'vic', 'viewer')
    conn.close()
    url = upload(client, png()).json()['avatar']

    response = client.get('/api/users/avatars', cookies=cookie_for('vic'))

    assert response.status_code == 200
    assert response.json() == {'avatars': {'alice': url}}
    assert client.get(url, cookies=cookie_for('vic')).status_code == 200


def test_the_pictures_are_for_people_signed_in(client):
    assert client.get('/api/users/avatars').status_code == 401


def test_the_upload_is_only_ever_your_own_account(client):
    """There is no route that takes someone else's id, and that is the point - a picture
    is the one thing on an account that is its owner's to choose."""
    writes = sorted((r.path, sorted(r.methods)) for r in client.app.routes
                    if 'avatar' in getattr(r, 'path', '') and not {'GET', 'HEAD'} & r.methods)

    assert writes == [('/api/users/me/avatar', ['DELETE']), ('/api/users/me/avatar', ['PUT'])]


def test_a_slow_picture_does_not_hold_up_everyone_elses_requests(client, monkeypatch):
    """Decoding and re-encoding a picture is CPU work. Done on the event loop, it stalls
    every /validate the whole app is waiting on until it finishes."""
    import threading
    entered, release = threading.Event(), threading.Event()
    keep = avatars.store

    def slow_store(user_id, raw):
        entered.set()
        release.wait(5)
        return keep(user_id, raw)

    monkeypatch.setattr(avatars, 'store', slow_store)
    with client:
        cookies = cookie_for('alice')
        bob = cookie_for('bob')
        uploading = threading.Thread(target=lambda: client.put(
            '/api/users/me/avatar', files={'file': ('face.png', png(), 'image/png')},
            cookies=cookies))
        uploading.start()
        assert entered.wait(5)
        answered = []
        checking = threading.Thread(
            target=lambda: answered.append(client.get('/validate', cookies=bob).status_code))
        checking.start()
        checking.join(2)
        while_uploading = list(answered)
        release.set()
        uploading.join(5)
        checking.join(5)

    assert while_uploading == [200]
    assert not checking.is_alive() and not uploading.is_alive()
