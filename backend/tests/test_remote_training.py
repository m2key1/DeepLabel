"""A local training run on the model backend its base model is read on (6.5): the
snapshot described file by file, the run started, its progress mirrored for the run page,
and the weights taken back, verified and registered."""
import hashlib
import json
import threading
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from fastapi.testclient import TestClient

from app import config, remote_training, store, trainer, weights
from app.deps import get_db
from app.main import app

SECRET = 'train-secret'
WEIGHTS = b'trained weights'
LM_FILES = {'lm/domain.bin': b'kenlm binary', 'lm/domain.dict': b'byte inventory'}
METRICS = [{'key': 'cer', 'label': 'CER', 'unit': 'fraction', 'better': 'lower', 'headline': True}]
PROGRESS = [json.dumps({'epoch': 1, 'loss': 2.5}), json.dumps({'epoch': 1, 'cer': 0.5}),
            json.dumps({'epoch': 2, 'cer': 0.3})]


class TrainingBackend(BaseHTTPRequestHandler):
    calls: list = []
    polls = 0
    finish_as = 'done'
    snapshot_kind = 'ocr-lines/1'
    builtin = False
    lm_build = None

    def log_message(self, *args):
        pass

    def send(self, status: int, body: bytes, kind='application/json'):
        self.send_response(status)
        self.send_header('Content-Type', kind)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def answer(self, body, status=200):
        self.send(status, json.dumps(body).encode())

    def do_GET(self):
        TrainingBackend.calls.append(('GET', self.path))
        if self.path == '/v1/info':
            return self.answer({'contract': '1.0', 'tasks': ['ocr'], 'weights': {'builtin': TrainingBackend.builtin},
                                'train': {'tasks': ['ocr'], 'snapshot': TrainingBackend.snapshot_kind,
                                          'metrics': METRICS, 'outputs': ['weights', 'lm', 'lm_dict']}})
        if self.path == '/v1/train/7-1':
            TrainingBackend.polls += 1
            state = TrainingBackend.finish_as if TrainingBackend.polls >= 3 else 'running'
            return self.answer({'train_id': '7-1', 'state': state, 'phase': 'training',
                                'error': 'CUDA out of memory' if state == 'error' else None,
                                'log_tail': f'poll {TrainingBackend.polls}'})
        if self.path.startswith('/v1/train/7-1/progress?from='):
            start = int(self.path.rsplit('=', 1)[1])
            shown = PROGRESS[:min(len(PROGRESS), TrainingBackend.polls)]
            return self.send(200, ''.join(f'{line}\n' for line in shown[start:]).encode(), 'application/x-ndjson')
        if self.path == '/v1/train/7-1/artifacts':
            files = [{'role': 'weights', 'path': 'model.ckpt', 'size': len(WEIGHTS),
                      'sha256': hashlib.sha256(WEIGHTS).hexdigest()}]
            if TrainingBackend.lm_build == 'built':
                files += [{'role': 'lm' if path.endswith('.bin') else 'lm_dict', 'path': path, 'size': len(content),
                           'sha256': hashlib.sha256(content).hexdigest()} for path, content in LM_FILES.items()]
            lm_build = {'lm_build': TrainingBackend.lm_build} if TrainingBackend.lm_build else {}
            return self.answer({'files': files, **lm_build})
        if self.path == '/v1/train/7-1/artifacts/model.ckpt':
            return self.send(200, WEIGHTS, 'application/octet-stream')
        if self.path.removeprefix('/v1/train/7-1/artifacts/') in LM_FILES:
            return self.send(200, LM_FILES[self.path.removeprefix('/v1/train/7-1/artifacts/')], 'application/octet-stream')
        if self.path == '/v1/train/7-1/artifacts/metrics.json':
            return self.send(200, json.dumps({'val_metric': 0.3, 'val_metric_name': 'cer'}).encode())
        self.answer({'error': {'code': 'not_found', 'message': self.path}}, 404)

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])) or b'{}')
        TrainingBackend.calls.append(('POST', self.path, body))
        self.answer({'train_id': '7-1'}, 202 if self.path == '/v1/train' else 200)

    def do_DELETE(self):
        TrainingBackend.calls.append(('DELETE', self.path))
        self.answer({'deleted': True})


@pytest.fixture
def backend(monkeypatch):
    TrainingBackend.calls, TrainingBackend.polls = [], 0
    TrainingBackend.finish_as, TrainingBackend.snapshot_kind = 'done', 'ocr-lines/1'
    TrainingBackend.builtin, TrainingBackend.lm_build = False, None
    server = ThreadingHTTPServer(('127.0.0.1', 0), TrainingBackend)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    monkeypatch.setattr(config, 'MODEL_BACKENDS', {
        'ocr': config.ModelBackend('ocr', f'http://127.0.0.1:{server.server_port}', SECRET, 'default')})
    monkeypatch.setattr(config, 'MODEL_BACKEND_FETCH_URL', 'http://deeplabel:8000')
    monkeypatch.setattr(remote_training, 'POLL_SECONDS', 0)
    yield
    server.shutdown()


@pytest.fixture
def conn(tmp_path, monkeypatch):
    monkeypatch.setattr('app.config.TRAININGS_DIR', tmp_path / 'trainings')
    monkeypatch.setattr('app.config.WEIGHTS_DIR', tmp_path / 'weights')
    monkeypatch.setattr('app.evaluator.create_baseline', lambda *a, **k: None)
    monkeypatch.setattr('app.evaluator.create_result_eval', lambda *a, **k: None)
    connection = store.connect(tmp_path / 'app.db')
    base = tmp_path / 'base.ckpt'
    base.write_bytes(b'base weights')
    connection.execute("INSERT INTO models (id, task, name, checkpoint, backend) "
                       "VALUES (3, 'ocr', 'DeepOCR', ?, 'ocr')", (str(base),))
    connection.execute("INSERT INTO trainings (id, task, name, owner, base_model_id, dataset_job_ids, epochs) "
                       "VALUES (7, 'ocr', 'Ledger fine-tune', 'alice', 3, '[]', 2)")
    connection.commit()
    weights.store_model_files(connection, 3)
    # A snapshot already cut, as a retry finds one.
    snapshot = config.training_dir(7) / 'snapshot'
    (snapshot / 'train').mkdir(parents=True)
    (snapshot / 'valid').mkdir()
    (snapshot / 'train' / 'line_1.png').write_bytes(b'crop one')
    (snapshot / 'train' / 'line_1.txt').write_text('Anno', encoding='utf-8')
    (snapshot / 'valid' / 'line_2.png').write_bytes(b'crop two')
    (snapshot / 'manifest.json').write_text(json.dumps({'line_1': 'j1', 'line_2': 'j2'}), encoding='utf-8')
    (snapshot / 'counts.json').write_text(json.dumps({'train': 1, 'val': 1}), encoding='utf-8')
    connection.execute("UPDATE trainings SET snapshot_counts = '{\"train\": 1, \"val\": 1}'")
    connection.commit()
    yield connection
    connection.close()


def test_a_run_on_its_bases_backend_ends_as_a_registered_model_there(conn, backend):
    trainer.run_local(conn, 7)

    run = trainer.get_training(conn, 7)
    assert (run['status'], run['backend'], run['backend_train_id']) == ('done', 'ocr', '7-1')
    started = next(c for c in TrainingBackend.calls if c[:2] == ('POST', '/v1/train'))[2]
    assert started['run'] == {'id': 7, 'attempt': 1, 'name': 'Ledger fine-tune', 'owner': 'alice'}
    assert started['snapshot'] == {
        'manifest_url': 'http://deeplabel:8000/backend-api/v1/trainings/7/snapshot/manifest.json'}
    assert started['base_weights']['sha256'] == hashlib.sha256(b'base weights').hexdigest()
    assert started['params']['epochs'] == 2
    # Every progress line once, in order, where the run page reads them.
    output = config.training_dir(7) / 'output'
    assert (output / 'progress.jsonl').read_text(encoding='utf-8').splitlines() == PROGRESS
    model = conn.execute('SELECT * FROM models WHERE id = ?', (run['model_id'],)).fetchone()
    assert (model['trained_from'], model['backend']) == (3, 'ocr')
    assert json.loads(model['metrics'])['val_metric'] == 0.3
    stored = weights.model_files(conn, model['id'])
    assert [f['sha256'] for f in stored if f['role'] == 'weights'] == [hashlib.sha256(WEIGHTS).hexdigest()]
    assert ('DELETE', '/v1/train/7-1') in TrainingBackend.calls
    assert trainer.read_log_tail(run) == 'poll 3'
    # The run page reads the metrics as the backend declared them.
    assert trainer.training_payload(conn.execute('SELECT * FROM trainings WHERE id = 7').fetchone())[
        'metric_info'] == METRICS


def asking_for_a_language_model(conn) -> None:
    conn.execute('UPDATE trainings SET build_lm = 1 WHERE id = 7')
    conn.commit()


def test_a_run_asking_for_a_language_model_registers_the_one_its_backend_built(conn, backend):
    asking_for_a_language_model(conn)
    TrainingBackend.lm_build = 'built'

    trainer.run_local(conn, 7)

    run = trainer.get_training(conn, 7)
    started = next(c for c in TrainingBackend.calls if c[:2] == ('POST', '/v1/train'))[2]
    assert started['params']['build_lm'] is True
    assert (run['status'], run['lm_build']) == ('done', 'built')
    model = conn.execute('SELECT * FROM models WHERE id = ?', (run['model_id'],)).fetchone()
    assert Path(model['lm_path']).read_bytes() == b'kenlm binary'
    assert Path(model['lm_dict_path']).read_bytes() == b'byte inventory'
    stored = {f['role']: f['sha256'] for f in weights.model_files(conn, model['id'])}
    assert stored['lm'] == hashlib.sha256(b'kenlm binary').hexdigest()
    assert stored['lm_dict'] == hashlib.sha256(b'byte inventory').hexdigest()


def test_a_language_model_build_that_failed_there_is_reported_and_the_model_keeps_its_bases(
        conn, backend, tmp_path):
    asking_for_a_language_model(conn)
    TrainingBackend.lm_build = 'failed'
    base_lm, base_dict = tmp_path / 'base.bin', tmp_path / 'base.dict'
    base_lm.write_bytes(b'base lm')
    base_dict.write_bytes(b'base dict')
    conn.execute('UPDATE models SET lm_path = ?, lm_dict_path = ? WHERE id = 3', (str(base_lm), str(base_dict)))
    conn.commit()

    trainer.run_local(conn, 7)

    run = trainer.get_training(conn, 7)
    assert (run['status'], run['lm_build']) == ('done', 'failed')
    model = conn.execute('SELECT * FROM models WHERE id = ?', (run['model_id'],)).fetchone()
    assert (model['lm_path'], model['lm_dict_path']) == (str(base_lm), str(base_dict))


def test_a_run_not_asking_for_a_language_model_tells_its_backend_so(conn, backend):
    trainer.run_local(conn, 7)

    started = next(c for c in TrainingBackend.calls if c[:2] == ('POST', '/v1/train'))[2]
    assert started['params']['build_lm'] is False
    assert trainer.get_training(conn, 7)['lm_build'] is None


def unstored_base(conn) -> None:
    conn.execute("INSERT INTO models (id, task, name, source, checkpoint, backend) VALUES (4, 'ocr', 'Stock', 'builtin', '', 'ocr')")
    conn.execute('UPDATE trainings SET base_model_id = 4 WHERE id = 7')
    conn.commit()


def test_a_base_with_no_stored_files_trains_from_the_backends_builtin_weights(conn, backend):
    TrainingBackend.builtin = True
    unstored_base(conn)
    trainer.run_local(conn, 7)

    assert trainer.get_training(conn, 7)['status'] == 'done'
    started = next(c for c in TrainingBackend.calls if c[:2] == ('POST', '/v1/train'))[2]
    assert started['base_weights'] == {'builtin': True}


def test_a_run_from_scratch_sends_no_base(conn, backend):
    conn.execute('UPDATE trainings SET base_model_id = NULL WHERE id = 7')
    conn.commit()
    trainer.run_local(conn, 7)

    started = next(c for c in TrainingBackend.calls if c[:2] == ('POST', '/v1/train'))[2]
    assert started['base_weights'] is None


def test_a_cluster_run_on_a_builtin_base_marks_its_base_directory_as_the_builtin(conn, backend):
    TrainingBackend.builtin = True
    unstored_base(conn)

    remote_training.prepare_cluster_run(conn, trainer.get_training(conn, 7), None)

    assert sorted(p.name for p in (config.training_dir(7) / 'base').iterdir()) == ['builtin']


def test_a_base_with_no_stored_files_is_refused_where_the_backend_has_no_builtin(conn, backend):
    unstored_base(conn)
    trainer.run_local(conn, 7)

    run = trainer.get_training(conn, 7)
    assert run['status'] == 'error' and 'the base model 4 has no files in the weight store' in run['error']
    assert not any(c[:2] == ('POST', '/v1/train') for c in TrainingBackend.calls)


def test_the_snapshot_is_described_file_by_file_with_its_groups(conn, backend):
    manifest = remote_training.write_snapshot_manifest(trainer.get_training(conn, 7))

    assert (manifest['format'], manifest['kind'], manifest['kind_version']) == ('deeplabel-snapshot/1', 'ocr-lines', 1)
    assert manifest['splits'] == {'train': 1, 'valid': 1}
    assert manifest['groups'] == {'line_1': 'j1', 'line_2': 'j2'}
    assert [f['path'] for f in manifest['files']] == ['counts.json', 'train/line_1.png', 'train/line_1.txt',
                                                      'valid/line_2.png']
    assert manifest['files'][1] == {'path': 'train/line_1.png', 'sha256': hashlib.sha256(b'crop one').hexdigest(),
                                    'size': 8}


def test_the_flags_each_dataset_was_transcribed_under_travel_in_the_manifest_not_as_a_file(conn, backend):
    flags = {'names': ['long_s', 'keep_hyphens'], 'by_dataset': {'j1': [1.0, 0.0], 'j2': [0.0, 1.0]}}
    (config.training_dir(7) / 'snapshot' / remote_training.CONVENTIONS_NAME).write_text(json.dumps(flags))

    manifest = remote_training.write_snapshot_manifest(trainer.get_training(conn, 7))

    assert manifest['conventions'] == flags
    assert remote_training.CONVENTIONS_NAME not in [f['path'] for f in manifest['files']]


def test_a_snapshot_without_flags_has_no_conventions_field(conn, backend):
    assert 'conventions' not in remote_training.write_snapshot_manifest(trainer.get_training(conn, 7))


def test_a_run_that_fails_there_fails_here_with_its_reason(conn, backend):
    TrainingBackend.finish_as = 'error'
    trainer.run_local(conn, 7)
    run = trainer.get_training(conn, 7)
    assert (run['status'], run['error'], run['model_id']) == ('error', 'CUDA out of memory', None)


def test_a_backend_that_wants_another_snapshot_kind_is_refused_before_anything_starts(conn, backend):
    TrainingBackend.snapshot_kind = 'page-lines/1'
    trainer.run_local(conn, 7)
    run = trainer.get_training(conn, 7)
    assert run['status'] == 'error' and 'wants a page-lines/1 snapshot' in run['error']
    assert not any(c[:2] == ('POST', '/v1/train') for c in TrainingBackend.calls)


def test_a_cancel_here_is_passed_on(conn, backend, monkeypatch):
    calls = iter([False, True])
    monkeypatch.setattr(trainer, 'is_cancelled', lambda conn, tid: next(calls, True))
    trainer.run_local(conn, 7)
    assert ('POST', '/v1/train/7-1/cancel', {}) in TrainingBackend.calls


def test_a_base_on_no_backend_fails_the_run_saying_so(conn, backend, monkeypatch):
    conn.execute('UPDATE models SET backend = NULL')
    conn.commit()
    monkeypatch.setattr(config, 'MODEL_BACKENDS', {'ocr': config.ModelBackend('ocr', '', SECRET, 'default')})

    trainer.run_local(conn, 7)

    run = trainer.get_training(conn, 7)
    assert (run['status'], run['error']) == ('error', 'the base model (3) is not on a configured model backend')


class TestTheSnapshotRoutes:
    @pytest.fixture
    def client(self, conn, backend):
        remote_training.write_snapshot_manifest(trainer.get_training(conn, 7))
        conn.execute("UPDATE trainings SET status = 'running', backend = 'ocr'")
        conn.commit()
        app.dependency_overrides[get_db] = lambda: conn
        yield TestClient(app)
        app.dependency_overrides.clear()

    def test_the_training_backend_gets_the_manifest_and_files(self, client):
        headers = {'X-Model-Backend-Secret': SECRET}
        manifest = client.get('/backend-api/v1/trainings/7/snapshot/manifest.json', headers=headers)
        assert manifest.status_code == 200 and manifest.json()['kind'] == 'ocr-lines'
        crop = client.get('/backend-api/v1/trainings/7/snapshot/train/line_1.png', headers=headers)
        assert crop.content == b'crop one'

    def test_nobody_else_and_nothing_outside_it(self, client, conn, monkeypatch):
        assert client.get('/backend-api/v1/trainings/7/snapshot/manifest.json').status_code == 401
        headers = {'X-Model-Backend-Secret': SECRET}
        assert client.get('/backend-api/v1/trainings/7/snapshot/../../app.db', headers=headers).status_code == 404
        assert client.get('/backend-api/v1/trainings/7/snapshot/manifest.json', headers=headers).status_code == 200
        conn.execute("UPDATE trainings SET status = 'done'")
        conn.commit()
        assert client.get('/backend-api/v1/trainings/7/snapshot/train/line_1.png', headers=headers).status_code == 404


def test_a_cluster_run_ships_the_entrypoint_contract_and_runs_the_backends_image(conn, backend):
    conn.execute("UPDATE trainings SET target = 'slurm', gpu_type = 'h200', gpu_count = 2")
    conn.commit()
    training = trainer.get_training(conn, 7)

    remote_training.prepare_cluster_run(conn, training, {'transform': {'name': 'Compose'}})
    script = trainer._backend_sbatch_script(training, '/scratch/images/deepocr.sqsh', ['deeplabel-train', '--x'])

    tdir = config.training_dir(7)
    params = json.loads((tdir / 'params.json').read_text(encoding='utf-8'))
    assert (params['gpus'], params['epochs'], params['task']) == (2, 2, 'ocr')
    assert params['augmentation'] == {'transform': {'name': 'Compose'}}
    assert (tdir / 'base' / 'weights').read_bytes() == b'base weights'
    assert json.loads((tdir / remote_training.MANIFEST_NAME).read_text())['kind'] == 'ocr-lines'
    assert '#SBATCH --gres=gpu:h200:2' in script
    # The nodes start a job at 1024 open files, which a trainer's data-loader workers run out of.
    for line in ('ulimit -n "$(ulimit -Hn)"',
                 'export TRAIN_BASE="${SLURM_SUBMIT_DIR}/base"', 'export TRAIN_PARAMS="${SLURM_SUBMIT_DIR}/params.json"',
                 'export TRAIN_GPUS="2"',
                 'cp "${SLURM_SUBMIT_DIR}/snapshot-manifest.json" "${TRAIN_SNAPSHOT}/manifest.json"'):
        assert line in script.splitlines()
    assert script.rstrip().endswith('--container-image=/scratch/images/deepocr.sqsh '
                                    '--container-mounts="${SLURM_SUBMIT_DIR}:${SLURM_SUBMIT_DIR}" '
                                    '--container-workdir="${SLURM_SUBMIT_DIR}" deeplabel-train --x')


def test_weights_written_under_another_name_are_registered(tmp_path):
    (tmp_path / 'artifacts.json').write_text(json.dumps({'files': [{'role': 'weights', 'path': 'best.pt'}]}))
    (tmp_path / 'best.pt').write_bytes(b'w')
    remote_training.adopt_weights(tmp_path)
    assert (tmp_path / 'model.ckpt').read_bytes() == b'w'


CHECKED_LINE = """
    INSERT INTO jobs (id, name, owner, status) VALUES ('j1', 'Volume', 'root', 'done');
    INSERT INTO pages (id, job_id, idx, filename, source_file, status) VALUES (1, 'j1', 0, 'p.png', 'p.png', 'done');
    INSERT INTO elements (id, page_id, order_idx, class_name, bbox) VALUES (1, 1, 0, 'Paragraph', '[0,0,9,9]');
    INSERT INTO lines (element_id, order_idx, polygon, text, checked) VALUES (1, 0, '[]', 'Anno', 1);
"""


class TestALanguageModelOnTheBackend:
    FRONT = {'X-Frontend-Secret': 'front', 'X-Auth-User': 'root', 'X-Auth-Role': 'admin'}

    @pytest.fixture
    def client(self, conn, backend, monkeypatch):
        monkeypatch.setattr('app.config.FRONTEND_SECRET', 'front')
        conn.executescript(CHECKED_LINE)
        app.dependency_overrides[get_db] = lambda: conn
        yield TestClient(app)
        app.dependency_overrides.clear()

    def submit(self, client):
        return client.post('/api/trainings', headers=self.FRONT, json={
            'task': 'ocr', 'name': 'With its own LM', 'dataset_job_ids': ['j1'], 'base_model_id': 3,
            'build_lm': True})

    def test_a_backend_that_outputs_one_offers_and_accepts_it(self, client):
        assert client.get('/api/trainings/options?task=ocr&base_model_id=3', headers=self.FRONT).json()['builds_lm']
        accepted = self.submit(client)
        assert accepted.status_code == 200, accepted.text
        assert accepted.json()['build_lm'] is True

    def test_a_backend_that_outputs_none_neither_offers_nor_accepts_it(self, client, monkeypatch):
        original = TrainingBackend.do_GET

        def without_lm(handler):
            if handler.path == '/v1/info':
                return handler.answer({'contract': '1.0', 'tasks': ['ocr'], 'train': {
                    'tasks': ['ocr'], 'snapshot': 'ocr-lines/1', 'outputs': ['weights']}})
            return original(handler)

        monkeypatch.setattr(TrainingBackend, 'do_GET', without_lm)
        assert client.get('/api/trainings/options?task=ocr&base_model_id=3',
                          headers=self.FRONT).json()['builds_lm'] is False
        refused = self.submit(client)
        assert (refused.status_code, refused.json()['detail']) == (
            400, 'model backend "ocr" builds no language model')


class TestTheBackendsKnobs:
    FRONT = {'X-Frontend-Secret': 'front', 'X-Auth-User': 'root', 'X-Auth-Role': 'admin'}
    TUNABLES = [{'key': 'learning_rate', 'label': 'Learning rate', 'group': 'Schedule', 'kind': 'float',
                 'help': 'Peak rate.', 'above': 0, 'default': 0.0001}]

    @pytest.fixture
    def client(self, conn, backend, monkeypatch):
        monkeypatch.setattr('app.config.FRONTEND_SECRET', 'front')
        original = TrainingBackend.do_GET

        def with_tunables(handler):
            if handler.path == '/v1/info':
                return handler.answer({'contract': '1.0', 'tasks': ['ocr'], 'train': {
                    'tasks': ['ocr'], 'snapshot': 'ocr-lines/1', 'tunables': self.TUNABLES, 'default_epochs': 20,
                    'resources': {'default_batch': {'local': 6, 'cluster': 20}}}})
            return original(handler)

        monkeypatch.setattr(TrainingBackend, 'do_GET', with_tunables)
        app.dependency_overrides[get_db] = lambda: conn
        yield TestClient(app)
        app.dependency_overrides.clear()

    def test_a_base_on_a_backend_offers_that_backends_knobs_and_batches(self, client):
        options = client.get('/api/trainings/options?task=ocr&base_model_id=3', headers=self.FRONT).json()

        assert options['backend'] == 'ocr'
        assert [(t['key'], t['default'], t['above']) for t in options['tunables']] == [('learning_rate', 0.0001, 0)]
        assert options['batch']['local'] == 6 and options['batch']['cluster']['h200'] == 20
        assert options['source'] == 'model backend "ocr"'
        # The epochs an untuned run there trains for, which the form shows as the placeholder.
        assert options['columns'] == {'epochs': 20}

    def test_a_run_there_is_checked_against_them(self, client, conn):
        conn.execute("INSERT INTO jobs (id, name, owner, status) VALUES ('j1', 'Volume', 'root', 'done')")
        conn.commit()

        def submit(hyperparams):
            return client.post('/api/trainings', headers=self.FRONT, json={
                'task': 'ocr', 'name': 'Tuned there', 'dataset_job_ids': ['j1'], 'base_model_id': 3,
                'hyperparams': hyperparams})

        refused = submit({'warmup_epochs': 1})
        assert (refused.status_code, refused.json()['detail']) == (400, 'unknown hyperparameter warmup_epochs')
        assert submit({'learning_rate': 0}).json()['detail'] == 'learning_rate must be greater than 0'

    def test_a_run_left_without_a_batch_takes_the_backends_own(self, client, conn):
        conn.executescript(CHECKED_LINE)

        def started(target, **extra):
            return client.post('/api/trainings', headers=self.FRONT, json={
                'task': 'ocr', 'name': f'Run {target} {extra}', 'dataset_job_ids': ['j1'], 'base_model_id': 3,
                'target': target, **extra}).json()

        assert started('local')['batch_size'] == 6
        assert started('slurm', gpu_type='h200', gpu_count=1)['batch_size'] == 20
        assert started('local', batch_size=3)['batch_size'] == 3


class TestScalingOnTheBackend:
    """6.9: the batch per GPU the backend measured for the card, the accumulation that
    keeps the effective batch its learning rates were tuned at, and a square-root factor
    on those rates once more GPUs outgrow it."""
    FRONT = {'X-Frontend-Secret': 'front', 'X-Auth-User': 'root', 'X-Auth-Role': 'admin'}
    TUNABLES = [{'key': 'learning_rate', 'role': 'learning_rate', 'label': 'Learning rate', 'kind': 'float',
                 'default': 0.0001},
                {'key': 'grad_accum_steps', 'role': 'accumulation', 'label': 'Accumulation', 'kind': 'int',
                 'default': 1}]

    @pytest.fixture
    def declared(self, backend, monkeypatch):
        resources = {'default_batch': {'local': 6, 'cluster': 20},
                     'batch_by_gpu': {'rtx5090': 8, 'rtx6000bb': 16, 'h200': 32}, 'effective_batch': 16}
        original = TrainingBackend.do_GET

        def with_scaling(handler):
            if handler.path == '/v1/info':
                return handler.answer({'contract': '1.1', 'tasks': ['ocr'], 'gpu': {'card': 'rtx5090', 'count': 1},
                                       'train': {'tasks': ['ocr'], 'snapshot': 'ocr-lines/1',
                                                 'tunables': self.TUNABLES, 'resources': resources}})
            return original(handler)

        monkeypatch.setattr(TrainingBackend, 'do_GET', with_scaling)
        return resources

    @staticmethod
    def scaled(conn, target='local', gpu_type=None, gpus=None, batch=None, hyperparams=None):
        return trainer.run_scaling(conn, 'ocr', target, gpu_type, gpus, 3, batch, hyperparams)

    def test_a_local_run_takes_its_cards_batch_and_accumulates_up_to_the_effective_batch(self, conn, declared):
        assert self.scaled(conn) == {'batch_size': 8, 'grad_accum_steps': 2, 'lr_scale': None, 'effective_batch': 16}

    def test_a_card_that_holds_the_effective_batch_needs_no_accumulation(self, conn, declared):
        assert self.scaled(conn, 'slurm', 'rtx6000bb', 1) == {
            'batch_size': 16, 'grad_accum_steps': 1, 'lr_scale': None, 'effective_batch': 16}

    def test_more_gpus_than_the_effective_batch_needs_scale_the_rate_by_the_square_root(self, conn, declared):
        assert self.scaled(conn, 'slurm', 'h200', 4) == {
            'batch_size': 32, 'grad_accum_steps': 1, 'lr_scale': 2.8284, 'effective_batch': 128}

    def test_a_chosen_batch_is_per_gpu_and_still_accumulates(self, conn, declared):
        assert self.scaled(conn, batch=4) == {'batch_size': 4, 'grad_accum_steps': 4, 'lr_scale': None,
                                              'effective_batch': 16}

    def test_a_chosen_accumulation_stands_and_the_rate_follows_what_it_makes(self, conn, declared):
        assert self.scaled(conn, hyperparams={'grad_accum_steps': 1}) == {
            'batch_size': 8, 'grad_accum_steps': None, 'lr_scale': 0.7071, 'effective_batch': 8}

    def test_a_card_the_backend_did_not_measure_takes_its_target_default(self, conn, declared):
        assert self.scaled(conn, 'slurm', 'l40s', 1)['batch_size'] == 20

    def test_a_backend_that_declares_no_effective_batch_trains_as_before(self, conn, declared):
        del declared['effective_batch']
        assert self.scaled(conn) == {'batch_size': 8, 'grad_accum_steps': None, 'lr_scale': None,
                                     'effective_batch': 8}

    def test_the_run_records_its_scaling_and_sends_it_to_the_backend(self, conn, declared, monkeypatch):
        monkeypatch.setattr('app.config.FRONTEND_SECRET', 'front')
        conn.executescript("""
            INSERT INTO jobs (id, name, owner, status) VALUES ('j1', 'Volume', 'root', 'done');
            INSERT INTO pages (id, job_id, idx, filename, source_file, status) VALUES (1, 'j1', 0, 'p.png', 'p.png', 'done');
            INSERT INTO elements (id, page_id, order_idx, class_name, bbox) VALUES (1, 1, 0, 'Paragraph', '[0,0,9,9]');
            INSERT INTO lines (element_id, order_idx, polygon, text, checked) VALUES (1, 0, '[]', 'Anno', 1);
        """)
        app.dependency_overrides[get_db] = lambda: conn
        try:
            run = TestClient(app).post('/api/trainings', headers=self.FRONT, json={
                'task': 'ocr', 'name': 'Scaled', 'dataset_job_ids': ['j1'], 'base_model_id': 3}).json()
        finally:
            app.dependency_overrides.clear()

        assert (run['batch_size'], run['grad_accum_steps'], run['lr_scale']) == (8, 2, None)
        params = remote_training.request_for(conn, trainer.get_training(conn, run['id']), None)['params']
        assert (params['batch_size'], params['grad_accum_steps']) == (8, 2)
        assert 'lr_scale' not in params


    def test_the_form_offers_the_batch_each_card_was_measured_at(self, conn, declared, monkeypatch):
        monkeypatch.setattr('app.config.FRONTEND_SECRET', 'front')
        app.dependency_overrides[get_db] = lambda: conn
        try:
            options = TestClient(app).get('/api/trainings/options?task=ocr&base_model_id=3', headers=self.FRONT).json()
        finally:
            app.dependency_overrides.clear()

        assert options['batch'] == {'local': 8, 'cluster': {'h200': 32, 'rtx6000bb': 16, 'l40s': 20}}
        assert options['effective_batch'] == 16


    @pytest.mark.parametrize(('declared_card', 'offered'), [('l40s', 'l40s'), ('a100', None), (None, None)])
    def test_the_form_starts_on_the_card_the_backend_prefers(self, conn, declared, monkeypatch, declared_card,
                                                              offered):
        """A backend names the cheapest card that holds it - Kraken peaks at 2 GB - so a run
        does not default to a larger one; a card the cluster does not offer is ignored."""
        if declared_card:
            declared['preferred_gpu'] = declared_card
        monkeypatch.setattr('app.config.FRONTEND_SECRET', 'front')
        app.dependency_overrides[get_db] = lambda: conn
        try:
            options = TestClient(app).get('/api/trainings/options?task=ocr&base_model_id=3', headers=self.FRONT).json()
        finally:
            app.dependency_overrides.clear()

        assert options['preferred_gpu'] == offered

def test_a_run_the_fallback_shrank_is_recorded_at_what_it_trained(conn, tmp_path):
    conn.execute('UPDATE trainings SET batch_size = 8, grad_accum_steps = 2 WHERE id = 7')
    conn.commit()
    out = tmp_path / 'out'
    out.mkdir()
    (out / 'model.ckpt').write_bytes(b'w')
    note = {'asked': {'batch_size': 8, 'grad_accum_steps': 2}, 'trained': {'batch_size': 2, 'grad_accum_steps': 8}}
    (out / 'fallback.json').write_text(json.dumps(note))

    trainer.register_result(conn, trainer.get_training(conn, 7), out)

    run = trainer.training_payload(conn.execute('SELECT * FROM trainings WHERE id = 7').fetchone())
    assert (run['batch_size'], run['grad_accum_steps'], run['batch_fallback']) == (2, 8, note)


def test_the_manifest_counts_a_test_split_where_the_run_has_one(tmp_path, monkeypatch):
    monkeypatch.setattr('app.config.TRAININGS_DIR', tmp_path / 'trainings')
    snapshot = config.training_dir(9) / 'snapshot'
    (snapshot / 'test' / 'lines').mkdir(parents=True)
    (snapshot / 'test' / 'lines' / 'p.json').write_text('{}')
    (snapshot / 'counts.json').write_text(json.dumps({'train': 3, 'val': 1, 'test': 2}))

    manifest = remote_training.write_snapshot_manifest({'id': 9, 'task': 'lines'})

    assert manifest['splits'] == {'train': 3, 'valid': 1, 'test': 2}
    assert 'test/lines/p.json' in [f['path'] for f in manifest['files']]


def test_a_new_attempt_starts_from_an_empty_output_and_a_resumed_one_keeps_its_checkpoint():
    """A retry keeps the frozen snapshot but must not train on top of the failed attempt's
    output: its progress was appended to the old file, so the run page charted both."""
    training = {'task': 'lines', 'id': 40, 'gpu_type': 'rtx6000bb', 'gpu_count': 1, 'owner': 'dev'}

    fresh = trainer._backend_sbatch_script(training, '/images/x.sqsh', ['train']).splitlines()
    resumed = trainer._backend_sbatch_script(training, '/images/x.sqsh', ['train'], resume=True).splitlines()

    assert fresh.index('rm -rf "${TRAIN_OUTPUT}"') < fresh.index('mkdir -p "${TRAIN_OUTPUT}"')
    assert 'rm -rf "${TRAIN_OUTPUT}"' not in resumed
