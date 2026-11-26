"""A second factor at sign-in (#135): DeepLabel's own sign-in page answers Authentik's stages
for an authenticator app and recovery codes - setting them up at the first sign-in, asking for
a code at every one after - and an admin can take a lost factor away, which is logged."""
import pytest
from fastapi.testclient import TestClient

from app import auth, config, store
from tests.fake_authentik import RECOVERY, RIGHT_CODE, SECRET, install

EMAIL = 'anna@example.org'


@pytest.fixture
def provider(tmp_path, monkeypatch):
    fake = install(monkeypatch, tmp_path)
    fake.add(EMAIL, 'right-password', name='Anna Test')
    fake.second_factor = True
    return fake


@pytest.fixture
def client(provider):
    from app.main import app
    return TestClient(app, base_url='https://testserver', follow_redirects=False)


def start(client, password='right-password', next='/jobs/abc'):
    return client.post('/api/sign-in', headers={'X-Real-IP': '192.0.2.1'},
                       json={'email': EMAIL, 'password': password, 'next': next})


def step(client, pending, **reply):
    return client.post('/api/sign-in/step', json={'pending': pending, **reply})


def enrol(client):
    first = start(client).json()
    recovery = step(client, first['pending'], code=RIGHT_CODE).json()
    return step(client, recovery['pending'], stored=True)


class TestTheFirstSignIn:
    def test_the_password_leads_to_setting_up_an_app_and_gives_no_session_yet(self, client):
        response = start(client)

        assert response.status_code == 200
        answer = response.json()
        assert answer['step']['kind'] == 'enrol'
        assert answer['step']['secret'] == SECRET
        assert answer['step']['otpauth'] == (f'otpauth://totp/DeepLabel%3A{EMAIL.replace("@", "%40")}?secret={SECRET}'
                                             '&algorithm=SHA1&digits=6&period=30&issuer=DeepLabel')
        assert answer['step']['qr'].startswith('data:image/svg+xml')
        assert len(answer['pending']) >= 32
        assert 'set-cookie' not in response.headers
        assert client.get('/api/me').status_code == 401

    def test_a_wrong_code_asks_again_with_why(self, client):
        pending = start(client).json()['pending']

        answer = step(client, pending, code='000000').json()

        assert answer['step']['kind'] == 'enrol'
        assert answer['step']['error'] == ('That code did not work. Check the time on your phone, wait for the '
                                           'next code and try again.')
        assert client.get('/api/me').status_code == 401

    def test_the_right_code_shows_the_recovery_codes_once(self, client):
        pending = start(client).json()['pending']

        answer = step(client, pending, code=RIGHT_CODE).json()

        assert answer['step'] == {'kind': 'recovery', 'codes': RECOVERY}
        assert client.get('/api/me').status_code == 401

    def test_storing_them_signs_in_and_goes_where_it_was_headed(self, client):
        response = enrol(client)

        assert (response.status_code, response.json()) == (200, {'next': '/jobs/abc'})
        assert client.get('/api/me').json()['user'] == EMAIL

    def test_a_sign_in_step_is_taken_once(self, client):
        pending = start(client).json()['pending']
        step(client, pending, code=RIGHT_CODE)

        response = step(client, pending, code=RIGHT_CODE)

        assert (response.status_code, response.json()['detail']) == (
            400, {'message': 'Signing in took too long or was finished elsewhere - start again.'})

    def test_one_left_waiting_too_long_has_to_start_again(self, client):
        pending = start(client).json()['pending']
        conn = store.connect(config.DB_PATH)
        conn.execute("UPDATE pending_sign_ins SET created_at = datetime('now', '-11 minutes')")
        conn.commit()
        conn.close()

        assert step(client, pending, code=RIGHT_CODE).status_code == 400


class TestEverySignInAfter:
    @pytest.fixture
    def enrolled(self, client):
        enrol(client)
        client.cookies.clear()
        return client

    def test_the_password_asks_for_a_code_and_offers_a_recovery_code(self, enrolled):
        answer = start(enrolled).json()

        assert answer['step'] == {'kind': 'code', 'recovery': True}

    def test_the_apps_code_signs_in(self, enrolled):
        pending = start(enrolled).json()['pending']

        assert step(enrolled, pending, code=RIGHT_CODE).json() == {'next': '/jobs/abc'}
        assert enrolled.get('/api/me').json()['user'] == EMAIL

    def test_a_recovery_code_signs_in_once(self, enrolled):
        pending = start(enrolled).json()['pending']
        assert step(enrolled, pending, code=RECOVERY[0]).json() == {'next': '/jobs/abc'}
        enrolled.cookies.clear()

        again = step(enrolled, start(enrolled).json()['pending'], code=RECOVERY[0]).json()

        assert again['step']['kind'] == 'code' and again['step']['error'].startswith('That code did not work.')

    def test_the_password_is_still_checked_first(self, enrolled):
        assert start(enrolled, password='not-it').status_code == 400


def _session(username: str) -> dict:
    conn = store.connect(config.DB_PATH)
    user = conn.execute('SELECT * FROM users WHERE username = ?', (username,)).fetchone()
    token = auth.new_token()
    store.create_session(conn, user['id'], token, auth.session_expiry())
    conn.close()
    return {config.SESSION_COOKIE: token}


class TestALostFactor:
    @pytest.fixture
    def admin(self, provider, client):
        provider.add('bert@example.org', 'bert-password', name='Bert')
        provider.second_factor = False
        client.post('/api/sign-in', json={'email': 'bert@example.org', 'password': 'bert-password', 'next': '/'})
        provider.second_factor = True
        enrol(client)
        client.cookies.clear()
        conn = store.connect(config.DB_PATH)
        store.upsert_user(conn, 'root@example.org', 'root', 'admin')
        anna = conn.execute('SELECT id FROM users WHERE subject = ?', (EMAIL,)).fetchone()['id']
        conn.close()
        provider._add_device(provider.by(email='bert@example.org'), 'totp')
        return anna

    def test_an_admin_takes_it_away_and_the_next_sign_in_sets_one_up_again(self, provider, client, admin):
        response = client.delete(f'/api/users/{admin}/second-factor', cookies=_session('root'))

        assert (response.status_code, response.json()) == (200, {'removed': 2})
        assert start(client).json()['step']['kind'] == 'enrol'

    def test_only_that_persons_factors_go(self, provider, client, admin):
        client.delete(f'/api/users/{admin}/second-factor', cookies=_session('root'))

        assert [d['user']['username'] for d in provider.devices] == ['bert@example.org']

    def test_it_is_in_the_accounts_log(self, client, admin):
        client.delete(f'/api/users/{admin}/second-factor', cookies=_session('root'))

        entries = client.get(f'/api/users/{admin}/audit', cookies=_session('root')).json()['entries']
        assert [(e['actor'], e['field'], e['old_value'], e['new_value']) for e in entries][0] == \
            ('root', 'second_factor', '2 devices', 'reset')

    def test_only_an_admin_may(self, client, admin):
        assert client.delete(f'/api/users/{admin}/second-factor', cookies=_session(EMAIL)).status_code == 403


class TestGuessingCodes:
    """A right password must not buy unlimited tries at the code, nor an endless sign-in."""

    @pytest.fixture
    def enrolled(self, client):
        enrol(client)
        client.cookies.clear()
        return client

    def test_after_five_wrong_codes_the_next_try_waits(self, enrolled):
        pending = start(enrolled).json()['pending']
        for _ in range(5):
            pending = step(enrolled, pending, code='000000').json()['pending']

        response = step(enrolled, pending, code=RIGHT_CODE)

        assert response.status_code == 429
        assert response.json()['detail']['message'] == 'Too many attempts - try again in 1 minute.'
        assert enrolled.get('/api/me').status_code == 401

    def test_the_password_again_does_not_forgive_the_wrong_codes(self, enrolled):
        for _ in range(5):
            pending = start(enrolled).json()['pending']
            assert step(enrolled, pending, code='000000').status_code == 200

        response = start(enrolled)

        assert response.status_code == 429
        assert response.json()['detail']['message'] == 'Too many attempts - try again in 1 minute.'
        assert enrolled.get('/api/me').status_code == 401

    def test_answering_does_not_keep_a_sign_in_open_past_ten_minutes(self, enrolled):
        pending = start(enrolled).json()['pending']
        conn = store.connect(config.DB_PATH)
        conn.execute("UPDATE pending_sign_ins SET created_at = datetime('now', '-9 minutes')")
        conn.commit()
        conn.close()
        pending = step(enrolled, pending, code='000000').json()['pending']
        conn = store.connect(config.DB_PATH)
        conn.execute("UPDATE pending_sign_ins SET created_at = datetime(created_at, '-2 minutes')")
        conn.commit()
        conn.close()

        assert step(enrolled, pending, code=RIGHT_CODE).status_code == 400


class TestResettingWithCare:
    def test_an_admin_does_not_take_their_own(self, provider, client):
        provider.add('root@example.org', 'root-password', name='Root')
        provider.second_factor = False
        client.post('/api/sign-in', json={'email': 'root@example.org', 'password': 'root-password', 'next': '/'})
        client.cookies.clear()
        conn = store.connect(config.DB_PATH)
        root = conn.execute("SELECT id FROM users WHERE subject = 'root@example.org'").fetchone()['id']
        conn.close()

        response = client.delete(f'/api/users/{root}/second-factor', cookies=_session('root@example.org'))

        assert response.status_code == 400

    def test_what_went_before_a_refusal_is_logged(self, provider, client, monkeypatch):
        enrol(client)
        client.cookies.clear()
        conn = store.connect(config.DB_PATH)
        store.upsert_user(conn, 'root@example.org', 'root', 'admin')
        anna = conn.execute('SELECT id FROM users WHERE subject = ?', (EMAIL,)).fetchone()['id']
        conn.close()
        provider.refuse_static_delete = True

        response = client.delete(f'/api/users/{anna}/second-factor', cookies=_session('root'))

        assert response.status_code == 502
        entries = client.get(f'/api/users/{anna}/audit', cookies=_session('root')).json()['entries']
        assert (entries[0]['field'], entries[0]['old_value'], entries[0]['new_value']) == \
            ('second_factor', '1 devices', 'reset in part')
