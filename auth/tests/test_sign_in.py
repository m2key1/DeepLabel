"""DeepLabel's own sign-in page. The auth service runs Authentik's login flow for the person
and hands back a DeepLabel session, so the browser never sees Authentik."""
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from app import config, store
from tests.fake_authentik import install


@pytest.fixture
def provider(tmp_path, monkeypatch):
    fake = install(monkeypatch, tmp_path)
    fake.add('anna@example.org', 'right-password', name='Anna Test')
    return fake


@pytest.fixture
def client(provider):
    from app.main import app
    return TestClient(app, base_url='https://testserver', follow_redirects=False)


def attempt(client, password, email='anna@example.org', address='192.0.2.1', next='/'):
    return client.post('/api/sign-in', headers={'X-Real-IP': address},
                       json={'email': email, 'password': password, 'next': next})


class TestSigningIn:
    def test_the_right_password_gives_a_session_and_the_page_to_go_back_to(self, client):
        response = attempt(client, 'right-password', next='/jobs/abc')

        assert response.status_code == 200
        assert response.json() == {'next': '/jobs/abc'}
        me = client.get('/api/me')
        assert me.status_code == 200 and me.json()['user'] == 'anna@example.org'

    def test_a_wrong_password_says_so_and_gives_no_session(self, client):
        response = attempt(client, 'not-it')

        assert response.status_code == 400
        assert response.json()['detail'] == {'message': 'Wrong email or password.'}
        assert 'set-cookie' not in response.headers
        assert client.get('/api/me').status_code == 401

    def test_an_unknown_email_reads_the_same_as_a_wrong_password(self, client):
        assert attempt(client, 'x', email='nobody@example.org').json()['detail'] == {
            'message': 'Wrong email or password.'}

    def test_a_next_page_on_another_site_is_not_followed(self, client):
        for elsewhere in ('//evil.example.org/x', 'https://evil.example.org/', '/\\evil.example.org'):
            client.cookies.clear()
            assert attempt(client, 'right-password', next=elsewhere).json() == {'next': '/'}

    def test_a_login_flow_with_a_step_deeplabel_cannot_answer_is_reported_not_guessed(self, provider, client):
        provider.extra_stage = 'ak-stage-authenticator-validate'

        response = attempt(client, 'right-password')

        assert response.status_code == 502
        assert response.json()['detail'] == {
            'message': 'Signing in is not possible right now. Try again in a minute, or tell an admin.'}


class TestThrottle:
    def test_after_five_wrong_passwords_even_the_right_one_waits(self, client):
        for _ in range(store.SIGN_IN_TRIES['account']):
            assert attempt(client, 'not-it').status_code == 400

        response = attempt(client, 'right-password')

        assert response.status_code == 429
        assert response.json()['detail'] == {'message': 'Too many attempts - try again in 1 minute.',
                                             'retry_after': 60}
        assert client.get('/api/me').status_code == 401

    def test_one_address_trying_many_accounts_waits_too(self, client):
        for n in range(store.SIGN_IN_TRIES['address'] - 1):
            attempt(client, 'x', email=f'guess{n}@example.org')
        # A shared address takes more than one person's typos before it waits.
        assert attempt(client, 'right-password').status_code == 200
        client.cookies.clear()
        attempt(client, 'x', email='one-more@example.org')

        assert attempt(client, 'right-password').status_code == 429
        assert attempt(client, 'right-password', address='192.0.2.99').status_code == 200

    def test_the_right_password_forgives_the_accounts_failures(self, client):
        for _ in range(store.SIGN_IN_TRIES['account'] - 1):
            attempt(client, 'not-it')
        assert attempt(client, 'right-password').status_code == 200
        client.cookies.clear()

        for _ in range(store.SIGN_IN_TRIES['account'] - 1):
            assert attempt(client, 'not-it', address='192.0.2.2').status_code == 400
        assert attempt(client, 'right-password', address='192.0.2.2').status_code == 200


def test_the_wait_doubles_up_to_fifteen_minutes_and_a_quiet_hour_forgives(tmp_path):
    conn = store.connect(tmp_path / 'auth.db')
    t = datetime(2026, 11, 3, 12, 0, tzinfo=timezone.utc)
    key = ['account:anna@example.org']
    waits = []
    for n in range(1, 11):
        store.note_sign_in_failure(conn, key, now=t)
        waits.append(store.sign_in_wait(conn, key, now=t))

    assert waits == [0, 0, 0, 0, 60, 120, 240, 480, 900, 900]
    assert store.sign_in_wait(conn, key, now=t + timedelta(seconds=901)) == 0
    store.note_sign_in_failure(conn, key, now=t + timedelta(hours=2))
    assert store.sign_in_wait(conn, key, now=t + timedelta(hours=2)) == 0


class TestWhereVisitorsGo:
    def test_a_visitor_without_a_session_goes_to_deeplabels_sign_in_page(self, client):
        response = client.get('/api/login', params={'next': '/jobs/abc'})

        assert response.status_code == 303
        assert response.headers['location'] == '/sign-in?next=%2Fjobs%2Fabc'

    def test_log_out_ends_the_session_and_lands_on_sign_in(self, client):
        attempt(client, 'right-password')

        response = client.post('/api/logout')

        assert response.json() == {'ok': True, 'redirect': '/sign-in'}
        assert client.get('/api/me').status_code == 401


class TestDevBypass:
    @pytest.fixture
    def dev(self, tmp_path, monkeypatch):
        monkeypatch.setattr(config, 'DB_PATH', tmp_path / 'auth.db')
        monkeypatch.setattr(config, 'DEV_AUTH', True)
        from app.main import app
        return TestClient(app, base_url='https://testserver', follow_redirects=False)

    def test_it_signs_in_at_once_and_goes_where_it_was_headed(self, dev):
        response = dev.get('/api/login', params={'next': '/jobs/abc'})

        assert response.status_code == 303 and response.headers['location'] == '/jobs/abc'
        assert dev.get('/api/me').status_code == 200

    def test_log_out_goes_back_through_the_bypass(self, dev):
        dev.get('/api/login')

        assert dev.post('/api/logout').json() == {'ok': True, 'redirect': '/api/login'}
        assert dev.get('/api/me').status_code == 401

    def test_there_is_no_password_sign_in(self, dev):
        assert dev.post('/api/sign-in', json={'email': 'a@b.c', 'password': 'x'}).status_code == 404


class TestUsernames:
    @pytest.fixture
    def bo(self, provider):
        provider.add('bo@example.org', 'bos-password', username='bo')
        return provider

    def test_the_username_signs_in_as_well_as_the_email(self, bo, client):
        assert attempt(client, 'bos-password', email='bo').status_code == 200
        assert client.get('/api/me').json()['user'] == 'bo'

    def test_wrong_passwords_count_against_the_account_however_it_was_named(self, bo, client):
        for name in ('bo', 'BO', 'bo@example.org', 'Bo@Example.org', 'bo'):
            assert attempt(client, 'not-it', email=name).status_code == 400

        assert attempt(client, 'bos-password', email='bo@example.org').status_code == 429
