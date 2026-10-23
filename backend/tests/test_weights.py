"""The weight store of docs/MODEL-BACKENDS.md section 5: model files by content, imported
once from the paths model rows hold today, and served to the backend each model belongs to
with the secret that names that backend."""
import base64
import hashlib
import json

import pytest
from fastapi.testclient import TestClient

from app import config, store, weights
from app.deps import get_db
from app.main import app

OCR_SECRET = 'ocr-secret'
LAYOUT_SECRET = 'layout-secret'


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


@pytest.fixture(autouse=True)
def no_map_registry(tmp_path, monkeypatch):
    monkeypatch.setattr('app.config.MAPSEG_REGISTRY', tmp_path / 'no-registry.json')


@pytest.fixture
def files(tmp_path):
    folder = tmp_path / 'models'
    folder.mkdir()
    contents = {'ocr.ckpt': b'ocr weights ' * 1000, 'domain.bin': b'kenlm', 'domain.dict': b'dict',
                'layout.pth': b'layout weights', 'gone.pt': None}
    for name, data in contents.items():
        if data is not None:
            (folder / name).write_bytes(data)
    return folder, contents


@pytest.fixture
def conn(tmp_path, files):
    folder, _ = files
    connection = store.connect(tmp_path / 'app.db')
    connection.executemany(
        'INSERT INTO models (id, task, name, checkpoint, lm_path, lm_dict_path, backend) VALUES (?,?,?,?,?,?,?)',
        [(1, 'ocr', 'Shipped OCR', str(folder / 'ocr.ckpt'), str(folder / 'domain.bin'),
          str(folder / 'domain.dict'), None),
         (2, 'layout', 'Shipped layout', str(folder / 'layout.pth'), None, None, None),
         (3, 'ocr', 'Lost one', str(folder / 'gone.pt'), None, None, None),
         (4, 'ocr', 'Same file elsewhere', str(folder / 'ocr.ckpt'), None, None, 'yolo-ocr')])
    connection.commit()
    yield connection
    connection.close()


@pytest.fixture
def backends(monkeypatch):
    monkeypatch.setattr('app.config.MODEL_BACKENDS', {
        'ocr': config.ModelBackend('ocr', 'http://ocr:9100', OCR_SECRET, 'default'),
        'layout': config.ModelBackend('layout', 'http://layout:9100', LAYOUT_SECRET, 'default')})
    monkeypatch.setattr('app.config.MODEL_BACKEND_FETCH_URL', 'http://deeplabel:8000')


@pytest.fixture
def client(conn, backends):
    app.dependency_overrides[get_db] = lambda: conn
    yield TestClient(app)
    app.dependency_overrides.clear()


def test_the_import_stores_every_file_by_content_and_reports_what_is_missing(conn, files):
    _, contents = files
    report = weights.import_existing(conn)

    assert [(r['id'], r['roles']) for r in report['stored']] == [
        (1, ['lm', 'lm_dict', 'weights']), (2, ['weights']), (4, ['weights'])]
    assert report['missing'] == [{'id': 3, 'name': 'Lost one',
                                  'problems': [f'weights file {files[0] / "gone.pt"} is missing']}]
    assert weights.model_files(conn, 1) == [
        {'role': 'lm', 'filename': 'domain.bin', 'sha256': sha(b'kenlm'), 'size': 5},
        {'role': 'lm_dict', 'filename': 'domain.dict', 'sha256': sha(b'dict'), 'size': 4},
        {'role': 'weights', 'filename': 'ocr.ckpt', 'sha256': sha(contents['ocr.ckpt']), 'size': 12000}]
    stored = weights.blob_path(sha(contents['ocr.ckpt']))
    assert stored.parent.name == sha(contents['ocr.ckpt'])[:2]
    assert stored.read_bytes() == contents['ocr.ckpt']
    assert (files[0] / 'ocr.ckpt').is_file(), 'copied, never moved'
    assert conn.execute('SELECT COUNT(*) FROM models').fetchone()[0] == 4, 'a missing file deletes nothing'


def test_running_the_import_again_copies_nothing(conn):
    weights.import_existing(conn)
    blob = weights.blob_path(weights.model_files(conn, 2)[0]['sha256'])
    blob.chmod(0o444)
    before = blob.stat().st_mtime_ns

    report = weights.import_existing(conn)

    assert report['stored'] == []
    assert [r['id'] for r in report['skipped']] == [1, 2, 4]
    assert blob.stat().st_mtime_ns == before
    assert not list((config.WEIGHTS_DIR / '.incoming').iterdir())


def test_one_file_shared_by_two_models_is_stored_once(conn, files):
    weights.import_existing(conn)
    assert weights.model_files(conn, 1)[2]['sha256'] == weights.model_files(conn, 4)[0]['sha256']
    blobs = [p for p in config.WEIGHTS_DIR.rglob('*') if p.is_file()]
    assert len(blobs) == 4


def test_the_map_registry_becomes_model_rows_once(conn, tmp_path, monkeypatch):
    registry_file = tmp_path / 'registry.json'
    (tmp_path / 'cadastre.pth').write_bytes(b'map weights')
    registry_file.write_text(json.dumps({'models': [{
        'id': 'franciscan-cadastre-upernet', 'label': 'Franciscan cadastre', 'checkpoint': 'cadastre.pth',
        'classes': [{'id': 0, 'name': 'background', 'color': [0, 0, 0]},
                    {'id': 1, 'name': 'Parcel', 'color': [200, 0, 0]}],
        'class_priority': ['Parcel'], 'input_size': 768}]}))
    monkeypatch.setattr('app.config.MAPSEG_REGISTRY', registry_file)

    weights.import_existing(conn)
    weights.import_existing(conn)

    rows = conn.execute("SELECT * FROM models WHERE task = 'map_segmentation'").fetchall()
    assert len(rows) == 1
    row = rows[0]
    assert (row['name'], row['ref'], row['input_size'], row['source']) == (
        'Franciscan cadastre', 'franciscan-cadastre-upernet', 768, 'registry')
    assert json.loads(row['classes']) == [
        {'id': 0, 'name': 'background', 'color': [0, 0, 0], 'priority': 1},
        {'id': 1, 'name': 'Parcel', 'color': [200, 0, 0], 'priority': 0}]
    assert weights.model_files(conn, row['id'])[0]['sha256'] == sha(b'map weights')


def test_a_model_trained_elsewhere_is_imported_with_its_lm(conn, files):
    folder, _ = files
    model_id = weights.import_file(conn, folder / 'layout.pth', 'layout', 'YOLO pages', backend='yolo',
                                   model_type='yolo')
    row = conn.execute('SELECT * FROM models WHERE id = ?', (model_id,)).fetchone()
    assert (row['source'], row['backend'], row['model_type'], row['is_default']) == ('imported', 'yolo', 'yolo', 0)
    assert [f['role'] for f in weights.model_files(conn, model_id)] == ['weights']
    with pytest.raises(ValueError, match='already exists'):
        weights.import_file(conn, folder / 'layout.pth', 'layout', 'yolo pages')
    with pytest.raises(ValueError, match='needs both'):
        weights.import_file(conn, folder / 'ocr.ckpt', 'ocr', 'Half an LM', lm=folder / 'domain.bin')


def test_the_command_line_import_exits_non_zero_when_a_file_is_missing(conn, monkeypatch, tmp_path, capsys):
    monkeypatch.setattr('app.config.DB_PATH', tmp_path / 'app.db')
    assert weights.main(['import-existing']) == 1
    assert json.loads(capsys.readouterr().out)['missing'][0]['id'] == 3


def get(client, sha256: str, secret: str | None, **headers):
    if secret is not None:
        headers['X-Model-Backend-Secret'] = secret
    return client.get(f'/backend-api/v1/files/{sha256}', headers=headers)


def test_a_backend_fetches_its_models_files_with_digest_and_range(client, conn, files):
    _, contents = files
    weights.import_existing(conn)
    data = contents['ocr.ckpt']

    whole = get(client, sha(data), OCR_SECRET)
    assert whole.status_code == 200
    assert whole.content == data
    assert whole.headers['etag'] == f'"{sha(data)}"'
    assert whole.headers['repr-digest'] == f'sha-256=:{base64.b64encode(hashlib.sha256(data).digest()).decode()}:'
    assert whole.headers['accept-ranges'] == 'bytes'

    rest = get(client, sha(data), OCR_SECRET, Range='bytes=10000-')
    assert rest.status_code == 206
    assert rest.content == data[10000:]
    assert rest.headers['content-range'] == f'bytes 10000-11999/{len(data)}'

    head = client.head(f'/backend-api/v1/files/{sha(data)}', headers={'X-Model-Backend-Secret': OCR_SECRET})
    assert (head.status_code, head.headers['content-length'], head.content) == (200, str(len(data)), b'')


def test_a_backend_cannot_fetch_another_backends_files(client, conn, files):
    weights.import_existing(conn)
    layout = weights.model_files(conn, 2)[0]['sha256']
    assert get(client, layout, LAYOUT_SECRET).status_code == 200
    assert get(client, layout, OCR_SECRET).status_code == 404
    assert get(client, 'f' * 64, OCR_SECRET).status_code == 404
    assert get(client, layout, 'not-a-secret').status_code == 401
    assert get(client, layout, None).status_code == 401


def test_the_frontend_secret_opens_nothing_here(client, conn, monkeypatch):
    weights.import_existing(conn)
    monkeypatch.setattr('app.config.FRONTEND_SECRET', 'frontend-secret')
    layout = weights.model_files(conn, 2)[0]['sha256']
    response = client.get(f'/backend-api/v1/files/{layout}', headers={
        'X-Frontend-Secret': 'frontend-secret', 'X-Auth-User': 'root', 'X-Auth-Role': 'admin'})
    assert response.status_code == 401


def test_a_manifest_lists_the_files_with_urls_on_the_fetch_address(client, conn, files):
    _, contents = files
    weights.import_existing(conn)
    response = client.get('/backend-api/v1/models/1/manifest', headers={'X-Model-Backend-Secret': OCR_SECRET})
    assert response.status_code == 200
    body = response.json()
    assert (body['model_id'], body['task'], body['backend']) == (1, 'ocr', 'ocr')
    assert [(f['role'], f['url']) for f in body['files']] == [
        ('lm', f'http://deeplabel:8000/backend-api/v1/files/{sha(b"kenlm")}'),
        ('lm_dict', f'http://deeplabel:8000/backend-api/v1/files/{sha(b"dict")}'),
        ('weights', f'http://deeplabel:8000/backend-api/v1/files/{sha(contents["ocr.ckpt"])}')]
    other = client.get('/backend-api/v1/models/2/manifest', headers={'X-Model-Backend-Secret': OCR_SECRET})
    assert other.status_code == 404


def test_the_model_list_carries_each_models_files(client, conn, monkeypatch):
    weights.import_existing(conn)
    monkeypatch.setattr('app.config.FRONTEND_SECRET', 'frontend-secret')
    response = client.get('/api/models', headers={
        'X-Frontend-Secret': 'frontend-secret', 'X-Auth-User': 'root', 'X-Auth-Role': 'admin'})
    by_id = {m['id']: m for m in response.json()['models']}
    assert [f['role'] for f in by_id[1]['files']] == ['lm', 'lm_dict', 'weights']
    assert by_id[3]['files'] == []


def test_a_backend_without_a_secret_is_a_configuration_error(monkeypatch):
    monkeypatch.setenv('MODEL_BACKENDS', 'ocr,layout')
    monkeypatch.setenv('MODEL_BACKEND_OCR_SECRET', 's')
    monkeypatch.delenv('MODEL_BACKEND_LAYOUT_SECRET', raising=False)
    with pytest.raises(ValueError, match='MODEL_BACKEND_LAYOUT_SECRET must be set'):
        config._model_backends()
    monkeypatch.setenv('MODEL_BACKEND_LAYOUT_SECRET', 't')
    monkeypatch.setenv('MODEL_BACKEND_LAYOUT_URL', 'http://layout:9100/')
    assert config._model_backends()['layout'] == config.ModelBackend('layout', 'http://layout:9100', 't', 'default')


def test_deleting_a_training_takes_its_model_files_and_only_unshared_blobs(conn, files):
    from app import trainer
    folder, contents = files
    (folder / 'run.ckpt').write_bytes(b'trained once')
    conn.execute("INSERT INTO models (id, task, name, checkpoint) VALUES (5, 'ocr', 'Run model', ?)",
                 (str(folder / 'run.ckpt'),))
    conn.execute("INSERT INTO models (id, task, name, checkpoint) VALUES (6, 'ocr', 'Run copy', ?)",
                 (str(folder / 'ocr.ckpt'),))
    conn.execute("INSERT INTO trainings (id, task, name, status, model_id) VALUES (9, 'ocr', 'Run', 'done', 5)")
    conn.execute("INSERT INTO trainings (id, task, name, status, model_id) VALUES (10, 'ocr', 'Copy', 'done', 6)")
    conn.commit()
    weights.import_existing(conn)

    trainer.delete(conn, trainer.get_training(conn, 9))
    trainer.delete(conn, trainer.get_training(conn, 10))

    assert conn.execute('SELECT id FROM models WHERE id IN (5, 6)').fetchall() == []
    assert conn.execute('SELECT * FROM model_files WHERE model_id IN (5, 6)').fetchall() == []
    assert not weights.blob_path(sha(b'trained once')).exists()
    assert weights.blob_path(sha(contents['ocr.ckpt'])).is_file(), 'model 1 still uses it'


def test_one_server_under_two_names_is_both_of_them(monkeypatch):
    monkeypatch.setattr('app.config.MODEL_BACKENDS', {
        'stub': config.ModelBackend('stub', 'http://stub:9100', 'shared', 'default'),
        'edges': config.ModelBackend('edges', 'http://stub:9100', 'shared', 'default'),
        'ocr': config.ModelBackend('ocr', 'http://ocr:9100', 'other', 'default')})

    assert weights.backends_for_secret('shared') == {'stub', 'edges'}
    assert weights.backends_for_secret('other') == {'ocr'}
    assert weights.backends_for_secret('wrong') == frozenset()
