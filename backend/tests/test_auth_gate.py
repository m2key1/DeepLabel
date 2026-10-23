"""The middleware every API call passes through. It is the whole authentication boundary:
the backend trusts headers, and nginx is what puts them there, so a request that reaches
it without the shared secret has not come through the front door.
"""
import pytest
from fastapi.testclient import TestClient

from app import store
from app.deps import get_db
from app.main import app

SECRET = 'test-secret'


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    conn = store.connect(tmp_path / 'app.db')
    app.dependency_overrides[get_db] = lambda: conn
    yield TestClient(app)
    app.dependency_overrides.clear()
    conn.close()


def headers(**overrides):
    base = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'alice', 'X-Auth-Role': 'member'}
    base.update(overrides)
    return {k: v for k, v in base.items() if v is not None}


class TestTheSharedSecret:
    def test_a_request_without_it_never_reaches_a_route(self, client):
        response = client.get('/api/jobs', headers={'X-Auth-User': 'alice', 'X-Auth-Role': 'admin'})

        assert response.status_code == 403
        assert response.json()['detail'] == 'forbidden'

    def test_a_wrong_one_is_refused_the_same_way(self, client):
        assert client.get('/api/jobs', headers=headers(**{'X-Frontend-Secret': 'guessed'})
                          ).status_code == 403

    def test_a_deployment_that_configured_none_refuses_everything(self, client, monkeypatch):
        """Rather than accepting everything, which is how this fails open."""
        monkeypatch.setattr('app.config.FRONTEND_SECRET', '')

        assert client.get('/api/jobs', headers=headers()).status_code == 403


class TestWhoIsAsking:
    def test_a_request_with_no_identity_is_not_authenticated(self, client):
        response = client.get('/api/jobs', headers=headers(**{'X-Auth-User': None}))

        assert response.status_code == 401
        assert response.json()['detail'] == 'not authenticated'

    def test_an_identity_with_no_role_is_not_authenticated_either(self, client):
        assert client.get('/api/jobs', headers=headers(**{'X-Auth-Role': None})
                          ).status_code == 401

    def test_a_complete_identity_gets_through(self, client):
        assert client.get('/api/jobs', headers=headers()).status_code == 200


class TestReadOnlyAccounts:
    def test_a_viewer_may_read(self, client):
        assert client.get('/api/jobs', headers=headers(**{'X-Auth-Role': 'viewer'})
                          ).status_code == 200

    @pytest.mark.parametrize('method', ['post', 'patch', 'put', 'delete'])
    def test_but_may_not_write_by_any_method(self, client, method):
        response = getattr(client, method)('/api/jobs/j1',
                                           headers=headers(**{'X-Auth-Role': 'viewer'}))

        assert response.status_code == 403
        assert response.json()['detail'] == 'read-only account'


class TestWhatIsNotBehindTheGate:
    def test_the_docs_are_reachable_without_an_identity(self, client):
        assert client.get('/docs').status_code == 200

    def test_so_is_the_schema(self, client):
        assert client.get('/openapi.json').status_code == 200


class TestWhatTheDeploymentOffers:
    def test_the_layout_templates_are_served_for_the_new_dataset_picker(self, client):
        templates = client.get('/api/layout-templates', headers=headers()).json()['templates']

        default = next(t for t in templates if t['is_default'])
        assert default['name'] == 'Schematismus' and 'Paragraph' in [c['name'] for c in default['classes']]

    def test_the_task_list_is_what_this_deployment_can_actually_create(self, client, monkeypatch):
        monkeypatch.setattr('app.config.ENABLE_MAP_SEGMENTATION', False)

        tasks = client.get('/api/tasks', headers=headers()).json()['tasks']

        assert 'text' in tasks
        assert 'map_segmentation' not in tasks
