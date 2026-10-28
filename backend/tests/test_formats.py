import pytest

from app import formats, imports

# A page as export.collect_job gives it: a heading of a class of the dataset's own, and a
# paragraph with a slanted line and a checked one.
PAGE = {
    'id': 1, 'idx': 0, 'filename': 'scan_001.png', 'width': 1000, 'height': 2000,
    'layout_checked': True, 'lines_checked': False,
    'elements': [
        {'order_idx': 0, 'class_name': 'Kopfzeile', 'bbox': [0.1, 0.05, 0.9, 0.1], 'conf': 1.0, 'kind': 'content',
         'lines': [{'id': 1, 'order_idx': 0, 'polygon': [[0.1, 0.05], [0.9, 0.05], [0.9, 0.1], [0.1, 0.1]],
                    'text': 'Zollbuecher', 'corrected_text': None, 'confidence': 0.9, 'checked': True}]},
        {'order_idx': 1, 'class_name': 'Paragraph', 'bbox': [0.1, 0.2, 0.9, 0.5], 'conf': 1.0, 'kind': 'content',
         'lines': [{'id': 2, 'order_idx': 0, 'polygon': [[0.1, 0.2], [0.9, 0.22], [0.9, 0.27], [0.1, 0.25]],
                    'text': 'Wien, den 3. May', 'corrected_text': 'Wien, den 3. Mai', 'confidence': 0.7,
                    'checked': False},
                   {'id': 3, 'order_idx': 1, 'polygon': [[0.1, 0.3], [0.9, 0.3], [0.9, 0.35], [0.1, 0.35]],
                    'text': 'Zoll & Maut', 'corrected_text': None, 'confidence': None, 'checked': True}]},
        {'order_idx': 2, 'class_name': 'Table', 'bbox': [0, 0, 1, 1], 'conf': 1.0, 'kind': 'container', 'lines': []},
    ],
}
DATA = {'job': {'name': 'Zollbücher <Band 3>'}, 'pages': [PAGE]}


def regions(parsed: dict) -> list:
    return [(r['class_name'], [(l['text'], l.get('checked')) for l in r['lines']]) for r in parsed['regions']]


def corners(parsed: dict) -> list:
    return [[[round(x, 3), round(y, 3)] for x, y in l['polygon']] for r in parsed['regions'] for l in r['lines']]


EXPECTED = [('Kopfzeile', [('Zollbuecher', True)]),
            ('Paragraph', [('Wien, den 3. Mai', False), ('Zoll & Maut', True)])]
SLANTED = [[0.1, 0.2], [0.9, 0.22], [0.9, 0.27], [0.1, 0.25]]


class TestPageXml:
    def test_reads_back_classes_text_outlines_and_checks(self):
        parsed = imports.parse_page_xml(formats.page_xml(PAGE).encode())

        assert (parsed['image'], parsed['width'], parsed['height']) == ('scan_001.png', 1000, 2000)
        assert regions(parsed) == EXPECTED
        assert corners(parsed)[1] == SLANTED

    def test_a_tool_reading_only_the_standard_sees_page_s_own_types(self):
        xml = formats.page_xml(PAGE)
        assert 'type="other"' in xml and 'type="paragraph"' in xml

    def test_someone_else_s_page_xml_is_read_as_before(self):
        xml = formats.page_xml(PAGE).replace('<Creator>DeepLabel</Creator>', '<Creator>Transkribus</Creator>')
        parsed = imports.parse_page_xml(xml.encode())
        assert [r['class_name'] for r in parsed['regions']] == ['Paragraph', 'Paragraph']
        assert all('checked' not in l for r in parsed['regions'] for l in r['lines'])


class TestAlto:
    def test_reads_back_classes_text_and_outlines(self):
        parsed = imports.parse_alto(formats.alto(PAGE).encode())

        assert (parsed['image'], parsed['width'], parsed['height']) == ('scan_001.png', 1000, 2000)
        assert [(r['class_name'], [l['text'] for l in r['lines']]) for r in parsed['regions']] == \
            [(name, [text for text, _ in lines]) for name, lines in EXPECTED]
        assert corners(parsed)[1] == SLANTED


class TestHocr:
    def test_reads_back_classes_text_boxes_and_checks(self):
        parsed = imports.parse_hocr(formats.hocr(PAGE, 'Zollbuecher').encode())

        assert (parsed['image'], parsed['width'], parsed['height']) == ('scan_001.png', 1000, 2000)
        assert regions(parsed) == EXPECTED
        # hOCR keeps boxes, so the slanted line comes back as the box round it.
        assert corners(parsed)[1] == [[0.1, 0.2], [0.9, 0.2], [0.9, 0.27], [0.1, 0.27]]


class TestTei:
    def test_reads_back_every_page_with_classes_text_outlines_and_checks(self):
        second = {**PAGE, 'id': 2, 'idx': 1, 'filename': 'scan_002.png'}
        pages = imports.parse_tei(formats.tei({**DATA, 'pages': [PAGE, second]}).encode())

        assert [(p['image'], p['width'], p['height']) for p in pages] == \
            [('scan_001.png', 1000, 2000), ('scan_002.png', 1000, 2000)]
        assert regions(pages[0]) == EXPECTED
        assert corners(pages[1])[1] == SLANTED

    def test_text_and_page_breaks_read_in_order_for_whoever_wants_only_the_text(self):
        xml = formats.tei(DATA)
        assert '<pb n="1" facs="#f1"/>' in xml
        assert '<lb facs="#f1_r2_l1" n="1"/>Wien, den 3. Mai<lb facs="#f1_r2_l2" n="2"/>Zoll &amp; Maut' in xml
        assert '<title>Zollbücher &lt;Band 3&gt;</title>' in xml


@pytest.mark.parametrize('render', [formats.page_xml, formats.alto, lambda p: formats.hocr(p, 't')])
def test_a_page_with_nothing_on_it_is_still_a_page(render):
    empty = {**PAGE, 'elements': []}
    text = render(empty)
    assert 'scan_001.png' in text
