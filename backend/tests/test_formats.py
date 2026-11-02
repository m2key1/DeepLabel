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


# The table holds no lines, but comes back as the box it is.
EXPECTED = [('Kopfzeile', [('Zollbuecher', True)]),
            ('Paragraph', [('Wien, den 3. Mai', False), ('Zoll & Maut', True)]),
            ('Table', [])]
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
        # The page-wide table holds both regions; another tool's table is read as one too.
        assert [r['class_name'] for r in parsed['regions']] == ['Table', 'Paragraph', 'Paragraph']
        assert all('checked' not in l for r in parsed['regions'] for l in r['lines'])


class TestAlto:
    def test_reads_back_classes_text_and_outlines(self):
        parsed = imports.parse_alto(formats.alto(PAGE).encode())

        assert (parsed['image'], parsed['width'], parsed['height']) == ('scan_001.png', 1000, 2000)
        assert [(r['class_name'], [l['text'] for l in r['lines']]) for r in parsed['regions']] == \
            [(name, [text for text, _ in lines]) for name, lines in EXPECTED]
        assert corners(parsed)[1] == SLANTED

    def test_reads_back_which_lines_were_checked(self):
        parsed = imports.parse_alto(formats.alto(PAGE).encode())
        assert regions(parsed) == EXPECTED

    def test_marks_checked_lines_with_a_standard_tag(self):
        xml = formats.alto(PAGE)
        assert '<OtherTag ID="checked" LABEL="checked"' in xml
        assert xml.count('TAGREFS="checked"') == 2

    def test_someone_else_s_alto_says_nothing_about_checks(self):
        xml = formats.alto(PAGE).replace('<softwareName>DeepLabel</softwareName>', '<softwareName>Tesseract</softwareName>')
        parsed = imports.parse_alto(xml.encode())
        assert all('checked' not in l for r in parsed['regions'] for l in r['lines'])


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


def box(x0, y0, x1, y1):
    return {'bbox': [x0, y0, x1, y1], 'conf': 1.0}


def one_line(i, x0, y0, x1, y1, text):
    return [{'id': i, 'order_idx': 0, 'polygon': [[x0, y0], [x1, y0], [x1, y1], [x0, y1]],
             'text': text, 'corrected_text': None, 'confidence': None, 'checked': True}]


# Two columns side by side with a divider between them: a column holding a paragraph and an
# empty one, a table holding a paragraph, in a reading order that is not the nesting order.
STRUCTURED = {**PAGE, 'elements': [
    {'order_idx': 0, 'class_name': 'Column', 'kind': 'container', 'lines': [], **box(0.05, 0.15, 0.5, 0.9)},
    {'order_idx': 1, 'class_name': 'Paragraph', 'kind': 'content', **box(0.1, 0.2, 0.45, 0.4),
     'lines': one_line(1, 0.1, 0.2, 0.45, 0.25, 'Erste Spalte')},
    {'order_idx': 2, 'class_name': 'Divider', 'kind': 'container', 'lines': [], **box(0.5, 0.15, 0.52, 0.9)},
    {'order_idx': 3, 'class_name': 'Table', 'kind': 'container', 'lines': [], **box(0.55, 0.15, 0.95, 0.9)},
    {'order_idx': 4, 'class_name': 'Paragraph', 'kind': 'content', **box(0.6, 0.2, 0.9, 0.3),
     'lines': one_line(2, 0.6, 0.2, 0.9, 0.25, 'In der Tabelle')},
    {'order_idx': 5, 'class_name': 'Paragraph', 'kind': 'content', 'lines': [], **box(0.1, 0.5, 0.45, 0.6)},
]}
STRUCTURE = [(e['class_name'], e['kind'], e['bbox'], [l['text'] for l in e['lines']]) for e in STRUCTURED['elements']]

PARSE_OWN = {
    'page': lambda: imports.parse_page_xml(formats.page_xml(STRUCTURED).encode()),
    'alto': lambda: imports.parse_alto(formats.alto(STRUCTURED).encode()),
    'hocr': lambda: imports.parse_hocr(formats.hocr(STRUCTURED, 't').encode()),
    'tei': lambda: imports.parse_tei(formats.tei({'job': {'name': 'x'}, 'pages': [STRUCTURED]}).encode())[0],
}


class TestFullStructure:
    """Containers and boxes without lines travel through every standard format and come back
    as they were: class, kind, box and place in the reading order."""

    @pytest.mark.parametrize('fmt', PARSE_OWN)
    def test_every_box_comes_back_in_its_class_and_order(self, fmt):
        parsed = PARSE_OWN[fmt]()

        assert [(r['class_name'], r.get('kind', 'content'), [round(v, 3) for v in r['bbox']],
                 [l['text'] for l in r['lines']]) for r in parsed['regions']] == STRUCTURE

    def test_page_xml_nests_regions_in_a_table_and_draws_the_divider_as_a_separator(self):
        xml = formats.page_xml(STRUCTURED)
        table = xml.index('<TableRegion')
        assert table < xml.index('In der Tabelle') < xml.index('</TableRegion>')
        assert '<SeparatorRegion' in xml
        assert xml.index('<TextRegion') < xml.index('Erste Spalte') < xml.index('</TextRegion>', xml.index('Erste Spalte'))

    def test_alto_holds_a_container_s_blocks_in_a_composed_block(self):
        xml = formats.alto(STRUCTURED)
        assert xml.count('<ComposedBlock') == 2
        assert xml.index('<ComposedBlock') < xml.index('Erste') < xml.index('</ComposedBlock>')

    def test_hocr_marks_the_table_and_the_separator_as_hocr_names_them(self):
        html = formats.hocr(STRUCTURED, 't')
        assert "class='ocr_table'" in html and "class='ocr_separator'" in html


class TestTablesAndSeparatorsFromOtherTools:
    """Another tool's tables and separators come in as Table and Divider; its other boxes
    without lines stay out, as before."""

    def test_page_xml(self):
        xml = f'''<PcGts xmlns="{formats.PAGE_NS}"><Metadata><Creator>Transkribus</Creator></Metadata>
          <Page imageFilename="a.png" imageWidth="100" imageHeight="100">
            <TableRegion id="t"><Coords points="10,10 90,10 90,90 10,90"/>
              <TableCell id="c"><Coords points="10,10 50,10 50,50 10,50"/>
                <TextLine id="l"><Coords points="12,12 48,12 48,20 12,20"/><TextEquiv><Unicode>Zelle</Unicode></TextEquiv></TextLine>
              </TableCell></TableRegion>
            <SeparatorRegion id="s"><Coords points="5,0 6,0 6,100 5,100"/></SeparatorRegion>
            <TextRegion id="e" type="paragraph"><Coords points="0,95 10,95 10,99 0,99"/></TextRegion>
            <GraphicRegion id="g"><Coords points="0,0 4,0 4,4 0,4"/></GraphicRegion>
          </Page></PcGts>'''
        parsed = imports.parse_page_xml(xml.encode())
        assert sorted((r['class_name'], r.get('kind', 'content'), len(r['lines'])) for r in parsed['regions']) == [
            ('Divider', 'container', 0), ('Paragraph', 'content', 1), ('Table', 'container', 0)]

    def test_hocr(self):
        html = '''<html xmlns="http://www.w3.org/1999/xhtml"><body>
          <div class='ocr_page' title='bbox 0 0 100 100'>
            <table class='ocr_table' title='bbox 10 10 90 90'><tr><td>
              <span class='ocr_line' title='bbox 12 12 48 20'><span class='ocrx_word'>Zelle</span></span>
            </td></tr></table>
            <div class='ocr_separator' title='bbox 5 0 6 100'></div>
            <div class='ocr_carea' title='bbox 0 95 10 99'></div>
          </div></body></html>'''
        parsed = imports.parse_hocr(html.encode())
        assert sorted((r['class_name'], r.get('kind', 'content'), len(r['lines'])) for r in parsed['regions']) == [
            ('Divider', 'container', 0), ('Paragraph', 'content', 1), ('Table', 'container', 0)]

    def test_tei(self):
        xml = f'''<TEI xmlns="{formats.TEI_NS}"><facsimile>
          <surface ulx="0" uly="0" lrx="100" lry="100">
            <zone type="TableRegion" points="10,10 90,10 90,90 10,90">
              <zone type="TableCell" points="10,10 50,10 50,50 10,50">
                <zone type="line" xml:id="l1" points="12,12 48,12 48,20 12,20"/></zone></zone>
            <zone type="SeparatorRegion" points="5,0 6,0 6,100 5,100"/>
            <zone type="TextRegion" points="0,95 10,95 10,99 0,99"/>
          </surface></facsimile><text><body><ab><lb facs="#l1"/>Zelle</ab></body></text></TEI>'''
        parsed = imports.parse_tei(xml.encode())[0]
        assert sorted((r['class_name'], r.get('kind', 'content'), len(r['lines'])) for r in parsed['regions']) == [
            ('Divider', 'container', 0), ('Paragraph', 'content', 1), ('Table', 'container', 0)]
