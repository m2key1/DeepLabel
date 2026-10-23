"""The OIDC handshake keeps its state in a cookie on the host the login started from, and the
provider always returns to OIDC_REDIRECT_URI. A login started on any other address - a
bookmarked tailnet IP, the plain HTTP port - lost that cookie and failed with a CSRF 403."""
import pytest
from fastapi.responses import RedirectResponse
from fastapi.testclient import TestClient

from app import auth, config

REDIRECT_URI = 'https://deeplabel.example.ts.net/api/auth/callback'


class FakeOAuth:
    async def authorize_redirect(self, request, redirect_uri):
        return RedirectResponse(f'https://idp.example.org/authorize?redirect_uri={redirect_uri}')


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(config, 'DB_PATH', tmp_path / 'auth.db')
    monkeypatch.setattr(config, 'DEV_AUTH', False)
    monkeypatch.setattr(config, 'OIDC_REDIRECT_URI', REDIRECT_URI)
    monkeypatch.setattr(auth, 'oauth', lambda: FakeOAuth())
    from app.main import app
    return TestClient(app, follow_redirects=False)


def test_a_login_from_another_host_moves_to_the_callback_host_first(client):
    response = client.get('http://192.0.2.10:9025/api/login')

    assert response.status_code == 307
    assert response.headers['location'] == 'https://deeplabel.example.ts.net/api/login'


def test_a_login_on_the_callback_host_goes_to_the_provider(client):
    response = client.get('http://deeplabel.example.ts.net/api/login')

    assert response.status_code == 307
    assert response.headers['location'] == f'https://idp.example.org/authorize?redirect_uri={REDIRECT_URI}'
