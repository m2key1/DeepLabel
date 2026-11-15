import io
import json

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app import backend_client, recognize, store
from app.deps import get_db
from app.main import app

SECRET = 'test-secret'
ALICE = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'alice', 'X-Auth-Role': 'member', 'X-Auth-Caps': 'recognize'}
# In a crop, the fake finds one line across its middle half; it reads a line as its region's
# class and its place there.
CROP_LINE = [[0.0, 0.25], [1.0, 0.25], [1.0, 0.75], [0.0, 0.75]]
READ_CONFIDENCE = 0.8


def _png(width: int, height: int) -> bytes:
    out = io.BytesIO()
    Image.new('RGB', (width, height), 'white').save(out, format='PNG')
    return out.getvalue()


class FakeBackend:
    """A model backend for every model: the layout boxes it is given, lines as above."""

    def __init__(self, detections: list[tuple[str, list[float], float]]):
        self.detections = detections
        self.on_wait = None

    def load(self, conn, model_id):
        return None, {}

    def info(self):
        return {}

    def max_items(self, task):
        return 16

    def predict_all(self, task, weights, params, items):
        if task == 'layout':
            return {'results': [{'detections': [{'label': label, 'bbox': bbox, 'confidence': confidence}
                                                for label, bbox, confidence in self.detections]} for _ in items]}
        if task == 'lines':
            assert params == {'scope': 'crop'}
            return {'results': [{'lines': [{'polygon': CROP_LINE}]} for _ in items]}
        return {'results': [{'text': f"{item.context['element_class']} {item.context['line_index'] + 1}",
                             'confidence': READ_CONFIDENCE} for item in items]}


@pytest.fixture
def conn(tmp_path, monkeypatch):
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    monkeypatch.setattr('app.config.MODEL_BACKENDS', {})
    monkeypatch.setattr('app.config.JOBS_DIR', tmp_path / 'jobs')
    monkeypatch.setattr('app.config.BLOBS_DIR', tmp_path / 'blobs')
    connection = store.connect(tmp_path / 'app.db')
    connection.execute("INSERT INTO jobs (id, name, owner, task, status) VALUES ('mine', 'Mine', 'alice', 'text', 'done')")
    connection.commit()
    yield connection
    connection.close()


@pytest.fixture
def models(conn) -> dict[str, int]:
    ids = {task: conn.execute('INSERT INTO models (task, name, checkpoint, is_default) VALUES (?, ?, ?, 1)',
                              (task, task.title(), f'{task}.ckpt')).lastrowid for task in ('layout', 'lines', 'ocr')}
    conn.commit()
    return ids


def _served_by(monkeypatch, backend: FakeBackend) -> None:
    monkeypatch.setattr(backend_client, 'client_for', lambda conn, model_id: backend)


def test_layout_model_must_name_a_layout_model(conn, models):
    app.dependency_overrides[get_db] = lambda: conn
    try:
        response = TestClient(app).post('/api/recognize/pages', headers=ALICE, data={'layout_model': str(models['ocr'])},
                                        files=[('files', ('a.png', _png(8, 8), 'image/png'))])
    finally:
        app.dependency_overrides.clear()
    assert (response.status_code, response.json()['detail']) == (400, 'not an available layout model')


def test_own_lines_and_a_layout_model_are_not_sent_together(conn, models):
    with pytest.raises(recognize.Refused) as refused:
        recognize.pages(conn, 'alice', [recognize.Upload('a.png', _png(8, 8))],
                        {'layout_model': str(models['layout']), 'lines': '{"a.png": []}'})
    assert (refused.value.status, refused.value.message) == (
        400, 'send lines or layout_model, not both: with layout the lines are found inside its regions')


def test_regions_come_in_reading_order_with_the_containers_last_and_a_page_number_read_as_one_line(
        conn, models, monkeypatch):
    _served_by(monkeypatch, FakeBackend([
        ('Paragraph', [0.1, 0.4, 0.9, 0.8], 0.8),
        ('PageNumber', [0.45, 0.02, 0.55, 0.08], 0.7),
        ('Header', [0.1, 0.1, 0.9, 0.3], 0.9),
        ('Column', [0.05, 0.35, 0.95, 0.85], 0.6),
    ]))
    answer = recognize.pages(conn, 'alice', [recognize.Upload('leaf.png', _png(400, 300))],
                             {'layout_model': str(models['layout'])})

    assert answer['models'] == {'layout': {'id': models['layout'], 'name': 'Layout'},
                                'lines': {'id': models['lines'], 'name': 'Lines'},
                                'ocr': {'id': models['ocr'], 'name': 'Ocr', 'decode': 'rescored'}}
    assert answer['pages'] == [{
        'id': 'leaf.png', 'width': 400, 'height': 300,
        'regions': [
            {'class': 'Pagenumber', 'role': 'content', 'polygon': [[180, 6], [220, 6], [220, 24], [180, 24]],
             'confidence': 0.7},
            {'class': 'Header', 'role': 'content', 'polygon': [[40, 30], [360, 30], [360, 90], [40, 90]],
             'confidence': 0.9},
            {'class': 'Paragraph', 'role': 'content', 'polygon': [[40, 120], [360, 120], [360, 240], [40, 240]],
             'confidence': 0.8},
            {'class': 'Column', 'role': 'container', 'polygon': [[20, 105], [380, 105], [380, 255], [20, 255]],
             'confidence': 0.6},
        ],
        'lines': [
            {'polygon': [[180, 6], [220, 6], [220, 24], [180, 24]], 'text': 'Pagenumber 1',
             'confidence': READ_CONFIDENCE, 'region': 0},
            {'polygon': [[40, 45], [360, 45], [360, 75], [40, 75]], 'text': 'Header 1',
             'confidence': READ_CONFIDENCE, 'region': 1},
            {'polygon': [[40, 150], [360, 150], [360, 210], [40, 210]], 'text': 'Paragraph 1',
             'confidence': READ_CONFIDENCE, 'region': 2},
        ],
    }]


def test_kept_into_a_dataset_without_a_class_for_a_label_that_region_is_left_out_and_its_lines_unassigned(
        conn, models, monkeypatch):
    _served_by(monkeypatch, FakeBackend([('Header', [0.1, 0.1, 0.9, 0.3], 0.9),
                                         ('Marginalia', [0.1, 0.4, 0.9, 0.8], 0.8)]))
    answer = recognize.pages(conn, 'alice', [recognize.Upload('leaf.png', _png(400, 300))],
                             {'layout_model': str(models['layout']), 'keep': 'Mine'})

    assert [(r['class'], r['role']) for r in answer['pages'][0]['regions']] == [('Header', 'content'),
                                                                                ('Marginalia', 'content')]
    assert answer['kept'] == {'dataset': 'mine', 'name': 'Mine', 'created': False, 'pages': 1, 'duplicates': []}
    elements = conn.execute(
        'SELECT e.id, e.class_name, e.kind, e.bbox FROM elements e JOIN pages p ON e.page_id = p.id '
        "WHERE p.job_id = 'mine' AND e.deleted = 0 ORDER BY e.order_idx").fetchall()
    held = [(e['class_name'], e['kind'], json.loads(e['bbox']),
             [(r['text'], r['confidence'], r['checked']) for r in conn.execute(
                 'SELECT text, confidence, checked FROM lines WHERE element_id = ? AND deleted = 0 ORDER BY order_idx',
                 (e['id'],))]) for e in elements]
    assert held == [('Header', 'content', [0.1, 0.1, 0.9, 0.3], [('Header 1', READ_CONFIDENCE, 0)]),
                    ('Unassigned', 'orphan', [0.1, 0.5, 0.9, 0.7], [('Marginalia 1', READ_CONFIDENCE, 0)])]
