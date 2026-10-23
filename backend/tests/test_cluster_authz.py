"""Training is granted per person and per target by an admin, not implied by a role: the
local GPU is one card everyone shares and the cluster is one shared account, one
allocation and one unlocked ssh session. Neither target may be reached by posting what
the UI does not offer, and unlocking stays with admins, who hold the second factor.
"""
import pytest
from fastapi.testclient import TestClient

from app import store
from app.deps import get_db
from app.main import app

SECRET = 'test-secret'
ADMIN = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'root', 'X-Auth-Role': 'admin'}
# What the proxy sends for a default member: the local GPU, and nothing else.
MEMBER = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'alice', 'X-Auth-Role': 'member',
          'X-Auth-Train-Local': '1'}
# Once an admin has ticked the cluster for this account.
GRANTED = {**MEMBER, 'X-Auth-Train-Cluster': '1'}
# The two grants are independent: the cluster without the shared local card.
CLUSTER_ONLY = {**GRANTED, 'X-Auth-Train-Local': '0'}
# Someone an admin has stopped from training at all.
NO_TRAINING = {**MEMBER, 'X-Auth-Train-Local': '0'}


@pytest.fixture
def client(tmp_path, monkeypatch, training_backend):
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    monkeypatch.setattr('app.config.SLURM_HOST', '10.0.0.1')
    monkeypatch.setattr('app.config.SLURM_USER', 'someone')
    conn = store.connect(tmp_path / 'app.db')
    conn.execute("INSERT INTO jobs (id, name, owner, status) VALUES ('job1', 'data', 'alice', 'done')")
    conn.commit()
    app.dependency_overrides[get_db] = lambda: conn
    yield TestClient(app)
    app.dependency_overrides.clear()
    conn.close()


def targets(client, headers):
    res = client.get('/api/trainings', headers=headers)
    assert res.status_code == 200
    return res.json()['targets']


def test_the_cluster_is_offered_to_admins_and_granted_members_only(client):
    assert targets(client, ADMIN) == {'local': True, 'slurm': True}
    assert targets(client, MEMBER) == {'local': True, 'slurm': False}
    assert targets(client, GRANTED) == {'local': True, 'slurm': True}


def test_each_target_is_offered_on_its_own_grant(client):
    assert targets(client, CLUSTER_ONLY) == {'local': False, 'slurm': True}
    assert targets(client, NO_TRAINING) == {'local': False, 'slurm': False}


def test_the_capability_set_outranks_the_older_training_headers(client):
    """Once the set arrives it is the whole answer: an auth service still sending the
    local grant from its own column cannot give back what the set took away."""
    taken = {**MEMBER, 'X-Auth-Caps': 'pipeline.layout pipeline.lines pipeline.ocr'}
    assert targets(client, taken) == {'local': False, 'slurm': False}
    assert targets(client, {**taken, 'X-Auth-Caps': 'pipeline.ocr train.local'}) == {
        'local': True, 'slurm': False}


def test_a_member_without_the_local_grant_is_refused_the_local_target(client):
    res = client.post('/api/trainings', headers=NO_TRAINING, json={
        'task': 'ocr', 'name': 'local-sneak', 'dataset_job_ids': ['job1'], 'target': 'local'})
    assert res.status_code == 403
    assert 'local GPU' in res.json()['detail']


def test_the_local_grant_is_not_needed_for_the_cluster(client):
    res = client.post('/api/trainings', headers=CLUSTER_ONLY, json={
        'task': 'ocr', 'name': 'cluster-only', 'dataset_job_ids': ['job1'], 'target': 'slurm',
        'gpu_type': 'h200', 'gpu_count': 1})
    # Past both gates; it stops on the dataset having nothing reviewed.
    assert res.status_code == 400
    assert 'no checked material' in res.json()['detail']


def test_an_unconfigured_cluster_is_offered_to_nobody(client, monkeypatch):
    monkeypatch.setattr('app.config.SLURM_HOST', '')
    assert targets(client, ADMIN)['slurm'] is False


def test_a_member_posting_the_cluster_target_is_refused(client):
    res = client.post('/api/trainings', headers=MEMBER, json={
        'task': 'ocr', 'name': 'sneaky', 'dataset_job_ids': ['job1'], 'target': 'slurm'})
    assert res.status_code == 403
    assert 'admin' in res.json()['detail']


def test_a_granted_member_passes_the_cluster_gate(client):
    res = client.post('/api/trainings', headers=GRANTED, json={
        'task': 'ocr', 'name': 'granted', 'dataset_job_ids': ['job1'], 'target': 'slurm',
        'gpu_type': 'rtx6000bb', 'gpu_count': 2})
    # It stops on the dataset having nothing reviewed, which is only reachable past the gate.
    assert res.status_code == 400
    assert 'no checked material' in res.json()['detail']


def test_a_granted_member_sees_the_session_but_cannot_unlock(client):
    assert client.get('/api/slurm/session', headers=GRANTED).status_code == 200
    for method, url in (('POST', '/api/slurm/session'),
                        ('POST', '/api/slurm/session/answer'),
                        ('DELETE', '/api/slurm/session')):
        body = {'session_id': 'x', 'code': '123456'} if url.endswith('answer') else None
        res = client.request(method, url, headers=GRANTED, **({'json': body} if body else {}))
        assert res.status_code == 403, f'{method} {url} let a granted member unlock'


def test_the_unlock_is_admin_only(client):
    for method, url in (('GET', '/api/slurm/session'),
                        ('POST', '/api/slurm/session'),
                        ('POST', '/api/slurm/session/answer')):
        body = {'session_id': 'x', 'code': '123456'} if url.endswith('answer') else None
        res = client.request(method, url, headers=MEMBER, **({'json': body} if body else {}))
        assert res.status_code == 403, f'{method} {url} let a member through'

