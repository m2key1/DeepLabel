"""This service reaches the provider over OIDC_INTERNAL_URL when that is set, while the
provider still sees - and answers for - the public address browsers use. Behind tailscale
serve the public address is a listener that containers cannot reach (tailscale 1.104 binds
it to tailscale0), so without this every login failed with a 500."""
import asyncio

import httpx
import pytest

from app import auth, authentik, config, issuer_route

ISSUER = 'https://deeplabel.example.ts.net:10000/application/o/deeplabel/'
INTERNAL = 'http://deeplabel-authentik:9000'
DISCOVERY = {
    'issuer': ISSUER,
    'authorization_endpoint': 'https://deeplabel.example.ts.net:10000/application/o/authorize/',
    'token_endpoint': 'https://deeplabel.example.ts.net:10000/application/o/token/',
    'jwks_uri': 'https://deeplabel.example.ts.net:10000/application/o/deeplabel/jwks/',
}


@pytest.fixture
def routed(monkeypatch):
    monkeypatch.setattr(config, 'DEV_AUTH', False)
    monkeypatch.setattr(config, 'OIDC_ISSUER', ISSUER)
    monkeypatch.setattr(config, 'OIDC_INTERNAL_URL', INTERNAL)
    monkeypatch.setattr(config, 'OIDC_CLIENT_ID', 'client')
    monkeypatch.setattr(config, 'OIDC_CLIENT_SECRET', 'secret')
    monkeypatch.setattr(auth, '_oauth', None)
    seen: list[httpx.Request] = []

    def answer(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.path.endswith('/.well-known/openid-configuration'):
            return httpx.Response(200, json=DISCOVERY)
        if request.url.path == '/api/v3/core/users/' and request.method == 'GET':
            return httpx.Response(200, json={'results': [{'pk': 7, 'type': 'external', 'is_superuser': False, 'is_active': True}]})
        if request.url.path == '/api/v3/core/users/7/recovery/':
            return httpx.Response(200, json={'link': 'https://deeplabel.example.ts.net:10000/recover/abc'})
        return httpx.Response(404)

    monkeypatch.setattr(issuer_route.httpx, 'AsyncHTTPTransport', lambda: httpx.MockTransport(answer))
    monkeypatch.setattr(issuer_route.httpx, 'HTTPTransport', lambda: httpx.MockTransport(answer))
    yield seen
    auth._oauth = None


def test_the_login_reads_the_provider_over_the_internal_address(routed):
    client = auth.oauth()
    metadata = asyncio.run(client.load_server_metadata())

    assert metadata['token_endpoint'] == DISCOVERY['token_endpoint']
    [request] = routed
    assert str(request.url) == f'{INTERNAL}/application/o/deeplabel/.well-known/openid-configuration'
    assert request.headers['Host'] == 'deeplabel.example.ts.net:10000'
    assert request.headers['X-Forwarded-Proto'] == 'https'


def test_an_invite_reaches_authentik_the_same_way(routed, monkeypatch):
    monkeypatch.setattr(config, 'AUTHENTIK_API_TOKEN', 'token')
    link, created = authentik.recovery_link('ada@example.org', 'Ada')

    assert (link, created) == ('https://deeplabel.example.ts.net:10000/recover/abc', False)
    assert [str(r.url) for r in routed] == [
        f'{INTERNAL}/api/v3/core/users/?email=ada%40example.org',
        f'{INTERNAL}/api/v3/core/users/7/recovery/',
    ]
    assert {r.headers['Host'] for r in routed} == {'deeplabel.example.ts.net:10000'}


def test_other_addresses_are_left_alone():
    request = httpx.Request('GET', 'https://elsewhere.example.org/x')
    assert str(issuer_route._rerouted(request, ISSUER, INTERNAL).url) == 'https://elsewhere.example.org/x'
    assert 'X-Forwarded-Proto' not in request.headers


def test_without_an_internal_address_nothing_is_rerouted(monkeypatch):
    monkeypatch.setattr(config, 'OIDC_ISSUER', ISSUER)
    monkeypatch.setattr(config, 'OIDC_INTERNAL_URL', '')
    assert issuer_route.async_transport() == {} and issuer_route.transport() == {}
