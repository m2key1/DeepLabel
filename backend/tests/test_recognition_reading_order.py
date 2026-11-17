"""A request for pages may say how they are laid out (#120), as a dataset does: `reading_order`
takes the dataset's choices, 'auto' by default, and a kept dataset reads on with it."""
import io

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app import backend_client, store
from app.deps import get_db
from app.main import app

SECRET = 'test-secret'
MAY_RECOGNIZE = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'alice', 'X-Auth-Role': 'member',
                 'X-Auth-Caps': 'recognize'}
WIDTH, HEIGHT = 400, 300


def _line(x0: float, x1: float, y: float) -> list:
    return [[x0, y], [x1, y], [x1, y + 0.05], [x0, y + 0.05]]


# Two columns, the right one set a little lower, so read across they interleave.
LEFT_TOP, LEFT_FOOT = _line(0.05, 0.45, 0.10), _line(0.05, 0.45, 0.40)
RIGHT_TOP, RIGHT_FOOT = _line(0.55, 0.95, 0.12), _line(0.55, 0.95, 0.42)


def _png() -> bytes:
    out = io.BytesIO()
    Image.new('RGB', (WIDTH, HEIGHT), 'white').save(out, format='PNG')
    return out.getvalue()


class FakeBackend:
    def load(self, conn, model_id):
        return None, {}

    def info(self):
        return {}

    def max_items(self, task):
        return 16

    def predict_all(self, task, weights, params, items):
        if task == 'lines':
            return {'results': [{'lines': [{'polygon': p} for p in (RIGHT_FOOT, LEFT_TOP, RIGHT_TOP, LEFT_FOOT)]}
                                for _ in items]}
        return {'results': [{'text': 'read', 'confidence': 0.9} for _ in items]}


@pytest.fixture
def conn(tmp_path, monkeypatch):
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    monkeypatch.setattr('app.config.MODEL_BACKENDS', {})
    monkeypatch.setattr('app.config.JOBS_DIR', tmp_path / 'jobs')
    monkeypatch.setattr('app.config.BLOBS_DIR', tmp_path / 'blobs')
    monkeypatch.setattr(backend_client, 'client_for', lambda conn, model_id: FakeBackend())
    connection = store.connect(tmp_path / 'app.db')
    for task in ('lines', 'ocr'):
        connection.execute("INSERT INTO models (task, name, checkpoint, is_default) VALUES (?, ?, 'x.ckpt', 1)",
                           (task, task))
    connection.commit()
    yield connection
    connection.close()


@pytest.fixture
def client(conn):
    app.dependency_overrides[get_db] = lambda: conn
    yield TestClient(app)
    app.dependency_overrides.clear()


def _pages(client, **fields):
    return client.post('/api/recognize/pages', headers=MAY_RECOGNIZE, data=fields,
                       files=[('files', ('leaf.png', _png(), 'image/png'))])


def _order(response) -> list[str]:
    assert response.status_code == 200, response.text
    names = {'left top': LEFT_TOP, 'left foot': LEFT_FOOT, 'right top': RIGHT_TOP, 'right foot': RIGHT_FOOT}
    in_pixels = {name: [[round(x * WIDTH), round(y * HEIGHT)] for x, y in line] for name, line in names.items()}
    by_outline = {str(outline): name for name, outline in in_pixels.items()}
    return [by_outline[str(line['polygon'])] for line in response.json()['pages'][0]['lines']]


def test_two_columns_are_read_one_after_the_other(client):
    assert _order(_pages(client, reading_order='1x2')) == ['left top', 'left foot', 'right top', 'right foot']


def test_one_column_is_read_straight_across_the_page(client):
    assert _order(_pages(client, reading_order='1x1')) == ['left top', 'right top', 'left foot', 'right foot']


def test_left_unsaid_it_is_worked_out_from_the_page_as_auto_is(client):
    assert _order(_pages(client)) == _order(_pages(client, reading_order='auto'))


def test_a_layout_not_offered_is_refused(client):
    refused = _pages(client, reading_order='3x1')
    assert (refused.status_code, refused.json()['detail']) == (
        400, 'reading_order must be one of auto, 1x1, 1x2, 1x3, 2x1, 2x2, 2x3')


def test_a_kept_dataset_reads_on_with_it(client, conn):
    kept = _pages(client, reading_order='1x2', keep='Two columns')
    assert kept.status_code == 200, kept.text
    assert conn.execute("SELECT reading_order FROM jobs WHERE name = 'Two columns'").fetchone()[0] == '1x2'
