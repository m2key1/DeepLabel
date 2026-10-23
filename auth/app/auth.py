import hashlib
import secrets
from datetime import datetime, timedelta, timezone

from app import config, issuer_route

_oauth = None


def oidc_enabled() -> bool:
    return not config.DEV_AUTH and bool(config.OIDC_ISSUER)


def oauth():
    """The Authlib OIDC client, built lazily against the discovery document.
    Returns None in dev-bypass mode or when OIDC is not configured."""
    global _oauth
    if not oidc_enabled():
        return None
    if _oauth is None:
        from authlib.integrations.starlette_client import OAuth
        _oauth = OAuth().register(
            name='pocketid',
            client_id=config.OIDC_CLIENT_ID,
            client_secret=config.OIDC_CLIENT_SECRET,
            server_metadata_url=config.OIDC_ISSUER.rstrip('/') + '/.well-known/openid-configuration',
            client_kwargs={'scope': 'openid profile email', **issuer_route.async_transport()},
        )
    return _oauth


def new_token() -> str:
    return secrets.token_urlsafe(32)


def session_expiry() -> str:
    when = datetime.now(timezone.utc) + timedelta(days=config.SESSION_TTL_DAYS)
    return when.strftime('%Y-%m-%d %H:%M:%S')


API_TOKEN_PREFIX = 'dlp_'


def new_api_token() -> str:
    return API_TOKEN_PREFIX + secrets.token_urlsafe(32)


def hash_api_token(token: str) -> str:
    """Plain SHA-256: the token is 256 bits of system randomness, so there is no
    low-entropy secret for a slow KDF to protect."""
    return hashlib.sha256(token.encode()).hexdigest()


def api_token_prefix(token: str) -> str:
    return token[:12]


def api_token_expiry(days: int | None) -> str | None:
    if not days:
        return None
    return (datetime.now(timezone.utc) + timedelta(days=days)).strftime('%Y-%m-%d %H:%M:%S')
