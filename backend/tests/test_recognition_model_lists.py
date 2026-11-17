"""A Recognition-only key limited to some models (decision 287): it is offered only those, a
model off its list reads as not available, and a request naming none gets the key's own
default - the deployment's if the list has it, else the one of that task registered first
on the list. Sessions and keys without a list reach every model."""
import io

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app import backend_client, jobs, store
from app.deps import get_db
from app.main import app

SECRET = 'test-secret'
OPEN = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'guest', 'X-Auth-Role': 'viewer', 'X-Auth-Caps': 'recognize',
        'X-Auth-Scope': 'recognize'}
LINE = [[0.1, 0.4], [0.9, 0.4], [0.9, 0.6], [0.1, 0.6]]


def _png(width: int, height: int) -> bytes:
    out = io.BytesIO()
    Image.new('RGB', (width, height), 'white').save(out, format='PNG')
    return out.getvalue()


class FakeBackend:
    """Every model at once: one line on a page, and a reading of every line."""

    def load(self, conn, model_id):
        return None, {}

    def info(self):
        return {}

    def max_items(self, task):
        return 16

    def predict_all(self, task, weights, params, items):
        if task == 'lines':
            return {'results': [{'lines': [{'polygon': LINE}]} for _ in items]}
        return {'results': [{'text': 'read', 'confidence': 0.9} for _ in items]}


@pytest.fixture
def conn(tmp_path, monkeypatch):
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    monkeypatch.setattr('app.config.MODEL_BACKENDS', {})
    monkeypatch.setattr('app.config.JOBS_DIR', tmp_path / 'jobs')
    monkeypatch.setattr('app.config.BLOBS_DIR', tmp_path / 'blobs')
    monkeypatch.setattr('app.config.RECOGNITION_DIR', tmp_path / 'recognition', raising=False)
    monkeypatch.setattr(backend_client, 'client_for', lambda conn, model_id: FakeBackend())
    connection = store.connect(tmp_path / 'app.db')
    yield connection
    connection.close()


@pytest.fixture
def models(conn) -> dict[str, int]:
    """One layout model, two line models and three OCR models, the first of each the default."""
    rows = [('layout', 'Layout', 1, '2026-01-01'),
            ('lines', 'Lines A', 1, '2026-01-01'), ('lines', 'Lines B', 0, '2026-02-01'),
            ('ocr', 'OCR v3', 1, '2026-01-01'), ('ocr', 'OCR v4', 0, '2026-02-01'), ('ocr', 'OCR other', 0, '2026-03-01')]
    ids = {name: conn.execute('INSERT INTO models (task, name, checkpoint, is_default, created_at) VALUES (?, ?, ?, ?, ?)',
                              (task, name, f'{name}.ckpt', default, f'{created} 00:00:00')).lastrowid
           for task, name, default, created in rows}
    conn.commit()
    return ids


@pytest.fixture
def client(conn):
    app.dependency_overrides[get_db] = lambda: conn
    yield TestClient(app)
    app.dependency_overrides.clear()


def _key(*ids: int) -> dict:
    return {**OPEN, 'X-Auth-Models': ','.join(str(i) for i in ids)}


def _offered(client, headers) -> dict:
    response = client.get('/api/recognize', headers=headers)
    assert response.status_code == 200, response.text
    return {task: [(m['name'], m['default']) for m in listed] for task, listed in response.json()['models'].items()}


def _pages(client, headers, **fields):
    return client.post('/api/recognize/pages', headers=headers, data=fields,
                       files=[('files', ('leaf.png', _png(400, 300), 'image/png'))])


def _read_with(response) -> dict:
    assert response.status_code == 200, response.text
    return {task: model['name'] for task, model in response.json()['models'].items()}


class TestWhatAKeyIsOffered:
    def test_a_limited_key_sees_its_models_and_its_own_defaults(self, client, models):
        assert _offered(client, _key(models['Lines B'], models['OCR v4'], models['OCR other'])) == {
            'layout': [], 'lines': [('Lines B', True)], 'ocr': [('OCR v4', True), ('OCR other', False)]}

    def test_a_key_without_a_list_sees_every_model_and_the_deployments_defaults(self, client, models):
        assert _offered(client, OPEN) == {
            'layout': [('Layout', True)], 'lines': [('Lines A', True), ('Lines B', False)],
            'ocr': [('OCR v3', True), ('OCR v4', False), ('OCR other', False)]}


class TestWhatAKeyReadsWith:
    def test_naming_no_model_reads_with_the_keys_own_defaults(self, client, models):
        assert _read_with(_pages(client, _key(models['Lines B'], models['OCR v4']))) == {
            'lines': 'Lines B', 'ocr': 'OCR v4'}

    def test_the_deployments_default_wins_where_the_list_has_it(self, client, models):
        assert _read_with(_pages(client, _key(models['Lines B'], models['OCR v4'], models['OCR v3']))) == {
            'lines': 'Lines B', 'ocr': 'OCR v3'}

    def test_a_model_off_the_list_reads_as_one_that_does_not_exist(self, client, models):
        key = _key(models['Lines B'], models['OCR v4'])
        off_list = _pages(client, key, ocr_model=str(models['OCR v3']))
        unknown = _pages(client, key, ocr_model='999')
        assert (off_list.status_code, off_list.json()['detail']) == (400, 'not an available ocr model')
        assert (unknown.status_code, unknown.json()['detail']) == (400, 'not an available ocr model')
        layout = _pages(client, key, layout_model=str(models['Layout']))
        assert (layout.status_code, layout.json()['detail']) == (400, 'not an available layout model')

    def test_a_model_on_the_list_is_read_with_when_named(self, client, models):
        key = _key(models['Lines A'], models['Lines B'], models['OCR v4'], models['OCR other'])
        assert _read_with(_pages(client, key, lines_model=str(models['Lines A']), ocr_model=str(models['OCR other']))) == {
            'lines': 'Lines A', 'ocr': 'OCR other'}

    def test_line_images_are_held_to_the_list_too(self, client, models):
        key = _key(models['OCR v4'])
        sent = [('files', ('line.png', _png(200, 30), 'image/png'))]
        read = client.post('/api/recognize/lines', headers=key, files=sent)
        assert _read_with(read) == {'ocr': 'OCR v4'}
        refused = client.post('/api/recognize/lines', headers=key, files=sent, data={'ocr_model': str(models['OCR v3'])})
        assert (refused.status_code, refused.json()['detail']) == (400, 'not an available ocr model')

    def test_a_list_without_an_ocr_model_reads_nothing(self, client, models):
        refused = _pages(client, _key(models['Lines B']))
        assert (refused.status_code, refused.json()['detail']) == (403, 'this API token may use no ocr model')

    def test_a_request_cannot_widen_its_keys_list_by_a_field_of_its_own(self, client, models):
        key = _key(models['Lines B'], models['OCR v4'])
        refused = _pages(client, key, ocr_model=str(models['OCR v3']), allowed_models=str(models['OCR v3']))
        assert (refused.status_code, refused.json()['detail']) == (400, 'not an available ocr model')


class TestAnAsyncRequestOfALimitedKey:
    def test_it_is_refused_at_once_for_a_model_off_the_list(self, client, models):
        refused = _pages(client, _key(models['Lines B'], models['OCR v4']), ocr_model=str(models['OCR v3']),
                         **{'async': 'true'})
        assert (refused.status_code, refused.json()['detail']) == (400, 'not an available ocr model')

    def test_it_reads_with_the_keys_defaults_when_its_turn_comes(self, conn, client, models):
        key = _key(models['Lines B'], models['OCR v4'])
        submitted = _pages(client, key, **{'async': 'true'})
        assert submitted.status_code == 202, submitted.text
        request_id = submitted.json()['id']
        jobs._run_work(conn, 'recognition', request_id)
        assert _read_with(client.get(f'/api/recognize/{request_id}', headers=key)) == {
            'lines': 'Lines B', 'ocr': 'OCR v4'}


def test_a_kept_dataset_reads_on_with_the_models_its_key_read_with(conn, client, models):
    key = {**_key(models['Lines B'], models['OCR v4']), 'X-Auth-Role': 'member'}
    kept = _pages(client, key, keep='Guest pages')
    assert kept.status_code == 200, kept.text
    dataset = conn.execute('SELECT model_lines_id, model_ocr_id FROM jobs WHERE id = ?',
                           (kept.json()['kept']['dataset'],)).fetchone()
    assert tuple(dataset) == (models['Lines B'], models['OCR v4'])
