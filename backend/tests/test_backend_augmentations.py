"""Augmentation on a model backend: the catalog is the trainer's, and a stack is checked and
previewed by it (6.2)."""
import json
import threading
from email.parser import BytesParser
from email.policy import default
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from PIL import Image

from app import augmentations, config

CATALOG = {'library': 'albumentations', 'version': '9.9.9',
           'transforms': [{'name': 'InvertImg', 'category': 'pixel', 'targets': ['image'], 'params': []}]}
DRAWN = 'data:image/png;base64,ZHJhd24='


class Trainer(BaseHTTPRequestHandler):
    previews: list = []
    refuse = False

    def log_message(self, *args):
        pass

    def answer(self, body: dict, status: int = 200):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == '/v1/info':
            return self.answer({'contract': '1.0', 'tasks': ['ocr'], 'train': {'tasks': ['ocr']}})
        self.answer(CATALOG)

    def do_POST(self):
        body = self.rfile.read(int(self.headers['Content-Length']))
        message = BytesParser(policy=default).parsebytes(
            f'Content-Type: {self.headers["Content-Type"]}\r\n\r\n'.encode() + body)
        parts = list(message.iter_parts())
        request = json.loads(parts[0].get_content())
        Trainer.previews.append((request, len(parts) - 1))
        if Trainer.refuse:
            return self.answer({'error': {'code': 'bad_request', 'message': 'InvertImg: unknown argument foo'}}, 400)
        self.answer({'images': [DRAWN] * (len(parts) - 1)})


@pytest.fixture
def trainer(monkeypatch):
    Trainer.previews, Trainer.refuse = [], False
    server = ThreadingHTTPServer(('127.0.0.1', 0), Trainer)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    monkeypatch.setattr(config, 'MODEL_BACKENDS', {
        'ocr': config.ModelBackend('ocr', f'http://127.0.0.1:{server.server_port}', 's', 'default')})
    monkeypatch.setattr(augmentations, '_catalogs', {})
    yield
    server.shutdown()


SPEC = {'__version__': '9.9.9', 'transform': {'__class_fullname__': 'Compose', 'transforms': [
    {'__class_fullname__': 'InvertImg', 'p': 0.5}]}}


def test_the_catalog_is_the_training_backends(trainer):
    catalog = augmentations.catalog().payload()
    assert (catalog['version'], [t['name'] for t in catalog['transforms']], catalog['error']) == \
        ('9.9.9', ['InvertImg'], None)
    assert [g['name'] for g in catalog['groups']] == ['OneOf', 'SomeOf', 'Sequential']


def test_a_stack_is_checked_by_the_backends_trainer(trainer, monkeypatch):
    monkeypatch.setattr(augmentations, 'unknown_steps', lambda spec, task: None)
    assert augmentations.check_spec(SPEC, 'ocr') is None
    assert Trainer.previews == [({'spec': SPEC, 'seed': 0, 'draws': 1}, 1)]

    Trainer.refuse = True
    assert augmentations.check_spec(SPEC, 'ocr') == 'InvertImg: unknown argument foo'


def test_a_task_no_backend_trains_has_no_trainer(trainer):
    assert augmentations.trainer_backend('ocr') is not None
    assert augmentations.trainer_backend('lines') is None


def test_a_preview_shows_each_crop_at_the_models_height_before_and_after(trainer, tmp_path):
    crop = tmp_path / 'line.png'
    Image.new('RGB', (200, 40), 'white').save(crop)
    sample = {'id': 5, 'dataset': 'Volume', 'text': 'Anno', 'corrected_text': None}

    shown = augmentations._backend_preview(augmentations.trainer_backend('ocr'), SPEC, [(sample, crop)], 80, 3, 7)

    assert (shown['ok'], shown['draws'], shown['render_seed']) == (True, augmentations.HARSHEST_DRAWS, 7)
    [line] = shown['samples']
    assert (line['line_id'], line['text'], line['augmented'], line['harshest']) == (5, 'Anno', DRAWN, DRAWN)
    assert line['original'].startswith('data:image/png;base64,')
    assert Trainer.previews == [({'spec': SPEC, 'seed': 7, 'draws': 1}, 1),
                                ({'spec': SPEC, 'seed': 7, 'draws': augmentations.HARSHEST_DRAWS}, 1)]
