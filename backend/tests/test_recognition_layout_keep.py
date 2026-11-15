import io
import json
from collections import Counter

import pytest
from PIL import Image

from app import backend_client, layout_templates, recognize, store, text_job


def ring(x0: float, y0: float, x1: float, y1: float) -> list:
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]


# In a crop the fake finds one line across its middle half; on a whole page it finds these
# two, the lower one first. It reads a line as its region's class - Loose outside every
# region - and its place there. Pages are 400 or 200 px square, so every outline lands on a
# whole pixel and comes back exactly.
CROP_LINE = ring(0.0, 0.25, 1.0, 0.75)
PAGE_LINES = [ring(0.1, 0.6, 0.9, 0.7), ring(0.1, 0.2, 0.9, 0.3)]
READ_CONFIDENCE = 0.8
LAYOUT_AUTHOR = 'model:layout@Layout'
LINES_AUTHOR = 'model:lines@Lines'
READER = 'model:ocr@Ocr'
REORDERED_BY = 'system:reading-order'


def _png(width: int, height: int) -> bytes:
    out = io.BytesIO()
    Image.new('RGB', (width, height), 'white').save(out, format='PNG')
    return out.getvalue()


class FakeBackend:
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
            found = {'crop': [CROP_LINE], 'page': PAGE_LINES}[params['scope']]
            return {'results': [{'lines': [{'polygon': polygon} for polygon in found]} for _ in items]}
        return {'results': [{'text': f"{item.context.get('element_class', 'Loose')} {item.context['line_index'] + 1}",
                             'confidence': READ_CONFIDENCE} for item in items]}


@pytest.fixture
def conn(tmp_path, monkeypatch):
    monkeypatch.setattr('app.config.MODEL_BACKENDS', {})
    monkeypatch.setattr('app.config.JOBS_DIR', tmp_path / 'jobs')
    monkeypatch.setattr('app.config.BLOBS_DIR', tmp_path / 'blobs')
    connection = store.connect(tmp_path / 'app.db')
    _dataset(connection, 'mine', 'Mine')
    yield connection
    connection.close()


@pytest.fixture
def models(conn) -> dict[str, int]:
    ids = {task: conn.execute('INSERT INTO models (task, name, checkpoint, is_default) VALUES (?, ?, ?, 1)',
                              (task, task.title(), f'{task}.ckpt')).lastrowid for task in ('layout', 'lines', 'ocr')}
    conn.commit()
    return ids


def _dataset(conn, job_id: str, name: str, **columns) -> None:
    names = ['id', 'name', 'owner', 'task', 'status', *columns]
    conn.execute(f'INSERT INTO jobs ({", ".join(names)}) VALUES ({", ".join("?" * len(names))})',
                 (job_id, name, 'alice', 'text', 'done', *columns.values()))


def _template(conn, name: str, classes: list[dict]) -> int:
    template_id = conn.execute("INSERT INTO layout_templates (name, owner, rules, outside_order) "
                               "VALUES (?, 'alice', NULL, 'from_page')", (name,)).lastrowid
    layout_templates.insert_classes(conn, 'layout_template_classes', 'template_id', template_id, classes)
    return template_id


def _layout_model(conn, name: str, template_id: int | None = None) -> int:
    return conn.execute("INSERT INTO models (task, name, checkpoint, layout_template_id) VALUES ('layout', ?, ?, ?)",
                        (name, f'{name}.ckpt', template_id)).lastrowid


def _served_by(monkeypatch, detections: list) -> None:
    backend = FakeBackend(detections)
    monkeypatch.setattr(backend_client, 'client_for', lambda conn, model_id: backend)


def _leaf(name: str = 'leaf.png', size: int = 400) -> recognize.Upload:
    return recognize.Upload(name, _png(size, size))


def _recognize(conn, keep: str, uploads: list, layout_model: int, **fields) -> dict:
    return recognize.pages(conn, 'alice', uploads, {'layout_model': str(layout_model), 'keep': keep, **fields})


def _page_id(conn, job_id: str, filename: str = 'leaf.png') -> int:
    return conn.execute('SELECT id FROM pages WHERE job_id = ? AND filename = ?', (job_id, filename)).fetchone()['id']


def _json(value):
    return json.loads(value) if value else None


def _elements(conn, page_id: int) -> list:
    """Content and Unassigned in reading order, then the containers among themselves."""
    return conn.execute("SELECT * FROM elements WHERE page_id = ? AND deleted = 0 "
                        "ORDER BY kind = 'container', order_idx, id", (page_id,)).fetchall()


def _lines_of(conn, element_id: int) -> list:
    return conn.execute('SELECT * FROM lines WHERE element_id = ? AND deleted = 0 ORDER BY order_idx',
                        (element_id,)).fetchall()


def _held(conn, page_id: int) -> list[dict]:
    return [{'class': e['class_name'], 'raw': e['raw_class_name'], 'kind': e['kind'], 'order': e['order_idx'],
             'bbox': json.loads(e['bbox']), 'conf': e['conf'], 'lines_bbox': _json(e['lines_bbox']),
             'polygon': _json(e['polygon']),
             'lines': [(line['text'], json.loads(line['polygon'])) for line in _lines_of(conn, e['id'])]}
            for e in _elements(conn, page_id)]


def _ids(conn, page_id: int) -> list[tuple[int, list[int]]]:
    return [(e['id'], [line['id'] for line in _lines_of(conn, e['id'])]) for e in _elements(conn, page_id)]


def _revisions(conn, job_id: str) -> list[tuple]:
    return [(r['target_type'], r['target_id'], r['author'], r['action']) for r in conn.execute(
        'SELECT * FROM revisions WHERE job_id = ? ORDER BY id', (job_id,))]


def _content(class_name: str, order: int, bbox: list, conf: float, lines: list, raw: str | None = None) -> dict:
    return {'class': class_name, 'raw': raw or class_name, 'kind': 'content', 'order': order, 'bbox': bbox,
            'conf': conf, 'lines_bbox': bbox, 'polygon': None, 'lines': lines}


def _container(class_name: str, order: int, bbox: list, conf: float) -> dict:
    return {'class': class_name, 'raw': class_name, 'kind': 'container', 'order': order, 'bbox': bbox,
            'conf': conf, 'lines_bbox': None, 'polygon': None, 'lines': []}


def _unassigned(order: int, bbox: list, lines: list) -> dict:
    return {'class': 'Unassigned', 'raw': None, 'kind': 'orphan', 'order': order, 'bbox': bbox, 'conf': None,
            'lines_bbox': None, 'polygon': None, 'lines': lines}


LEDGER_CLASSES = [
    {'id': 1, 'name': 'Heading', 'role': 'content', 'reads': None, 'color': None, 'position': 0},
    {'id': 2, 'name': 'Paragraph', 'role': 'content', 'reads': None, 'color': None, 'position': 1},
    {'id': 3, 'name': 'Footnote', 'role': 'container', 'reads': 'down', 'color': None, 'position': 2},
]


def test_kept_into_a_dataset_of_other_classes_a_label_is_mapped_skipped_or_held_as_the_datasets_container(
        conn, models, monkeypatch):
    _dataset(conn, 'ledger', 'Ledger')
    layout_templates.insert_classes(conn, 'job_layout_classes', 'job_id', 'ledger', LEDGER_CLASSES)
    requested = _layout_model(conn, 'Ledger layout')
    layout_templates.decide_labels(conn, 'ledger', requested, {'Header': 1, 'PageHeader': None})
    # What the dataset decided for its default model, which this request does not run.
    layout_templates.decide_labels(conn, 'ledger', models['layout'], {'Header': None, 'PageHeader': 1})
    _served_by(monkeypatch, [('Header', [0.1, 0.1, 0.9, 0.2], 0.9),
                             ('Paragraph', [0.1, 0.3, 0.9, 0.5], 0.8),
                             ('PageHeader', [0.1, 0.6, 0.9, 0.7], 0.7),
                             ('Footnote', [0.1, 0.8, 0.9, 0.9], 0.6)])
    answer = _recognize(conn, 'Ledger', [_leaf()], requested)

    assert answer['kept'] == {'dataset': 'ledger', 'name': 'Ledger', 'created': False, 'pages': 1, 'duplicates': []}
    # The model's template reads all four as content, so each held a line in the request.
    assert [(r['class'], r['role']) for r in answer['pages'][0]['regions']] == [
        ('Header', 'content'), ('Paragraph', 'content'), ('PageHeader', 'content'), ('Footnote', 'content')]
    assert _held(conn, _page_id(conn, 'ledger')) == [
        _content('Heading', 0, [0.1, 0.1, 0.9, 0.2], 0.9, [('Header 1', ring(0.1, 0.125, 0.9, 0.175))]),
        _content('Paragraph', 1, [0.1, 0.3, 0.9, 0.5], 0.8, [('Paragraph 1', ring(0.1, 0.35, 0.9, 0.45))]),
        _unassigned(2, [0.1, 0.625, 0.9, 0.875], [('PageHeader 1', ring(0.1, 0.625, 0.9, 0.675)),
                                                  ('Footnote 1', ring(0.1, 0.825, 0.9, 0.875))]),
        _container('Footnote', 0, [0.1, 0.8, 0.9, 0.9], 0.6),
    ]
    assert layout_templates.job_classes(conn, 'ledger') == LEDGER_CLASSES
    job = store.get_job(conn, 'ledger')
    assert (job['model_layout_id'], job['layout_template_id']) == (None, None)


LETTER_CLASSES = [
    {'id': 1, 'name': 'Address', 'role': 'content', 'reads': None, 'color': '#336699', 'position': 1},
    {'id': 2, 'name': 'Body', 'role': 'content', 'reads': None, 'color': None, 'position': 0},
    {'id': 3, 'name': 'Signature', 'role': 'content', 'reads': None, 'color': None, 'position': 2},
    {'id': 5, 'name': 'Frame', 'role': 'container', 'reads': 'down', 'color': None, 'position': 3},
]
LETTER_PAGE = [
    _content('Address', 0, [0.1, 0.1, 0.9, 0.2], 0.9, [('Address 1', ring(0.1, 0.125, 0.9, 0.175))]),
    _content('Body', 1, [0.1, 0.3, 0.9, 0.6], 0.8, [('Body 1', ring(0.1, 0.375, 0.9, 0.525))]),
    _content('Signature', 2, [0.1, 0.7, 0.9, 0.8], 0.6, [('Signature 1', ring(0.1, 0.725, 0.9, 0.775))]),
    _container('Frame', 0, [0.05, 0.25, 0.95, 0.65], 0.7),
]


def test_a_new_dataset_takes_the_models_own_template_and_a_second_request_in_another_letter_case_adds_to_it(
        conn, models, monkeypatch):
    template_id = _template(conn, 'Letters', LETTER_CLASSES)
    model_id = _layout_model(conn, 'Letter layout', template_id)
    _served_by(monkeypatch, [('Address', [0.1, 0.1, 0.9, 0.2], 0.9), ('Body', [0.1, 0.3, 0.9, 0.6], 0.8),
                             ('Frame', [0.05, 0.25, 0.95, 0.65], 0.7), ('Signature', [0.1, 0.7, 0.9, 0.8], 0.6)])
    first = _recognize(conn, 'Letters kept', [_leaf('first.png')], model_id)

    job_id = first['kept']['dataset']
    assert first['kept'] == {'dataset': job_id, 'name': 'Letters kept', 'created': True, 'pages': 1, 'duplicates': []}
    job = store.get_job(conn, job_id)
    assert {key: job[key] for key in ('owner', 'task', 'status', 'line_mode', 'run_layout', 'run_lines', 'run_ocr',
                                      'model_layout_id', 'model_lines_id', 'model_ocr_id', 'ocr_decode',
                                      'layout_template_id', 'layout_rules')} == {
        'owner': 'alice', 'task': 'text', 'status': 'done', 'line_mode': 'per_crop', 'run_layout': True,
        'run_lines': True, 'run_ocr': True, 'model_layout_id': model_id, 'model_lines_id': None,
        'model_ocr_id': None, 'ocr_decode': 'auto', 'layout_template_id': template_id, 'layout_rules': None}
    by_position = [LETTER_CLASSES[1], LETTER_CLASSES[0], LETTER_CLASSES[2], LETTER_CLASSES[3]]
    assert layout_templates.job_classes(conn, job_id) == by_position
    assert _held(conn, _page_id(conn, job_id, 'first.png')) == LETTER_PAGE

    second = _recognize(conn, 'LETTERS KEPT', [_leaf('second.png', 200)], model_id)

    assert second['kept'] == {'dataset': job_id, 'name': 'Letters kept', 'created': False, 'pages': 1,
                              'duplicates': []}
    assert [r['id'] for r in conn.execute("SELECT id FROM jobs WHERE owner = 'alice' ORDER BY id != 'mine'")] == [
        'mine', job_id]
    assert [(p['filename'], p['idx'], p['status']) for p in conn.execute(
        'SELECT * FROM pages WHERE job_id = ? ORDER BY idx', (job_id,))] == [('first.png', 0, 'done'),
                                                                            ('second.png', 1, 'done')]
    assert _held(conn, _page_id(conn, job_id, 'second.png')) == LETTER_PAGE
    assert layout_templates.job_classes(conn, job_id) == by_position
    assert Counter((kind, author, action) for kind, _, author, action in _revisions(conn, job_id)) == {
        ('element', 'model:layout@Letter layout', 'create'): 8, ('line', READER, 'create'): 6}


PLAIN_CLASSES = [
    {'id': 1, 'name': 'Text', 'role': 'content', 'reads': None, 'color': None, 'position': 0},
    {'id': 2, 'name': 'Box', 'role': 'container', 'reads': 'across', 'color': None, 'position': 1},
]


def test_a_new_dataset_from_a_model_without_a_template_takes_the_default_templates_classes(
        conn, models, monkeypatch):
    conn.execute('UPDATE layout_templates SET is_default = 0')
    plain_id = _template(conn, 'Plain', PLAIN_CLASSES)
    conn.execute('UPDATE layout_templates SET is_default = 1 WHERE id = ?', (plain_id,))
    _served_by(monkeypatch, [('Text', [0.1, 0.1, 0.9, 0.3], 0.9)])
    answer = _recognize(conn, 'Plain kept', [_leaf()], models['layout'])

    job_id = answer['kept']['dataset']
    job = store.get_job(conn, job_id)
    assert (job['model_layout_id'], job['layout_template_id'], job['layout_rules']) == (
        models['layout'], plain_id, None)
    assert layout_templates.job_classes(conn, job_id) == PLAIN_CLASSES
    assert _held(conn, _page_id(conn, job_id)) == [
        _content('Text', 0, [0.1, 0.1, 0.9, 0.3], 0.9, [('Text 1', ring(0.1, 0.15, 0.9, 0.25))])]


@pytest.mark.parametrize('shape, outlined', [('box', False), ('rotated', True), ('polygon', True)])
def test_a_dataset_drawing_outlines_keeps_each_box_as_its_four_corners(conn, models, monkeypatch, shape, outlined):
    _dataset(conn, 'drawn', 'Drawn', layout_shape=shape)
    _served_by(monkeypatch, [('Header', [0.1, 0.1, 0.9, 0.2], 0.9), ('Paragraph', [0.1, 0.3, 0.9, 0.5], 0.8),
                             ('Column', [0.05, 0.25, 0.95, 0.9], 0.7), ('Marginalia', [0.1, 0.92, 0.9, 0.98], 0.6)])
    _recognize(conn, 'Drawn', [_leaf()], models['layout'])

    def corners(*bbox):
        return ring(*bbox) if outlined else None
    assert [(e['class'], e['kind'], e['bbox'], e['polygon']) for e in _held(conn, _page_id(conn, 'drawn'))] == [
        ('Header', 'content', [0.1, 0.1, 0.9, 0.2], corners(0.1, 0.1, 0.9, 0.2)),
        ('Paragraph', 'content', [0.1, 0.3, 0.9, 0.5], corners(0.1, 0.3, 0.9, 0.5)),
        ('Unassigned', 'orphan', [0.1, 0.935, 0.9, 0.965], None),
        ('Column', 'container', [0.05, 0.25, 0.95, 0.9], corners(0.05, 0.25, 0.95, 0.9)),
    ]


def test_a_scan_the_dataset_holds_lands_as_a_duplicate_without_layout_or_lines_and_out_of_the_counts(
        conn, models, monkeypatch):
    _served_by(monkeypatch, [('Header', [0.1, 0.1, 0.9, 0.2], 0.9), ('Paragraph', [0.1, 0.3, 0.9, 0.5], 0.8),
                             ('Column', [0.05, 0.25, 0.95, 0.55], 0.7), ('Marginalia', [0.1, 0.6, 0.9, 0.7], 0.6)])
    _recognize(conn, 'Mine', [_leaf('first.png')], models['layout'])
    # Identical white scans of one size are one file: again.png is first.png, and the
    # second 200 px scan repeats the first within the request.
    answer = _recognize(conn, 'mine', [recognize.Upload('broken.png', b'not an image'), _leaf('again.png'),
                                       _leaf('fresh.png', 200), _leaf('fresh copy.png', 200)], models['layout'])

    assert answer['kept'] == {'dataset': 'mine', 'name': 'Mine', 'created': False, 'pages': 1,
                              'duplicates': ['again.png', 'fresh copy.png']}
    pages = conn.execute(
        'SELECT filename, status, layout_model_id, lines_model_id, '
        '(SELECT COUNT(*) FROM elements e WHERE e.page_id = p.id) elements, '
        '(SELECT COUNT(*) FROM lines l JOIN elements e ON l.element_id = e.id WHERE e.page_id = p.id) lines '
        "FROM pages p WHERE job_id = 'mine' ORDER BY idx").fetchall()
    # Header, Paragraph, Column and the Unassigned bucket; the lines of Header, Paragraph and Marginalia.
    done = (models['layout'], models['lines'], 4, 3)
    duplicate = (None, None, 0, 0)
    assert [tuple(p) for p in pages] == [('first.png', 'done', *done), ('again.png', 'duplicate', *duplicate),
                                         ('fresh.png', 'done', *done), ('fresh copy.png', 'duplicate', *duplicate)]
    assert store.get_job(conn, 'mine')['counters'] == {
        'pages_total': 2, 'pages_ingested': 2, 'pages_layout_done': 2, 'elements_total': 4,
        'elements_lines_done': 4, 'lines_total': 6, 'lines_ocr_done': 6}


def test_each_kept_row_is_logged_once_by_the_model_that_made_it_and_the_page_notes_its_models(
        conn, models, monkeypatch):
    _served_by(monkeypatch, [('Header', [0.1, 0.1, 0.9, 0.2], 0.9), ('Paragraph', [0.1, 0.3, 0.9, 0.5], 0.8),
                             ('Column', [0.05, 0.25, 0.95, 0.55], 0.7), ('Marginalia', [0.1, 0.6, 0.9, 0.7], 0.6),
                             ('PageNumber', [0.45, 0.9, 0.55, 0.95], 0.5)])
    _recognize(conn, 'Mine', [_leaf()], models['layout'], decode='greedy')
    page_id = _page_id(conn, 'mine')

    # The page number is read first, by the template and by the dataset alike: the page is
    # kept in the order the dataset reads it, so putting it in order changes nothing.
    assert _held(conn, page_id) == [
        _content('Pagenumber', 0, [0.45, 0.9, 0.55, 0.95], 0.5, [('Pagenumber 1', ring(0.45, 0.9, 0.55, 0.95))],
                 raw='PageNumber'),
        _content('Header', 1, [0.1, 0.1, 0.9, 0.2], 0.9, [('Header 1', ring(0.1, 0.125, 0.9, 0.175))]),
        _content('Paragraph', 2, [0.1, 0.3, 0.9, 0.5], 0.8, [('Paragraph 1', ring(0.1, 0.35, 0.9, 0.45))]),
        _unassigned(3, [0.1, 0.625, 0.9, 0.675], [('Marginalia 1', ring(0.1, 0.625, 0.9, 0.675))]),
        _container('Column', 0, [0.05, 0.25, 0.95, 0.55], 0.7),
    ]
    (number, [number_line]), (header, [header_line]), (paragraph, [paragraph_line]), (bucket, [loose_line]), \
        (column, []) = _ids(conn, page_id)
    reader = f'{READER}#greedy'
    assert _revisions(conn, 'mine') == [
        ('element', number, LAYOUT_AUTHOR, 'create'), ('line', number_line, reader, 'create'),
        ('element', header, LAYOUT_AUTHOR, 'create'), ('line', header_line, reader, 'create'),
        ('element', paragraph, LAYOUT_AUTHOR, 'create'), ('line', paragraph_line, reader, 'create'),
        ('element', column, LAYOUT_AUTHOR, 'create'),
        ('element', bucket, LINES_AUTHOR, 'create'), ('line', loose_line, reader, 'create'),
    ]
    snapshots = [json.loads(r['snapshot']) for r in conn.execute(
        "SELECT snapshot FROM revisions WHERE job_id = 'mine' AND target_type = 'line' ORDER BY id")]
    assert [(s['text'], s['confidence'], s['checked']) for s in snapshots] == [
        ('Pagenumber 1', READ_CONFIDENCE, False), ('Header 1', READ_CONFIDENCE, False),
        ('Paragraph 1', READ_CONFIDENCE, False), ('Marginalia 1', READ_CONFIDENCE, False)]
    lines = conn.execute('SELECT l.* FROM lines l JOIN elements e ON l.element_id = e.id WHERE e.page_id = ? '
                         'ORDER BY l.id', (page_id,)).fetchall()
    assert [(line['checked'], line['corrected_text'], line['ocr_model_id'], line['ocr_run_at'] is not None)
            for line in lines] == [(0, None, models['ocr'], True)] * 4
    noted = conn.execute('SELECT * FROM pages WHERE id = ?', (page_id,)).fetchone()
    assert (noted['layout_model_id'], noted['lines_model_id'], noted['layout_run_at'] is not None,
            noted['lines_run_at'] is not None) == (models['layout'], models['lines'], True, True)


PAGE_LINES_LOGGED = {('element', LINES_AUTHOR, 'create'): 1, ('line', READER, 'create'): 2}


@pytest.mark.parametrize('detections, regions, containers, logged', [
    ([], [], [], PAGE_LINES_LOGGED),
    ([('Column', [0.05, 0.1, 0.95, 0.9], 0.7)],
     [{'class': 'Column', 'role': 'container', 'polygon': [[20, 40], [380, 40], [380, 360], [20, 360]],
       'confidence': 0.7}],
     [_container('Column', 0, [0.05, 0.1, 0.95, 0.9], 0.7)],
     {('element', LAYOUT_AUTHOR, 'create'): 1, **PAGE_LINES_LOGGED}),
], ids=['nothing found', 'only a container'])
def test_a_page_without_a_content_region_keeps_its_whole_page_lines_unassigned(
        conn, models, monkeypatch, detections, regions, containers, logged):
    _served_by(monkeypatch, detections)
    answer = _recognize(conn, 'Mine', [_leaf()], models['layout'])

    assert answer['pages'][0]['regions'] == regions
    assert answer['pages'][0]['lines'] == [
        {'polygon': [[40, 80], [360, 80], [360, 120], [40, 120]], 'text': 'Loose 1', 'confidence': READ_CONFIDENCE,
         'region': None},
        {'polygon': [[40, 240], [360, 240], [360, 280], [40, 280]], 'text': 'Loose 2', 'confidence': READ_CONFIDENCE,
         'region': None}]
    page_id = _page_id(conn, 'mine')
    assert _held(conn, page_id) == [
        _unassigned(0, [0.1, 0.2, 0.9, 0.7], [('Loose 1', ring(0.1, 0.2, 0.9, 0.3)),
                                              ('Loose 2', ring(0.1, 0.6, 0.9, 0.7))]),
        *containers]
    noted = conn.execute('SELECT * FROM pages WHERE id = ?', (page_id,)).fetchone()
    assert (noted['layout_model_id'], noted['lines_model_id']) == (models['layout'], models['lines'])
    assert Counter((kind, author, action) for kind, _, author, action in _revisions(conn, 'mine')) == logged


def test_unassigned_lines_on_both_sides_of_a_box_get_a_bucket_each_logged_as_the_reading_orders(
        conn, models, monkeypatch):
    _served_by(monkeypatch, [('Marginalia', [0.1, 0.1, 0.9, 0.2], 0.9), ('Paragraph', [0.1, 0.3, 0.9, 0.5], 0.8),
                             ('Marginalia', [0.1, 0.6, 0.9, 0.7], 0.7)])
    _recognize(conn, 'Mine', [_leaf()], models['layout'])
    page_id = _page_id(conn, 'mine')

    assert [(e['class'], e['order'], e['lines']) for e in _held(conn, page_id)] == [
        ('Unassigned', 0, [('Marginalia 1', ring(0.1, 0.125, 0.9, 0.175))]),
        ('Paragraph', 1, [('Paragraph 1', ring(0.1, 0.35, 0.9, 0.45))]),
        ('Unassigned', 2, [('Marginalia 1', ring(0.1, 0.625, 0.9, 0.675))]),
    ]
    (kept_bucket, [top_line]), (paragraph, [paragraph_line]), (split_bucket, [bottom_line]) = _ids(conn, page_id)
    assert _revisions(conn, 'mine') == [
        ('element', paragraph, LAYOUT_AUTHOR, 'create'), ('line', paragraph_line, READER, 'create'),
        ('element', kept_bucket, LINES_AUTHOR, 'create'),
        ('line', top_line, READER, 'create'), ('line', bottom_line, READER, 'create'),
        ('element', kept_bucket, REORDERED_BY, 'update'), ('element', paragraph, REORDERED_BY, 'update'),
        ('element', split_bucket, REORDERED_BY, 'create'), ('line', bottom_line, REORDERED_BY, 'update'),
    ]


def test_a_model_without_a_template_reads_the_page_as_its_dataset_does_so_the_kept_page_stays_in_order(
        conn, models, monkeypatch):
    # A dataset whose model has no template works its order out from the page - two columns,
    # left then right - and so does the request, so keeping it reorders nothing.
    _served_by(monkeypatch, [('Paragraph', [0.05, 0.1, 0.45, 0.3], 0.91), ('Paragraph', [0.55, 0.2, 0.95, 0.4], 0.92),
                             ('Paragraph', [0.05, 0.5, 0.45, 0.7], 0.93), ('Paragraph', [0.55, 0.6, 0.95, 0.8], 0.94)])
    answer = _recognize(conn, 'Mine', [_leaf()], models['layout'])
    page_id = _page_id(conn, 'mine')

    assert [r['confidence'] for r in answer['pages'][0]['regions']] == [0.91, 0.93, 0.92, 0.94]
    assert [(e['conf'], e['order'], e['lines']) for e in _held(conn, page_id)] == [
        (0.91, 0, [('Paragraph 1', ring(0.05, 0.15, 0.45, 0.25))]),
        (0.93, 1, [('Paragraph 1', ring(0.05, 0.55, 0.45, 0.65))]),
        (0.92, 2, [('Paragraph 1', ring(0.55, 0.25, 0.95, 0.35))]),
        (0.94, 3, [('Paragraph 1', ring(0.55, 0.65, 0.95, 0.75))]),
    ]
    assert [r for r in _revisions(conn, 'mine') if r[2] == REORDERED_BY] == []


def test_a_divider_is_a_container_of_the_template_so_no_line_is_read_in_it_nor_kept_unassigned(
        conn, models, monkeypatch):
    _served_by(monkeypatch, [('Header', [0.1, 0.1, 0.9, 0.2], 0.9), ('Divider', [0.1, 0.3, 0.9, 0.4], 0.8),
                             ('Paragraph', [0.1, 0.5, 0.9, 0.7], 0.7)])
    answer = _recognize(conn, 'Mine', [_leaf()], models['layout'])

    held = sorted(_held(conn, _page_id(conn, 'mine')), key=lambda e: e['bbox'][1])
    assert [(e['class'], e['kind'], [text for text, _ in e['lines']]) for e in held] == [
        ('Header', 'content', ['Header 1']), ('Divider', 'container', []), ('Paragraph', 'content', ['Paragraph 1'])]
    assert [(r['class'], r['role']) for r in answer['pages'][0]['regions']] == [
        ('Header', 'content'), ('Paragraph', 'content'), ('Divider', 'container')]
    assert [line['text'] for line in answer['pages'][0]['lines']] == ['Header 1', 'Paragraph 1']


def test_a_region_the_template_reads_as_a_container_but_the_dataset_as_content_is_left_for_line_detection(
        conn, models, monkeypatch):
    _dataset(conn, 'plain', 'Plainbook')
    layout_templates.insert_classes(conn, 'job_layout_classes', 'job_id', 'plain', PLAIN_CLASSES[:1])
    layout_templates.decide_labels(conn, 'plain', models['layout'], {'Table': 1, 'Paragraph': 1})
    _served_by(monkeypatch, [('Table', [0.1, 0.1, 0.9, 0.5], 0.9), ('Paragraph', [0.1, 0.6, 0.9, 0.8], 0.8)])
    answer = _recognize(conn, 'Plainbook', [_leaf()], models['layout'])
    page_id = _page_id(conn, 'plain')

    assert [(r['class'], r['role']) for r in answer['pages'][0]['regions']] == [
        ('Paragraph', 'content'), ('Table', 'container')]
    assert [(e['class'], e['kind'], e['bbox'], e['lines']) for e in _held(conn, page_id)] == [
        ('Text', 'content', [0.1, 0.1, 0.9, 0.5], []),
        ('Text', 'content', [0.1, 0.6, 0.9, 0.8], [('Paragraph 1', ring(0.1, 0.65, 0.9, 0.75))]),
    ]
    # No line was looked for in the Table, so it is what stale_elements calls a box that
    # never had detection - the next run of the dataset finds its lines.
    (never_detected, _), (_, _) = _ids(conn, page_id)
    assert [(r['id'], r['page_id']) for r in text_job.stale_elements(conn, 'plain')] == [(never_detected, page_id)]
