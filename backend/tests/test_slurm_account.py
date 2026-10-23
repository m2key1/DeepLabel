"""Cluster jobs run under one shared login, so SLURM cannot tell one DeepLabel user from
another. The account a run is charged to is therefore set per person by an admin and
carried on the run itself, and the submitter's name rides along on the job, so sacct can
still say who spent what.
"""
import pytest
from fastapi.testclient import TestClient

from app import store, trainer
from app.deps import get_db
from app.main import app
from app.trainer import sanitize_slurm_account

SECRET = 'test-secret'
ADMIN = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'root', 'X-Auth-Role': 'admin'}
CHARGED = {**ADMIN, 'X-Auth-Slurm-Account': 'p_dhinfra'}


@pytest.fixture
def client(tmp_path, monkeypatch, training_backend):
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    monkeypatch.setattr('app.config.SLURM_HOST', '10.0.0.1')
    monkeypatch.setattr('app.config.SLURM_USER', 'someone')
    monkeypatch.setattr(trainer, 'submit_slurm', lambda *a, **k: None)
    conn = store.connect(tmp_path / 'app.db')
    conn.execute("INSERT INTO jobs (id, name, owner, status) VALUES ('j1', 'data', 'root', 'done')")
    conn.execute("INSERT INTO pages (id, job_id, idx, filename, source_file, status) "
                 "VALUES (1, 'j1', 0, 'p1.png', '/nonexistent.png', 'done')")
    conn.execute("INSERT INTO elements (id, page_id, order_idx, class_name, bbox, kind) "
                 "VALUES (1, 1, 0, 'Paragraph', '[0,0,1,1]', 'content')")
    conn.execute("INSERT INTO lines (id, element_id, order_idx, polygon, text, checked) "
                 "VALUES (1, 1, 0, '[[0,0],[1,0],[1,1],[0,1]]', 'Wien', 1)")
    conn.commit()
    app.dependency_overrides[get_db] = lambda: conn
    yield TestClient(app), conn
    app.dependency_overrides.clear()
    conn.close()


@pytest.fixture
def slurm_config(monkeypatch):
    monkeypatch.setattr('app.config.SLURM_PARTITION', 'compute')
    monkeypatch.setattr('app.config.SLURM_ACCOUNT', 'deeplabel')
    monkeypatch.setattr('app.config.SLURM_GRES', 'gpu:h200:1')


def _script(training: dict) -> str:
    return trainer._backend_sbatch_script(training, '/images/ocr.sqsh', ['train'])


def _create(client, name, headers, **extra):
    return client.post('/api/trainings', headers=headers, json={
        'task': 'ocr', 'name': name, 'dataset_job_ids': ['j1'], 'target': 'slurm',
        'gpu_type': 'h200', 'gpu_count': 1, **extra})


def _account(conn, name: str) -> str:
    return conn.execute('SELECT slurm_account FROM trainings WHERE name = ?', (name,)).fetchone()[0]


def test_the_submitters_account_is_stored_on_the_run(client):
    """Stored, not read at submit time: a retry days later charges the same account even
    if the person's has since changed."""
    api, conn = client
    assert _create(api, 'charged', CHARGED).status_code == 200
    assert _account(conn, 'charged') == 'p_dhinfra'


def test_no_account_leaves_the_run_on_the_cluster_default(client):
    api, conn = client
    assert _create(api, 'default', ADMIN).status_code == 200
    assert _account(conn, 'default') == ''


@pytest.mark.parametrize('forged', ['has space', 'a;rm -rf /', 'quote"s', '$(whoami)', 'a' * 65])
def test_a_forged_account_header_never_reaches_the_run(client, forged):
    """Only something holding the frontend secret can set the header, but the value is
    interpolated into a #SBATCH directive, so the backend refuses to trust it."""
    api, conn = client
    assert _create(api, 'forged', {**ADMIN, 'X-Auth-Slurm-Account': forged}).status_code == 200
    assert _account(conn, 'forged') == ''
    assert sanitize_slurm_account(forged) == ''


def test_an_ordinary_account_name_passes_the_check():
    for good in ('p_dhinfra', 'proj-42', 'a.b_c-d', ''):
        assert sanitize_slurm_account(good) == good


def test_the_script_charges_the_runs_account(slurm_config):
    script = _script({'task': 'ocr', 'id': 7, 'owner': 'alice', 'slurm_account': 'p_dhinfra'})
    assert '#SBATCH --account=p_dhinfra' in script
    assert '#SBATCH --account=deeplabel' not in script


def test_the_script_falls_back_to_the_cluster_wide_account(slurm_config):
    script = _script({'task': 'ocr', 'id': 7, 'owner': 'alice'})
    assert '#SBATCH --account=deeplabel' in script


def test_the_script_names_the_submitter_for_sacct(slurm_config):
    """One shared login means sacct's User column says nothing; the comment is what
    attributes a run to a person."""
    script = _script({'task': 'ocr', 'id': 7, 'owner': 'alice'})
    assert '#SBATCH --comment=deeplabel:alice' in script


def test_the_account_picker_lists_what_the_login_may_charge_to(client, monkeypatch):
    api, _ = client
    monkeypatch.setattr(trainer, '_ssh', lambda cmd: __import__('subprocess').CompletedProcess(
        cmd, 0, stdout='p_dhinfra\nadmin-test-0005\np_dhinfra\n', stderr=''))
    assert api.get('/api/slurm/accounts', headers=ADMIN).json() == {
        'accounts': ['admin-test-0005', 'p_dhinfra']}


def test_a_locked_cluster_offers_no_accounts_rather_than_failing(client, monkeypatch):
    api, _ = client
    monkeypatch.setattr(trainer, '_ssh', lambda cmd: __import__('subprocess').CompletedProcess(
        cmd, 255, stdout='', stderr='Permission denied (keyboard-interactive).'))
    assert api.get('/api/slurm/accounts', headers=ADMIN).json() == {'accounts': []}


def test_the_account_picker_is_admin_only(client):
    api, _ = client
    member = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'alice', 'X-Auth-Role': 'member'}
    assert api.get('/api/slurm/accounts', headers=member).status_code == 403
