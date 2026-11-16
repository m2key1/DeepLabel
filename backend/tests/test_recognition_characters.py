import io
import re

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app import backend_client, jobs, store
from app.deps import get_db
from app.main import app

SECRET = 'test-secret'
ALICE = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'alice', 'X-Auth-Role': 'member', 'X-Auth-Caps': 'recognize'}
# The lower line first, so only the column sweep puts them in order.
TOP = [[0.1, 0.1], [0.9, 0.1], [0.9, 0.2], [0.1, 0.2]]
LOW = [[0.1, 0.5], [0.9, 0.5], [0.9, 0.6], [0.1, 0.6]]
# What a line read at place 0, 1 or 2 of the request carries with `characters`: the backend's
# bands, its 0-100 scores as 0-1.
CHARACTERS = [[{'x0': 0.0, 'x1': 0.4, 'confidence': 0.97}, {'x0': 0.4, 'x1': 1.0, 'confidence': score}]
              for score in (0.3, 0.31, 0.32)]


def _png(width: int, height: int) -> bytes:
    out = io.BytesIO()
    Image.new('RGB', (width, height), 'white').save(out, format='PNG')
    return out.getvalue()


SCAN = _png(300, 200)
LINE_IMAGES = {'one.png': _png(120, 20), 'two.png': _png(160, 20)}


class FakeBackend:
    """Two lines on every page, each read with two bands - a sure start and a doubtful end
    whose score is the line's place in the request - except at the places in `bare`, which
    the model reads without any."""

    def __init__(self, bare=()):
        self.bare = set(bare)
        self.on_wait = None

    def load(self, conn, model_id):
        return None, {}

    def info(self):
        return {}

    def max_items(self, task):
        return 16

    def predict_all(self, task, weights, params, items):
        if task == 'lines':
            return {'results': [{'lines': [{'polygon': LOW}, {'polygon': TOP}]} for _ in items]}
        results = []
        for item in items:
            place = item.context['line_index']
            result = {'text': f'line {place + 1}', 'confidence': 0.75}
            if place not in self.bare:
                result['conf_profile'] = [{'x0': 0.0, 'x1': 0.4, 'c': 97}, {'x0': 0.4, 'x1': 1.0, 'c': 30 + place}]
            results.append(result)
        return {'results': results}


@pytest.fixture
def conn(tmp_path, monkeypatch):
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    monkeypatch.setattr('app.config.MODEL_BACKENDS', {})
    monkeypatch.setattr('app.config.JOBS_DIR', tmp_path / 'jobs')
    monkeypatch.setattr('app.config.BLOBS_DIR', tmp_path / 'blobs')
    monkeypatch.setattr('app.config.RECOGNITION_DIR', tmp_path / 'recognition')
    connection = store.connect(tmp_path / 'app.db')
    for task in ('lines', 'ocr'):
        connection.execute('INSERT INTO models (task, name, checkpoint, is_default) VALUES (?, ?, ?, 1)',
                           (task, task.title(), f'{task}.ckpt'))
    connection.commit()
    yield connection
    connection.close()


@pytest.fixture
def client(conn):
    app.dependency_overrides[get_db] = lambda: conn
    yield TestClient(app)
    app.dependency_overrides.clear()


def _serve(monkeypatch, backend: FakeBackend) -> None:
    monkeypatch.setattr(backend_client, 'client_for', lambda conn, model_id: backend)


@pytest.fixture
def backend(monkeypatch) -> FakeBackend:
    served = FakeBackend()
    _serve(monkeypatch, served)
    return served


def _pages(client, **fields):
    response = client.post('/api/recognize/pages', headers=ALICE, data=fields,
                           files=[('files', ('a.png', SCAN, 'image/png'))])
    assert response.status_code == 200, response.text
    return response.json()['pages'][0]


def _lines(client, files, **fields):
    return client.post('/api/recognize/lines', headers=ALICE, data=fields,
                       files=[('files', (name, data, 'image/png')) for name, data in files])


class TestPages:
    def test_each_line_of_a_page_carries_the_bands_it_was_read_with(self, client, backend):
        lines = _pages(client, characters='true')['lines']

        assert [(line['text'], line['confidence'], line['characters']) for line in lines] == \
               [('line 1', 0.75, CHARACTERS[0]), ('line 2', 0.75, CHARACTERS[1])]

    @pytest.mark.parametrize('fields', [{}, {'characters': 'false'}])
    def test_without_characters_a_line_is_as_it_was(self, client, backend, fields):
        lines = _pages(client, **fields)['lines']

        assert [sorted(line) for line in lines] == [['confidence', 'polygon', 'text']] * 2

    def test_a_line_the_model_read_without_bands_carries_none(self, client, monkeypatch):
        _serve(monkeypatch, FakeBackend(bare={1}))

        lines = _pages(client, characters='true')['lines']

        assert [line['characters'] for line in lines] == [CHARACTERS[0], None]

    @pytest.mark.parametrize('fmt', ['page', 'alto', 'hocr'])
    def test_the_documents_stay_as_they_are(self, client, backend, fmt):
        plain = _pages(client, format=fmt)
        with_characters = _pages(client, format=fmt, characters='true')

        def undated(document: str) -> str:
            return re.sub(r'<(Created|LastChange)>[^<]*', r'<\1>', document)

        assert [line['characters'] for line in with_characters['lines']] == CHARACTERS[:2]
        assert undated(with_characters['document']) == undated(plain['document'])


class TestLines:
    def test_each_line_image_carries_its_bands_and_an_unreadable_one_only_its_error(self, client, backend):
        response = _lines(client, [('one.png', LINE_IMAGES['one.png']), ('broken.png', b'not an image'),
                                   ('two.png', LINE_IMAGES['two.png'])], characters='true')

        assert response.status_code == 200, response.text
        assert response.json()['lines'] == [
            {'id': 'one.png', 'text': 'line 1', 'confidence': 0.75, 'characters': CHARACTERS[0]},
            {'id': 'broken.png', 'error': 'the image could not be read'},
            {'id': 'two.png', 'text': 'line 3', 'confidence': 0.75, 'characters': CHARACTERS[2]},
        ]

    def test_without_characters_a_line_image_is_as_it_was(self, client, backend):
        response = _lines(client, [('one.png', LINE_IMAGES['one.png'])])

        assert response.json()['lines'] == [{'id': 'one.png', 'text': 'line 1', 'confidence': 0.75}]


class TestAsync:
    @pytest.mark.parametrize('route', ['pages', 'lines'])
    def test_an_async_request_answers_the_bands_once_read(self, conn, client, backend, route):
        images = [('a.png', SCAN)] if route == 'pages' else [('one.png', LINE_IMAGES['one.png'])]
        sent = client.post(f'/api/recognize/{route}', headers=ALICE, data={'async': 'true', 'characters': 'true'},
                           files=[('files', (name, data, 'image/png')) for name, data in images])
        assert sent.status_code == 202, sent.text

        jobs._run_work(conn, 'recognition', sent.json()['id'])
        answer = client.get(f'/api/recognize/{sent.json()["id"]}', headers=ALICE).json()

        lines = answer['pages'][0]['lines'] if route == 'pages' else answer['lines']
        assert [line['characters'] for line in lines] == CHARACTERS[:len(lines)]
        assert len(lines) == (2 if route == 'pages' else 1)
