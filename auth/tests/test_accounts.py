"""Accounts on DeepLabel's own pages: invitations and password links, a password change, sign-up
and the wait for an admin's approval. Authentik keeps the accounts and is never seen."""
import sqlite3
from urllib.parse import parse_qs, urlsplit

import pytest
from fastapi.testclient import TestClient

from app import auth, config, store
from tests.fake_authentik import install


@pytest.fixture
def fake(tmp_path, monkeypatch):
    fake = install(monkeypatch, tmp_path)
    fake.add('root@example.org', 'root-password', name='Root')
    fake.add('alice@example.org', 'alice-password', name='Alice')
    conn = store.connect(config.DB_PATH)
    store.upsert_user(conn, 'root@example.org', 'root@example.org', 'admin', email='root@example.org')
    store.upsert_user(conn, 'alice@example.org', 'alice@example.org', 'member', email='alice@example.org')
    conn.close()
    return fake


def browser() -> TestClient:
    from app.main import app
    return TestClient(app, base_url='https://testserver', follow_redirects=False)


def signed_in(email: str) -> TestClient:
    """A browser with a session of this account, as a sign-in would leave it."""
    conn = store.connect(config.DB_PATH)
    user = conn.execute('SELECT id FROM users WHERE subject = ?', (email,)).fetchone()
    token = auth.new_token()
    store.create_session(conn, user['id'], token, auth.session_expiry())
    conn.close()
    client = browser()
    client.cookies.set(config.SESSION_COOKIE, token)
    return client


def sign_in(client: TestClient, email: str, password: str):
    return client.post('/api/sign-in', json={'email': email, 'password': password})


def account(email: str):
    conn = store.connect(config.DB_PATH)
    try:
        return conn.execute('SELECT * FROM users WHERE subject = ?', (email,)).fetchone()
    finally:
        conn.close()


def token_of(link: str) -> str:
    assert link.startswith('/set-password?token=')
    return parse_qs(urlsplit(link).query)['token'][0]


def message(response) -> str:
    return response.json()['detail']['message']


class TestInvitations:
    def invite(self, email, role='viewer', name='', as_user='root@example.org'):
        return signed_in(as_user).post('/api/users/invitations', json={'email': email, 'name': name, 'role': role})

    def test_an_unknown_email_gets_an_account_and_a_deeplabel_link(self, fake):
        response = self.invite(' Julia@Example.org ', role='member', name='Julia D')

        assert response.status_code == 200
        body = response.json()
        assert (body['created'], body['known'], body['valid_days']) == (True, False, 7)
        made = fake.by(email='julia@example.org')
        assert (made['username'], made['name'], made['type'], made['password']) == (
            'julia@example.org', 'Julia D', 'external', None)
        assert browser().get('/api/set-password', params={'token': token_of(body['link'])}).json() == {
            'email': 'julia@example.org', 'purpose': 'invite'}

    def test_the_invited_person_sets_a_password_and_is_in_with_their_role_without_waiting(self, fake):
        link = self.invite('julia@example.org', role='member').json()['link']
        client = browser()

        response = client.post('/api/set-password', json={'token': token_of(link), 'password': 'julias-password'})

        assert response.status_code == 200 and response.json() == {'next': '/'}
        me = client.get('/api/me').json()
        assert (me['user'], me['role'], me['pending']) == ('julia@example.org', 'member', False)
        assert client.get('/validate').status_code == 200
        assert fake.by(email='julia@example.org')['password'] == 'julias-password'

    def test_a_link_works_once(self, fake):
        token = token_of(self.invite('julia@example.org').json()['link'])
        browser().post('/api/set-password', json={'token': token, 'password': 'julias-password'})

        again = browser().post('/api/set-password', json={'token': token, 'password': 'another-password'})

        assert again.status_code == 410
        assert message(again) == 'This link has expired or was already used. Ask an admin for a new one.'
        assert fake.by(email='julia@example.org')['password'] == 'julias-password'

    def test_a_password_authentik_refuses_says_why_and_leaves_the_link_usable(self, fake):
        token = token_of(self.invite('julia@example.org').json()['link'])

        refused = browser().post('/api/set-password', json={'token': token, 'password': 'short'})

        assert refused.status_code == 400
        assert message(refused) == 'Password needs to be 8 characters or longer.'
        assert fake.by(email='julia@example.org')['password'] is None
        assert browser().post('/api/set-password', json={'token': token, 'password': 'long-enough'}).status_code == 200

    def test_a_new_link_cancels_the_last_one(self, fake):
        first = token_of(self.invite('julia@example.org').json()['link'])
        second = token_of(self.invite('julia@example.org').json()['link'])

        assert browser().get('/api/set-password', params={'token': first}).status_code == 410
        assert browser().get('/api/set-password', params={'token': second}).status_code == 200

    def test_someone_deeplabel_knows_gets_a_reset_and_it_is_in_their_history(self, fake):
        body = self.invite('alice@example.org').json()

        assert (body['created'], body['known']) == (False, True)
        history = signed_in('root@example.org').get(f"/api/users/{account('alice@example.org')['id']}/audit")
        assert [(e['actor'], e['field'], e['new_value']) for e in history.json()['entries']] == [
            ('root@example.org', 'password_link', 'issued')]

    @pytest.mark.parametrize('overrides, reason', [
        ({'type': 'internal'}, 'This account is managed in Authentik itself; change it there.'),
        ({'is_superuser': True}, 'This account is managed in Authentik itself; change it there.'),
        ({'is_active': False}, 'This account is deactivated in Authentik.'),
    ])
    def test_no_link_for_an_account_deeplabel_does_not_own(self, fake, overrides, reason):
        fake.add('ops@example.org', 'ops-password', **overrides)

        response = self.invite('ops@example.org')

        assert (response.status_code, message(response)) == (409, reason)

    def test_only_admins_invite_and_only_well_formed_emails(self, fake):
        assert self.invite('julia@example.org', as_user='alice@example.org').status_code == 403
        bad = self.invite('julia at example')
        assert (bad.status_code, message(bad)) == (400, 'That is not an email address.')
        assert fake.by(email='julia@example.org') is None

    def test_authentik_being_down_is_reported_not_raised(self, fake):
        fake.down = True

        response = self.invite('julia@example.org')

        assert response.status_code == 502
        assert message(response) == 'Authentik could not be reached. Try again in a minute, or tell an admin.'

    def test_without_a_token_account_management_is_off_and_the_page_is_told(self, fake, monkeypatch):
        admin = signed_in('root@example.org')
        assert admin.get('/api/users').json()['invitations'] is True
        monkeypatch.setattr(config, 'AUTHENTIK_API_TOKEN', '')

        assert admin.get('/api/users').json()['invitations'] is False
        assert self.invite('julia@example.org').status_code == 503
        assert admin.get('/api/me').json()['password_change'] is False


class TestAdminReset:
    def test_the_link_sets_a_new_password_and_ends_every_old_session(self, fake):
        alice = signed_in('alice@example.org')
        link = signed_in('root@example.org').post(f"/api/users/{account('alice@example.org')['id']}/password-link")
        assert link.status_code == 200 and link.json()['valid_days'] == 7

        fresh = browser()
        assert fresh.post('/api/set-password', json={'token': token_of(link.json()['link']),
                                                     'password': 'alices-new-password'}).status_code == 200

        assert alice.get('/api/me').status_code == 401
        assert fresh.get('/api/me').json()['user'] == 'alice@example.org'
        assert sign_in(browser(), 'alice@example.org', 'alice-password').status_code == 400
        assert sign_in(browser(), 'alice@example.org', 'alices-new-password').status_code == 200

    def test_members_make_no_links(self, fake):
        response = signed_in('alice@example.org').post(f"/api/users/{account('root@example.org')['id']}/password-link")
        assert response.status_code == 403


class TestChangingYourOwnPassword:
    def test_the_new_one_works_the_old_one_does_not_and_only_this_session_stays(self, fake):
        elsewhere = signed_in('alice@example.org')
        here = signed_in('alice@example.org')

        response = here.post('/api/users/me/password', json={'password': 'alices-new-password'})

        assert response.status_code == 200 and response.json() == {'ended_sessions': 1}
        assert here.get('/api/me').status_code == 200
        assert elsewhere.get('/api/me').status_code == 401
        assert sign_in(browser(), 'alice@example.org', 'alice-password').status_code == 400
        assert sign_in(browser(), 'alice@example.org', 'alices-new-password').status_code == 200

    def test_a_password_authentik_refuses_changes_nothing(self, fake):
        response = signed_in('alice@example.org').post('/api/users/me/password', json={'password': 'short'})

        assert (response.status_code, message(response)) == (400, 'Password needs to be 8 characters or longer.')
        assert fake.by(email='alice@example.org')['password'] == 'alice-password'

    def test_an_api_token_cannot_change_it(self, fake):
        conn = store.connect(config.DB_PATH)
        raw = 'dl_' + auth.new_token()
        store.create_api_token(conn, account('alice@example.org')['id'], 'script', auth.hash_api_token(raw),
                               raw[:8], False, None)
        conn.close()

        response = browser().post('/api/users/me/password', json={'password': 'alices-new-password'},
                                  headers={'Authorization': f'Bearer {raw}'})

        assert response.status_code == 403
        assert fake.by(email='alice@example.org')['password'] == 'alice-password'


class TestSignUpAndApproval:
    @pytest.fixture
    def open_sign_up(self, fake, monkeypatch):
        monkeypatch.setattr(config, 'SELF_SIGN_UP', True)
        return fake

    def sign_up(self, client, email='mia@example.org', password='mias-password', address='192.0.2.1'):
        return client.post('/api/sign-up', headers={'X-Real-IP': address},
                           json={'name': 'Mia', 'email': email, 'password': password})

    def test_sign_up_is_off_unless_it_is_switched_on(self, fake):
        assert browser().get('/api/sign-in/options').json() == {'sign_up': False}
        assert self.sign_up(browser()).status_code == 404
        assert fake.by(email='mia@example.org') is None

    def test_a_new_account_is_made_signed_in_and_waits(self, open_sign_up):
        client = browser()
        assert client.get('/api/sign-in/options').json() == {'sign_up': True}

        response = self.sign_up(client)

        assert response.status_code == 200
        made = open_sign_up.by(email='mia@example.org')
        assert (made['type'], made['name'], made['password']) == ('external', 'Mia', 'mias-password')
        me = client.get('/api/me').json()
        assert (me['user'], me['pending'], me['email'], me['name']) == ('mia@example.org', True, 'mia@example.org', 'Mia')

    def test_a_waiting_account_reaches_nothing_but_who_it_is(self, open_sign_up):
        client = browser()
        self.sign_up(client)

        assert client.get('/validate').status_code == 403
        assert client.get('/api/settings').status_code == 403
        assert client.post('/api/tokens', json={'name': 'x'}).status_code == 403
        assert client.get('/api/me').status_code == 200

    def test_admins_see_how_many_wait_and_let_one_in_with_a_role(self, open_sign_up):
        client = browser()
        self.sign_up(client)
        admin = signed_in('root@example.org')
        assert admin.get('/api/users/pending').json() == {'count': 1}
        mia = account('mia@example.org')

        approved = admin.post(f"/api/users/{mia['id']}/approve", json={'role': 'member'})

        assert approved.status_code == 200
        assert (approved.json()['pending'], approved.json()['role']) == (0, 'member')
        assert admin.get('/api/users/pending').json() == {'count': 0}
        assert client.get('/validate').status_code == 200
        assert client.get('/api/me').json()['pending'] is False
        history = admin.get(f"/api/users/{mia['id']}/audit").json()['entries']
        assert [(e['field'], e['old_value'], e['new_value']) for e in history] == [('approved', 'pending', 'member')]

    def test_a_rejected_sign_up_is_switched_off_here_and_in_authentik(self, open_sign_up):
        client = browser()
        self.sign_up(client)
        admin = signed_in('root@example.org')

        rejected = admin.post(f"/api/users/{account('mia@example.org')['id']}/reject")

        assert rejected.status_code == 200 and rejected.json()['active'] == 0
        assert client.get('/api/me').status_code == 401
        assert open_sign_up.by(email='mia@example.org')['is_active'] is False
        assert sign_in(browser(), 'mia@example.org', 'mias-password').status_code == 400
        assert admin.get('/api/users/pending').json() == {'count': 0}

    def test_only_a_waiting_account_is_approved_and_only_by_an_admin(self, open_sign_up):
        self.sign_up(browser())
        mia = account('mia@example.org')
        assert signed_in('alice@example.org').post(f"/api/users/{mia['id']}/approve", json={}).status_code == 403
        alice = account('alice@example.org')
        assert signed_in('root@example.org').post(f"/api/users/{alice['id']}/approve", json={}).status_code == 409

    def test_an_email_with_an_account_is_turned_away(self, open_sign_up):
        response = self.sign_up(browser(), email='Alice@example.org')

        assert response.status_code == 409
        assert message(response) == ('There is already an account for this email. Sign in, '
                                     'or ask an admin for a new password.')

    def test_a_password_authentik_refuses_makes_no_account(self, open_sign_up):
        response = self.sign_up(browser(), password='short')

        assert (response.status_code, message(response)) == (400, 'Password needs to be 8 characters or longer.')
        assert open_sign_up.by(email='mia@example.org') is None

    def test_one_address_makes_only_a_few_accounts(self, open_sign_up):
        for n in range(store.SIGN_IN_TRIES['sign-up']):
            assert self.sign_up(browser(), email=f'mia{n}@example.org').status_code == 200

        refused = self.sign_up(browser(), email='mia9@example.org')

        assert refused.status_code == 429
        assert open_sign_up.by(email='mia9@example.org') is None
        assert self.sign_up(browser(), email='mia9@example.org', address='192.0.2.2').status_code == 200


class TestFirstSignIn:
    def test_someone_made_in_authentik_directly_waits_too(self, fake):
        fake.add('bob@example.org', 'bobs-password')
        client = browser()

        assert sign_in(client, 'bob@example.org', 'bobs-password').status_code == 200

        assert client.get('/api/me').json()['pending'] is True

    def test_the_bootstrap_admin_is_in_at_once(self, fake, monkeypatch):
        conn = store.connect(config.DB_PATH)
        conn.execute("DELETE FROM users WHERE subject = 'root@example.org'")
        conn.commit()
        conn.close()
        client = browser()

        sign_in(client, 'root@example.org', 'root-password')

        me = client.get('/api/me').json()
        assert (me['role'], me['pending']) == ('admin', False)


def test_accounts_from_before_are_not_made_to_wait(tmp_path):
    db = tmp_path / 'auth.db'
    old = sqlite3.connect(db)
    old.executescript("""
        CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, subject TEXT UNIQUE NOT NULL,
                            username TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT 'member',
                            active INTEGER NOT NULL DEFAULT 1);
        INSERT INTO users (subject, username, role) VALUES ('old', 'old', 'member');
    """)
    old.close()

    conn = store.connect(db)

    assert [tuple(r) for r in conn.execute('SELECT subject, pending FROM users')] == [('old', 0)]
    store.connect(db).close()


def test_the_service_reaches_authentik_s_admin_api_with_its_token(fake):
    assert ('GET', '/api/v3/core/users/') not in fake.requests
    signed_in('root@example.org').post('/api/users/invitations', json={'email': 'julia@example.org'})
    assert [r for r in fake.requests if r[1].startswith('/api/v3/core/users/')][:2] == [
        ('GET', '/api/v3/core/users/'), ('POST', '/api/v3/core/users/')]


class TestPasswordRulesForTheMeter:
    def test_the_policy_s_length_and_strength_threshold_are_served_to_anyone(self, fake):
        from tests.fake_authentik import POLICY
        POLICY_CHECKED = {**POLICY, 'check_zxcvbn': True, 'zxcvbn_score_threshold': 3, 'length_min': 10}
        fake.policy = POLICY_CHECKED

        assert browser().get('/api/sign-in/password-rules').json() == {
            'min_length': 10, 'strength_check': True, 'min_score': 4}

    def test_without_authentik_s_api_only_the_fallback_length_is_known(self, fake, monkeypatch):
        monkeypatch.setattr(config, 'AUTHENTIK_API_TOKEN', '')

        assert browser().get('/api/sign-in/password-rules').json() == {
            'min_length': 8, 'strength_check': False, 'min_score': 0}


class TestWeakPasswordAtSignIn:
    @pytest.fixture
    def weak(self, fake):
        fake.add('olaf@example.org', 'olaf123')
        conn = store.connect(config.DB_PATH)
        store.upsert_user(conn, 'olaf@example.org', 'olaf@example.org', 'member', email='olaf@example.org')
        conn.close()
        return fake

    def test_a_password_below_the_rules_opens_only_the_way_to_a_new_one(self, weak):
        client = browser()

        assert sign_in(client, 'olaf@example.org', 'olaf123').status_code == 200

        me = client.get('/api/me').json()
        assert (me['user'], me['password_change_due']) == ('olaf@example.org', True)
        assert client.get('/validate').status_code == 403
        assert client.get('/api/settings').status_code == 403

    def test_a_new_password_lets_them_in_and_ends_their_other_sessions(self, weak):
        elsewhere = signed_in('olaf@example.org')
        client = browser()
        sign_in(client, 'olaf@example.org', 'olaf123')

        changed = client.post('/api/users/me/password', json={'password': 'olafs-new-password'})

        assert changed.status_code == 200
        assert client.get('/api/me').json()['password_change_due'] is False
        assert client.get('/validate').status_code == 200
        assert elsewhere.get('/api/me').status_code == 401

    def test_the_new_password_has_to_meet_the_rules_too(self, weak):
        client = browser()
        sign_in(client, 'olaf@example.org', 'olaf123')

        refused = client.post('/api/users/me/password', json={'password': 'short'})

        assert refused.status_code == 400
        assert client.get('/validate').status_code == 403

    def test_api_tokens_keep_working(self, weak):
        conn = store.connect(config.DB_PATH)
        raw = 'dl_' + auth.new_token()
        store.create_api_token(conn, account('olaf@example.org')['id'], 'script', auth.hash_api_token(raw),
                               raw[:8], False, None)
        conn.close()
        sign_in(browser(), 'olaf@example.org', 'olaf123')

        assert browser().get('/validate', headers={'Authorization': f'Bearer {raw}'}).status_code == 200

    def test_a_password_that_meets_the_rules_is_not_asked_again(self, fake):
        client = browser()
        sign_in(client, 'alice@example.org', 'alice-password')

        assert client.get('/api/me').json()['password_change_due'] is False
        assert client.get('/validate').status_code == 200
