import httpx

from app import config, issuer_route

LINK_VALID_DAYS = 7


class Refused(Exception):
    """Why no link may be made for this person, in words meant for the admin who asked."""


class Unavailable(Exception):
    """Authentik could not be reached, or did not do what it was asked."""


def invitations_enabled() -> bool:
    return bool(config.AUTHENTIK_API_TOKEN and config.OIDC_ISSUER)


def _base_url() -> str:
    # The issuer is <authentik>/application/o/<app>/. Calling Authentik on that same
    # address matters: it builds the link from the host it was asked on, so the link
    # points wherever the people who log in can already reach.
    return config.OIDC_ISSUER.split('/application/o/')[0]


def _client() -> httpx.Client:
    return httpx.Client(base_url=_base_url(), timeout=15,
                        headers={'Authorization': f'Bearer {config.AUTHENTIK_API_TOKEN}'},
                        **issuer_route.transport())


def recovery_link(email: str, name: str) -> tuple[str, bool]:
    """A link with which the person behind this email sets their password, and whether
    their Authentik account had to be created first."""
    with _client() as client:
        found = _call(client, 'GET', '/api/v3/core/users/', params={'email': email})['results']
        if found:
            user = found[0]
            # A link sets the password of whatever account it is for, so one for an
            # Authentik operator would hand that operator's access to whoever holds it.
            if user['type'] != 'external' or user['is_superuser']:
                raise Refused('This account is managed in Authentik itself; reset it there.')
            if not user['is_active']:
                raise Refused('This account is deactivated in Authentik.')
        else:
            user = _call(client, 'POST', '/api/v3/core/users/', json={
                'username': email, 'email': email, 'name': name,
                'type': 'external', 'path': 'users',
            })
        link = _call(client, 'POST', f'/api/v3/core/users/{user["pk"]}/recovery/',
                     json={'token_duration': f'days={LINK_VALID_DAYS}'})['link']
    return link, not found


def _call(client: httpx.Client, method: str, path: str, **kwargs) -> dict:
    try:
        resp = client.request(method, path, **kwargs)
    except httpx.HTTPError as e:
        raise Unavailable(f'Authentik could not be reached: {e}') from None
    if resp.is_error:
        raise Unavailable(f'Authentik refused {method} {path} ({resp.status_code}): {resp.text[:300]}')
    return resp.json()
