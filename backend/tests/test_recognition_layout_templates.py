import io
import json
import re
import xml.etree.ElementTree as ET

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app import backend_client, formats, layout_templates, recognize, store
from app.deps import get_db
from app.main import app

SECRET = 'test-secret'
ALICE = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'alice', 'X-Auth-Role': 'member', 'X-Auth-Caps': 'recognize'}
CROP_LINE = [[0.0, 0.25], [1.0, 0.25], [1.0, 0.75], [0.0, 0.75]]
READ_CONFIDENCE = 0.8
LETTERS = [('Address', 'content', None), ('Heading', 'content', None), ('Body', 'content', None),
           ('Signature', 'content', None), ('Entry', 'content', None), ('Amount', 'content', None),
           ('Row', 'container', 'across'), ('Block', 'container', 'down')]
PAGE = {'p': formats.PAGE_NS}

# Two columns of a 1000 x 1000 page, sent bottom right first. Address starts higher than
# Heading but its centre (y 0.24) is lower than Heading's (0.15).
TWO_COLUMNS = [
    ('Signature', [0.55, 0.40, 0.95, 0.60], 0.6),
    ('Body', [0.05, 0.50, 0.45, 0.70], 0.7),
    ('Heading', [0.55, 0.05, 0.95, 0.25], 0.8),
    ('Address', [0.05, 0.02, 0.45, 0.46], 0.9),
]
# A Row reading across over an Amount (centre x 0.25, y 0.14) and an Entry (x 0.725, y 0.10);
# a Block reading down over an Entry (x 0.70, y 0.40) and an Amount (x 0.25, y 0.65); and a
# label no template has, below both. Either direction swapped reads its pair the other way.
CONTAINERS = [
    ('Block', [0.05, 0.30, 0.95, 0.90], 0.51),
    ('Amount', [0.10, 0.60, 0.40, 0.70], 0.52),
    ('Entry', [0.55, 0.08, 0.90, 0.12], 0.53),
    ('Marginalia', [0.05, 0.92, 0.95, 0.98], 0.54),
    ('Row', [0.05, 0.05, 0.95, 0.20], 0.55),
    ('Entry', [0.50, 0.32, 0.90, 0.48], 0.56),
    ('Amount', [0.10, 0.10, 0.40, 0.18], 0.57),
]


def _png(width: int, height: int) -> bytes:
    out = io.BytesIO()
    Image.new('RGB', (width, height), 'white').save(out, format='PNG')
    return out.getvalue()


def _ring(x0, y0, x1, y1) -> list:
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]


def _region(class_name: str, role: str, polygon: list, confidence: float) -> dict:
    return {'class': class_name, 'role': role, 'polygon': polygon, 'confidence': confidence}


def _line(polygon: list, text: str, region: int | None) -> dict:
    return {'polygon': polygon, 'text': text, 'confidence': READ_CONFIDENCE, 'region': region}


class FakeBackend:
    """A model backend for every model. Layout finds the boxes it is given. In a crop the
    lines model finds one line across the crop's middle half, on a whole page the lines it
    is given. OCR reads a line as its region's class - 'Page' outside every region - and
    its place there."""

    def __init__(self, detections: list, page_lines: list = ()):
        self.detections = detections
        self.page_lines = page_lines
        self.tasks: list[str] = []
        self.crops_searched: list[tuple[int, int]] = []
        self.on_wait = None

    def load(self, conn, model_id):
        return None, {}

    def info(self):
        return {}

    def max_items(self, task):
        return 16

    def predict_all(self, task, weights, params, items):
        self.tasks.append(task)
        if task == 'layout':
            return {'results': [{'detections': [{'label': label, 'bbox': bbox, 'confidence': confidence}
                                                for label, bbox, confidence in self.detections]} for _ in items]}
        if task == 'lines' and params == {'scope': 'crop'}:
            self.crops_searched += [item.image.size for item in items]
            return {'results': [{'lines': [{'polygon': CROP_LINE}]} for _ in items]}
        if task == 'lines':
            assert params == {'scope': 'page'}
            return {'results': [{'lines': [{'polygon': p} for p in self.page_lines]} for _ in items]}
        return {'results': [{'text': f"{item.context.get('element_class', 'Page')} {item.context['line_index'] + 1}",
                             'confidence': READ_CONFIDENCE} for item in items]}


@pytest.fixture
def conn(tmp_path, monkeypatch):
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    monkeypatch.setattr('app.config.MODEL_BACKENDS', {})
    monkeypatch.setattr('app.config.JOBS_DIR', tmp_path / 'jobs')
    monkeypatch.setattr('app.config.BLOBS_DIR', tmp_path / 'blobs')
    connection = store.connect(tmp_path / 'app.db')
    yield connection
    connection.close()


@pytest.fixture
def models(conn) -> dict[str, int]:
    ids = {task: conn.execute("INSERT INTO models (task, name, checkpoint, is_default, created_at) "
                              "VALUES (?, ?, ?, 1, '2026-01-01 00:00:00')",
                              (task, name, f'{task}.ckpt')).lastrowid
           for task, name in (('layout', 'RF-DETR'), ('lines', 'Lines'), ('ocr', 'Ocr'))}
    conn.commit()
    return ids


def _template(conn, name: str, outside_order: str, classes: list = LETTERS) -> int:
    template_id = conn.execute('INSERT INTO layout_templates (name, owner, outside_order) VALUES (?, ?, ?)',
                               (name, 'alice', outside_order)).lastrowid
    layout_templates.insert_classes(conn, 'layout_template_classes', 'template_id', template_id, [
        {'id': i + 1, 'name': class_name, 'role': role, 'reads': reads, 'color': None, 'position': i}
        for i, (class_name, role, reads) in enumerate(classes)])
    conn.commit()
    return template_id


def _make_default(conn, template_id: int) -> None:
    conn.execute('UPDATE layout_templates SET is_default = (id = ?)', (template_id,))
    conn.commit()


def _layout_model(conn, name: str, template_id: int | None = None, archived: bool = False,
                  created_at: str = '2026-02-01 00:00:00') -> int:
    model_id = conn.execute('INSERT INTO models (task, name, checkpoint, archived, layout_template_id, created_at) '
                            "VALUES ('layout', ?, ?, ?, ?, ?)",
                            (name, f'{name}.ckpt', int(archived), template_id, created_at)).lastrowid
    conn.commit()
    return model_id


def _serve(monkeypatch, backend: FakeBackend, unserved: set = frozenset()) -> None:
    monkeypatch.setattr(backend_client, 'client_for', lambda conn, model_id: None if model_id in unserved else backend)


def _read(conn, layout_id, uploads: list | None = None, **fields) -> dict:
    return recognize.pages(conn, 'alice', uploads or [recognize.Upload('leaf.png', _png(1000, 1000))],
                           {'layout_model': str(layout_id), **fields})


def _post(conn, fields: dict):
    app.dependency_overrides[get_db] = lambda: conn
    try:
        return TestClient(app).post('/api/recognize/pages', headers=ALICE, data=fields,
                                    files=[('files', ('leaf.png', _png(1000, 1000), 'image/png'))])
    finally:
        app.dependency_overrides.clear()


def _offered_layout(conn) -> list[dict]:
    app.dependency_overrides[get_db] = lambda: conn
    try:
        response = TestClient(app).get('/api/recognize', headers=ALICE)
    finally:
        app.dependency_overrides.clear()
    assert response.status_code == 200, response.text
    assert response.json()['models']['lines'] == response.json()['models']['ocr'] == []
    return response.json()['models']['layout']


class TestATemplateOfItsOwn:
    def test_reading_from_the_page_it_reads_two_columns_the_left_one_first(self, conn, models, monkeypatch):
        model = _layout_model(conn, 'Letters layout', _template(conn, 'Letters', 'from_page'))
        backend = FakeBackend(TWO_COLUMNS)
        _serve(monkeypatch, backend)

        answer = _read(conn, model)

        assert answer['models']['layout'] == {'id': model, 'name': 'Letters layout'}
        assert answer['pages'] == [{
            'id': 'leaf.png', 'width': 1000, 'height': 1000,
            'regions': [
                _region('Address', 'content', _ring(50, 20, 450, 460), 0.9),
                _region('Body', 'content', _ring(50, 500, 450, 700), 0.7),
                _region('Heading', 'content', _ring(550, 50, 950, 250), 0.8),
                _region('Signature', 'content', _ring(550, 400, 950, 600), 0.6),
            ],
            'lines': [
                _line(_ring(50, 130, 450, 350), 'Address 1', 0),
                _line(_ring(50, 550, 450, 650), 'Body 1', 1),
                _line(_ring(550, 100, 950, 200), 'Heading 1', 2),
                _line(_ring(550, 450, 950, 550), 'Signature 1', 3),
            ],
        }]
        assert backend.tasks == ['layout', 'lines', 'ocr']
        assert tuple(conn.execute('SELECT requests, pages, lines FROM recognition_usage').fetchone()) == (1, 1, 4)

    def test_reading_top_to_bottom_it_reads_the_same_boxes_by_their_centres(self, conn, models, monkeypatch):
        model = _layout_model(conn, 'Letters layout', _template(conn, 'Letters', 'top_to_bottom'))
        _serve(monkeypatch, FakeBackend(TWO_COLUMNS))

        page = _read(conn, model)['pages'][0]

        assert [(r['class'], r['confidence']) for r in page['regions']] == [
            ('Heading', 0.8), ('Address', 0.9), ('Signature', 0.6), ('Body', 0.7)]
        assert [(line['text'], line['region']) for line in page['lines']] == [
            ('Heading 1', 0), ('Address 1', 1), ('Signature 1', 2), ('Body 1', 3)]

    def test_its_containers_read_across_and_down_and_a_label_it_lacks_is_content_of_that_name(
            self, conn, models, monkeypatch):
        model = _layout_model(conn, 'Letters layout', _template(conn, 'Letters', 'from_page'))
        _serve(monkeypatch, FakeBackend(CONTAINERS))

        page = _read(conn, model)['pages'][0]

        assert page['regions'] == [
            _region('Amount', 'content', _ring(100, 100, 400, 180), 0.57),
            _region('Entry', 'content', _ring(550, 80, 900, 120), 0.53),
            _region('Entry', 'content', _ring(500, 320, 900, 480), 0.56),
            _region('Amount', 'content', _ring(100, 600, 400, 700), 0.52),
            _region('Marginalia', 'content', _ring(50, 920, 950, 980), 0.54),
            _region('Row', 'container', _ring(50, 50, 950, 200), 0.55),
            _region('Block', 'container', _ring(50, 300, 950, 900), 0.51),
        ]
        assert page['lines'] == [
            _line(_ring(100, 120, 400, 160), 'Amount 1', 0),
            _line(_ring(550, 90, 900, 110), 'Entry 1', 1),
            _line(_ring(500, 360, 900, 440), 'Entry 1', 2),
            _line(_ring(100, 625, 400, 675), 'Amount 1', 3),
            _line(_ring(50, 935, 950, 965), 'Marginalia 1', 4),
        ]

    @pytest.mark.parametrize('outside_order', ['from_page', 'top_to_bottom'])
    def test_a_container_inside_another_is_filled_first_and_the_containers_are_listed_outside_in(
            self, conn, models, monkeypatch, outside_order):
        # A Row reading across holds two Blocks reading down; the right Block stands higher,
        # so a Row read down would take it first. Sent outer Row before the Blocks.
        model = _layout_model(conn, 'Letters layout', _template(conn, 'Letters', outside_order))
        _serve(monkeypatch, FakeBackend([
            ('Signature', [0.60, 0.50, 0.85, 0.60], 0.61),
            ('Body', [0.15, 0.60, 0.40, 0.70], 0.62),
            ('Row', [0.05, 0.05, 0.95, 0.95], 0.63),
            ('Heading', [0.60, 0.15, 0.85, 0.25], 0.64),
            ('Block', [0.55, 0.05, 0.90, 0.80], 0.65),
            ('Address', [0.15, 0.20, 0.40, 0.30], 0.66),
            ('Block', [0.10, 0.10, 0.45, 0.90], 0.67),
        ]))

        page = _read(conn, model)['pages'][0]

        assert [(r['class'], r['role'], r['confidence']) for r in page['regions']] == [
            ('Address', 'content', 0.66), ('Body', 'content', 0.62), ('Heading', 'content', 0.64),
            ('Signature', 'content', 0.61), ('Row', 'container', 0.63), ('Block', 'container', 0.67),
            ('Block', 'container', 0.65)]
        assert [(line['text'], line['region']) for line in page['lines']] == [
            ('Address 1', 0), ('Body 1', 1), ('Heading 1', 2), ('Signature 1', 3)]

    def test_a_page_with_no_content_region_has_its_lines_found_on_the_whole_page_in_no_region(
            self, conn, models, monkeypatch):
        model = _layout_model(conn, 'Letters layout', _template(conn, 'Letters', 'from_page'))
        backend = FakeBackend([('Block', [0.05, 0.05, 0.95, 0.95], 0.7)],
                              page_lines=[_ring(0.1, 0.6, 0.9, 0.7), _ring(0.1, 0.2, 0.9, 0.3)])
        _serve(monkeypatch, backend)

        page = _read(conn, model)['pages'][0]

        assert page['regions'] == [_region('Block', 'container', _ring(50, 50, 950, 950), 0.7)]
        assert page['lines'] == [_line(_ring(100, 200, 900, 300), 'Page 1', None),
                                 _line(_ring(100, 600, 900, 700), 'Page 2', None)]
        assert backend.crops_searched == []

    def test_lines_stacked_in_a_container_reading_across_are_read_top_to_bottom(self, conn, models, monkeypatch):
        model = _layout_model(conn, 'Letters layout', _template(conn, 'Letters', 'from_page'))
        _serve(monkeypatch, FakeBackend([('Row', [0.05, 0.05, 0.95, 0.95], 0.7)],
                                        page_lines=[_ring(0.1, 0.6, 0.9, 0.7), _ring(0.1, 0.2, 0.9, 0.3)]))

        assert [line['polygon'] for line in _read(conn, model)['pages'][0]['lines']] == [
            _ring(100, 200, 900, 300), _ring(100, 600, 900, 700)]

    def test_its_page_document_nests_each_regions_lines_inside_the_container_holding_it(
            self, conn, models, monkeypatch):
        model = _layout_model(conn, 'Letters layout', _template(conn, 'Letters', 'from_page'))
        _serve(monkeypatch, FakeBackend(CONTAINERS))

        document = _read(conn, model, format='page')['pages'][0]['document']

        def nested(parent) -> list:
            return [(r.get('id'), re.search(r'type:([^;]+);', r.get('custom')).group(1),
                     [u.text for u in r.findall('p:TextLine/p:TextEquiv/p:Unicode', PAGE)], nested(r))
                    for r in parent if r.tag.endswith('Region')]
        assert nested(ET.fromstring(document).find('p:Page', PAGE)) == [
            ('r5', 'Marginalia', ['Marginalia 1'], []),
            ('r6', 'Row', [], [('r1', 'Amount', ['Amount 1'], []), ('r2', 'Entry', ['Entry 1'], [])]),
            ('r7', 'Block', [], [('r3', 'Entry', ['Entry 1'], []), ('r4', 'Amount', ['Amount 1'], [])]),
        ]

    def test_its_text_document_reads_the_lines_in_the_regions_order(self, conn, models, monkeypatch):
        model = _layout_model(conn, 'Letters layout', _template(conn, 'Letters', 'from_page'))
        _serve(monkeypatch, FakeBackend(TWO_COLUMNS))

        assert _read(conn, model, format='txt')['pages'][0]['document'] == \
            'Address 1\nBody 1\nHeading 1\nSignature 1'

    def test_kept_into_a_new_dataset_the_page_holds_its_regions_in_the_answers_order(
            self, conn, models, monkeypatch):
        letters = _template(conn, 'Letters', 'from_page')
        model = _layout_model(conn, 'Letters layout', letters)
        _serve(monkeypatch, FakeBackend(CONTAINERS))

        kept = _read(conn, model, keep='Ledger')['kept']

        job_id = kept['dataset']
        assert kept == {'dataset': job_id, 'name': 'Ledger', 'created': True, 'pages': 1, 'duplicates': []}
        job = conn.execute('SELECT layout_template_id, run_layout, model_layout_id FROM jobs WHERE id = ?',
                           (job_id,)).fetchone()
        assert tuple(job) == (letters, 1, model)
        assert [(c['name'], c['role'], c['reads']) for c in layout_templates.job_classes(conn, job_id)] == LETTERS
        elements = conn.execute(
            'SELECT e.id, e.class_name, e.kind, e.order_idx, e.bbox FROM elements e JOIN pages p ON e.page_id = p.id '
            "WHERE p.job_id = ? AND e.deleted = 0 ORDER BY e.kind = 'container', e.order_idx", (job_id,)).fetchall()
        held = [(e['class_name'], e['kind'], e['order_idx'], json.loads(e['bbox']),
                 [r['text'] for r in conn.execute('SELECT text FROM lines WHERE element_id = ? AND deleted = 0 '
                                                  'ORDER BY order_idx', (e['id'],))]) for e in elements]
        assert held == [
            ('Amount', 'content', 0, [0.10, 0.10, 0.40, 0.18], ['Amount 1']),
            ('Entry', 'content', 1, [0.55, 0.08, 0.90, 0.12], ['Entry 1']),
            ('Entry', 'content', 2, [0.50, 0.32, 0.90, 0.48], ['Entry 1']),
            ('Amount', 'content', 3, [0.10, 0.60, 0.40, 0.70], ['Amount 1']),
            ('Unassigned', 'orphan', 4, [0.05, 0.935, 0.95, 0.965], ['Marginalia 1']),
            ('Row', 'container', 0, [0.05, 0.05, 0.95, 0.20], []),
            ('Block', 'container', 1, [0.05, 0.30, 0.95, 0.90], []),
        ]


class TestTheDefaultTemplate:
    SCHEMATISMUS_PAGE = (
        ('Paragraph', [0.10, 0.70, 0.90, 0.86], 0.81),
        ('PageNumber', [0.45, 0.94, 0.55, 0.97], 0.82),
        ('WeirdTable', [0.05, 0.10, 0.95, 0.30], 0.83),
        ('Column', [0.05, 0.40, 0.95, 0.90], 0.84),
        ('Paragraph', [0.10, 0.44, 0.90, 0.60], 0.85),
        ('Paragraph', [0.60, 0.12, 0.90, 0.20], 0.86),
        ('Header', [0.10, 0.20, 0.40, 0.28], 0.87),
    )

    def test_schematismus_reads_the_page_number_first_as_one_line_a_weird_table_as_a_table_across_and_a_column_down(
            self, conn, models, monkeypatch):
        # The page number stands at the foot of the page; the Table's Header is lower than
        # its Paragraph but further left.
        backend = FakeBackend(self.SCHEMATISMUS_PAGE)
        _serve(monkeypatch, backend)

        response = _post(conn, {'layout_model': str(models['layout'])})

        assert response.status_code == 200, response.text
        assert response.json()['models']['layout'] == {'id': models['layout'], 'name': 'RF-DETR'}
        assert response.json()['pages'] == [{
            'id': 'leaf.png', 'width': 1000, 'height': 1000,
            'regions': [
                _region('Pagenumber', 'content', _ring(450, 940, 550, 970), 0.82),
                _region('Header', 'content', _ring(100, 200, 400, 280), 0.87),
                _region('Paragraph', 'content', _ring(600, 120, 900, 200), 0.86),
                _region('Paragraph', 'content', _ring(100, 440, 900, 600), 0.85),
                _region('Paragraph', 'content', _ring(100, 700, 900, 860), 0.81),
                _region('Table', 'container', _ring(50, 100, 950, 300), 0.83),
                _region('Column', 'container', _ring(50, 400, 950, 900), 0.84),
            ],
            'lines': [
                _line(_ring(450, 940, 550, 970), 'Pagenumber 1', 0),
                _line(_ring(100, 220, 400, 260), 'Header 1', 1),
                _line(_ring(600, 140, 900, 180), 'Paragraph 1', 2),
                _line(_ring(100, 480, 900, 560), 'Paragraph 1', 3),
                _line(_ring(100, 740, 900, 820), 'Paragraph 1', 4),
            ],
        }]
        assert backend.crops_searched == [(300, 80), (300, 80), (800, 160), (800, 160)]

    def test_a_schematismus_divider_is_a_container_no_line_is_looked_for_in(self, conn, models, monkeypatch):
        backend = FakeBackend([('Divider', [0.05, 0.48, 0.95, 0.52], 0.7),
                               ('Paragraph', [0.10, 0.60, 0.90, 0.80], 0.9)])
        _serve(monkeypatch, backend)

        page = _read(conn, models['layout'])['pages'][0]

        assert page['regions'] == [_region('Paragraph', 'content', _ring(100, 600, 900, 800), 0.9),
                                   _region('Divider', 'container', _ring(50, 480, 950, 520), 0.7)]
        assert page['lines'] == [_line(_ring(100, 650, 900, 750), 'Paragraph 1', 0)]
        assert backend.crops_searched == [(800, 200)]

    def test_a_model_without_a_template_reads_by_a_changed_default_and_keeps_no_schematismus_rule(
            self, conn, models, monkeypatch):
        # Under Letters a PageNumber is a label like any other: not renamed, not read first,
        # its lines looked for in its box.
        _make_default(conn, _template(conn, 'Letters', 'from_page'))
        backend = FakeBackend([('PageNumber', [0.45, 0.90, 0.55, 0.98], 0.8),
                               ('Body', [0.10, 0.10, 0.90, 0.50], 0.9)])
        _serve(monkeypatch, backend)

        page = _read(conn, models['layout'])['pages'][0]

        assert page['regions'] == [_region('Body', 'content', _ring(100, 100, 900, 500), 0.9),
                                   _region('PageNumber', 'content', _ring(450, 900, 550, 980), 0.8)]
        assert page['lines'] == [_line(_ring(100, 200, 900, 400), 'Body 1', 0),
                                 _line(_ring(450, 920, 550, 960), 'PageNumber 1', 1)]
        assert backend.crops_searched == [(800, 400), (100, 80)]


def test_each_page_is_laid_out_in_its_own_pixels(conn, models, monkeypatch):
    model = _layout_model(conn, 'Letters layout', _template(conn, 'Letters', 'from_page'))
    _serve(monkeypatch, FakeBackend([('Body', [0.10, 0.20, 0.90, 0.60], 0.9)]))

    answer = _read(conn, model, [recognize.Upload('big.png', _png(1000, 1000)),
                                 recognize.Upload('small.png', _png(500, 250))])

    assert answer['models']['layout'] == {'id': model, 'name': 'Letters layout'}
    assert [(p['id'], p['regions'], p['lines']) for p in answer['pages']] == [
        ('big.png', [_region('Body', 'content', _ring(100, 200, 900, 600), 0.9)],
         [_line(_ring(100, 300, 900, 500), 'Body 1', 0)]),
        ('small.png', [_region('Body', 'content', _ring(50, 50, 450, 150), 0.9)],
         [_line(_ring(50, 75, 450, 125), 'Body 1', 0)]),
    ]


def test_an_empty_layout_model_field_reads_the_page_without_layout(conn, models, monkeypatch):
    backend = FakeBackend([('Body', [0.10, 0.20, 0.90, 0.60], 0.9)],
                          page_lines=[_ring(0.1, 0.5, 0.9, 0.6), _ring(0.1, 0.1, 0.9, 0.2)])
    _serve(monkeypatch, backend)

    answer = _read(conn, '')

    assert set(answer['models']) == {'lines', 'ocr'}
    assert answer['pages'] == [{
        'id': 'leaf.png', 'width': 1000, 'height': 1000,
        'lines': [{'polygon': _ring(100, 100, 900, 200), 'text': 'Page 1', 'confidence': READ_CONFIDENCE},
                  {'polygon': _ring(100, 500, 900, 600), 'text': 'Page 2', 'confidence': READ_CONFIDENCE}],
    }]
    assert backend.tasks == ['lines', 'ocr']


class TestTheOffer:
    @pytest.fixture
    def offer(self, conn, models, monkeypatch) -> dict[str, int]:
        letters = _template(conn, 'Letters', 'from_page')
        ids = {
            'default': models['layout'],
            'letters': _layout_model(conn, 'Letters layout', letters, created_at='2026-02-01 00:00:00'),
            'schematismus': _layout_model(conn, 'Volumes layout', layout_templates.ensure_schematismus(conn),
                                          created_at='2026-03-01 00:00:00'),
            'archived': _layout_model(conn, 'Old layout', letters, archived=True, created_at='2026-04-01 00:00:00'),
            'unserved': _layout_model(conn, 'Unserved layout', letters, created_at='2026-05-01 00:00:00'),
            'letters_template': letters,
        }
        layouts = {ids[k] for k in ('default', 'letters', 'schematismus', 'archived')}
        backend = FakeBackend([])
        monkeypatch.setattr(backend_client, 'client_for',
                            lambda conn, model_id: backend if model_id in layouts else None)
        return ids

    def test_each_served_layout_model_comes_with_the_template_it_reads_by(self, conn, offer):
        assert _offered_layout(conn) == [
            {'id': offer['default'], 'name': 'RF-DETR', 'default': True, 'template': 'Schematismus'},
            {'id': offer['letters'], 'name': 'Letters layout', 'default': False, 'template': 'Letters'},
            {'id': offer['schematismus'], 'name': 'Volumes layout', 'default': False, 'template': 'Schematismus'},
        ]

    def test_a_model_without_a_template_follows_a_changed_default_and_one_with_its_own_keeps_it(self, conn, offer):
        _make_default(conn, offer['letters_template'])

        assert [(m['id'], m['template']) for m in _offered_layout(conn)] == [
            (offer['default'], 'Letters'), (offer['letters'], 'Letters'), (offer['schematismus'], 'Schematismus')]


@pytest.mark.parametrize('named, status, detail', [
    ('abc', 400, 'layout_model must be a model id'),
    ('2.5', 400, 'layout_model must be a model id'),
    ('archived', 400, 'not an available layout model'),
    ('ocr', 400, 'not an available layout model'),
    ('lines', 400, 'not an available layout model'),
    ('missing', 400, 'not an available layout model'),
    ('unserved', 503, 'the layout model "Unserved layout" is not on a configured model backend'),
])
def test_a_layout_model_that_cannot_run_is_refused_before_anything_is_read(
        conn, models, monkeypatch, named, status, detail):
    ids = {'archived': _layout_model(conn, 'Old layout', archived=True),
           'unserved': _layout_model(conn, 'Unserved layout'),
           'ocr': models['ocr'], 'lines': models['lines'], 'missing': 9999}
    backend = FakeBackend([('Body', [0.10, 0.20, 0.90, 0.60], 0.9)])
    _serve(monkeypatch, backend, unserved={ids['unserved']})

    response = _post(conn, {'layout_model': str(ids.get(named, named))})

    assert (response.status_code, response.json()['detail']) == (status, detail)
    assert backend.tasks == []
    assert conn.execute('SELECT COUNT(*) FROM recognition_usage').fetchone()[0] == 0


# Four paragraphs in two columns, sent out of order: by columns they read left top, left
# bottom, right top, right bottom; top to bottom by centre they interleave.
PARAGRAPH_COLUMNS = [
    ('Paragraph', [0.55, 0.15, 0.95, 0.35], 0.9),
    ('Paragraph', [0.05, 0.50, 0.45, 0.70], 0.9),
    ('Paragraph', [0.05, 0.10, 0.45, 0.30], 0.9),
    ('Paragraph', [0.55, 0.55, 0.95, 0.75], 0.9),
]
LOOSE_COLUMNS = [_ring(0.55, 0.3, 0.95, 0.4), _ring(0.05, 0.1, 0.45, 0.2), _ring(0.55, 0.1, 0.95, 0.2),
                 _ring(0.05, 0.3, 0.45, 0.4)]


class TestTheAnswerReadsAsTheKeptDataset:
    """Whatever the template, a page reads in the answer as the dataset it is kept in reads
    it - so a kept page needs no reordering, and a page added in the app later reads alike."""

    @pytest.mark.parametrize('outside_order, detections, page_lines, count', [
        (None, PARAGRAPH_COLUMNS, (), 4),
        (None, [('Column', [0.02, 0.02, 0.98, 0.98], 0.6)], LOOSE_COLUMNS, 4),
        ('from_page', TWO_COLUMNS, (), 4),
        ('top_to_bottom', TWO_COLUMNS, (), 4),
        ('from_page', CONTAINERS, (), 5),
        ('from_page', [('Row', [0.05, 0.05, 0.95, 0.95], 0.7)], [_ring(0.1, 0.6, 0.9, 0.7), _ring(0.1, 0.2, 0.9, 0.3)],
         2),
    ], ids=['no template, two columns', 'no template, lines in a column', 'from the page', 'top to bottom',
            'containers', 'lines in an across container'])
    def test_a_kept_page_holds_the_lines_in_the_answers_order_and_is_not_reordered(
            self, conn, models, monkeypatch, outside_order, detections, page_lines, count):
        model = models['layout'] if outside_order is None else \
            _layout_model(conn, 'Letters layout', _template(conn, 'Letters', outside_order))
        _serve(monkeypatch, FakeBackend(detections, page_lines=page_lines))

        answer = _read(conn, model, keep='Kept')

        answered = [line['polygon'] for line in answer['pages'][0]['lines']]
        assert len(answered) == count
        kept = [[[round(x * 1000), round(y * 1000)] for x, y in json.loads(row['polygon'])] for row in conn.execute(
            'SELECT l.polygon FROM lines l JOIN elements e ON l.element_id = e.id JOIN pages p ON e.page_id = p.id '
            "WHERE p.job_id = ? AND e.deleted = 0 AND l.deleted = 0 AND e.kind != 'container' "
            'ORDER BY e.order_idx, l.order_idx', (answer['kept']['dataset'],))]
        assert kept == answered
        assert conn.execute("SELECT COUNT(*) FROM revisions WHERE author = 'system:reading-order'").fetchone()[0] == 0
