"""Authentik, as far as DeepLabel uses it: the brand, the login flow's executor, the
authorization endpoint, the token exchange and the user info for signing in, and the admin
API for managing accounts. Each step answers the way the real one does, down to a POST
redirecting back to the executor.

Accounts: root@example.org / copper willow tandem fjord (the bootstrap admin),
anna@example.org / quartz lantern orbit meadow, olaf@example.org / olaf1234 (long enough,
but too easy to guess), and locked@example.org, whose password nobody knows, for the throttle."""
import json
import secrets
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlencode, urlsplit

ISSUER_PATH = '/application/o/deeplabel/'
FLOW = '/api/v3/flows/executor/default-authentication-flow/'
TOKEN = 'e2e-authentik-token'
SHORTEST = 8

users: dict[int, dict] = {}
sessions: dict[str, dict] = {}
codes: dict[str, int] = {}
tokens: dict[str, int] = {}


def add(email: str, password: str | None, name: str = '', **overrides) -> dict:
    pk = max(users, default=10) + 1
    users[pk] = {'pk': pk, 'username': email, 'email': email, 'name': name, 'type': 'external',
                 'is_active': True, 'is_superuser': False, 'password': password, **overrides}
    return users[pk]


add('service@example.org', None, type='internal_service_account')
add('root@example.org', 'copper willow tandem fjord', 'Root Admin')
add('anna@example.org', 'quartz lantern orbit meadow', 'Anna Example')
add('olaf@example.org', 'olaf1234', 'Olaf Example')
add('locked@example.org', secrets.token_hex(16))


def public(user: dict) -> dict:
    return {k: v for k, v in user.items() if k != 'password'}


def find(**fields) -> dict | None:
    return next((u for u in users.values() if all(u[k] == v for k, v in fields.items())), None)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _session(self) -> tuple[str, dict]:
        cookie = self.headers.get('Cookie', '')
        sid = next((part.split('=', 1)[1] for part in cookie.split('; ') if part.startswith('ak=')), '')
        if sid not in sessions:
            sid = secrets.token_hex(8)
            sessions[sid] = {'stage': 'ak-stage-identification', 'user': None, 'done': False}
        return sid, sessions[sid]

    def _send(self, status: int, body: dict | None = None, location: str | None = None, sid: str | None = None):
        self.send_response(status)
        if location:
            self.send_header('Location', location)
        if sid:
            self.send_header('Set-Cookie', f'ak={sid}; Path=/')
        data = json.dumps(body).encode() if body is not None else b''
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _admin(self, method: str, url, body: dict | None) -> None:
        if self.headers.get('Authorization') != f'Bearer {TOKEN}':
            return self._send(403, {'detail': 'not this token'})
        path = url.path
        if path == '/api/v3/core/users/' and method == 'GET':
            wanted = {k: v[0] for k, v in parse_qs(url.query).items()}
            return self._send(200, {'results': [public(u) for u in users.values()
                                                if all(u.get(k) == v for k, v in wanted.items())]})
        if path == '/api/v3/core/users/' and method == 'POST':
            return self._send(201, public(add(body['email'], None, body.get('name', ''),
                                              username=body['username'], type=body['type'])))
        if path == '/api/v3/policies/password/':
            return self._send(200, {'results': [{
                'name': 'default-password-change-password-policy', 'password_field': 'password',
                'length_min': SHORTEST, 'amount_digits': 0, 'amount_uppercase': 0, 'amount_lowercase': 0,
                'amount_symbols': 0, 'check_static_rules': True, 'check_have_i_been_pwned': False,
                'error_message': f'Password needs to be {SHORTEST} characters or longer.',
                # As a fresh Authentik has it: guessable passwords are refused.
                'check_zxcvbn': True, 'zxcvbn_score_threshold': 2}]})
        parts = path.strip('/').split('/')
        if parts[:4] == ['api', 'v3', 'core', 'users'] and len(parts) >= 5 and int(parts[4]) in users:
            user = users[int(parts[4])]
            if parts[5:] == ['set_password']:
                user['password'] = body['password']
                return self._send(204)
            if method == 'PATCH':
                user.update(body)
                return self._send(200, public(user))
        self._send(404, {'detail': 'not found'})

    def do_GET(self):
        url = urlsplit(self.path)
        if url.path.startswith('/api/v3/') and not url.path.startswith(('/api/v3/flows/', '/api/v3/core/brands/')):
            return self._admin('GET', url, None)
        sid, session = self._session()
        if url.path == ISSUER_PATH + '.well-known/openid-configuration':
            base = f"http://{self.headers['Host']}"
            return self._send(200, {'issuer': base + ISSUER_PATH,
                                    'authorization_endpoint': base + '/application/o/authorize/',
                                    'token_endpoint': base + '/application/o/token/',
                                    'userinfo_endpoint': base + '/application/o/userinfo/'})
        if url.path == '/api/v3/core/brands/current/':
            return self._send(200, {'flow_authentication': 'default-authentication-flow'})
        if url.path == FLOW:
            if session['done'] == 'redirecting':
                session['done'] = True
                return self._send(302, location=f'{FLOW}?query=', sid=sid)
            if session['done']:
                return self._send(200, {'component': 'xak-flow-redirect', 'to': '/'}, sid=sid)
            return self._send(200, {'component': session['stage']}, sid=sid)
        if url.path == '/application/o/authorize/':
            params = {k: v[0] for k, v in parse_qs(url.query).items()}
            if session['done'] is not True:
                return self._send(302, location='/flows/-/default/authentication/')
            code = secrets.token_hex(8)
            codes[code] = session['user']['pk']
            return self._send(302, location=f"{params['redirect_uri']}?{urlencode({'code': code, 'state': params['state']})}")
        if url.path == '/application/o/userinfo/':
            pk = tokens.get(self.headers.get('Authorization', '').removeprefix('Bearer '))
            if pk is None:
                return self._send(401, {'detail': 'no such token'})
            user = users[pk]
            return self._send(200, {'sub': user['username'], 'email': user['email'],
                                    'preferred_username': user['username'], 'name': user['name']})
        self._send(404, {'detail': 'not found'})

    def _body(self) -> bytes:
        return self.rfile.read(int(self.headers.get('Content-Length') or 0))

    def do_PATCH(self):
        self._admin('PATCH', urlsplit(self.path), json.loads(self._body() or b'{}'))

    def do_POST(self):
        url = urlsplit(self.path)
        body = self._body()
        if url.path.startswith('/api/v3/') and not url.path.startswith(('/api/v3/flows/', '/api/v3/core/brands/')):
            return self._admin('POST', url, json.loads(body or b'{}'))
        sid, session = self._session()
        if url.path == FLOW:
            answer = json.loads(body)
            if answer['component'] == 'ak-stage-identification':
                uid = answer['uid_field']
                session['user'] = find(email=uid) or find(username=uid)
                session['stage'] = 'ak-stage-password'
            elif answer['component'] == 'ak-stage-password':
                user = session['user']
                if not user or not user['is_active'] or not user['password'] or user['password'] != answer['password']:
                    return self._send(200, {'component': 'ak-stage-password', 'response_errors': {
                        'password': [{'string': 'Invalid password', 'code': 'invalid'}]}}, sid=sid)
                session['done'] = 'redirecting'
            return self._send(302, location=f'{FLOW}?query=', sid=sid)
        if url.path == '/application/o/token/':
            form = {k: v[0] for k, v in parse_qs(body.decode()).items()}
            pk = codes.pop(form.get('code', ''), None)
            if pk is None or form.get('client_secret') != 'e2e-client-secret':
                return self._send(400, {'error': 'invalid_grant'})
            token = secrets.token_hex(16)
            tokens[token] = pk
            return self._send(200, {'access_token': token, 'token_type': 'Bearer'})
        self._send(404, {'detail': 'not found'})


if __name__ == '__main__':
    ThreadingHTTPServer(('0.0.0.0', 9000), Handler).serve_forever()
