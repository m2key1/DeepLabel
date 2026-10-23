import json
import tomllib
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import store
from app.deps import get_db
from app.main import app

REPO = Path(__file__).resolve().parents[2]
SECRET = 'test-secret'


def pyproject_version(package: str) -> str:
    return tomllib.loads((REPO / package / 'pyproject.toml').read_text())['project']['version']


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    conn = store.connect(tmp_path / 'app.db')
    app.dependency_overrides[get_db] = lambda: conn
    yield TestClient(app)
    app.dependency_overrides.clear()
    conn.close()


def meta(client):
    return client.get('/api/meta', headers={'X-Frontend-Secret': SECRET, 'X-Auth-User': 'alice',
                                            'X-Auth-Role': 'viewer'})


def test_every_package_carries_the_same_version():
    frontend = json.loads((REPO / 'frontend' / 'package.json').read_text())['version']
    assert {pyproject_version('backend'), pyproject_version('auth'), pyproject_version('client'), frontend} \
        == {'0.1.0'}


def test_meta_names_the_version_and_the_commit_the_image_was_built_from(client, monkeypatch):
    monkeypatch.setattr('app.config.GIT_COMMIT', 'a1b2c3d')
    response = meta(client)
    assert response.status_code == 200
    assert response.json() == {'version': '0.1.0', 'commit': 'a1b2c3d'}


def test_an_image_built_without_a_commit_says_so(client, monkeypatch):
    monkeypatch.setattr('app.config.GIT_COMMIT', '')
    assert meta(client).json() == {'version': '0.1.0', 'commit': None}
