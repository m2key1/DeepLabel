import httpx

from app import config, issuer_route, password_rules

# The rules a new password has to meet are Authentik's own: this is the policy its
# password-change flow checks, applied here before a password is set through the API,
# which on its own checks nothing.
PASSWORD_POLICY = 'default-password-change-password-policy'
# What applies when that policy is missing, so a password is never set unchecked.
SHORTEST_PASSWORD = 8


class Refused(Exception):
    """Why this account may not be touched, in words meant for whoever asked."""


class Unavailable(Exception):
    """Authentik could not be reached, or did not do what it was asked."""


def enabled() -> bool:
    """Whether DeepLabel can manage accounts in Authentik: invitations, password links,
    password changes, sign-up and rejections all need the service token."""
    return bool(config.AUTHENTIK_API_TOKEN and config.OIDC_ISSUER)


def _base_url() -> str:
    return config.OIDC_ISSUER.split('/application/o/')[0]


def _client() -> httpx.Client:
    return httpx.Client(base_url=_base_url(), timeout=15,
                        headers={'Authorization': f'Bearer {config.AUTHENTIK_API_TOKEN}'},
                        **issuer_route.transport())


def _call(client: httpx.Client, method: str, path: str, **kwargs) -> dict:
    try:
        resp = client.request(method, path, **kwargs)
    except httpx.HTTPError as e:
        raise Unavailable(f'Authentik could not be reached: {e}') from None
    if resp.is_error:
        raise Unavailable(f'Authentik refused {method} {path} ({resp.status_code}): {resp.text[:300]}')
    return resp.json() if resp.content else {}


def owned(user: dict) -> dict:
    """The account, if DeepLabel may manage it. A password set here works for whatever
    account it is set on, so one for an Authentik operator would hand over their access."""
    if user['type'] != 'external' or user['is_superuser']:
        raise Refused('This account is managed in Authentik itself; change it there.')
    if not user['is_active']:
        raise Refused('This account is deactivated in Authentik.')
    return user


def find_user(*, email: str | None = None, username: str | None = None) -> dict | None:
    params = {'email': email} if email is not None else {'username': username}
    with _client() as client:
        found = _call(client, 'GET', '/api/v3/core/users/', params=params)['results']
    return found[0] if found else None


def account(*, email: str | None = None, username: str | None = None) -> dict:
    """An existing account DeepLabel may manage."""
    user = find_user(email=email, username=username)
    if user is None:
        raise Refused('There is no account for this person in Authentik.')
    return owned(user)


def create_user(email: str, name: str) -> dict:
    """A new external account, named by its email. It has no usable password until one
    is set, so it cannot sign in before that."""
    with _client() as client:
        return _call(client, 'POST', '/api/v3/core/users/', json={
            'username': email, 'email': email, 'name': name, 'type': 'external', 'path': 'users'})


def password_policy() -> dict | None:
    """The password policy Authentik's own password changes are held to, or None when this
    deployment has none."""
    with _client() as client:
        found = _call(client, 'GET', '/api/v3/policies/password/', params={'name': PASSWORD_POLICY})['results']
    return found[0] if found else None


def password_problems(password: str, account: dict | None = None) -> list[str]:
    """What is wrong with a password by Authentik's password policy; empty when it may be
    set. `account` is whose password it is, which a strength check holds the password
    against, as Authentik does."""
    policy = password_policy()
    if policy is None:
        return [] if len(password) >= SHORTEST_PASSWORD else [
            f'Password needs to be {SHORTEST_PASSWORD} characters or longer.']
    with _client() as client:
        brand = _call(client, 'GET', '/api/v3/core/brands/current/').get('branding_title', '')
    inputs = [account.get(field, '') for field in ('username', 'name', 'email')] if account else []
    return password_rules.problems(policy, password, [*inputs, brand])


def set_password(user_pk: int, password: str) -> None:
    with _client() as client:
        _call(client, 'POST', f'/api/v3/core/users/{user_pk}/set_password/', json={'password': password})


def set_active(user_pk: int, active: bool) -> None:
    with _client() as client:
        _call(client, 'PATCH', f'/api/v3/core/users/{user_pk}/', json={'is_active': active})
