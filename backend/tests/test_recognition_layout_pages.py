import io
import json
import xml.etree.ElementTree as ET
from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app import backend_client, formats, layout_templates, recognize, store
from app.backend_client import Encoded
from app.deps import get_db
from app.main import app

SECRET = 'test-secret'
ALICE = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'alice', 'X-Auth-Role': 'member', 'X-Auth-Caps': 'recognize'}
READ_CONFIDENCE = 0.75
NS = {'p': formats.PAGE_NS, 'a': formats.ALTO_NS, 'h': 'http://www.w3.org/1999/xhtml'}

# A two-column page as the line model finds it on a 1000 x 500 scan, in the scrambled order
# a detector gives: the column sweep reads L1 L2 R1 R2, a plain top-to-bottom sort L1 R1 L2 R2.
L1 = [[0.05, 0.1], [0.45, 0.1], [0.45, 0.2], [0.05, 0.2]]
L2 = [[0.05, 0.3], [0.45, 0.3], [0.45, 0.4], [0.05, 0.4]]
R1 = [[0.55, 0.1], [0.95, 0.1], [0.95, 0.2], [0.55, 0.2]]
R2 = [[0.55, 0.3], [0.95, 0.3], [0.95, 0.4], [0.55, 0.4]]
TWO_COLUMNS = [R2, L1, R1, L2]
L1_PX = [[50, 50], [450, 50], [450, 100], [50, 100]]
L2_PX = [[50, 150], [450, 150], [450, 200], [50, 200]]
R1_PX = [[550, 50], [950, 50], [950, 100], [550, 100]]
R2_PX = [[550, 150], [950, 150], [950, 200], [550, 200]]
SWEPT = [{'polygon': L1_PX, 'text': 'loose 1', 'confidence': READ_CONFIDENCE, 'region': None},
         {'polygon': L2_PX, 'text': 'loose 2', 'confidence': READ_CONFIDENCE, 'region': None},
         {'polygon': R1_PX, 'text': 'loose 3', 'confidence': READ_CONFIDENCE, 'region': None},
         {'polygon': R2_PX, 'text': 'loose 4', 'confidence': READ_CONFIDENCE, 'region': None}]
# Inside a Column, lines level with each other are read left to right before the next row,
# as a dataset reads the lines a Column holds.
ROW_BY_ROW = [{'polygon': L1_PX, 'text': 'loose 1', 'confidence': READ_CONFIDENCE, 'region': None},
              {'polygon': R1_PX, 'text': 'loose 2', 'confidence': READ_CONFIDENCE, 'region': None},
              {'polygon': L2_PX, 'text': 'loose 3', 'confidence': READ_CONFIDENCE, 'region': None},
              {'polygon': R2_PX, 'text': 'loose 4', 'confidence': READ_CONFIDENCE, 'region': None}]

# Two lines in every crop, the lower one first, so only a sort puts them top to bottom.
TWO_IN_A_CROP = [[[0.0, 0.6], [1.0, 0.6], [1.0, 0.9], [0.0, 0.9]], [[0.0, 0.1], [1.0, 0.1], [1.0, 0.4], [0.0, 0.4]]]

HEADER = ('Header', [0.1, 0.1, 0.9, 0.3], 0.9)
PARAGRAPH = ('Paragraph', [0.1, 0.4, 0.9, 0.8], 0.8)
HEADER_REGION = {'class': 'Header', 'role': 'content', 'polygon': [[100, 50], [900, 50], [900, 150], [100, 150]],
                 'confidence': 0.9}
PARAGRAPH_REGION = {'class': 'Paragraph', 'role': 'content',
                    'polygon': [[100, 200], [900, 200], [900, 400], [100, 400]], 'confidence': 0.8}
HEADER_A = [[100, 60], [900, 60], [900, 90], [100, 90]]
HEADER_B = [[100, 110], [900, 110], [900, 140], [100, 140]]
PARAGRAPH_A = [[100, 220], [900, 220], [900, 280], [100, 280]]
PARAGRAPH_B = [[100, 320], [900, 320], [900, 380], [100, 380]]
PAGE_NUMBER_BOX = [[450, 10], [550, 10], [550, 40], [450, 40]]


def _line(polygon: list, text: str, region: int | None) -> dict:
    return {'polygon': polygon, 'text': text, 'confidence': READ_CONFIDENCE, 'region': region}


def _png(width: int, height: int) -> bytes:
    out = io.BytesIO()
    Image.new('RGB', (width, height), 'white').save(out, format='PNG')
    return out.getvalue()


def _size(image) -> tuple[int, int]:
    if isinstance(image, Encoded):
        with Image.open(io.BytesIO(image.data)) as opened:
            return opened.size
    return image.size


def _detection(label: str, bbox: list, confidence: float | None) -> dict:
    return {'label': label, 'bbox': bbox, **({'confidence': confidence} if confidence is not None else {})}


class FakeBackend:
    """Every model backend at once. Layout answers each page it is sent with the next page's
    boxes; lines answer a whole page with `page_lines` and every crop with `crop_lines`; a
    reading names the region class and place it was asked with, so a line's text shows the
    context it was read in."""

    def __init__(self, *pages_boxes: list, page_lines: list = (), crop_lines: list = TWO_IN_A_CROP):
        self.pages_boxes = iter(pages_boxes)
        self.page_lines = page_lines
        self.crop_lines = crop_lines
        self.sent: list = []
        self.contexts: list[dict] = []
        self.on_wait = None

    def load(self, conn, model_id):
        return None, {}

    def info(self):
        return {}

    def max_items(self, task):
        return 16

    def predict_all(self, task, weights, params, items):
        if task == 'layout':
            self.sent.append(('layout', [('file' if isinstance(item.image, Encoded) else 'image', _size(item.image))
                                         for item in items]))
            return {'results': [{'detections': [_detection(*box) for box in next(self.pages_boxes)]}
                                for _ in items]}
        if task == 'lines':
            self.sent.append(('lines', params, [_size(item.image) for item in items]))
            found = self.page_lines if params['scope'] == 'page' else self.crop_lines
            return {'results': [{'lines': [{'polygon': polygon} for polygon in found]} for _ in items]}
        self.contexts += [item.context for item in items]
        return {'results': [{'text': f"{item.context.get('element_class', 'loose')} {item.context['line_index'] + 1}",
                             'confidence': READ_CONFIDENCE} for item in items]}


def _canonical(contexts: list[dict]) -> list[dict]:
    return sorted(contexts, key=lambda context: json.dumps(context, sort_keys=True))


@pytest.fixture
def conn(tmp_path, monkeypatch):
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    monkeypatch.setattr('app.config.MODEL_BACKENDS', {})
    connection = store.connect(tmp_path / 'app.db')
    yield connection
    connection.close()


@pytest.fixture
def models(conn) -> dict[str, int]:
    ids = {task: conn.execute('INSERT INTO models (task, name, checkpoint, is_default) VALUES (?, ?, ?, 1)',
                              (task, task.title(), f'{task}.ckpt')).lastrowid for task in ('layout', 'lines', 'ocr')}
    conn.commit()
    return ids


def _served_by(monkeypatch, backend: FakeBackend) -> FakeBackend:
    monkeypatch.setattr(backend_client, 'client_for', lambda conn, model_id: backend)
    return backend


def _laid_out(conn, models, files: list[tuple[str, bytes]], **fields) -> dict:
    return recognize.pages(conn, 'alice', [recognize.Upload(name, data) for name, data in files],
                           {'layout_model': str(models['layout']), **fields})


def _local(tag: str) -> str:
    return tag.rsplit('}', 1)[-1]


def _page_tree(document: str) -> tuple[dict, list, list]:
    page = ET.fromstring(document).find('p:Page', NS)
    order = [(ref.get('index'), ref.get('regionRef'))
             for ref in page.iterfind('p:ReadingOrder/p:OrderedGroup/p:RegionRefIndexed', NS)]
    return dict(page.attrib), order, [_page_region(r) for r in page if _local(r.tag) != 'ReadingOrder']


def _page_region(region) -> dict:
    return {'tag': _local(region.tag), **region.attrib, 'coords': region.find('p:Coords', NS).get('points'),
            'lines': [(line.get('id'), line.get('custom'), line.find('p:Coords', NS).get('points'),
                       line.find('p:TextEquiv', NS).get('conf'), line.find('p:TextEquiv/p:Unicode', NS).text)
                      for line in region.findall('p:TextLine', NS)],
            'regions': [_page_region(r) for r in region if _local(r.tag).endswith('Region')]}


def _alto_tree(document: str) -> tuple[list, dict, list]:
    root = ET.fromstring(document)
    tags = [(tag.get('ID'), tag.get('LABEL')) for tag in root.iterfind('a:Tags/a:LayoutTag', NS)]
    page = root.find('a:Layout/a:Page', NS)
    return tags, dict(page.attrib), [_alto_block(b) for b in page.find('a:PrintSpace', NS)]


def _alto_block(block) -> dict:
    return {'tag': _local(block.tag), **block.attrib,
            'lines': [{**line.attrib, 'points': line.find('a:Shape/a:Polygon', NS).get('POINTS'),
                       'words': [word.get('CONTENT') for word in line.findall('a:String', NS)]}
                      for line in block.findall('a:TextLine', NS)],
            'blocks': [_alto_block(b) for b in block if _local(b.tag) != 'TextLine']}


def _hocr_tree(document: str) -> tuple[str, dict, list]:
    root = ET.fromstring(document)
    page = root.find('h:body/h:div', NS)
    return root.find('h:head/h:title', NS).text, dict(page.attrib), [_hocr_area(area) for area in page]


def _hocr_area(area) -> dict:
    paragraph = area.find('h:p', NS)
    return {**area.attrib,
            'lines': [] if paragraph is None else [{**line.attrib, 'words': [word.text for word in line]}
                                                   for line in paragraph],
            'areas': [_hocr_area(child) for child in area if _local(child.tag) == 'div']}


def test_a_page_where_layout_finds_nothing_has_its_lines_found_on_the_whole_page_in_column_order(
        conn, models, monkeypatch):
    backend = _served_by(monkeypatch, FakeBackend([], page_lines=TWO_COLUMNS))
    answer = _laid_out(conn, models, [('leaf.png', _png(1000, 500))])

    assert answer == {
        'models': {'layout': {'id': models['layout'], 'name': 'Layout'},
                   'lines': {'id': models['lines'], 'name': 'Lines'},
                   'ocr': {'id': models['ocr'], 'name': 'Ocr', 'decode': 'rescored'}},
        'pages': [{'id': 'leaf.png', 'width': 1000, 'height': 500, 'regions': [], 'lines': SWEPT}]}
    assert backend.sent == [('layout', [('file', (1000, 500))]), ('lines', {'scope': 'page'}, [(1000, 500)])]
    assert _canonical(backend.contexts) == [{'line_index': 0}, {'line_index': 1}, {'line_index': 2},
                                            {'line_index': 3}]


def test_a_page_with_only_a_container_keeps_it_as_a_region_and_finds_its_lines_on_the_whole_page(
        conn, models, monkeypatch):
    backend = _served_by(monkeypatch, FakeBackend([('Column', [0.02, 0.04, 0.98, 0.96], 0.6)],
                                                  page_lines=TWO_COLUMNS))
    page = _laid_out(conn, models, [('leaf.png', _png(1000, 500))])['pages'][0]

    assert page == {'id': 'leaf.png', 'width': 1000, 'height': 500,
                    'regions': [{'class': 'Column', 'role': 'container',
                                 'polygon': [[20, 20], [980, 20], [980, 480], [20, 480]], 'confidence': 0.6}],
                    'lines': ROW_BY_ROW}
    assert backend.sent == [('layout', [('file', (1000, 500))]), ('lines', {'scope': 'page'}, [(1000, 500)])]
    assert _canonical(backend.contexts) == [{'line_index': 0}, {'line_index': 1}, {'line_index': 2},
                                            {'line_index': 3}]


def test_a_page_whose_only_region_is_a_divider_has_no_content_region_so_its_lines_are_found_on_the_whole_page(
        conn, models, monkeypatch):
    # The Schematismus template makes Divider a container: a rule with no text, never read.
    backend = _served_by(monkeypatch, FakeBackend([('Divider', [0.05, 0.5, 0.95, 0.52], 0.7)],
                                                  page_lines=TWO_COLUMNS))
    page = _laid_out(conn, models, [('leaf.png', _png(1000, 500))])['pages'][0]

    assert page == {'id': 'leaf.png', 'width': 1000, 'height': 500,
                    'regions': [{'class': 'Divider', 'role': 'container',
                                 'polygon': [[50, 250], [950, 250], [950, 260], [50, 260]], 'confidence': 0.7}],
                    'lines': SWEPT}
    assert backend.sent == [('layout', [('file', (1000, 500))]), ('lines', {'scope': 'page'}, [(1000, 500)])]


def test_a_divider_among_text_regions_is_a_container_that_holds_no_line(conn, models, monkeypatch):
    backend = _served_by(monkeypatch, FakeBackend([PARAGRAPH, ('Divider', [0.1, 0.33, 0.9, 0.35], 0.7), HEADER]))
    page = _laid_out(conn, models, [('leaf.png', _png(1000, 500))], format='page')['pages'][0]

    assert page['regions'] == [HEADER_REGION, PARAGRAPH_REGION,
                               {'class': 'Divider', 'role': 'container',
                                'polygon': [[100, 165], [900, 165], [900, 175], [100, 175]], 'confidence': 0.7}]
    assert page['lines'] == [_line(HEADER_A, 'Header 1', 0), _line(HEADER_B, 'Header 2', 0),
                             _line(PARAGRAPH_A, 'Paragraph 1', 1), _line(PARAGRAPH_B, 'Paragraph 2', 1)]
    assert backend.sent == [('layout', [('file', (1000, 500))]),
                            ('lines', {'scope': 'crop'}, [(800, 100), (800, 200)])]
    assert _page_tree(page['document'])[2][2] == {
        'tag': 'SeparatorRegion', 'id': 'r3',
        'custom': 'readingOrder {index:2;} structure {type:Divider;} deeplabel {kind:container;}',
        'coords': '100,165 900,165 900,175 100,175', 'lines': [], 'regions': []}


def test_a_page_number_alone_is_read_as_one_line_of_its_box_without_asking_the_line_model(
        conn, models, monkeypatch):
    backend = _served_by(monkeypatch, FakeBackend([('PageNumber', [0.45, 0.02, 0.55, 0.08], 0.7)],
                                                  page_lines=TWO_COLUMNS))
    page = _laid_out(conn, models, [('leaf.png', _png(1000, 500))])['pages'][0]

    assert page == {'id': 'leaf.png', 'width': 1000, 'height': 500,
                    'regions': [{'class': 'Pagenumber', 'role': 'content', 'polygon': PAGE_NUMBER_BOX,
                                 'confidence': 0.7}],
                    'lines': [_line(PAGE_NUMBER_BOX, 'Pagenumber 1', 0)]}
    assert backend.sent == [('layout', [('file', (1000, 500))])]
    assert backend.contexts == [{'element_class': 'Pagenumber', 'line_index': 0}]


def test_content_regions_that_hold_no_line_leave_the_page_unread_rather_than_reading_it_whole(
        conn, models, monkeypatch):
    backend = _served_by(monkeypatch, FakeBackend([HEADER], page_lines=TWO_COLUMNS, crop_lines=[]))
    answer = _laid_out(conn, models, [('leaf.png', _png(1000, 500))])

    assert answer == {'models': {'layout': {'id': models['layout'], 'name': 'Layout'},
                                 'lines': {'id': models['lines'], 'name': 'Lines'}},
                      'pages': [{'id': 'leaf.png', 'width': 1000, 'height': 500, 'regions': [HEADER_REGION],
                                 'lines': []}]}
    assert backend.sent == [('layout', [('file', (1000, 500))]), ('lines', {'scope': 'crop'}, [(800, 100)])]
    assert backend.contexts == []


# A leaf in reading order: a page number, a heading, and a paragraph inside a table. The
# layout model gives them out of that order.
LEAF = [PARAGRAPH, HEADER, ('PageNumber', [0.45, 0.02, 0.55, 0.08], 0.7), ('Table', [0.05, 0.35, 0.95, 0.85], 0.6)]


def _leaf(conn, models, monkeypatch, **fields) -> tuple[dict, FakeBackend]:
    backend = _served_by(monkeypatch, FakeBackend(LEAF, page_lines=TWO_COLUMNS))
    return _laid_out(conn, models, [('leaf.png', _png(1000, 500))], **fields)['pages'][0], backend


def test_lines_are_read_top_to_bottom_in_each_region_and_counted_from_zero_in_each(conn, models, monkeypatch):
    page, backend = _leaf(conn, models, monkeypatch)

    assert page == {'id': 'leaf.png', 'width': 1000, 'height': 500,
                    'regions': [{'class': 'Pagenumber', 'role': 'content', 'polygon': PAGE_NUMBER_BOX,
                                 'confidence': 0.7},
                                HEADER_REGION, PARAGRAPH_REGION,
                                {'class': 'Table', 'role': 'container',
                                 'polygon': [[50, 175], [950, 175], [950, 425], [50, 425]], 'confidence': 0.6}],
                    'lines': [_line(PAGE_NUMBER_BOX, 'Pagenumber 1', 0),
                              _line(HEADER_A, 'Header 1', 1), _line(HEADER_B, 'Header 2', 1),
                              _line(PARAGRAPH_A, 'Paragraph 1', 2), _line(PARAGRAPH_B, 'Paragraph 2', 2)]}
    assert backend.sent == [('layout', [('file', (1000, 500))]),
                            ('lines', {'scope': 'crop'}, [(800, 100), (800, 200)])]
    assert _canonical(backend.contexts) == [
        {'element_class': 'Header', 'line_index': 0}, {'element_class': 'Header', 'line_index': 1},
        {'element_class': 'Pagenumber', 'line_index': 0},
        {'element_class': 'Paragraph', 'line_index': 0}, {'element_class': 'Paragraph', 'line_index': 1}]


def test_page_xml_nests_each_regions_lines_in_it_and_a_table_as_a_table_region_around_what_it_holds(
        conn, models, monkeypatch):
    page, _ = _leaf(conn, models, monkeypatch, format='page')

    assert page['lines'][1] == _line(HEADER_A, 'Header 1', 1)
    assert _page_tree(page['document']) == (
        {'imageFilename': 'leaf.png', 'imageWidth': '1000', 'imageHeight': '500'},
        [('0', 'r1'), ('1', 'r2'), ('2', 'r3'), ('3', 'r4')],
        [{'tag': 'TextRegion', 'id': 'r1', 'type': 'page-number',
          'custom': 'readingOrder {index:0;} structure {type:Pagenumber;}',
          'coords': '450,10 550,10 550,40 450,40',
          'lines': [('r1l1', 'readingOrder {index:0;}', '450,10 550,10 550,40 450,40', '0.7500', 'Pagenumber 1')],
          'regions': []},
         {'tag': 'TextRegion', 'id': 'r2', 'type': 'heading',
          'custom': 'readingOrder {index:1;} structure {type:Header;}',
          'coords': '100,50 900,50 900,150 100,150',
          'lines': [('r2l1', 'readingOrder {index:0;}', '100,60 900,60 900,90 100,90', '0.7500', 'Header 1'),
                    ('r2l2', 'readingOrder {index:1;}', '100,110 900,110 900,140 100,140', '0.7500', 'Header 2')],
          'regions': []},
         {'tag': 'TableRegion', 'id': 'r4',
          'custom': 'readingOrder {index:3;} structure {type:Table;} deeplabel {kind:container;}',
          'coords': '50,175 950,175 950,425 50,425', 'lines': [],
          'regions': [{'tag': 'TextRegion', 'id': 'r3', 'type': 'paragraph',
                       'custom': 'readingOrder {index:2;} structure {type:Paragraph;}',
                       'coords': '100,200 900,200 900,400 100,400',
                       'lines': [('r3l1', 'readingOrder {index:0;}', '100,220 900,220 900,280 100,280', '0.7500',
                                  'Paragraph 1'),
                                 ('r3l2', 'readingOrder {index:1;}', '100,320 900,320 900,380 100,380', '0.7500',
                                  'Paragraph 2')],
                       'regions': []}]}])


def test_alto_writes_each_region_as_a_text_block_of_its_class_and_a_container_as_a_composed_block(
        conn, models, monkeypatch):
    page, _ = _leaf(conn, models, monkeypatch, format='alto')

    assert _alto_tree(page['document']) == (
        [('tag1', 'Header'), ('tag2', 'Pagenumber'), ('tag3', 'Paragraph'), ('tag4', 'Table')],
        {'ID': 'p1', 'PHYSICAL_IMG_NR': '1', 'WIDTH': '1000', 'HEIGHT': '500'},
        [{'tag': 'TextBlock', 'ID': 'r1', 'HPOS': '450', 'VPOS': '10', 'WIDTH': '100', 'HEIGHT': '30',
          'TAGREFS': 'tag2',
          'lines': [{'ID': 'r1l1', 'HPOS': '450', 'VPOS': '10', 'WIDTH': '100', 'HEIGHT': '30',
                     'points': '450,10 550,10 550,40 450,40', 'words': ['Pagenumber', '1']}],
          'blocks': []},
         {'tag': 'TextBlock', 'ID': 'r2', 'HPOS': '100', 'VPOS': '50', 'WIDTH': '800', 'HEIGHT': '100',
          'TAGREFS': 'tag1',
          'lines': [{'ID': 'r2l1', 'HPOS': '100', 'VPOS': '60', 'WIDTH': '800', 'HEIGHT': '30',
                     'points': '100,60 900,60 900,90 100,90', 'words': ['Header', '1']},
                    {'ID': 'r2l2', 'HPOS': '100', 'VPOS': '110', 'WIDTH': '800', 'HEIGHT': '30',
                     'points': '100,110 900,110 900,140 100,140', 'words': ['Header', '2']}],
          'blocks': []},
         {'tag': 'ComposedBlock', 'ID': 'r4', 'HPOS': '50', 'VPOS': '175', 'WIDTH': '900', 'HEIGHT': '250',
          'TAGREFS': 'tag4 container', 'lines': [],
          'blocks': [{'tag': 'TextBlock', 'ID': 'r3', 'HPOS': '100', 'VPOS': '200', 'WIDTH': '800', 'HEIGHT': '200',
                      'TAGREFS': 'tag3',
                      'lines': [{'ID': 'r3l1', 'HPOS': '100', 'VPOS': '220', 'WIDTH': '800', 'HEIGHT': '60',
                                 'points': '100,220 900,220 900,280 100,280', 'words': ['Paragraph', '1']},
                                {'ID': 'r3l2', 'HPOS': '100', 'VPOS': '320', 'WIDTH': '800', 'HEIGHT': '60',
                                 'points': '100,320 900,320 900,380 100,380', 'words': ['Paragraph', '2']}],
                      'blocks': []}]}])


def test_hocr_writes_each_region_as_an_area_of_its_class_and_a_table_as_a_table_around_what_it_holds(
        conn, models, monkeypatch):
    page, _ = _leaf(conn, models, monkeypatch, format='hocr')

    assert _hocr_tree(page['document']) == (
        'leaf.png',
        {'class': 'ocr_page', 'id': 'page_1', 'title': 'image leaf.png; bbox 0 0 1000 500'},
        [{'class': 'ocr_carea', 'id': 'block_1', 'title': 'bbox 450 10 550 40; x_class Pagenumber',
          'lines': [{'class': 'ocr_line', 'id': 'line_1_1', 'title': 'bbox 450 10 550 40',
                     'words': ['Pagenumber', '1']}],
          'areas': []},
         {'class': 'ocr_carea', 'id': 'block_2', 'title': 'bbox 100 50 900 150; x_class Header',
          'lines': [{'class': 'ocr_line', 'id': 'line_2_1', 'title': 'bbox 100 60 900 90', 'words': ['Header', '1']},
                    {'class': 'ocr_line', 'id': 'line_2_2', 'title': 'bbox 100 110 900 140',
                     'words': ['Header', '2']}],
          'areas': []},
         {'class': 'ocr_table', 'id': 'block_4', 'title': 'bbox 50 175 950 425; x_class Table; x_container 1',
          'lines': [],
          'areas': [{'class': 'ocr_carea', 'id': 'block_3', 'title': 'bbox 100 200 900 400; x_class Paragraph',
                     'lines': [{'class': 'ocr_line', 'id': 'line_3_1', 'title': 'bbox 100 220 900 280',
                                'words': ['Paragraph', '1']},
                               {'class': 'ocr_line', 'id': 'line_3_2', 'title': 'bbox 100 320 900 380',
                                'words': ['Paragraph', '2']}],
                     'areas': []}]}])


def test_txt_with_layout_is_the_lines_text_in_reading_order(conn, models, monkeypatch):
    page, _ = _leaf(conn, models, monkeypatch, format='txt')

    assert page['document'] == 'Pagenumber 1\nHeader 1\nHeader 2\nParagraph 1\nParagraph 2'
    assert [line['region'] for line in page['lines']] == [0, 1, 1, 2, 2]


def test_lines_outside_every_region_are_one_text_region_in_each_document(conn, models, monkeypatch):
    def document(fmt: str) -> str:
        _served_by(monkeypatch, FakeBackend([('Column', [0.02, 0.04, 0.98, 0.96], 0.6)], page_lines=TWO_COLUMNS))
        return _laid_out(conn, models, [('leaf.png', _png(1000, 500))], format=fmt)['pages'][0]['document']

    assert _page_tree(document('page'))[1:] == (
        [('0', 'r1'), ('1', 'r2')],
        [{'tag': 'TextRegion', 'id': 'r1', 'type': 'other',
          'custom': 'readingOrder {index:0;} structure {type:Column;} deeplabel {kind:container;}',
          'coords': '20,20 980,20 980,480 20,480', 'lines': [],
          'regions': [{'tag': 'TextRegion', 'id': 'r2', 'type': 'other',
                       'custom': 'readingOrder {index:1;} structure {type:Text;}',
                       'coords': '50,50 950,50 950,200 50,200',
                       'lines': [('r2l1', 'readingOrder {index:0;}', '50,50 450,50 450,100 50,100', '0.7500',
                                  'loose 1'),
                                 ('r2l2', 'readingOrder {index:1;}', '550,50 950,50 950,100 550,100', '0.7500',
                                  'loose 2'),
                                 ('r2l3', 'readingOrder {index:2;}', '50,150 450,150 450,200 50,200', '0.7500',
                                  'loose 3'),
                                 ('r2l4', 'readingOrder {index:3;}', '550,150 950,150 950,200 550,200', '0.7500',
                                  'loose 4')],
                       'regions': []}]}])
    assert _alto_tree(document('alto'))[0::2] == (
        [('tag1', 'Column'), ('tag2', 'Text')],
        [{'tag': 'ComposedBlock', 'ID': 'r1', 'HPOS': '20', 'VPOS': '20', 'WIDTH': '960', 'HEIGHT': '460',
          'TAGREFS': 'tag1 container', 'lines': [],
          'blocks': [{'tag': 'TextBlock', 'ID': 'r2', 'HPOS': '50', 'VPOS': '50', 'WIDTH': '900', 'HEIGHT': '150',
                      'TAGREFS': 'tag2',
                      'lines': [{'ID': 'r2l1', 'HPOS': '50', 'VPOS': '50', 'WIDTH': '400', 'HEIGHT': '50',
                                 'points': '50,50 450,50 450,100 50,100', 'words': ['loose', '1']},
                                {'ID': 'r2l2', 'HPOS': '550', 'VPOS': '50', 'WIDTH': '400', 'HEIGHT': '50',
                                 'points': '550,50 950,50 950,100 550,100', 'words': ['loose', '2']},
                                {'ID': 'r2l3', 'HPOS': '50', 'VPOS': '150', 'WIDTH': '400', 'HEIGHT': '50',
                                 'points': '50,150 450,150 450,200 50,200', 'words': ['loose', '3']},
                                {'ID': 'r2l4', 'HPOS': '550', 'VPOS': '150', 'WIDTH': '400', 'HEIGHT': '50',
                                 'points': '550,150 950,150 950,200 550,200', 'words': ['loose', '4']}],
                      'blocks': []}]}])
    assert _hocr_tree(document('hocr'))[2] == [
        {'class': 'ocr_carea', 'id': 'block_1', 'title': 'bbox 20 20 980 480; x_class Column; x_container 1',
         'lines': [],
         'areas': [{'class': 'ocr_carea', 'id': 'block_2', 'title': 'bbox 50 50 950 200; x_class Text',
                    'lines': [{'class': 'ocr_line', 'id': 'line_2_1', 'title': 'bbox 50 50 450 100',
                               'words': ['loose', '1']},
                              {'class': 'ocr_line', 'id': 'line_2_2', 'title': 'bbox 550 50 950 100',
                               'words': ['loose', '2']},
                              {'class': 'ocr_line', 'id': 'line_2_3', 'title': 'bbox 50 150 450 200',
                               'words': ['loose', '3']},
                              {'class': 'ocr_line', 'id': 'line_2_4', 'title': 'bbox 550 150 950 200',
                               'words': ['loose', '4']}],
                    'areas': []}]}]
    assert document('txt') == 'loose 1\nloose 2\nloose 3\nloose 4'


def test_a_document_without_layout_is_one_text_region_of_every_line_as_before(conn, models, monkeypatch):
    backend = _served_by(monkeypatch, FakeBackend(page_lines=TWO_COLUMNS))
    answer = recognize.pages(conn, 'alice', [recognize.Upload('leaf.png', _png(1000, 500))], {'format': 'page'})
    page = answer['pages'][0]

    assert set(answer['models']) == {'lines', 'ocr'}
    assert {key: value for key, value in page.items() if key != 'document'} == {
        'id': 'leaf.png', 'width': 1000, 'height': 500,
        'lines': [{key: value for key, value in line.items() if key != 'region'} for line in SWEPT]}
    assert backend.sent == [('lines', {'scope': 'page'}, [(1000, 500)])]
    assert _page_tree(page['document']) == (
        {'imageFilename': 'leaf.png', 'imageWidth': '1000', 'imageHeight': '500'},
        [('0', 'r1')],
        [{'tag': 'TextRegion', 'id': 'r1', 'type': 'other', 'custom': 'readingOrder {index:0;} structure {type:Text;}',
          'coords': '50,50 950,50 950,200 50,200',
          'lines': [('r1l1', 'readingOrder {index:0;}', '50,50 450,50 450,100 50,100', '0.7500', 'loose 1'),
                    ('r1l2', 'readingOrder {index:1;}', '50,150 450,150 450,200 50,200', '0.7500', 'loose 2'),
                    ('r1l3', 'readingOrder {index:2;}', '550,50 950,50 950,100 550,100', '0.7500', 'loose 3'),
                    ('r1l4', 'readingOrder {index:3;}', '550,150 950,150 950,200 550,200', '0.7500', 'loose 4')],
          'regions': []}])


def test_the_layout_models_own_template_decides_the_containers_and_the_order(conn, models, monkeypatch):
    # Under Schematismus a Column would be a container and the page read top to bottom; this
    # template has no Column, makes a Band of its own a container, and reads by its columns.
    ledger = conn.execute("INSERT INTO layout_templates (name, owner, outside_order) "
                          "VALUES ('Ledger', 'alice', 'from_page')").lastrowid
    layout_templates.insert_classes(conn, 'layout_template_classes', 'template_id', ledger, [
        {'id': 1, 'name': 'Entry', 'role': 'content', 'reads': None, 'color': None, 'position': 0},
        {'id': 2, 'name': 'Band', 'role': 'container', 'reads': 'across', 'color': None, 'position': 1}])
    conn.execute('UPDATE models SET layout_template_id = ? WHERE id = ?', (ledger, models['layout']))
    conn.commit()
    backend = _served_by(monkeypatch, FakeBackend(
        [('Band', [0.0, 0.55, 1.0, 0.95], 0.4), ('Column', [0.05, 0.6, 0.95, 0.9], 0.5),
         ('Entry', [0.55, 0.3, 0.95, 0.4], 0.94), ('Entry', [0.55, 0.1, 0.95, 0.2], 0.93),
         ('Entry', [0.05, 0.3, 0.45, 0.4], 0.92), ('Entry', [0.05, 0.1, 0.45, 0.2], 0.91)],
        crop_lines=[[[0.0, 0.2], [1.0, 0.2], [1.0, 0.8], [0.0, 0.8]]]))
    page = _laid_out(conn, models, [('ledger.png', _png(1000, 500))])['pages'][0]

    assert page['regions'] == [
        {'class': 'Entry', 'role': 'content', 'polygon': L1_PX, 'confidence': 0.91},
        {'class': 'Entry', 'role': 'content', 'polygon': L2_PX, 'confidence': 0.92},
        {'class': 'Entry', 'role': 'content', 'polygon': R1_PX, 'confidence': 0.93},
        {'class': 'Entry', 'role': 'content', 'polygon': R2_PX, 'confidence': 0.94},
        {'class': 'Column', 'role': 'content', 'polygon': [[50, 300], [950, 300], [950, 450], [50, 450]],
         'confidence': 0.5},
        {'class': 'Band', 'role': 'container', 'polygon': [[0, 275], [1000, 275], [1000, 475], [0, 475]],
         'confidence': 0.4}]
    assert page['lines'] == [_line([[50, 60], [450, 60], [450, 90], [50, 90]], 'Entry 1', 0),
                             _line([[50, 160], [450, 160], [450, 190], [50, 190]], 'Entry 1', 1),
                             _line([[550, 60], [950, 60], [950, 90], [550, 90]], 'Entry 1', 2),
                             _line([[550, 160], [950, 160], [950, 190], [550, 190]], 'Entry 1', 3),
                             _line([[50, 330], [950, 330], [950, 420], [50, 420]], 'Column 1', 4)]
    assert backend.sent == [('layout', [('file', (1000, 500))]),
                            ('lines', {'scope': 'crop'}, [(400, 50), (400, 50), (400, 50), (400, 50), (900, 150)])]


def test_several_pages_are_each_laid_out_on_their_own_and_an_unreadable_one_fails_alone(conn, models, monkeypatch):
    backend = _served_by(monkeypatch, FakeBackend([HEADER], [], page_lines=TWO_COLUMNS))
    answer = _laid_out(conn, models, [('a.png', _png(1000, 500)), ('b.png', b'not an image'),
                                      ('c.png', _png(1000, 500))], format='txt')

    assert answer['pages'] == [
        {'id': 'a.png', 'width': 1000, 'height': 500, 'regions': [HEADER_REGION],
         'lines': [_line(HEADER_A, 'Header 1', 0), _line(HEADER_B, 'Header 2', 0)],
         'document': 'Header 1\nHeader 2'},
        {'id': 'b.png', 'error': 'the image could not be read'},
        {'id': 'c.png', 'width': 1000, 'height': 500, 'regions': [], 'lines': SWEPT,
         'document': 'loose 1\nloose 2\nloose 3\nloose 4'}]
    # Every page is laid out before any line is looked for: the two models may share a card.
    assert backend.sent == [('layout', [('file', (1000, 500))]), ('layout', [('file', (1000, 500))]),
                            ('lines', {'scope': 'crop'}, [(800, 100)]), ('lines', {'scope': 'page'}, [(1000, 500)])]
    usage = recognize.month_usage(conn, 'alice', datetime.now(UTC).strftime('%Y-%m'))
    assert {key: usage[key] for key in ('requests', 'pages', 'lines')} == {'requests': 1, 'pages': 2, 'lines': 6}


def test_a_page_taller_than_the_layout_limit_is_sent_downscaled_but_its_lines_are_cut_from_the_full_image(
        conn, models, monkeypatch):
    backend = _served_by(monkeypatch, FakeBackend([('Header', [0.1, 0.1, 0.9, 0.2], 0.9)]))
    page = _laid_out(conn, models, [('tall.png', _png(600, 6000))])['pages'][0]

    assert backend.sent == [('layout', [('image', (300, 3000))]), ('lines', {'scope': 'crop'}, [(480, 600)])]
    assert page == {'id': 'tall.png', 'width': 600, 'height': 6000,
                    'regions': [{'class': 'Header', 'role': 'content',
                                 'polygon': [[60, 600], [540, 600], [540, 1200], [60, 1200]], 'confidence': 0.9}],
                    'lines': [_line([[60, 660], [540, 660], [540, 840], [60, 840]], 'Header 1', 0),
                              _line([[60, 960], [540, 960], [540, 1140], [60, 1140]], 'Header 2', 0)]}


def test_through_the_route_a_region_the_detector_gave_no_confidence_and_a_line_outside_every_region_answer_null(
        conn, models, monkeypatch):
    _served_by(monkeypatch, FakeBackend([('Header', [0.1, 0.1, 0.9, 0.3], None)], [], page_lines=TWO_COLUMNS))
    app.dependency_overrides[get_db] = lambda: conn
    try:
        response = TestClient(app).post('/api/recognize/pages', headers=ALICE,
                                        data={'layout_model': str(models['layout'])},
                                        files=[('files', ('a.png', _png(1000, 500), 'image/png')),
                                               ('files', ('b.png', _png(1000, 500), 'image/png'))])
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    assert response.json()['pages'] == [
        {'id': 'a.png', 'width': 1000, 'height': 500, 'regions': [{**HEADER_REGION, 'confidence': None}],
         'lines': [_line(HEADER_A, 'Header 1', 0), _line(HEADER_B, 'Header 2', 0)]},
        {'id': 'b.png', 'width': 1000, 'height': 500, 'regions': [], 'lines': SWEPT}]
