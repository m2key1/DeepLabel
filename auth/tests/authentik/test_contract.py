"""The calls sign-in makes, against a real Authentik rather than the fake in test_sign_in.py.
An Authentik upgrade that changes its login flow or its redirects fails here first. Skipped
unless AUTHENTIK_CONTRACT_URL points at one; compose.yml beside this file starts one."""
import asyncio
import os
import time

import httpx
import pytest

from app import authentik, config, second_factor_setup, sign_in

URL = os.environ.get('AUTHENTIK_CONTRACT_URL', '').rstrip('/')
TOKEN = os.environ.get('AUTHENTIK_CONTRACT_TOKEN', 'contract-bootstrap-token')
# The token DeepLabel itself manages accounts with. Given the service account AUTHENTIK.md
# makes, these tests prove its permissions are enough; the setup token is a superuser's.
SERVICE_TOKEN = os.environ.get('AUTHENTIK_CONTRACT_SERVICE_TOKEN', TOKEN)
REDIRECT_URI = 'http://deeplabel.test/api/auth/callback'
EMAIL = 'contract-anna@example.org'
PASSWORD = 'Contract-Passw0rd!'

pytestmark = pytest.mark.skipif(not URL, reason='no Authentik to test against (AUTHENTIK_CONTRACT_URL)')


def _api(method: str, path: str, **kwargs):
    response = httpx.request(method, URL + path, headers={'Authorization': f'Bearer {TOKEN}'}, timeout=30, **kwargs)
    response.raise_for_status()
    return response.json() if response.content else None


def _first(path: str, **params):
    return _api('GET', path, params=params)['results'][0]


def _wait_for_default_flows(seconds: int = 180):
    """A fresh Authentik answers its API before its worker has written the default flows."""
    deadline = time.monotonic() + seconds
    while not _api('GET', '/api/v3/flows/instances/', params={'slug': 'default-provider-invalidation-flow'})['results']:
        if time.monotonic() > deadline:
            pytest.fail('Authentik never wrote its default flows')
        time.sleep(3)


@pytest.fixture(scope='module')
def provider():
    """The DeepLabel application as AUTHENTIK.md sets it up, and one external user."""
    _wait_for_default_flows()
    found = _api('GET', '/api/v3/providers/oauth2/', params={'name': 'deeplabel-contract'})['results']
    made = found[0] if found else _api('POST', '/api/v3/providers/oauth2/', json={
        'name': 'deeplabel-contract',
        'authorization_flow': _first('/api/v3/flows/instances/', slug='default-provider-authorization-implicit-consent')['pk'],
        'invalidation_flow': _first('/api/v3/flows/instances/', slug='default-provider-invalidation-flow')['pk'],
        'client_type': 'confidential', 'sub_mode': 'user_username',
        'redirect_uris': [{'matching_mode': 'strict', 'url': REDIRECT_URI}],
        'signing_key': _first('/api/v3/crypto/certificatekeypairs/', name='authentik Self-signed Certificate')['pk'],
        'property_mappings': [m['pk'] for m in _api('GET', '/api/v3/propertymappings/provider/scope/')['results']
                              if m['scope_name'] in ('openid', 'profile', 'email')],
    })
    if not _api('GET', '/api/v3/core/applications/', params={'slug': 'deeplabel'})['results']:
        _api('POST', '/api/v3/core/applications/', json={'name': 'DeepLabel', 'slug': 'deeplabel', 'provider': made['pk']})
    users = _api('GET', '/api/v3/core/users/', params={'username': EMAIL})['results']
    user = users[0] if users else _api('POST', '/api/v3/core/users/', json={
        'username': EMAIL, 'email': EMAIL, 'name': 'Anna Contract', 'type': 'external', 'path': 'users'})
    _api('POST', f"/api/v3/core/users/{user['pk']}/set_password/", json={'password': PASSWORD})
    return made, user


@pytest.fixture
def configured(provider, monkeypatch):
    made, user = provider
    monkeypatch.setattr(config, 'OIDC_ISSUER', f'{URL}/application/o/deeplabel/')
    monkeypatch.setattr(config, 'OIDC_INTERNAL_URL', '')
    monkeypatch.setattr(config, 'OIDC_CLIENT_ID', made['client_id'])
    monkeypatch.setattr(config, 'OIDC_CLIENT_SECRET', made['client_secret'])
    monkeypatch.setattr(config, 'OIDC_REDIRECT_URI', REDIRECT_URI)
    return user


def signed_in(email: str, password: str) -> dict:
    claims = asyncio.run(sign_in.start(email, password))
    assert isinstance(claims, dict), claims
    return claims


def test_the_right_password_names_the_person(configured):
    claims = signed_in(EMAIL, PASSWORD)

    assert claims['sub'] == EMAIL
    assert claims['email'] == EMAIL and claims['name'] == 'Anna Contract'


@pytest.mark.parametrize('email, password', [(EMAIL, 'not-it'), ('nobody@example.org', PASSWORD)])
def test_a_wrong_password_and_an_unknown_email_read_the_same(configured, email, password):
    with pytest.raises(sign_in.WrongCredentials):
        signed_in(email, password)


def test_a_deactivated_account_cannot_sign_in(configured):
    _api('PATCH', f"/api/v3/core/users/{configured['pk']}/", json={'is_active': False})
    try:
        with pytest.raises(sign_in.WrongCredentials):
            signed_in(EMAIL, PASSWORD)
    finally:
        _api('PATCH', f"/api/v3/core/users/{configured['pk']}/", json={'is_active': True})


@pytest.fixture
def managing(configured, monkeypatch):
    monkeypatch.setattr(config, 'AUTHENTIK_API_TOKEN', SERVICE_TOKEN)
    return configured


def test_accounts_are_found_by_email_and_by_username(managing):
    assert authentik.find_user(email=EMAIL)['pk'] == managing['pk']
    assert authentik.account(username=EMAIL)['pk'] == managing['pk']
    assert authentik.find_user(email='nobody@example.org') is None


def test_authentik_judges_a_password_by_its_own_rules(managing):
    assert authentik.password_problems('short') == ['Password needs to be 8 characters or longer.']
    assert authentik.password_problems('password1', managing) == ['Too easy to guess - add another word.']
    assert authentik.password_problems('violet hinge saddle parade', managing) == []


def test_a_new_account_takes_a_password_and_signs_in_and_can_be_switched_off(managing):
    email = 'contract-mia@example.org'
    found = authentik.find_user(email=email)
    made = found or authentik.create_user(email, 'Mia Contract')
    assert (made['type'], made['username']) == ('external', email)

    authentik.set_password(made['pk'], 'Mias-Passw0rd!')
    assert signed_in(email, 'Mias-Passw0rd!')['sub'] == email

    authentik.set_active(made['pk'], False)
    with pytest.raises(sign_in.WrongCredentials):
        signed_in(email, 'Mias-Passw0rd!')
    authentik.set_active(made['pk'], True)


def _totp(secret: str, at: float) -> str:
    """The code an authenticator app shows for `secret` at `at`, as RFC 6238 computes it."""
    import base64
    import hashlib
    import hmac
    import struct
    key = base64.b32decode(secret + '=' * (-len(secret) % 8))
    digest = hmac.new(key, struct.pack('>Q', int(at // 30)), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    return str((struct.unpack('>I', digest[offset:offset + 4])[0] & 0x7FFFFFFF) % 1_000_000).zfill(6)


SECOND_EMAIL = 'contract-bert@example.org'


@pytest.fixture
def required(configured, monkeypatch):
    """The login flow with a second factor required, as second_factor_setup leaves it, and an
    account that has none yet; relaxed again afterwards for the tests above."""
    users = _api('GET', '/api/v3/core/users/', params={'username': SECOND_EMAIL})['results']
    user = users[0] if users else _api('POST', '/api/v3/core/users/', json={
        'username': SECOND_EMAIL, 'email': SECOND_EMAIL, 'name': 'Bert Contract', 'type': 'external', 'path': 'users'})
    _api('POST', f"/api/v3/core/users/{user['pk']}/set_password/", json={'password': PASSWORD})
    monkeypatch.setattr(config, 'AUTHENTIK_API_TOKEN', SERVICE_TOKEN)
    authentik.remove_second_factor(user['pk'])
    with httpx.Client(base_url=URL, headers={'Authorization': f'Bearer {TOKEN}'}, timeout=30) as admin:
        second_factor_setup.require(admin)
        second_factor_setup.require(admin)
        try:
            yield user
        finally:
            second_factor_setup.relax(admin)


def test_a_first_sign_in_sets_up_an_app_and_recovery_codes_then_lets_in(required):
    asked = asyncio.run(sign_in.start(SECOND_EMAIL, PASSWORD))
    assert asked.step['kind'] == 'enrol'
    assert asked.step['otpauth'].startswith('otpauth://totp/DeepLabel%3Acontract-bert%40example.org?secret=')
    assert asked.step['otpauth'].endswith('&issuer=DeepLabel')

    codes = asyncio.run(sign_in.resume(asked.state, {'code': _totp(asked.step['secret'], time.time())}))
    assert codes.step['kind'] == 'recovery' and len(codes.step['codes']) == 6

    claims = asyncio.run(sign_in.resume(codes.state, {'stored': True}))
    assert claims['sub'] == SECOND_EMAIL

    # Every sign-in after asks for a code; a recovery code serves once, and a wrong one says why.
    later = asyncio.run(sign_in.start(SECOND_EMAIL, PASSWORD))
    assert later.step == {'kind': 'code', 'recovery': True}
    wrong = asyncio.run(sign_in.resume(later.state, {'code': 'not-a-code'}))
    assert (wrong.step['kind'], wrong.step['error']) == ('code', sign_in.WRONG_CODE)
    # A wrong code holds every factor back for a moment, as a person retyping takes anyway.
    time.sleep(2)
    assert asyncio.run(sign_in.resume(wrong.state, {'code': codes.step['codes'][0]}))['sub'] == SECOND_EMAIL

    # An admin takes the factor away, and the next sign-in sets one up again.
    assert authentik.remove_second_factor(required['pk']) == 2
    assert asyncio.run(sign_in.start(SECOND_EMAIL, PASSWORD)).step['kind'] == 'enrol'
