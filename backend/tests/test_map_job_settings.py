"""A map dataset's tile size, the window its model reads, and what a deployment without
the map runner may still be asked to do.

Tiling and pre-annotation run under MAPSEG_PYTHON with the cadastre_segmentation repo on
the path. Without them a map dataset that asks for either is refused up front, naming
why, rather than created and failed on its first run.
"""
import io
import json

import pytest
from PIL import Image
from fastapi.testclient import TestClient

from app import config, jobs, model_registry, store
from app.deps import get_db
from app.main import app

SECRET = 'test-secret'
OWNER = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'alice', 'X-Auth-Role': 'member'}
OTHER = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'bob', 'X-Auth-Role': 'member'}
ADMIN = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'root', 'X-Auth-Role': 'admin'}
NO_RUNNER = 'MAPSEG_PYTHON is not set'


def png_bytes(size=(4, 4)) -> bytes:
    buf = io.BytesIO()
    Image.new('RGB', size, 'white').save(buf, 'PNG')
    return buf.getvalue()


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    monkeypatch.setattr('app.config.JOBS_DIR', tmp_path / 'jobs')
    monkeypatch.setattr('app.config.MAPSEG_PYTHON', None)
    monkeypatch.setattr('app.config.MAPSEG_REGISTRY', tmp_path / 'absent-registry.json')
    conn = store.connect(tmp_path / 'app.db')
    app.dependency_overrides[get_db] = lambda: conn
    yield TestClient(app), conn
    app.dependency_overrides.clear()
    conn.close()


@pytest.fixture
def runner(tmp_path, monkeypatch):
    """A deployment with the map runner: an interpreter and the model repo's engine."""
    python = tmp_path / 'venv' / 'python'
    python.parent.mkdir()
    python.write_text('')
    engine = tmp_path / 'mapseg' / 'inference' / 'engine.py'
    engine.parent.mkdir(parents=True)
    engine.write_text('')
    monkeypatch.setattr('app.config.MAPSEG_PYTHON', python)
    monkeypatch.setattr('app.config.MAPSEG_ROOT', tmp_path / 'mapseg')


def create_map(api, headers=OWNER, **form):
    data = {'name': form.pop('name', 'maps'), 'task': 'map_segmentation',
            'run_predict': 'false', 'run_tile': 'false', **form}
    return api.post('/api/jobs', data=data, headers=headers,
                    files=[('files', ('sheet.png', png_bytes(), 'image/png'))])


def job_count(conn) -> int:
    return conn.execute('SELECT COUNT(*) FROM jobs').fetchone()[0]


class TestRunnerAvailability:
    def test_the_model_list_says_the_runner_is_missing_and_why(self, client):
        api, _ = client
        res = api.get('/api/map-models', headers=OWNER)
        assert res.status_code == 200
        runner = res.json()['runner']
        assert runner['available'] is False
        assert NO_RUNNER in runner['reason']

    def test_a_repo_without_the_inference_package_is_named(self, client, runner, tmp_path,
                                                          monkeypatch):
        monkeypatch.setattr('app.config.MAPSEG_ROOT', tmp_path / 'empty')
        api, _ = client
        runner = api.get('/api/map-models', headers=OWNER).json()['runner']
        assert runner['available'] is False
        assert str(tmp_path / 'empty') in runner['reason']

    def test_a_configured_runner_is_available(self, client, runner):
        api, _ = client
        assert api.get('/api/map-models', headers=OWNER).json()['runner'] == \
            {'available': True, 'reason': None}

    @pytest.mark.parametrize('phase', ['run_predict', 'run_tile'])
    def test_creating_a_map_dataset_that_needs_it_is_refused(self, client, phase):
        api, conn = client
        res = create_map(api, **{phase: 'true'})
        assert res.status_code == 400
        assert NO_RUNNER in res.json()['detail']
        assert job_count(conn) == 0

    def test_an_annotation_only_map_dataset_is_still_created(self, client):
        api, conn = client
        res = create_map(api)
        assert res.status_code == 200, res.text
        assert job_count(conn) == 1

    def test_a_server_folder_map_dataset_that_needs_it_is_refused(self, client, tmp_path):
        api, conn = client
        folder = tmp_path / 'maps'
        folder.mkdir()
        (folder / 'sheet.png').write_bytes(png_bytes())
        res = api.post('/api/jobs/path', headers=ADMIN, json={
            'name': 'maps', 'server_path': str(folder), 'task': 'map_segmentation',
            'run_tile': True})
        assert res.status_code == 400
        assert NO_RUNNER in res.json()['detail']
        assert job_count(conn) == 0

    def test_adding_maps_to_a_tiled_dataset_is_refused(self, client, runner, monkeypatch):
        api, conn = client
        job_id = create_map(api, run_tile='true').json()['job_id']
        conn.execute("UPDATE jobs SET status = 'done' WHERE id = ?", (job_id,))
        conn.commit()
        monkeypatch.setattr('app.config.MAPSEG_PYTHON', None)

        res = api.post(f'/api/jobs/{job_id}/pages/upload', headers=OWNER,
                       files=[('files', ('more.png', png_bytes(), 'image/png'))])

        assert res.status_code == 400
        assert NO_RUNNER in res.json()['detail']
        assert conn.execute('SELECT COUNT(*) FROM job_maps WHERE job_id = ?', (job_id,)).fetchone()[0] == 1
        assert store.get_job(conn, job_id)['status'] == 'done'

    def test_re_predicting_is_refused(self, client):
        api, conn = client
        job_id = create_map(api).json()['job_id']
        conn.execute("UPDATE jobs SET status = 'done' WHERE id = ?", (job_id,))
        conn.commit()

        res = api.post(f'/api/jobs/{job_id}/repredict', headers=ADMIN, json={})

        assert res.status_code == 400
        assert NO_RUNNER in res.json()['detail']
        assert store.get_job(conn, job_id)['status'] == 'done'


class TestTileSizeAtCreation:
    @pytest.mark.parametrize('size', [256, 768, 1000, 4096])
    def test_any_size_in_range_is_kept(self, client, runner, size):
        api, conn = client
        res = create_map(api, run_tile='true', tile_size=str(size))
        assert res.status_code == 200, res.text
        assert store.get_job(conn, res.json()['job_id'])['tile_size'] == size

    @pytest.mark.parametrize('size', [255, 4097, 0])
    def test_a_size_out_of_range_is_refused(self, client, runner, size):
        api, conn = client
        res = create_map(api, run_tile='true', tile_size=str(size))
        assert res.status_code == 400
        assert res.json()['detail'] == 'tile_size must be between 256 and 4096 px'
        assert job_count(conn) == 0


class TestTileSizeUnderProcessing:
    @pytest.fixture
    def tiled(self, client, runner):
        api, conn = client
        job_id = create_map(api, run_tile='true', tile_size='512').json()['job_id']
        conn.execute("UPDATE jobs SET status = 'done' WHERE id = ?", (job_id,))
        conn.commit()
        return api, conn, job_id

    def test_the_owner_changes_it(self, tiled):
        api, conn, job_id = tiled
        res = api.patch(f'/api/jobs/{job_id}', headers=OWNER, json={'tile_size': 1536})
        assert res.status_code == 200, res.text
        assert res.json()['tile_size'] == 1536
        assert store.get_job(conn, job_id)['tile_size'] == 1536

    def test_out_of_range_is_refused_and_nothing_changes(self, tiled):
        api, conn, job_id = tiled
        res = api.patch(f'/api/jobs/{job_id}', headers=OWNER, json={'tile_size': 5000})
        assert res.status_code == 400
        assert store.get_job(conn, job_id)['tile_size'] == 512

    def test_someone_else_may_not(self, tiled):
        api, conn, job_id = tiled
        conn.execute("INSERT INTO job_assignees (job_id, username) VALUES (?, 'bob')", (job_id,))
        conn.commit()
        res = api.patch(f'/api/jobs/{job_id}', headers=OTHER, json={'tile_size': 1024})
        assert res.status_code == 403
        assert store.get_job(conn, job_id)['tile_size'] == 512

    def test_not_while_it_runs(self, tiled):
        api, conn, job_id = tiled
        conn.execute("UPDATE jobs SET status = 'running' WHERE id = ?", (job_id,))
        conn.commit()
        res = api.patch(f'/api/jobs/{job_id}', headers=OWNER, json={'tile_size': 1024})
        assert res.status_code == 409
        assert store.get_job(conn, job_id)['tile_size'] == 512

    def test_a_dataset_that_cuts_no_tiles_has_none_to_change(self, client):
        api, conn = client
        job_id = create_map(api).json()['job_id']
        res = api.patch(f'/api/jobs/{job_id}', headers=OWNER, json={'tile_size': 1024})
        assert res.status_code == 400
        assert res.json()['detail'] == 'only a dataset that cuts its maps into tiles has a tile size'


class TestModelWindow:
    MODEL = {'id': 'big', 'label': 'Big', 'checkpoint': 'big.pth',
             'classes': [{'id': 0, 'name': 'background', 'color': [0, 0, 0]},
                         {'id': 1, 'name': 'buildings', 'color': [255, 0, 0]}]}

    @pytest.fixture
    def registry(self, tmp_path, monkeypatch):
        path = tmp_path / 'registry.json'
        monkeypatch.setattr('app.config.MAPSEG_REGISTRY', path)
        return lambda *models: path.write_text(json.dumps({'models': list(models)}))

    def test_a_model_that_declares_none_reads_512(self, registry):
        registry(self.MODEL)
        assert model_registry.list_models()[0]['input_size'] == 512

    def test_a_declared_input_size_is_listed(self, registry):
        registry({**self.MODEL, 'input_size': 1024})
        assert model_registry.list_models()[0]['input_size'] == 1024

    @pytest.mark.parametrize('size', ['512', 32, 8192, 512.5, True])
    def test_a_malformed_input_size_drops_the_entry(self, registry, size):
        registry({**self.MODEL, 'input_size': size}, {**self.MODEL, 'id': 'ok'})
        assert [m['id'] for m in model_registry.list_models()] == ['ok']

    def test_the_runner_is_told_the_window(self, registry, tmp_path, monkeypatch):
        registry({**self.MODEL, 'input_size': 768})
        monkeypatch.setattr('app.config.JOBS_DIR', tmp_path / 'jobs')
        conn = store.connect(tmp_path / 'app.db')
        conn.execute("INSERT INTO jobs (id, name, owner, task, model_id) "
                     "VALUES ('m1', 'Map', 'alice', 'map_segmentation', 'big')")
        conn.commit()
        config.job_dir('m1').mkdir(parents=True)
        spawned = []
        monkeypatch.setattr('app.jobs.subprocess.Popen', lambda args, **kw: spawned.append(args))

        jobs._spawn_map_runner('m1', False, True, 512, True, tmp_path / 'big.pth',
                               window=jobs.map_window(conn, 'm1'))

        args = spawned[0]
        assert args[args.index('--window') + 1] == '768'
