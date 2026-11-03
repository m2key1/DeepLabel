"""Authentik as far as DeepLabel uses it, over one set of accounts: the login flow and the
OIDC endpoints that sign-in drives, and the admin API that manages accounts. Each answer is
shaped the way the real one was in the spike and the contract tests."""
import json
from urllib.parse import parse_qs, urlencode

import httpx

ORIGIN = 'https://idp.example.org'
ISSUER = f'{ORIGIN}/application/o/deeplabel/'
REDIRECT_URI = 'https://deeplabel.example.org/api/auth/callback'
CLIENT_ID, CLIENT_SECRET = 'client-id', 'client-secret'
TOKEN = 'ak-service-token'
FLOW = '/api/v3/flows/executor/login-flow/'
SHORTEST = 8
# The default password policy, as a fresh Authentik has it, without the strength check:
# test_password_rules.py holds that against zxcvbn itself.
POLICY = {'name': 'default-password-change-password-policy', 'password_field': 'password', 'length_min': SHORTEST,
          'amount_digits': 0, 'amount_uppercase': 0, 'amount_lowercase': 0, 'amount_symbols': 0,
          'symbol_charset': '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~ ', 'check_static_rules': True,
          'error_message': f'Password needs to be {SHORTEST} characters or longer.',
          'check_have_i_been_pwned': False, 'check_zxcvbn': False, 'zxcvbn_score_threshold': 2}
INVALID = {'password': [{'string': 'Invalid password', 'code': 'invalid'}]}


class FakeAuthentik:
    def __init__(self):
        self.users: dict[int, dict] = {}
        self.requests: list[tuple[str, str]] = []
        self.sessions: dict[str, dict] = {}
        self.extra_stage: str | None = None
        self.down = False
        self.add('service@example.org', type='internal_service_account', pk=1)

    def add(self, email: str, password: str | None = None, *, name: str = '', pk: int | None = None,
            **overrides) -> dict:
        pk = pk or max(self.users, default=10) + 1
        self.users[pk] = {'pk': pk, 'username': email, 'email': email, 'name': name, 'type': 'external',
                          'is_active': True, 'is_superuser': False, 'password': password, **overrides}
        return self.users[pk]

    def by(self, **fields) -> dict | None:
        return next((u for u in self.users.values() if all(u[k] == v for k, v in fields.items())), None)

    def _public(self, user: dict) -> dict:
        return {k: v for k, v in user.items() if k != 'password'}

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if self.down:
            raise httpx.ConnectError('connection refused')
        path = request.url.path
        self.requests.append((request.method, path))
        if path.startswith('/api/v3/') and not path.startswith(('/api/v3/flows/', '/api/v3/core/brands/')):
            assert request.headers['authorization'] == f'Bearer {TOKEN}'
            return self._admin(request, path)
        return self._login(request, path)

    def _admin(self, request: httpx.Request, path: str) -> httpx.Response:
        body = json.loads(request.content) if request.content else None
        if path == '/api/v3/core/users/' and request.method == 'GET':
            params = dict(request.url.params)
            return httpx.Response(200, json={'results': [self._public(u) for u in self.users.values()
                                                         if all(u[k] == v for k, v in params.items())]})
        if path == '/api/v3/core/users/' and request.method == 'POST':
            return httpx.Response(201, json=self._public(self.add(body['email'], name=body['name'], **{
                k: body[k] for k in ('username', 'type')})))
        if path == '/api/v3/policies/password/':
            return httpx.Response(200, json={'results': [POLICY]})
        pk = int(path.split('/')[5])
        if path.endswith('/set_password/'):
            self.users[pk]['password'] = body['password']
            return httpx.Response(204)
        if request.method == 'PATCH':
            self.users[pk].update(body)
            return httpx.Response(200, json=self._public(self.users[pk]))
        return httpx.Response(404)

    def _login(self, request: httpx.Request, path: str) -> httpx.Response:
        sid = request.headers.get('cookie', '').partition('ak=')[2].split(';')[0]
        if sid not in self.sessions:
            sid = f's{len(self.sessions)}'
            self.sessions[sid] = {'stage': 'ak-stage-identification', 'user': None, 'done': False}
        session, cookie = self.sessions[sid], {'set-cookie': f'ak={sid}; Path=/'}
        if path == '/application/o/deeplabel/.well-known/openid-configuration':
            return httpx.Response(200, json={'authorization_endpoint': f'{ORIGIN}/application/o/authorize/',
                                             'token_endpoint': f'{ORIGIN}/application/o/token/',
                                             'userinfo_endpoint': f'{ORIGIN}/application/o/userinfo/'})
        if path == '/api/v3/core/brands/current/':
            return httpx.Response(200, json={'flow_authentication': 'login-flow'})
        if path == FLOW and request.method == 'GET':
            if session['done'] == 'redirecting':
                session['done'] = True
                return httpx.Response(302, headers={'location': f'{FLOW}?query=', **cookie})
            if session['done']:
                return httpx.Response(200, json={'component': 'xak-flow-redirect', 'to': '/'}, headers=cookie)
            return httpx.Response(200, json={'component': session['stage']}, headers=cookie)
        if path == FLOW:
            answer = json.loads(request.content)
            if answer['component'] == 'ak-stage-identification':
                uid = answer['uid_field']
                session['user'] = self.by(email=uid) or self.by(username=uid)
                session['stage'] = self.extra_stage or 'ak-stage-password'
            elif answer['component'] == 'ak-stage-password':
                user = session['user']
                if not user or not user['is_active'] or not user['password'] or user['password'] != answer['password']:
                    return httpx.Response(200, headers=cookie, json={'component': 'ak-stage-password',
                                                                    'response_errors': INVALID})
                session['done'] = 'redirecting'
            return httpx.Response(302, headers={'location': f'{FLOW}?query=', **cookie})
        if path == '/application/o/authorize/':
            if session['done'] is not True:
                return httpx.Response(302, headers={'location': '/flows/-/default/authentication/'})
            params = request.url.params
            assert params['redirect_uri'] == REDIRECT_URI and params['client_id'] == CLIENT_ID
            code = f"code-{session['user']['pk']}"
            return httpx.Response(302, headers={
                'location': f"{REDIRECT_URI}?{urlencode({'code': code, 'state': params['state']})}"})
        if path == '/application/o/token/':
            form = parse_qs(request.content.decode())
            assert form['client_secret'] == [CLIENT_SECRET] and form['redirect_uri'] == [REDIRECT_URI]
            return httpx.Response(200, json={'access_token': form['code'][0].replace('code-', 'at-')})
        if path == '/application/o/userinfo/':
            user = self.users[int(request.headers['authorization'].removeprefix('Bearer at-'))]
            return httpx.Response(200, json={'sub': user['username'], 'email': user['email'],
                                             'preferred_username': user['username'], 'name': user['name']})
        return httpx.Response(404)


def install(monkeypatch, tmp_path, *, token: str = TOKEN, sign_up: bool = False) -> FakeAuthentik:
    """Point the auth service at a fresh fake Authentik and an empty database."""
    from app import authentik, config, sign_in
    fake = FakeAuthentik()
    monkeypatch.setattr(config, 'DB_PATH', tmp_path / 'auth.db')
    monkeypatch.setattr(config, 'DEV_AUTH', False)
    monkeypatch.setattr(config, 'OIDC_ISSUER', ISSUER)
    monkeypatch.setattr(config, 'OIDC_INTERNAL_URL', '')
    monkeypatch.setattr(config, 'OIDC_CLIENT_ID', CLIENT_ID)
    monkeypatch.setattr(config, 'OIDC_CLIENT_SECRET', CLIENT_SECRET)
    monkeypatch.setattr(config, 'OIDC_REDIRECT_URI', REDIRECT_URI)
    monkeypatch.setattr(config, 'AUTHENTIK_API_TOKEN', token)
    monkeypatch.setattr(config, 'SELF_SIGN_UP', sign_up)
    monkeypatch.setattr(config, 'INITIAL_ADMIN_SUBJECT', 'root@example.org')
    transport = httpx.MockTransport(fake)
    monkeypatch.setattr(sign_in, 'client', lambda: httpx.AsyncClient(
        base_url=ORIGIN, follow_redirects=False, transport=transport))
    monkeypatch.setattr(authentik, '_client', lambda: httpx.Client(
        base_url=ORIGIN, headers={'Authorization': f'Bearer {token}'}, transport=transport))
    return fake
