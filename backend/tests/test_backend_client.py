"""DeepLabel's side of the model backend contract: how it loads weights, sends a batch and
reads what comes back, against a small backend served from the test itself."""
import json
import threading
from email.parser import BytesParser
from email.policy import default
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from PIL import Image

from app import backend_client, config, store
from app.backend_client import BackendClient, BackendError, Item
from app.remote_models import RemoteOcrEngine

SECRET = 'backend-secret'
SHA = 'ab' * 32


class FakeBackend(BaseHTTPRequestHandler):
    """Records what it was sent; answers as the stub backend would."""
    calls: list = []
    script: dict = {}
    builtin = False

    def log_message(self, *args):
        pass

    def answer(self, status: int, body: dict):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def scripted(self, path: str) -> bool:
        queue = self.script.get(path)
        if queue:
            status, body = queue.pop(0)
            self.answer(status, body)
            return True
        return False

    def do_GET(self):
        FakeBackend.calls.append(('GET', self.path, self.headers.get(backend_client.SECRET_HEADER), None))
        if self.scripted(self.path):
            return
        if self.path == '/v1/info':
            return self.answer(200, {'contract': '1.0', 'model_type': 'deepocr', 'tasks': ['ocr'],
                                     'tasks_detail': {'ocr': {'batch': {'max_items': 2},
                                                              'conventions': ['long_s', 'oblique_hyphen']}},
                                     'weights': {'builtin': FakeBackend.builtin}})
        self.answer(200, {'state': 'loaded', 'facts': {'target_height': 128, 'max_width': 4096,
                                                       'conventions': ['long_s', 'oblique_hyphen']}})

    def do_POST(self):
        body = self.rfile.read(int(self.headers['Content-Length']))
        FakeBackend.calls.append(('POST', self.path, self.headers.get(backend_client.SECRET_HEADER), body))
        if self.scripted(self.path):
            return
        if self.path == '/v1/weights/load':
            return self.answer(202, {'state': 'downloading'})
        message = BytesParser(policy=default).parsebytes(
            f'Content-Type: {self.headers["Content-Type"]}\r\n\r\n'.encode() + body)
        parts = {part.get_param('name', header='content-disposition'): part.get_content()
                 for part in message.iter_parts()}
        request = json.loads(parts['request'])
        asked = request['params'].get('convention', {})
        honoured = [name for name in ('long_s', 'oblique_hyphen') if asked.get(name)]
        self.answer(200, {'decode': 'rescored', 'conventions': honoured, 'results': [
            {'id': item['id'], 'text': f"read {item.get('context', {}).get('line_index')} of {len(parts) - 1}",
             'confidence': 0.9, 'conf_profile': [{'x0': 0.0, 'x1': 1.0, 'c': 90}]}
            if item['image'] in parts else {'id': item['id'], 'error': {'code': 'bad_image', 'message': 'x'}}
            for item in request['items']]})


@pytest.fixture
def backend(monkeypatch):
    FakeBackend.calls, FakeBackend.script, FakeBackend.builtin = [], {}, False
    server = ThreadingHTTPServer(('127.0.0.1', 0), FakeBackend)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    described = config.ModelBackend('ocr', f'http://127.0.0.1:{server.server_port}', SECRET, 'default')
    monkeypatch.setattr(config, 'MODEL_BACKENDS', {'ocr': described})
    monkeypatch.setattr(config, 'MODEL_BACKEND_FETCH_URL', 'http://deeplabel:8000')
    monkeypatch.setattr(backend_client, 'LOAD_POLL_SECONDS', 0.01)
    yield described
    server.shutdown()


@pytest.fixture
def conn(tmp_path):
    connection = store.connect(tmp_path / 'app.db')
    connection.executescript(f"""
        INSERT INTO models (id, task, name, checkpoint) VALUES (1, 'ocr', 'DeepOCR v12', '/o.ckpt');
        INSERT INTO model_files (model_id, role, filename, sha256, size) VALUES
            (1, 'weights', 'model.ckpt', '{SHA}', 10), (1, 'lm', 'lm.bin', '{'cd' * 32}', 5);
    """)
    yield connection
    connection.close()


def test_a_model_runs_on_its_backend_only_while_that_backend_has_a_url(conn, backend, monkeypatch):
    assert backend_client.client_for(conn, 1).backend.name == 'ocr'

    monkeypatch.setattr(config, 'MODEL_BACKENDS', {'ocr': config.ModelBackend('ocr', '', SECRET, 'default')})
    assert backend_client.client_for(conn, 1) is None
    assert backend_client.client_for(conn, None) is None


def test_loading_sends_the_files_with_their_urls_and_waits_until_loaded(conn, backend):
    weights, facts = BackendClient(backend).load(conn, 1)

    assert weights == {'sha256': SHA, 'files': {'lm': 'cd' * 32}}
    assert facts['target_height'] == 128
    load = next(c for c in FakeBackend.calls if c[1] == '/v1/weights/load')
    request = json.loads(load[3])
    assert request['files']['weights'] == {'sha256': SHA, 'size': 10,
                                           'url': f'http://deeplabel:8000/backend-api/v1/files/{SHA}'}
    assert [c[1] for c in FakeBackend.calls] == ['/v1/info', '/v1/weights/load', f'/v1/weights/{SHA}']
    assert {c[2] for c in FakeBackend.calls} == {SECRET}


class Neighbour(BaseHTTPRequestHandler):
    """Another backend on the same machine: records only which calls reached it."""
    calls: list = []

    def log_message(self, *args):
        pass

    def do_POST(self):
        Neighbour.calls.append((self.server.server_port, self.path, json.loads(self.rfile.read(
            int(self.headers['Content-Length'])) or b'null')))
        self.send_response(200)
        self.send_header('Content-Length', '2')
        self.end_headers()
        self.wfile.write(b'{}')


@pytest.fixture
def neighbours(backend, monkeypatch):
    """The ocr backend with a neighbour on its card, one on another card, one with no URL,
    one that does not answer, and itself under a second name."""
    Neighbour.calls = []
    servers = [ThreadingHTTPServer(('127.0.0.1', 0), Neighbour) for _ in range(2)]
    for server in servers:
        threading.Thread(target=server.serve_forever, daemon=True).start()
    same, other = (server.server_port for server in servers)
    monkeypatch.setattr(config, 'MODEL_BACKENDS', {
        'ocr': backend,
        'lines': config.ModelBackend('lines', f'http://127.0.0.1:{same}', SECRET, 'default'),
        'layout': config.ModelBackend('layout', f'http://127.0.0.1:{other}', SECRET, 'second-card'),
        'mapseg': config.ModelBackend('mapseg', '', SECRET, 'default'),
        'edges': config.ModelBackend('edges', 'http://127.0.0.1:9', SECRET, 'default'),
        'stub': config.ModelBackend('stub', backend.url, SECRET, 'default'),
    })
    yield same, other
    for server in servers:
        server.shutdown()


def test_loading_a_model_first_frees_the_card_from_the_other_backends_on_it(conn, neighbours):
    same, _ = neighbours

    BackendClient(config.MODEL_BACKENDS['ocr']).load(conn, 1)

    assert Neighbour.calls == [(same, '/v1/weights/unload', {})]
    assert [c[1] for c in FakeBackend.calls if c[1] == '/v1/weights/unload'] == []


def test_a_training_first_frees_the_card_from_the_other_backends_on_it(neighbours):
    same, _ = neighbours
    FakeBackend.script = {'/v1/train': [(202, {'train_id': 'run-1'})]}

    training = backend_client.start_training(BackendClient(config.MODEL_BACKENDS['ocr']), {'task': 'ocr'})

    assert training.id == 'run-1'
    assert Neighbour.calls == [(same, '/v1/weights/unload', {})]


def test_a_model_with_no_stored_files_is_refused_unless_the_backend_has_its_own(conn, backend):
    conn.execute('DELETE FROM model_files')
    with pytest.raises(BackendError, match='weight store'):
        BackendClient(backend).load(conn, 1)

    FakeBackend.builtin = True
    assert BackendClient(backend).load(conn, 1) == (None, {'target_height': 128, 'max_width': 4096,
                                                          'conventions': ['long_s', 'oblique_hyphen']})
    assert FakeBackend.calls[-1][:2] == ('GET', '/v1/weights/builtin')


def test_a_load_that_fails_says_why(conn, backend):
    FakeBackend.script = {f'/v1/weights/{SHA}': [(200, {'state': 'error', 'error': {
        'code': 'weights_checksum_mismatch', 'message': 'the download hashes to something else'}})]}

    with pytest.raises(BackendError) as raised:
        BackendClient(backend).load(conn, 1)
    assert raised.value.code == 'weights_checksum_mismatch'


def test_a_predict_is_retried_once_on_a_transient_refusal_and_not_after(backend):
    client = BackendClient(backend)
    image = Image.new('RGB', (20, 8), 'white')
    FakeBackend.script = {'/v1/predict/ocr': [(503, {'error': {'code': 'out_of_memory', 'message': 'oom',
                                                               'retryable': True}})]}
    assert client.predict('ocr', None, {}, [Item('1', image)])['results'][0]['text'] == 'read None of 1'

    FakeBackend.script = {'/v1/predict/ocr': [(503, {'error': {'code': 'starting', 'message': 'x',
                                                               'retryable': True}})] * 2}
    with pytest.raises(BackendError) as raised:
        client.predict('ocr', None, {}, [Item('1', image)])
    assert raised.value.code == 'starting'

    FakeBackend.script = {'/v1/predict/ocr': [(400, {'error': {'code': 'bad_request', 'message': 'no'}})]}
    with pytest.raises(BackendError, match='bad_request'):
        client.predict('ocr', None, {}, [Item('1', image)])
    # Retried after each 503, never after the 400: 2 + 2 + 1 calls.
    assert sum(1 for c in FakeBackend.calls if c[1] == '/v1/predict/ocr') == 5


def test_an_unreachable_backend_is_named_in_the_error():
    gone = config.ModelBackend('ocr', 'http://127.0.0.1:9', SECRET, 'default')
    with pytest.raises(BackendError) as raised:
        BackendClient(gone).info()
    assert raised.value.code == 'unreachable'
    assert 'model backend "ocr"' in raised.value.message


def test_the_engine_batches_by_the_backends_limit_and_records_what_ran(conn, backend):
    engine = RemoteOcrEngine(conn, BackendClient(backend), 1, 'beam', {'long_s': True, 'ligatures': True})
    images = [Image.new('RGB', (10 + i, 8), 'white') for i in range(3)]

    texts, confs, profiles = engine.predict_batch(images, contexts=[{'line_index': i} for i in range(3)])

    # Three crops at two a request: two requests, each image sent once, in order.
    assert texts == ['read 0 of 2', 'read 1 of 2', 'read 2 of 1']
    assert confs == [0.9] * 3 and profiles[0] == [{'x0': 0.0, 'x1': 1.0, 'c': 90}]
    assert (engine.decode, engine.honoured) == ('rescored', ['long_s'])
    sent = [json.loads(BytesParser(policy=default).parsebytes(
        b'Content-Type: ' + b'multipart/form-data; boundary=' + c[3].split(b'\r\n')[0][2:] + b'\r\n\r\n' + c[3])
        .get_payload()[0].get_content()) for c in FakeBackend.calls if c[1] == '/v1/predict/ocr']
    assert sent[0]['params'] == {'decode': 'beam', 'convention': {'long_s': True, 'ligatures': True}}
    assert sent[0]['weights'] == {'sha256': SHA, 'files': {'lm': 'cd' * 32}}
    row = conn.execute('SELECT target_height, max_width, conventions FROM models WHERE id = 1').fetchone()
    assert tuple(row) == (128, 4096, '["long_s", "oblique_hyphen"]')


def test_the_engine_keeps_text_composed_whatever_form_the_backend_returns(conn, backend):
    FakeBackend.script = {'/v1/predict/ocr': [(200, {'results': [{'id': '0', 'text': 'März', 'confidence': 0.9}]})]}
    engine = RemoteOcrEngine(conn, BackendClient(backend), 1, 'beam', {})

    texts, _, _ = engine.predict_batch([Image.new('RGB', (10, 8), 'white')])

    assert texts == ['März']
