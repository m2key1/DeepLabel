import json
import re
from contextlib import asynccontextmanager
from urllib.parse import urlencode

from fastapi import Depends, FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response
from pydantic import BaseModel

from app import auth, authentik, avatars, config, sign_in, store


@asynccontextmanager
async def lifespan(_app: FastAPI):
    _check_auth_config()
    store.connect(config.DB_PATH).close()
    yield


app = FastAPI(title='deeplabel-auth', lifespan=lifespan)


def _session_user(request: Request):
    conn = store.connect(config.DB_PATH)
    try:
        user = store.get_user_by_session(conn, request.cookies.get(config.SESSION_COOKIE))
        if user is not None and store.seen_is_stale(user['last_seen_at']):
            store.touch_seen(conn, user['id'])
        return user
    finally:
        conn.close()


def _bearer_user(request: Request):
    """The account behind an Authorization: Bearer token, for clients that have no
    cookie to send. Returns (user, readonly) or None."""
    header = request.headers.get('Authorization', '')
    scheme, _, raw = header.partition(' ')
    if scheme.lower() != 'bearer' or not raw.strip():
        return None
    conn = store.connect(config.DB_PATH)
    try:
        row = store.get_user_by_api_token(conn, auth.hash_api_token(raw.strip()))
        if row is None:
            return None
        store.touch_api_token(conn, row['token_id'])
        return row, bool(row['readonly'])
    finally:
        conn.close()


def _caller(request: Request):
    """The session cookie first, then an API token. Returns (user, readonly) or None."""
    user = _session_user(request)
    if user is not None:
        return user, False
    return _bearer_user(request)


READ_METHODS = {'GET', 'HEAD', 'OPTIONS'}


def present_user(request: Request) -> dict:
    """Whoever is signed in, let in yet or not. A read-only token is refused any write,
    the same way the backend refuses it."""
    found = _caller(request)
    if found is None:
        raise HTTPException(401, 'not authenticated')
    user, readonly = found
    if readonly and request.method not in READ_METHODS:
        raise HTTPException(403, 'read-only API token')
    return dict(user)


WAITING = 'this account is waiting for an admin to approve it'
NEW_PASSWORD_FIRST = 'this session has to choose a new password first'


def _held_back(user) -> str | None:
    """Why a signed-in person may not go further yet, or None. A session that signed in
    with a password below the rules may only choose a new one; API tokens carry no such
    flag and keep working."""
    if user['pending']:
        return WAITING
    if dict(user).get('password_change_due'):
        return NEW_PASSWORD_FIRST
    return None


def current_user(user: dict = Depends(present_user)) -> dict:
    """Someone signed in and let in: a pending account may only say who it is."""
    why = _held_back(user)
    if why:
        raise HTTPException(403, why)
    return user


def own_session(request: Request) -> dict:
    """A signed-in browser session, let in, which may be held back only to choose a new
    password - what that very session is there to do."""
    user = _session_user(request)
    if user is None:
        if _bearer_user(request) is not None:
            raise HTTPException(403, 'needs a signed-in session, not an API token')
        raise HTTPException(401, 'not authenticated')
    if user['pending']:
        raise HTTPException(403, WAITING)
    return dict(user)


def session_user(request: Request) -> dict:
    """A signed-in browser session only. Minting tokens and administering accounts stay
    out of a token's reach, so a leaked one can neither outlive its revocation by minting
    a successor nor grant anyone more than they had."""
    user = _session_user(request)
    if user is None:
        if _bearer_user(request) is not None:
            raise HTTPException(403, 'needs a signed-in session, not an API token')
        raise HTTPException(401, 'not authenticated')
    why = _held_back(user)
    if why:
        raise HTTPException(403, why)
    return dict(user)


def require_role(*roles: str, identify=current_user):
    def dep(user: dict = Depends(identify)):
        if user['role'] not in roles:
            raise HTTPException(status_code=403, detail='not permitted')
        return user
    return dep


require_admin_session = require_role('admin', identify=session_user)


def _first_role(conn, subject: str, email: str) -> tuple[str, bool]:
    """The role a first sign-in gets, and whether it waits for an admin first: the
    bootstrap admin and the dev user are in at once, someone invited comes in with the
    role they were invited with, and anyone else waits."""
    if subject == config.INITIAL_ADMIN_SUBJECT or (config.DEV_AUTH and subject == config.DEV_USER):
        return 'admin', False
    invited = store.take_invitation(conn, email) if email else None
    return (invited, False) if invited else ('viewer', True)


def _new_session(subject: str, username: str, email: str = '', display_name: str = '',
                 must_change_password: bool = False) -> str:
    conn = store.connect(config.DB_PATH)
    try:
        role, pending = (None, False) if store.known_user(conn, subject) else _first_role(conn, subject, email)
        user = store.upsert_user(conn, subject, username, role, email=email, display_name=display_name,
                                 pending=pending)
        token = auth.new_token()
        store.create_session(conn, user['id'], token, auth.session_expiry(), must_change_password)
    finally:
        conn.close()
    return token


def _with_session(resp: Response, token: str) -> Response:
    resp.set_cookie(config.SESSION_COOKIE, token, httponly=True, samesite='lax',
                    secure=config.SESSION_COOKIE_SECURE, max_age=config.SESSION_TTL_DAYS * 86400, path='/')
    return resp


def _safe_next(path: str | None) -> str:
    """Where to go after signing in: a path on this site, never another site."""
    if not path or not path.startswith('/') or path.startswith('//') or path.startswith('/\\'):
        return '/'
    return path


@app.get('/api/login')
def login(next: str | None = None):
    """Where a visitor without a session is sent. The dev bypass signs them straight in;
    otherwise they get DeepLabel's own sign-in page, and Authentik stays out of sight."""
    if config.DEV_AUTH:
        token = _new_session(config.DEV_USER, config.DEV_USER)
        return _with_session(RedirectResponse(_safe_next(next), status_code=303), token)
    if not auth.oidc_enabled():
        raise HTTPException(503, 'authentication is not configured')
    return RedirectResponse(f'/sign-in?{urlencode({"next": _safe_next(next)})}', status_code=303)


class SignIn(BaseModel):
    email: str
    password: str
    next: str = '/'


def _client_address(request: Request) -> str:
    # Set by the frontend's nginx from the connection it accepted; the browser cannot.
    return request.headers.get('X-Real-IP') or (request.client.host if request.client else '')


@app.post('/api/sign-in')
async def sign_in_with_password(body: SignIn, request: Request):
    """Signs in on DeepLabel's own page: the auth service runs Authentik's login flow for
    the person and answers with a DeepLabel session. Wrong passwords are throttled per
    account and per address, since Authentik sees every attempt come from here."""
    if not auth.oidc_enabled():
        raise HTTPException(404, 'signing in with a password is not used here')
    email = body.email.strip()
    account = f'account:{email.lower()}'
    keys = [account, f'address:{_client_address(request)}']
    conn = store.connect(config.DB_PATH)
    try:
        wait = store.sign_in_wait(conn, keys)
        if wait:
            minutes = -(-wait // 60)
            raise HTTPException(429, {'message': f'Too many attempts - try again in {minutes} '
                                                 f'{"minute" if minutes == 1 else "minutes"}.',
                                      'retry_after': wait})
        try:
            claims = await sign_in.sign_in(email, body.password)
        except sign_in.WrongCredentials:
            store.note_sign_in_failure(conn, keys)
            raise HTTPException(400, {'message': 'Wrong email or password.'}) from None
        except sign_in.Unavailable as why:
            print(f'AUTH: sign-in failed on the provider side: {why}', flush=True)
            raise HTTPException(502, {'message': 'Signing in is not possible right now. '
                                                 'Try again in a minute, or tell an admin.'}) from None
        store.clear_sign_in_failures(conn, account)
    finally:
        conn.close()
    return _signed_in(claims, _safe_next(body.next), weak=_below_the_rules(body.password, claims))


def _below_the_rules(password: str, claims: dict) -> bool:
    """Whether a password that just signed someone in no longer meets Authentik's rules.
    Sign-in is the only moment DeepLabel sees it. Not knowing never holds anyone back."""
    if not authentik.enabled():
        return False
    try:
        return bool(authentik.password_problems(password, {
            'username': claims.get('preferred_username') or '', 'email': claims.get('email') or '',
            'name': claims.get('name') or ''}))
    except authentik.Unavailable:
        return False


def _signed_in(claims: dict, next_page: str, weak: bool = False) -> Response:
    """A DeepLabel session for whoever the provider named, and where to go now."""
    subject = claims['sub']
    username = claims.get('preferred_username') or claims.get('email') or claims.get('name') or subject
    token = _new_session(subject, username, email=claims.get('email') or '', display_name=claims.get('name') or '',
                         must_change_password=weak)
    return _with_session(JSONResponse({'next': next_page}), token)


async def _sign_in_after_setting(username: str, password: str) -> Response:
    """Sign someone in with the password they have just set, through the same flow as
    the sign-in page, so the session is exactly the one a sign-in would give."""
    try:
        claims = await sign_in.sign_in(username, password)
    except (sign_in.WrongCredentials, sign_in.Unavailable) as why:
        print(f'AUTH: signing in after setting a password failed: {why!r}', flush=True)
        raise HTTPException(502, {'message': 'Your password is set, but signing you in failed. '
                                             'Sign in on the sign-in page.'}) from None
    return _signed_in(claims, '/')


def _account_problem(why: Exception) -> HTTPException:
    if isinstance(why, authentik.Refused):
        return HTTPException(409, {'message': str(why)})
    print(f'AUTH: Authentik call failed: {why}', flush=True)
    return HTTPException(502, {'message': 'Authentik could not be reached. Try again in a minute, or tell an admin.'})


def _checked_password(password: str, account: dict | None = None) -> None:
    problems = authentik.password_problems(password, account)
    if problems:
        raise HTTPException(400, {'message': ' '.join(problems)})


def _sign_up_enabled() -> bool:
    return config.SELF_SIGN_UP and auth.oidc_enabled() and authentik.enabled()


@app.get('/api/sign-in/options')
def sign_in_options():
    """What the sign-in page may offer besides signing in."""
    return {'sign_up': _sign_up_enabled()}


@app.get('/api/sign-in/password-rules')
def password_rules_for_the_meter():
    """What a new password has to reach, for the strength meter on the account pages:
    Authentik's minimum length, and the zxcvbn score it has to exceed when it checks one.
    The server still checks every password itself."""
    policy = None
    if auth.oidc_enabled() and authentik.enabled():
        try:
            policy = authentik.password_policy()
        except authentik.Unavailable:
            policy = None
    if policy is None:
        return {'min_length': authentik.SHORTEST_PASSWORD, 'strength_check': False, 'min_score': 0}
    checked = bool(policy.get('check_zxcvbn'))
    return {'min_length': policy.get('length_min', 0) if policy.get('check_static_rules') else 0,
            'strength_check': checked,
            'min_score': policy.get('zxcvbn_score_threshold', 2) + 1 if checked else 0}


class SignUp(BaseModel):
    name: str = ''
    email: str
    password: str


@app.post('/api/sign-up')
async def sign_up(body: SignUp, request: Request):
    """A new account, made in Authentik and signed in at once. It waits for an admin to
    let it in. One address may only make a few, so the form is no way to fill Authentik."""
    if not _sign_up_enabled():
        raise HTTPException(404, {'message': 'Accounts are made by an admin here.'})
    email = body.email.strip().lower()
    if not EMAIL_RE.match(email):
        raise HTTPException(400, {'message': 'That is not an email address.'})
    address = [f'sign-up:{_client_address(request)}']
    conn = store.connect(config.DB_PATH)
    try:
        wait = store.sign_in_wait(conn, address)
        if wait:
            raise HTTPException(429, {'message': 'Too many new accounts from here - try again later.',
                                      'retry_after': wait})
        try:
            if authentik.find_user(email=email) is not None:
                raise HTTPException(409, {'message': 'There is already an account for this email. Sign in, '
                                                     'or ask an admin for a new password.'})
            _checked_password(body.password, {'username': email, 'email': email, 'name': body.name.strip()})
            made = authentik.create_user(email, body.name.strip())
            authentik.set_password(made['pk'], body.password)
        except (authentik.Refused, authentik.Unavailable) as why:
            raise _account_problem(why) from None
        store.note_sign_in_failure(conn, address)
    finally:
        conn.close()
    return await _sign_in_after_setting(made['username'], body.password)


@app.post('/api/logout')
def logout(request: Request):
    """Ends DeepLabel's session. The browser never held one of Authentik's, so there is
    nothing else to end; without the dev bypass it lands on the sign-in page."""
    conn = store.connect(config.DB_PATH)
    try:
        store.delete_session(conn, request.cookies.get(config.SESSION_COOKIE))
    finally:
        conn.close()
    resp = JSONResponse({'ok': True, 'redirect': '/api/login' if config.DEV_AUTH else '/sign-in'})
    resp.delete_cookie(config.SESSION_COOKIE, path='/')
    return resp


@app.get('/api/me')
def me(user: dict = Depends(present_user)):
    return {'id': user['id'], 'user': user.get('username') or user['subject'],
            'role': user['role'], 'capabilities': sorted(store.effective_caps(user)),
            'pending': bool(user['pending']), 'email': user['email'], 'name': user['display_name'],
            'password_change_due': bool(user.get('password_change_due')),
            'password_change': auth.oidc_enabled() and authentik.enabled()}


class UserPatch(BaseModel):
    role: str | None = None
    active: bool | None = None
    train_local: bool | None = None
    train_cluster: bool | None = None
    slurm_account: str | None = None
    # Exceptions to what the role allows, one capability at a time. Setting one back to
    # what the role says drops the exception rather than storing it.
    permissions: dict[str, bool] | None = None


# An account name as SLURM accepts it. Anything else is refused rather than escaped: the
# value travels as an HTTP header and is then interpolated into a #SBATCH directive, and
# there is no legitimate account name that needs more than this.
SLURM_ACCOUNT_RE = re.compile(r'^[A-Za-z0-9._-]{0,64}$')


@app.get('/api/users')
def get_users(_admin=Depends(require_admin_session)):
    conn = store.connect(config.DB_PATH)
    try:
        # The catalogue travels with the accounts, so the admin page shows exactly the
        # capabilities this build has rather than a copy of the list that can drift.
        return {'users': [_user_payload(u) for u in store.list_users(conn)],
                'capabilities': list(store.CAPABILITIES),
                # What each role allows, which the admin page shows as the line a person's
                # exceptions break.
                'roles': {role: sorted(caps) for role, caps in store.ROLE_CAPS.items()},
                'invitations': auth.oidc_enabled() and authentik.enabled()}
    finally:
        conn.close()


@app.put('/api/users/me/avatar')
def set_my_avatar(file: UploadFile = File(...), user: dict = Depends(current_user)):
    """A picture of the person signed in. Only ever their own - a picture is the one thing
    on an account that is theirs to choose, and an admin changing it would be odd rather
    than useful. A plain def, so the decoding runs in the threadpool, off the event loop
    every /validate waits on."""
    raw = file.file.read(config.AVATAR_MAX_BYTES + 1)
    try:
        token = avatars.store(user['id'], raw)
    except avatars.Refused as why:
        raise HTTPException(400, str(why)) from None
    conn = store.connect(config.DB_PATH)
    try:
        store.set_avatar(conn, user['id'], token)
    finally:
        conn.close()
    return {'avatar': avatars.url_for(user.get('username') or user['subject'], token)}


@app.delete('/api/users/me/avatar')
def clear_my_avatar(user: dict = Depends(current_user)):
    """Back to the initials."""
    avatars.remove(user['id'])
    conn = store.connect(config.DB_PATH)
    try:
        store.set_avatar(conn, user['id'], '')
    finally:
        conn.close()
    return {'avatar': None}


@app.get('/api/users/{username}/avatar')
def get_avatar(username: str, _user: dict = Depends(current_user)):
    """Someone's picture, by the name the rest of the app knows them as - a dataset's
    owner and a line's author are both recorded that way, so it is the only handle the
    table has. Anyone signed in may see one; they are shown beside the datasets already."""
    conn = store.connect(config.DB_PATH)
    try:
        row = store.get_user_by_username(conn, username)
    finally:
        conn.close()
    if row is None or not row['avatar']:
        raise HTTPException(404)
    path = avatars.path_for(row['id'])
    if not path.exists():
        raise HTTPException(404)
    # The version is in the URL, so a picture that is still there is the one that was
    # asked for and can be kept for as long as the browser likes.
    return FileResponse(path, media_type='image/png',
                        headers={'Cache-Control': 'public, max-age=31536000, immutable'})


@app.get('/api/users/avatars')
def get_avatars(_user: dict = Depends(current_user)):
    """Who has a picture and where it is, for everyone signed in - a viewer included, who
    sees colleagues in the presence list like anyone else. Unlike the names list it tells
    nobody who exists without one."""
    conn = store.connect(config.DB_PATH)
    try:
        rows = store.list_users(conn)
    finally:
        conn.close()
    pictures = {(u['username'] or u['subject']): avatars.url_for(u['username'] or u['subject'], u['avatar'])
                for u in rows if u['active'] and u['avatar']}
    return {'avatars': pictures}


@app.get('/api/people/{username}')
def get_person(username: str, user: dict = Depends(current_user)):
    """Who someone is, for their profile page: open to everyone signed in, since the name,
    picture and role already show beside their work. The email is the person's own and
    an admin's to read, not a colleague's."""
    conn = store.connect(config.DB_PATH)
    try:
        row = store.get_user_by_username(conn, username)
    finally:
        conn.close()
    if row is None:
        raise HTTPException(404)
    name = row['username'] or row['subject']
    person = {'username': name, 'display_name': row['display_name'],
              'avatar': avatars.url_for(name, row['avatar']) or '',
              'role': row['role'], 'created_at': row['created_at']}
    if user['role'] == 'admin' or user['id'] == row['id']:
        person['email'] = row['email']
    return person


@app.get('/api/users/names', dependencies=[Depends(require_role('admin', 'member'))])
def get_user_names():
    """Just usernames, for assignment pickers - members may not read roles or status."""
    conn = store.connect(config.DB_PATH)
    try:
        rows = store.list_users(conn)
    finally:
        conn.close()
    return {'users': [{'id': u['id'], 'username': u['username'] or u['subject'],
                       'display_name': u['display_name'],
                       'avatar': avatars.url_for(u['username'] or u['subject'], u['avatar'])}
                      for u in rows if u['active']]}


class Invitation(BaseModel):
    email: str
    name: str = ''
    role: str = 'viewer'


EMAIL_RE = re.compile(r'^[^@\s]+@[^@\s]+\.[^@\s]+$')
LINK_VALID_DAYS = 7


def _require_accounts():
    if not (auth.oidc_enabled() and authentik.enabled()):
        raise HTTPException(503, {'message': 'Accounts cannot be managed here (no AUTHENTIK_API_TOKEN).'})


def _password_link(conn, *, purpose: str, account: dict, created_by: str) -> dict:
    """A one-time link to DeepLabel's own set-password page. The path only: the page that
    shows it adds the address the admin reached DeepLabel on."""
    token = auth.new_token()
    store.create_password_link(conn, auth.hash_api_token(token), purpose=purpose, email=account['email'],
                               username=account['username'], account_pk=account['pk'],
                               created_by=created_by, valid_days=LINK_VALID_DAYS)
    return {'link': f'/set-password?token={token}', 'valid_days': LINK_VALID_DAYS}


@app.post('/api/users/invitations')
def invite_user(body: Invitation, me: dict = Depends(require_admin_session)):
    """A link the person opens to set their password: a new account for an unknown email,
    a reset for one DeepLabel already knows. The admin sends it themselves, so no mail
    server is needed. Whoever is invited comes in with this role, without waiting."""
    _require_accounts()
    email = body.email.strip().lower()
    if not EMAIL_RE.match(email):
        raise HTTPException(400, {'message': 'That is not an email address.'})
    if body.role not in store.ROLES:
        raise HTTPException(400, {'message': 'No such role.'})
    try:
        found = authentik.find_user(email=email)
        account = authentik.create_user(email, body.name.strip()) if found is None else authentik.owned(found)
    except (authentik.Refused, authentik.Unavailable) as why:
        raise _account_problem(why) from None
    conn = store.connect(config.DB_PATH)
    try:
        known = store.get_user_by_email(conn, email)
        if known is None:
            store.invite(conn, email, body.role, _actor(me))
        else:
            store.log_user_change(conn, known['id'], _actor(me), 'password_link', '', 'issued')
            conn.commit()
        link = _password_link(conn, purpose='reset' if known else 'invite', account=account, created_by=_actor(me))
    finally:
        conn.close()
    return {**link, 'created': found is None, 'known': known is not None}


@app.post('/api/users/{user_id}/password-link')
def reset_password_link(user_id: int, me: dict = Depends(require_admin_session)):
    """A one-time link with which this person sets a new password. Their current one keeps
    working until the link is used."""
    _require_accounts()
    conn = store.connect(config.DB_PATH)
    try:
        user = store.get_user(conn, user_id)
        if user is None:
            raise HTTPException(404)
        try:
            account = authentik.account(username=user['subject'])
        except (authentik.Refused, authentik.Unavailable) as why:
            raise _account_problem(why) from None
        link = _password_link(conn, purpose='reset', account=account, created_by=_actor(me))
        store.log_user_change(conn, user_id, _actor(me), 'password_link', '', 'issued')
        conn.commit()
    finally:
        conn.close()
    return link


def _open_link(conn, token: str):
    row = store.password_link(conn, auth.hash_api_token(token))
    if row is None:
        raise HTTPException(410, {'message': 'This link has expired or was already used. Ask an admin for a new one.'})
    return row


@app.get('/api/set-password')
def password_link_info(token: str):
    """Who a password link is for, so the page can say whose password is being set."""
    conn = store.connect(config.DB_PATH)
    try:
        row = _open_link(conn, token)
    finally:
        conn.close()
    return {'email': row['email'], 'purpose': row['purpose']}


class SetPassword(BaseModel):
    token: str
    password: str


@app.post('/api/set-password')
async def set_password_with_link(body: SetPassword):
    """Set the password a link is for, spend the link, end the person's other sessions,
    and sign them in with it."""
    conn = store.connect(config.DB_PATH)
    try:
        row = _open_link(conn, body.token)
        try:
            _checked_password(body.password, {'username': row['username'], 'email': row['email']})
            authentik.set_password(row['account_pk'], body.password)
        except (authentik.Refused, authentik.Unavailable) as why:
            raise _account_problem(why) from None
        store.spend_password_link(conn, row['token_hash'])
        known = store.known_user(conn, row['username'])
        if known is not None:
            store.revoke_sessions(conn, known['id'])
            store.log_user_change(conn, known['id'], LINK_ACTOR, 'password', '', 'set')
            conn.commit()
    finally:
        conn.close()
    return await _sign_in_after_setting(row['username'], body.password)


LINK_ACTOR = 'password link'


class NewPassword(BaseModel):
    password: str


@app.post('/api/users/me/password')
def change_my_password(body: NewPassword, request: Request, me: dict = Depends(own_session)):
    """A new password for the person signed in. The session they are using is the proof,
    so the old password is not asked; every other session of theirs ends."""
    _require_accounts()
    try:
        account = authentik.account(username=me['subject'])
        _checked_password(body.password, account)
        authentik.set_password(account['pk'], body.password)
    except (authentik.Refused, authentik.Unavailable) as why:
        raise _account_problem(why) from None
    conn = store.connect(config.DB_PATH)
    try:
        ended = store.revoke_other_sessions(conn, me['id'], request.cookies.get(config.SESSION_COOKIE))
        store.password_changed(conn, request.cookies.get(config.SESSION_COOKIE))
        store.log_user_change(conn, me['id'], _actor(me), 'password', '', 'changed')
        conn.commit()
    finally:
        conn.close()
    return {'ended_sessions': ended}


@app.get('/api/users/pending')
def pending_count(_admin=Depends(require_admin_session)):
    """How many sign-ups wait for an admin, for the badge on Admin."""
    conn = store.connect(config.DB_PATH)
    try:
        return {'count': store.count_pending(conn)}
    finally:
        conn.close()


class Approval(BaseModel):
    role: str = 'viewer'


def _pending(conn, user_id: int):
    user = store.get_user(conn, user_id)
    if user is None:
        raise HTTPException(404)
    if not user['pending']:
        raise HTTPException(409, {'message': 'This account is not waiting for approval.'})
    return user


@app.post('/api/users/{user_id}/approve')
def approve(user_id: int, body: Approval, me: dict = Depends(require_admin_session)):
    if body.role not in store.ROLES:
        raise HTTPException(400, {'message': 'No such role.'})
    conn = store.connect(config.DB_PATH)
    try:
        _pending(conn, user_id)
        store.approve_user(conn, user_id, body.role)
        store.log_user_change(conn, user_id, _actor(me), 'approved', 'pending', body.role)
        conn.commit()
        return _user_payload(store.get_user(conn, user_id))
    finally:
        conn.close()


@app.post('/api/users/{user_id}/reject')
def reject(user_id: int, me: dict = Depends(require_admin_session)):
    """Turn a sign-up away: the account is switched off here and in Authentik, so it can
    neither come in nor sign in again."""
    conn = store.connect(config.DB_PATH)
    try:
        user = _pending(conn, user_id)
        if authentik.enabled():
            try:
                authentik.set_active(authentik.account(username=user['subject'])['pk'], False)
            except authentik.Refused:
                pass
            except authentik.Unavailable as why:
                raise _account_problem(why) from None
        store.set_user_active(conn, user_id, False)
        conn.execute('UPDATE users SET pending = 0 WHERE id = ?', (user_id,))
        store.log_user_change(conn, user_id, _actor(me), 'rejected', 'pending', 'disabled')
        conn.commit()
        return _user_payload(store.get_user(conn, user_id))
    finally:
        conn.close()


@app.patch('/api/users/{user_id}')
def patch_user(user_id: int, body: UserPatch, me: dict = Depends(require_admin_session)):
    if user_id == me['id'] and (body.role is not None or body.active is not None):
        raise HTTPException(400, 'cannot change your own role or status')
    if body.role is not None and body.role not in store.ROLES:
        raise HTTPException(400, 'invalid role')
    for cap in body.permissions or {}:
        if cap not in store.CAPABILITIES:
            raise HTTPException(400, f'no such capability: {cap}')
    if body.slurm_account is not None:
        body.slurm_account = body.slurm_account.strip()
        if not SLURM_ACCOUNT_RE.match(body.slurm_account):
            raise HTTPException(400, 'a SLURM account may only contain letters, digits, dot, '
                                     'dash and underscore')
    conn = store.connect(config.DB_PATH)
    try:
        before = store.get_user(conn, user_id)
        if before is None:
            raise HTTPException(404)
        role_name = body.role or before['role']
        if role_name == 'viewer' and _grants_anything(body):
            raise HTTPException(409, f'{_actor(dict(before))} is a viewer, and a viewer may not write '
                                     'at all - promote the account to member before granting it anything')
        if role_name != before['role']:
            # Exceptions were made against the old role, so the new one starts clean.
            dropped = {'exceptions': store.overrides_of(before), 'dormant_grants': store.dormant_grants(before)}
            store.set_user_role(conn, user_id, role_name)
            store.log_user_change(conn, user_id, _actor(me), 'role', before['role'], role_name)
            store.clear_exceptions(conn, user_id)
            for field, grants in dropped.items():
                if grants:
                    store.log_user_change(conn, user_id, _actor(me), field,
                                          json.dumps(grants, sort_keys=True), '{}')
            before = store.get_user(conn, user_id)
        if body.permissions is not None:
            # A member's training capabilities live in their grant columns, so a tick in
            # the matrix is the same change as one in the Training column.
            for cap, column in store.grant_columns(role_name).items():
                if cap in body.permissions:
                    setattr(body, column, body.permissions.pop(cap))
            wanted = {**store.stored_overrides(before), **body.permissions}
            role = store.role_caps(role_name)
            overrides = {cap: allowed for cap, allowed in wanted.items()
                         if allowed is not (cap in role)}
            if overrides != store.stored_overrides(before):
                store.set_user_permissions(conn, user_id, overrides)
                for cap in sorted(set(overrides) | set(store.stored_overrides(before))):
                    was = cap in store.effective_caps(before)
                    now = overrides.get(cap, cap in role)
                    if was != now:
                        store.log_user_change(conn, user_id, _actor(me), cap,
                                              str(int(was)), str(int(now)))
        changes = {
            'role': (body.role, store.set_user_role),
            'active': (body.active, store.set_user_active),
            'train_local': (body.train_local, store.set_user_train_local),
            'train_cluster': (body.train_cluster, store.set_user_train_cluster),
            'slurm_account': (body.slurm_account, store.set_user_slurm_account),
        }
        for field, (value, apply) in changes.items():
            if value is None or _same_setting(before[field], value):
                continue
            apply(conn, user_id, value)
            store.log_user_change(conn, user_id, _actor(me), field, before[field], _setting_text(value))
        conn.commit()
        return _user_payload(store.get_user(conn, user_id))
    finally:
        conn.close()


def _grants_anything(body: UserPatch) -> bool:
    return any((body.permissions or {}).values()) or bool(body.train_local) or bool(body.train_cluster)


def _user_payload(row) -> dict:
    """An account as the admin page reads it: its stored exceptions, and the set those
    come out to - so the page can show what is inherited and what was overridden."""
    user = dict(row)
    user['permissions'] = store.overrides_of(row)
    user['capabilities'] = sorted(store.effective_caps(row))
    return user


def _actor(user: dict) -> str:
    return user.get('username') or user['subject']


def _setting_text(value) -> str:
    """Flags are stored as 0/1, so the log reads the same as the column does."""
    return str(int(value)) if isinstance(value, bool) else str(value)


def _same_setting(stored, requested) -> bool:
    return str(stored) == _setting_text(requested)


@app.delete('/api/users/{user_id}/sessions')
def revoke_user_sessions(user_id: int, me: dict = Depends(require_admin_session)):
    """Sign a person out of every browser at once - a lost laptop, a shared machine.
    Your own sessions are left alone: that is what Log out is for."""
    if user_id == me['id']:
        raise HTTPException(400, 'cannot revoke your own sessions here')
    conn = store.connect(config.DB_PATH)
    try:
        if store.get_user(conn, user_id) is None:
            raise HTTPException(404)
        revoked = store.revoke_sessions(conn, user_id)
        store.log_user_change(conn, user_id, _actor(me), 'sessions', str(revoked), '0')
        conn.commit()
    finally:
        conn.close()
    return {'revoked': revoked}


@app.get('/api/users/{user_id}/audit')
def get_user_audit(user_id: int, _admin=Depends(require_admin_session)):
    """What changed on this account and who did it, newest first."""
    conn = store.connect(config.DB_PATH)
    try:
        if store.get_user(conn, user_id) is None:
            raise HTTPException(404)
        return {'entries': [dict(e) for e in store.list_user_audit(conn, user_id)]}
    finally:
        conn.close()


@app.get('/api/settings')
def get_settings(user: dict = Depends(current_user)):
    conn = store.connect(config.DB_PATH)
    try:
        return json.loads(store.get_user_settings(conn, user['id']) or '{}')
    finally:
        conn.close()


@app.put('/api/settings')
def put_settings(body: dict, user: dict = Depends(current_user)):
    """Replace the whole document. Prefer PATCH from the app: a client that sends
    everything it last read overwrites whatever changed meanwhile."""
    conn = store.connect(config.DB_PATH)
    try:
        store.set_user_settings(conn, user['id'], json.dumps(body))
    finally:
        conn.close()
    return body


@app.patch('/api/settings')
def patch_settings(body: dict, user: dict = Depends(current_user)):
    """Write the named settings and return the document they landed in."""
    conn = store.connect(config.DB_PATH)
    try:
        return store.merge_user_settings(conn, user['id'], body)
    finally:
        conn.close()


class TokenCreate(BaseModel):
    name: str = ''
    readonly: bool = False
    expires_days: int | None = None


def _token_payload(row) -> dict:
    token = dict(row)
    token['readonly'] = bool(token['readonly'])
    token['expired'] = bool(token.get('expired'))
    for secret in ('token_hash', 'subject'):
        token.pop(secret, None)
    return token


@app.get('/api/tokens')
def get_tokens(user: dict = Depends(session_user)):
    """The caller's own tokens, whatever their role: this backs the personal Settings
    page, which is nobody else's business. Everyone's is /api/admin/tokens."""
    conn = store.connect(config.DB_PATH)
    try:
        rows = store.list_api_tokens(conn, user['id'])
    finally:
        conn.close()
    return {'tokens': [_token_payload(r) for r in rows]}


@app.get('/api/admin/tokens')
def get_all_tokens(_admin=Depends(require_admin_session)):
    """Every token, for the Admin page - a leaked one has to be revocable by someone."""
    conn = store.connect(config.DB_PATH)
    try:
        rows = store.list_api_tokens(conn)
    finally:
        conn.close()
    return {'tokens': [_token_payload(r) for r in rows]}


@app.post('/api/tokens')
def post_token(body: TokenCreate, user: dict = Depends(session_user)):
    """The only moment the token itself exists outside the client: only its hash is
    stored, so a lost token is replaced rather than recovered."""
    name = body.name.strip()
    if not name:
        raise HTTPException(400, 'name must not be empty')
    if body.expires_days is not None and body.expires_days < 1:
        raise HTTPException(400, 'expires_days must be at least 1')
    token = auth.new_api_token()
    conn = store.connect(config.DB_PATH)
    try:
        row = store.create_api_token(conn, user['id'], name, auth.hash_api_token(token),
                                     auth.api_token_prefix(token), body.readonly,
                                     auth.api_token_expiry(body.expires_days))
    finally:
        conn.close()
    return {**_token_payload(row), 'token': token}


@app.delete('/api/tokens/{token_id}')
def delete_token(token_id: int, user: dict = Depends(session_user)):
    conn = store.connect(config.DB_PATH)
    try:
        deleted = store.delete_api_token(conn, token_id,
                                         None if user['role'] == 'admin' else user['id'])
    finally:
        conn.close()
    if not deleted:
        raise HTTPException(404)
    return {'ok': True}


@app.get('/validate')
def validate(request: Request):
    """Frontend auth_request target: resolve the session cookie - or an API token, for
    scripts - to identity headers the frontend forwards to the backend, or 401 so the
    SPA bounces to /api/login."""
    found = _caller(request)
    if found is None:
        return Response(status_code=401)
    user, readonly = found
    if _held_back(user):
        return Response(status_code=403)
    username = (user['username'] or user['subject']).replace('\n', ' ').replace('\r', ' ')
    headers = {'X-Auth-User': username, 'X-Auth-Role': user['role']}
    if readonly:
        headers['X-Auth-Readonly'] = '1'
    # What this person may do, resolved here so the backend never has to know which role
    # implies what. Space-separated: the names are dotted ASCII and nothing else.
    caps = store.effective_caps(user)
    headers['X-Auth-Caps'] = ' '.join(sorted(caps))
    # The two training headers that predate the set, for a gateway or backend that has not
    # learned it yet. Derived from it, so they can never grant what it does not.
    if 'train.local' in caps:
        headers['X-Auth-Train-Local'] = '1'
    if 'train.cluster' in caps:
        headers['X-Auth-Train-Cluster'] = '1'
    if SLURM_ACCOUNT_RE.match(user['slurm_account'] or '') and user['slurm_account']:
        headers['X-Auth-Slurm-Account'] = user['slurm_account']
    return Response(status_code=200, headers=headers)


def _check_auth_config():
    """Surface auth misconfiguration at boot, where it shows in the logs, instead of
    letting it manifest as every request silently returning 401."""
    if config.DEV_AUTH:
        print('AUTH: DEV_AUTH is on - login is bypassed and everyone is admin. '
              'Never enable this in production.', flush=True)
        return
    if not config.OIDC_ISSUER:
        print('AUTH: DEV_AUTH is off and OIDC_ISSUER is unset - every /api request will 401. '
              'Configure OIDC_* (see .env.example), or set DEV_AUTH=1 on a dev box.', flush=True)
        return
    missing = [n for n in ('OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'OIDC_REDIRECT_URI')
               if not getattr(config, n)]
    if missing:
        print(f'AUTH: OIDC_ISSUER is set but {", ".join(missing)} missing - login will fail.', flush=True)
    if not config.INITIAL_ADMIN_SUBJECT:
        print('AUTH: INITIAL_ADMIN_SUBJECT is unset - the first sign-in becomes a member and no one '
              'can manage roles. Set it to your OIDC subject to bootstrap an admin.', flush=True)
    print(f'AUTH: signing in through {config.OIDC_ISSUER}', flush=True)
