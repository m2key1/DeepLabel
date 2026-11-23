import secrets
from dataclasses import dataclass
from urllib.parse import parse_qs, parse_qsl, quote, unquote, urlencode, urlsplit

import httpx
import segno

from app import config, issuer_route


class WrongCredentials(Exception):
    """The email and password do not open an account. Authentik answers the same for an
    unknown email, a wrong password and a deactivated account, and so does this."""


class Unavailable(Exception):
    """Authentik could not be reached, or answered in a way this service does not follow."""


@dataclass
class Asked:
    """A stage only the person can answer: what their sign-in page shows them, and where the
    flow stands, to carry on from with their answer."""
    step: dict
    state: dict


# The stages this service answers itself, from the email and password it was given.
_ANSWERS = {
    'ak-stage-identification': lambda email, password: {'uid_field': email},
    'ak-stage-password': lambda email, password: {'password': password},
}
ISSUER = 'DeepLabel'
WRONG_CODE = 'That code did not work. Check the time on your phone, wait for the next code and try again.'
_MOST_STEPS = 8
_MOST_REDIRECTS = 5


def _branded(config_url: str) -> str:
    """The authenticator app's entry under DeepLabel's name rather than Authentik's."""
    parts = urlsplit(config_url)
    account = unquote(parts.path.lstrip('/')).split(':', 1)[-1]
    query = [(key, ISSUER if key == 'issuer' else value) for key, value in parse_qsl(parts.query)]
    return f'otpauth://{parts.netloc}/{quote(f"{ISSUER}:{account}", safe="")}?{urlencode(query)}'


def _enrolment(challenge: dict) -> dict:
    uri = _branded(challenge['config_url'])
    return {'kind': 'enrol', 'otpauth': uri, 'secret': parse_qs(urlsplit(uri).query)['secret'][0],
            'qr': segno.make(uri, error='m').svg_data_uri(scale=5, border=2)}


# The second factor's stages: what each shows the person, and its answer from their reply -
# None while the reply does not hold it yet.
_ASKED = {
    'ak-stage-authenticator-totp': (_enrolment, lambda reply: {'code': reply['code']} if reply.get('code') else None),
    'ak-stage-authenticator-static': (lambda challenge: {'kind': 'recovery', 'codes': challenge['codes']},
                                      lambda reply: {} if reply.get('stored') else None),
    'ak-stage-authenticator-validate': (
        lambda challenge: {'kind': 'code', 'recovery': any(device['device_class'] == 'static'
                                                           for device in challenge.get('device_challenges', []))},
        lambda reply: {'code': reply['code']} if reply.get('code') else None),
}


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


async def _walk(browser: httpx.AsyncClient, flow: str, challenge: dict, email: str = '', password: str = '',
                reply: dict | None = None) -> dict | Asked:
    """Answer the brand's login flow the way its own page would, one stage at a time, until it
    is done or asks something only the person knows. A reply answers one stage."""
    reply = dict(reply or {})
    error = None
    for _ in range(_MOST_STEPS):
        component = challenge.get('component')
        if component == 'xak-flow-redirect':
            return await _claims(browser)
        if component in _ANSWERS:
            if challenge.get('response_errors'):
                raise WrongCredentials()
            answer = _ANSWERS[component](email, password)
            if component == 'ak-stage-identification' and challenge.get('password_fields'):
                answer['password'] = password
        elif component in _ASKED:
            shown, answered = _ASKED[component]
            if challenge.get('response_errors'):
                error = WRONG_CODE
            answer = answered(reply)
            if answer is None:
                return Asked({**shown(challenge), **({'error': error} if error else {})},
                             {'flow': flow, 'cookies': {cookie.name: cookie.value for cookie in browser.cookies.jar}})
            reply = {}
        else:
            raise Unavailable(f'the login flow asks for {component}, which DeepLabel cannot answer')
        response = await browser.post(flow, params={'query': ''}, json={'component': component, **answer})
        challenge = await _json(await _followed(browser, response))
    raise Unavailable('the login flow did not finish')


async def _claims(browser: httpx.AsyncClient) -> dict:
    """Who the finished login flow signed in, as the provider's user info: the authorization
    code flow on that session, all from this service."""
    metadata = await _json(await browser.get(config.OIDC_ISSUER.rstrip('/') + '/.well-known/openid-configuration'))
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


async def start(email: str, password: str) -> dict | Asked:
    """Sign in with an email and password: who they belong to, or the first stage of a second
    factor the person has to answer."""
    async with client() as browser:
        brand = await _json(await browser.get('/api/v3/core/brands/current/'))
        flow = f"/api/v3/flows/executor/{brand.get('flow_authentication') or 'default-authentication-flow'}/"
        challenge = await _json(await browser.get(flow, params={'query': ''}))
        return await _walk(browser, flow, challenge, email, password)


async def resume(state: dict, reply: dict) -> dict | Asked:
    """Carry a sign-in on from where it asked the person something, with their reply."""
    async with client() as browser:
        browser.cookies.update(state['cookies'])
        challenge = await _json(await browser.get(state['flow'], params={'query': ''}))
        return await _walk(browser, state['flow'], challenge, reply=reply)
