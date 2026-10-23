import os
from pathlib import Path

from dotenv import load_dotenv

APP_ROOT = Path(__file__).resolve().parents[2]
load_dotenv(APP_ROOT / '.env')


def _bool_env(name: str, default: str) -> bool:
    return os.environ.get(name, default).strip().lower() not in ('0', 'false', 'no', 'off')


DATA_DIR = Path(os.environ.get('AUTH_DATA_DIR', APP_ROOT / 'data')).resolve()
DB_PATH = DATA_DIR / 'auth.db'
AVATAR_DIR = DATA_DIR / 'avatars'

# The most an uploaded picture may weigh before it is refused unread. Generous for a
# photograph off a phone and far below anything that would make decoding it a denial of
# service; what is stored afterwards is a fixed-size square, whatever arrives.
AVATAR_MAX_BYTES = int(os.environ.get('AVATAR_MAX_BYTES', str(5 * 1024 * 1024)))
# What one is kept at: the square the crop dialog uploads, so the profile page's large
# picture stays sharp on a high-density screen. Lists fetch each person's picture once, by
# its version token, however many rows show it.
AVATAR_SIZE = int(os.environ.get('AVATAR_SIZE', '512'))

DEV_USER = os.environ.get('DEV_USER', 'dev')
DEV_AUTH = _bool_env('DEV_AUTH', 'false')
OIDC_ISSUER = os.environ.get('OIDC_ISSUER', '')
OIDC_CLIENT_ID = os.environ.get('OIDC_CLIENT_ID', '')
OIDC_CLIENT_SECRET = os.environ.get('OIDC_CLIENT_SECRET', '')
OIDC_REDIRECT_URI = os.environ.get('OIDC_REDIRECT_URI', '')
# Where this service itself reaches the provider, when that differs from OIDC_ISSUER's
# public address: e.g. the Authentik container on the Docker network. Browsers keep using
# OIDC_ISSUER; only this service's own calls (discovery, keys, token, user info and the
# invite API) are sent here, carrying the public host so the provider answers as itself.
OIDC_INTERNAL_URL = os.environ.get('OIDC_INTERNAL_URL', '').rstrip('/')
SESSION_SECRET = os.environ.get('SESSION_SECRET', 'dev-insecure-change-me')
SESSION_COOKIE = os.environ.get('SESSION_COOKIE', 'sid')
SESSION_TTL_DAYS = int(os.environ.get('SESSION_TTL_DAYS', '14'))
SESSION_COOKIE_SECURE = _bool_env('SESSION_COOKIE_SECURE', 'true')
INITIAL_ADMIN_SUBJECT = os.environ.get('INITIAL_ADMIN_SUBJECT', '')

# An Authentik API token that lets admins invite people from the Admin page. Leave it
# empty to keep that off. It should belong to a service account that may only view and
# add users and create recovery links; see AUTHENTIK.md.
AUTHENTIK_API_TOKEN = os.environ.get('AUTHENTIK_API_TOKEN', '')
