import secrets
from urllib.parse import parse_qs, urlsplit

import httpx

from app import config, issuer_route


class WrongCredentials(Exception):
    """The email and password do not open an account. Authentik answers the same for an
    unknown email, a wrong password and a deactivated account, and so does this."""


class Unavailable(Exception):
    """Authentik could not be reached, or answered in a way this service does not follow."""


# Each answer the login flow asks for, by the stage that asks.
_ANSWERS = {
    'ak-stage-identification': lambda email, password: {'uid_field': email},
    'ak-stage-password': lambda email, password: {'password': password},
}
_MOST_STEPS = 8
_MOST_REDIRECTS = 5


def _origin() -> str:
    return config.OIDC_ISSUER.split('/application/o/')[0]


def client() -> httpx.AsyncClient:
    """One sign-in's own client: its cookie jar is the Authentik session, held for the
    length of this sign-in and never shown to the browser."""
    return httpx.AsyncClient(base_url=_origin(), timeout=15, follow_redirects=False,
                             **issuer_route.async_transport())


async def _json(response: httpx.Response) -> dict:
    if response.is_error or 'json' not in response.headers.get('content-type', ''):
        raise Unavailable(f'Authentik answered {response.status_code} at {response.url.path}')
    return response.json()


async def _followed(browser: httpx.AsyncClient, response: httpx.Response, stop: str = '') -> httpx.Response:
    """The answer at the end of Authentik's own redirects, or the redirect towards `stop`."""
    for _ in range(_MOST_REDIRECTS):
        location = response.headers.get('location')
        if response.status_code not in (301, 302, 303, 307) or not location or (stop and location.startswith(stop)):
            return response
        response = await browser.get(location)
    raise Unavailable('Authentik redirected too often')


async def _log_in(browser: httpx.AsyncClient, email: str, password: str) -> None:
    """Run the brand's login flow the way its own page would, one stage at a time."""
    brand = await _json(await browser.get('/api/v3/core/brands/current/'))
    flow = f"/api/v3/flows/executor/{brand.get('flow_authentication') or 'default-authentication-flow'}/"
    challenge = await _json(await browser.get(flow, params={'query': ''}))
    for _ in range(_MOST_STEPS):
        component = challenge.get('component')
        if component == 'xak-flow-redirect':
            return
        if component not in _ANSWERS:
            raise Unavailable(f'the login flow asks for {component}, which DeepLabel cannot answer')
        answer = {'component': component, **_ANSWERS[component](email, password)}
        if component == 'ak-stage-identification' and challenge.get('password_fields'):
            answer['password'] = password
        response = await browser.post(flow, params={'query': ''}, json=answer)
        challenge = await _json(await _followed(browser, response))
        if challenge.get('response_errors'):
            raise WrongCredentials()
    raise Unavailable('the login flow did not finish')


async def sign_in(email: str, password: str) -> dict:
    """Who the email and password belong to, as the provider's user info: Authentik's login
    flow, then the authorization code flow on that session, all from this service."""
    async with client() as browser:
        metadata = await _json(await browser.get(
            config.OIDC_ISSUER.rstrip('/') + '/.well-known/openid-configuration'))
        await _log_in(browser, email, password)
        state = secrets.token_urlsafe(16)
        response = await _followed(browser, await browser.get(metadata['authorization_endpoint'], params={
            'client_id': config.OIDC_CLIENT_ID, 'redirect_uri': config.OIDC_REDIRECT_URI,
            'response_type': 'code', 'scope': 'openid profile email', 'state': state,
        }), stop=config.OIDC_REDIRECT_URI)
        query = parse_qs(urlsplit(response.headers.get('location', '')).query)
        if query.get('state') != [state] or not query.get('code'):
            raise Unavailable('Authentik did not hand over an authorization code')
        tokens = await _json(await browser.post(metadata['token_endpoint'], data={
            'grant_type': 'authorization_code', 'code': query['code'][0],
            'redirect_uri': config.OIDC_REDIRECT_URI,
            'client_id': config.OIDC_CLIENT_ID, 'client_secret': config.OIDC_CLIENT_SECRET,
        }))
        claims = await _json(await browser.get(
            metadata['userinfo_endpoint'], headers={'Authorization': f"Bearer {tokens['access_token']}"}))
    if not claims.get('sub'):
        raise Unavailable('Authentik named no subject')
    return claims
