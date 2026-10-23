import io
import zipfile

import pytest
from fastapi.testclient import TestClient

from app import imports, store
from app.deps import get_db
from app.main import app

SECRET = 'test-secret'
ADMIN = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'alice', 'X-Auth-Role': 'admin'}

PAGE_XML = """<?xml version="1.0" encoding="UTF-8"?>
<PcGts xmlns="http://schema.primaresearch.org/PAGE/gts/pagecontent/2019-07-15">
  <Page imageFilename="folio_1.png" imageWidth="1000" imageHeight="2000">
    <TextRegion id="r1" type="heading">
      <Coords points="100,100 900,100 900,300 100,300"/>
      <TextLine id="l1">
        <Coords points="100,100 900,100 900,200 100,200"/>
        <TextEquiv><Unicode>Schematismus 1837</Unicode></TextEquiv>
      </TextLine>
    </TextRegion>
    <TextRegion id="r2" custom="structure {type:paragraph;}">
      <Coords points="100,400 900,400 900,800 100,800"/>
      <TextLine id="l2">
        <Coords points="100,400 900,400 900,500 100,500"/>
        <TextEquiv><Unicode>Pfarre Wien</Unicode></TextEquiv>
      </TextLine>
      <TextLine id="l3">
        <Coords points="100,600 900,600 900,700 100,700"/>
        <TextEquiv><Unicode>Kaplan Huber</Unicode></TextEquiv>
      </TextLine>
    </TextRegion>
  </Page>
</PcGts>
"""

SLANTED_PAGE_XML = """<?xml version="1.0" encoding="UTF-8"?>
<PcGts xmlns="http://schema.primaresearch.org/PAGE/gts/pagecontent/2019-07-15">
  <Page imageFilename="letter_1.png" imageWidth="1000" imageHeight="2000">
    <TextRegion id="r1" type="paragraph">
      <Coords points="100,100 900,200 900,400 100,300"/>
      <TextLine id="l1">
        <Coords points="100,100 900,200 900,400 100,300"/>
        <TextEquiv><Unicode>il suo dovere.</Unicode></TextEquiv>
      </TextLine>
      <TextLine id="l2">
        <Coords points="100,500 900,500"/>
        <TextEquiv><Unicode>Mi scusi</Unicode></TextEquiv>
      </TextLine>
    </TextRegion>
  </Page>
</PcGts>
"""

BLANK_PAGE_XML = """<?xml version="1.0" encoding="UTF-8"?>
<PcGts xmlns="http://schema.primaresearch.org/PAGE/gts/pagecontent/2019-07-15">
  <Page imageFilename="folio_2.png" imageWidth="1000" imageHeight="2000"/>
</PcGts>
"""

ALTO_XML = """<?xml version="1.0" encoding="UTF-8"?>
<alto xmlns="http://www.loc.gov/standards/alto/ns-v4#">
  <Description><sourceImageInformation><fileName>folio_1.png</fileName></sourceImageInformation></Description>
  <Layout>
    <Page WIDTH="1000" HEIGHT="2000">
      <PrintSpace>
        <TextBlock HPOS="100" VPOS="100" WIDTH="800" HEIGHT="200">
          <TextLine HPOS="100" VPOS="100" WIDTH="800" HEIGHT="100">
            <String CONTENT="Schematismus"/><String CONTENT="1837"/>
          </TextLine>
        </TextBlock>
      </PrintSpace>
    </Page>
  </Layout>
</alto>
"""


def test_page_xml_regions_lines_and_classes():
    parsed = imports.parse_page_xml(PAGE_XML.encode())
    assert parsed['image'] == 'folio_1.png'
    assert [r['class_name'] for r in parsed['regions']] == ['Header', 'Paragraph']
    # Geometry is normalized against the XML's own page size.
    assert parsed['regions'][0]['bbox'] == [0.1, 0.05, 0.9, 0.15]
    assert parsed['regions'][0]['lines'][0] == {
        'polygon': [[0.1, 0.05], [0.9, 0.05], [0.9, 0.1], [0.1, 0.1]],
        'text': 'Schematismus 1837'}
    assert [l['text'] for l in parsed['regions'][1]['lines']] == ['Pfarre Wien', 'Kaplan Huber']


def test_page_xml_keeps_a_slanted_line_polygon():
    """Handwriting runs at an angle, so a line's bounding box holds the neighbours
    above and below. The crop is deskewed from the polygon, so the polygon is what
    has to survive the import."""
    parsed = imports.parse_page_xml(SLANTED_PAGE_XML.encode())
    line = parsed['regions'][0]['lines'][0]
    assert line['polygon'] == [[0.1, 0.05], [0.9, 0.1], [0.9, 0.2], [0.1, 0.15]]
    # The region still carries a box - only lines are cropped.
    assert parsed['regions'][0]['bbox'] == [0.1, 0.05, 0.9, 0.2]


def test_page_xml_falls_back_to_a_box_for_a_degenerate_line():
    parsed = imports.parse_page_xml(SLANTED_PAGE_XML.encode())
    line = parsed['regions'][0]['lines'][1]
    assert line['polygon'] == [[0.1, 0.25], [0.9, 0.25], [0.9, 0.25], [0.1, 0.25]]


def test_alto_joins_word_strings_into_lines():
    parsed = imports.parse_alto(ALTO_XML.encode())
    assert parsed['image'] == 'folio_1.png'
    line = parsed['regions'][0]['lines'][0]
    assert line['text'] == 'Schematismus 1837'
    assert line['polygon'] == [[0.1, 0.05], [0.9, 0.05], [0.9, 0.1], [0.1, 0.1]]


NESTED_PAGE_XML = """<?xml version="1.0" encoding="UTF-8"?>
<PcGts xmlns="http://schema.primaresearch.org/PAGE/gts/pagecontent/2019-07-15">
  <Page imageFilename="folio_1.png" imageWidth="1000" imageHeight="2000">
    <TextRegion id="r1" type="heading">
      <Coords points="100,100 900,100 900,200 100,200"/>
      <TextLine id="l1">
        <Coords points="100,100 900,100 900,200 100,200"/>
        <TextEquiv><Unicode>Schematismus 1837</Unicode></TextEquiv>
      </TextLine>
    </TextRegion>
    <TableRegion id="t1">
      <Coords points="100,400 900,400 900,800 100,800"/>
      <TableCell id="c1" row="0" col="0">
        <Coords points="100,400 500,400 500,600 100,600"/>
        <TextLine id="l2">
          <Coords points="100,400 500,400 500,500 100,500"/>
          <TextEquiv><Unicode>Pfarre Wien</Unicode></TextEquiv>
        </TextLine>
      </TableCell>
      <TableCell id="c2" row="0" col="1">
        <Coords points="500,400 900,400 900,600 500,600"/>
        <TextLine id="l3">
          <Coords points="500,400 900,400 900,500 500,500"/>
          <TextEquiv><Unicode>Kaplan Huber</Unicode></TextEquiv>
        </TextLine>
      </TableCell>
    </TableRegion>
    <TextRegion id="r2" type="paragraph">
      <Coords points="100,1000 900,1000 900,1600 100,1600"/>
      <TextLine id="l4">
        <Coords points="100,1000 900,1000 900,1100 100,1100"/>
        <TextEquiv><Unicode>Dechantei</Unicode></TextEquiv>
      </TextLine>
      <TextRegion id="r2a" type="footnote">
        <Coords points="100,1200 900,1200 900,1400 100,1400"/>
        <TextLine id="l5">
          <Coords points="100,1200 900,1200 900,1300 100,1300"/>
          <TextEquiv><Unicode>Cooperator Leopold Mayr</Unicode></TextEquiv>
        </TextLine>
      </TextRegion>
    </TextRegion>
  </Page>
</PcGts>
"""


def test_page_xml_reads_lines_in_table_cells_and_nested_regions_in_document_order():
    """Transkribus and eScriptorium put lines inside table cells and nested regions, not
    only directly under the Page; skipping those lost transcribed lines without a word."""
    regions = imports.parse_page_xml(NESTED_PAGE_XML.encode())['regions']
    assert [(r['class_name'], r['raw_type'], [l['text'] for l in r['lines']])
            for r in regions] == [
        ('Header', 'heading', ['Schematismus 1837']),
        ('Paragraph', 'table-cell', ['Pfarre Wien']),
        ('Paragraph', 'table-cell', ['Kaplan Huber']),
        ('Paragraph', 'paragraph', ['Dechantei']),
        ('Footnote', 'footnote', ['Cooperator Leopold Mayr']),
    ]
    # Each cell keeps its own box, not the table's.
    assert regions[1]['bbox'] == [0.1, 0.2, 0.5, 0.3]
    assert regions[2]['lines'][0]['polygon'] == [[0.5, 0.2], [0.9, 0.2], [0.9, 0.25], [0.5, 0.25]]


HYPHENATED_ALTO_XML = """<?xml version="1.0" encoding="UTF-8"?>
<alto xmlns="http://www.loc.gov/standards/alto/ns-v4#">
  <Layout>
    <Page WIDTH="1000" HEIGHT="2000">
      <PrintSpace>
        <TextBlock HPOS="100" VPOS="100" WIDTH="800" HEIGHT="200">
          <TextLine HPOS="100" VPOS="100" WIDTH="800" HEIGHT="100">
            <String CONTENT="Pfarre"/><SP/><String CONTENT="Hei" SUBS_CONTENT="Heiligenstadt"/>
            <HYP CONTENT="-"/>
          </TextLine>
          <TextLine HPOS="100" VPOS="200" WIDTH="800" HEIGHT="100">
            <String CONTENT="ligenstadt" SUBS_CONTENT="Heiligenstadt"/>
          </TextLine>
        </TextBlock>
      </PrintSpace>
    </Page>
  </Layout>
</alto>
"""


def test_alto_keeps_the_line_end_hyphen_on_the_word_it_breaks():
    lines = imports.parse_alto(HYPHENATED_ALTO_XML.encode())['regions'][0]['lines']
    assert [l['text'] for l in lines] == ['Pfarre Hei-', 'ligenstadt']


def _zip(entries: dict[str, bytes]) -> io.BytesIO:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w') as zf:
        for name, data in entries.items():
            zf.writestr(name, data)
    buf.seek(0)
    return buf


def test_export_zip_pairs_xml_with_its_image():
    data = _zip({'page/folio_1.xml': PAGE_XML.encode(), 'folio_1.png': b'PNGDATA',
                 'mets.xml': b'<mets/>'})
    pages = imports.read_export_zip(data)
    assert len(pages) == 1
    assert pages[0]['format'] == 'page-xml'
    assert pages[0]['image_name'] == 'folio_1.png'
    assert pages[0]['image_member'] == 'folio_1.png'


def test_extract_images_streams_each_image_to_disk(tmp_path):
    """The parse pass leaves image bytes in the zip, so a multi-GB export never
    has to fit in memory - extraction streams member by member."""
    data = _zip({'folio_1.xml': PAGE_XML.encode(), 'scans/folio_1.png': b'PNGDATA'})
    pages = imports.read_export_zip(data)
    assert 'image_bytes' not in pages[0]
    entries = imports.extract_images(data, pages, tmp_path)
    assert entries == [('folio_1.png', str(tmp_path / '00000_folio_1.png'))]
    assert (tmp_path / '00000_folio_1.png').read_bytes() == b'PNGDATA'


def test_zip_without_usable_pairs_is_rejected():
    with pytest.raises(imports.ImportError_):
        imports.read_export_zip(_zip({'notes.txt': b'hello'}))
    # XML without its image cannot become a dataset either.
    with pytest.raises(imports.ImportError_):
        imports.read_export_zip(_zip({'folio_1.xml': PAGE_XML.encode()}))


def test_ingest_writes_elements_and_lines(tmp_path):
    conn = store.connect(tmp_path / 'app.db')
    conn.execute("INSERT INTO jobs (id, name, owner) VALUES ('j1', 'Import', 'eva')")
    conn.execute("INSERT INTO pages (id, job_id, idx, filename, source_file) "
                 "VALUES (1, 'j1', 0, 'folio_1.png', '/tmp/folio_1.png')")
    pages = imports.read_export_zip(_zip({'folio_1.xml': PAGE_XML.encode(),
                                          'folio_1.png': b'PNGDATA'}))
    counts = imports.ingest_pages(conn, 'j1', pages, 'import:eva', reviewed=True)
    assert counts == {'pages': 1, 'lines': 3}
    rows = conn.execute(
        'SELECT l.text, l.checked FROM lines l JOIN elements e ON l.element_id = e.id '
        'ORDER BY e.order_idx, l.order_idx').fetchall()
    assert [(r['text'], r['checked']) for r in rows] == [
        ('Schematismus 1837', 1), ('Pfarre Wien', 1), ('Kaplan Huber', 1)]
    assert conn.execute("SELECT width, height FROM pages WHERE id = 1").fetchone()['width'] == 1000
    conn.close()


def test_unreviewed_import_leaves_lines_unchecked(tmp_path):
    conn = store.connect(tmp_path / 'app.db')
    conn.execute("INSERT INTO jobs (id, name, owner) VALUES ('j1', 'Import', 'eva')")
    conn.execute("INSERT INTO pages (id, job_id, idx, filename, source_file) "
                 "VALUES (1, 'j1', 0, 'folio_1.png', '/tmp/folio_1.png')")
    pages = imports.read_export_zip(_zip({'folio_1.xml': PAGE_XML.encode(),
                                          'folio_1.png': b'PNGDATA'}))
    imports.ingest_pages(conn, 'j1', pages, 'import:eva', reviewed=False)
    assert conn.execute('SELECT COUNT(*) c FROM lines WHERE checked = 1').fetchone()['c'] == 0
    conn.close()


def test_export_zip_keeps_a_blank_leaf_as_a_page_without_regions():
    """Transkribus writes a Page element and nothing else for an untranscribed verso.
    Dropping it would shift every page number after it."""
    pages = imports.read_export_zip(_zip({
        'page/folio_1.xml': PAGE_XML.encode(), 'page/folio_2.xml': BLANK_PAGE_XML.encode(),
        'folio_1.png': b'PNGDATA', 'folio_2.png': b'PNGDATA'}))
    assert [(p['image_name'], len(p['regions'])) for p in pages] == [('folio_1.png', 2), ('folio_2.png', 0)]


def test_ingest_counts_a_blank_leaf_and_writes_nothing_on_it(tmp_path):
    conn = store.connect(tmp_path / 'app.db')
    conn.execute("INSERT INTO jobs (id, name, owner) VALUES ('j1', 'Import', 'eva')")
    conn.executemany(
        "INSERT INTO pages (id, job_id, idx, filename, source_file) VALUES (?, 'j1', ?, ?, ?)",
        [(1, 0, 'folio_1.png', '/tmp/folio_1.png'), (2, 1, 'folio_2.png', '/tmp/folio_2.png')])
    pages = imports.read_export_zip(_zip({
        'folio_1.xml': PAGE_XML.encode(), 'folio_2.xml': BLANK_PAGE_XML.encode(),
        'folio_1.png': b'PNGDATA', 'folio_2.png': b'PNGDATA'}))
    counts = imports.ingest_pages(conn, 'j1', pages, 'import:eva', reviewed=True)
    assert counts == {'pages': 2, 'lines': 3}
    assert conn.execute('SELECT COUNT(*) c FROM elements WHERE page_id = 2').fetchone()['c'] == 0
    size = conn.execute('SELECT width, height FROM pages WHERE id = 2').fetchone()
    assert (size['width'], size['height']) == (1000, 2000)
    conn.close()


def _page_xml(image: str, text: str, width: str = '1000',
              points: str = '100,100 900,100 900,200 100,200') -> bytes:
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<PcGts xmlns="http://schema.primaresearch.org/PAGE/gts/pagecontent/2019-07-15">
  <Page imageFilename="{image}" imageWidth="{width}" imageHeight="2000">
    <TextRegion id="r1" type="paragraph">
      <TextLine id="l1">
        <Coords points="{points}"/>
        <TextEquiv><Unicode>{text}</Unicode></TextEquiv>
      </TextLine>
    </TextRegion>
  </Page>
</PcGts>
""".encode()


@pytest.fixture
def api(tmp_path, monkeypatch):
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    monkeypatch.setattr('app.config.JOBS_DIR', tmp_path / 'jobs')
    conn = store.connect(tmp_path / 'app.db')
    app.dependency_overrides[get_db] = lambda: conn
    yield TestClient(app), conn
    app.dependency_overrides.clear()
    conn.close()


def _import(client, members: dict[str, bytes]):
    return client.post('/api/jobs/import', headers=ADMIN, data={'name': 'Volumes'},
                       files={'file': ('export.zip', _zip(members).getvalue(), 'application/zip')})


class TestFoldersWithTheSameImageName:
    """Volumes exported side by side restart their numbering, so each folder holds a 0001.png."""

    def test_each_xml_pairs_with_the_image_in_its_own_folder(self):
        pages = imports.read_export_zip(_zip({
            'vol1/page/0001.xml': _page_xml('0001.png', 'one'), 'vol1/0001.png': b'ONE',
            'vol2/page/0001.xml': _page_xml('0001.png', 'two'), 'vol2/0001.png': b'TWO'}))
        assert [(p['image_member'], p['image_name']) for p in pages] == [
            ('vol1/0001.png', 'vol1_0001.png'), ('vol2/0001.png', 'vol2_0001.png')]

    def test_a_flat_export_keeps_its_image_names(self):
        pages = imports.read_export_zip(_zip({
            'export/page/folio_1.xml': PAGE_XML.encode(), 'export/folio_1.png': b'PNGDATA'}))
        assert [p['image_name'] for p in pages] == ['folio_1.png']

    def test_the_import_keeps_both_pages_with_their_own_image_and_lines(self, api):
        client, conn = api
        response = _import(client, {
            'vol1/page/0001.xml': _page_xml('0001.png', 'one'), 'vol1/0001.png': b'ONE',
            'vol2/page/0001.xml': _page_xml('0001.png', 'two'), 'vol2/0001.png': b'TWO'})
        assert response.status_code == 200
        assert response.json()['pages'] == 2
        rows = conn.execute(
            'SELECT p.filename, p.source_file, l.text FROM pages p '
            'JOIN elements e ON e.page_id = p.id JOIN lines l ON l.element_id = e.id '
            'ORDER BY p.idx').fetchall()
        assert [(r['filename'], open(r['source_file'], 'rb').read(), r['text']) for r in rows] == [
            ('vol1_0001.png', b'ONE', 'one'), ('vol2_0001.png', b'TWO', 'two')]


class TestAnExportItCannotRead:
    """One unreadable XML refuses the import and names itself, so nothing arrives half-imported."""

    @pytest.mark.parametrize('xml, problem', [
        (b'<PcGts><Page imageFilename="a.png"', 'not well-formed XML'),
        (_page_xml('a.png', 'x', width=''), 'imageWidth'),
        (_page_xml('a.png', 'x', width='0'), 'imageWidth'),
        (_page_xml('a.png', 'x', points='100,100 abc,100'), 'abc'),
        (ALTO_XML.replace('WIDTH="1000" HEIGHT="2000"', 'HEIGHT="2000"').encode(), 'WIDTH'),
    ])
    def test_it_is_refused_with_the_file_and_what_is_wrong(self, api, xml, problem):
        client, conn = api
        response = _import(client, {'good.xml': _page_xml('good.png', 'fine'), 'good.png': b'G',
                                    'page/bad_page.xml': xml, 'a.png': b'A', 'folio_1.png': b'F'})
        assert response.status_code == 400
        detail = response.json()['detail']
        assert detail.startswith('page/bad_page.xml: ')
        assert problem in detail
        assert conn.execute('SELECT COUNT(*) c FROM jobs').fetchone()['c'] == 0


def _deeplabel_export(pages: list[dict]) -> bytes:
    import json
    return json.dumps({'job': {'id': 'abc', 'name': 'Name register'}, 'pages': pages}).encode()


EXPORTED_PAGE = {
    'idx': 0, 'filename': 'NR_1876.108.jpg', 'width': 1000, 'height': 2000, 'rotation': 0,
    'layout_checked': True, 'lines_checked': True,
    'elements': [
        {'order_idx': 0, 'class_name': 'Column', 'kind': 'container', 'bbox': [0.05, 0.05, 0.5, 0.95], 'lines': []},
        {'order_idx': 1, 'class_name': 'Paragraph', 'kind': 'content', 'bbox': [0.1, 0.1, 0.45, 0.2], 'conf': 0.9,
         'lines': [{'order_idx': 0, 'polygon': [[0.1, 0.1], [0.45, 0.1], [0.45, 0.15], [0.1, 0.15]],
                    'text': 'Anno', 'corrected_text': 'Anno 1876', 'checked': True},
                   {'order_idx': 1, 'polygon': [[0.1, 0.15], [0.45, 0.15], [0.45, 0.2], [0.1, 0.2]],
                    'text': '', 'corrected_text': None, 'checked': True}]},
        {'order_idx': 2, 'class_name': 'Stamp', 'kind': 'content', 'bbox': [0.6, 0.8, 0.9, 0.9],
         'lines': [{'order_idx': 0, 'polygon': [[0.6, 0.8], [0.9, 0.8], [0.9, 0.9], [0.6, 0.9]],
                    'text': 'k.k.', 'corrected_text': None, 'checked': False}]},
    ]}


class TestADeepLabelExport:
    """A dataset moved between DeepLabel instances keeps what made it ground truth: its
    classes, which boxes are containers, which lines were checked - text or not - and which
    pages were reviewed whole."""

    def test_it_imports_with_its_classes_checks_and_page_flags(self, api):
        client, conn = api
        response = _import(client, {'job.json': _deeplabel_export([EXPORTED_PAGE]),
                                    'images/NR_1876.108.jpg': b'JPEG'})

        assert response.status_code == 200, response.text
        body = response.json()
        assert (body['format'], body['pages'], body['lines']) == ('deeplabel', 1, 3)
        page = conn.execute("SELECT id, filename, width, height, layout_checked, lines_checked FROM pages").fetchone()
        assert (page['filename'], page['width'], page['height'], page['layout_checked'], page['lines_checked']) == (
            'NR_1876.108.jpg', 1000, 2000, 1, 1)
        elements = conn.execute('SELECT class_name, kind, bbox FROM elements WHERE page_id = ? ORDER BY order_idx',
                                (page['id'],)).fetchall()
        assert [(e['class_name'], e['kind']) for e in elements] == [
            ('Column', 'container'), ('Paragraph', 'content'), ('Stamp', 'content')]
        lines = conn.execute('SELECT text, corrected_text, checked FROM lines ORDER BY id').fetchall()
        assert [tuple(line) for line in lines] == [('Anno', 'Anno 1876', 1), ('', None, 1), ('k.k.', None, 0)]

    def test_a_class_the_dataset_lacks_is_added_to_it(self, api):
        from app import layout_templates
        client, conn = api
        job_id = _import(client, {'job.json': _deeplabel_export([EXPORTED_PAGE]),
                                  'images/NR_1876.108.jpg': b'JPEG'}).json()['job_id']

        classes = {c['name']: c for c in layout_templates.job_classes(conn, job_id)}
        assert classes['Stamp']['role'] == 'content'
        assert 'Column' in classes and [c for c in classes].count('Column') == 1

    def test_a_class_stored_under_another_spelling_and_the_unassigned_lines_add_nothing(self, api):
        from app import layout_templates
        client, conn = api
        page = {**EXPORTED_PAGE, 'elements': [
            {'order_idx': 0, 'class_name': 'Pagenumber', 'kind': 'content', 'bbox': [0.5, 0.05, 0.55, 0.08],
             'lines': []},
            {'order_idx': 1, 'class_name': 'Unassigned', 'kind': 'orphan', 'bbox': [0, 0, 1, 1],
             'lines': [{'order_idx': 0, 'polygon': [[0.1, 0.9], [0.2, 0.9], [0.2, 0.95], [0.1, 0.95]],
                        'text': 'x', 'checked': True}]}]}
        response = _import(client, {'job.json': _deeplabel_export([page]), 'images/NR_1876.108.jpg': b'JPEG'})

        assert response.status_code == 200, response.text
        job_id = response.json()['job_id']
        assert len(layout_templates.job_classes(conn, job_id)) == len(layout_templates.schematismus_classes())
        kinds = conn.execute('SELECT class_name, kind FROM elements ORDER BY order_idx').fetchall()
        assert [tuple(k) for k in kinds] == [('Pagenumber', 'content'), ('Unassigned', 'orphan')]

    def test_a_page_whose_image_is_missing_refuses_the_import(self, api):
        client, _ = api
        response = _import(client, {'job.json': _deeplabel_export([EXPORTED_PAGE])})
        assert (response.status_code, response.json()['detail']) == (
            400, 'job.json names NR_1876.108.jpg, which is not under images/ in the archive')


def test_an_export_carries_each_pages_review_flags(tmp_path):
    from app import export
    conn = store.connect(tmp_path / 'app.db')
    conn.executescript("""
        INSERT INTO jobs (id, name, owner, status) VALUES ('j1', 'Volume', 'root', 'done');
        INSERT INTO pages (id, job_id, idx, filename, source_file, status, layout_checked, lines_checked)
            VALUES (1, 'j1', 0, 'p.png', 'p.png', 'done', 1, 0);
    """)
    [page] = export.collect_job(conn, 'j1')['pages']
    assert (page['layout_checked'], page['lines_checked']) == (True, False)
    conn.close()


def test_an_import_that_fails_after_unpacking_leaves_no_files_behind(api, tmp_path, monkeypatch):
    client, conn = api

    def broken(*args, **kwargs):
        raise RuntimeError('disk full')

    monkeypatch.setattr(imports, 'ingest_pages', broken)
    with pytest.raises(RuntimeError):
        _import(client, {'job.json': _deeplabel_export([EXPORTED_PAGE]), 'images/NR_1876.108.jpg': b'JPEG'})

    assert list((tmp_path / 'jobs').iterdir()) == []
    assert conn.execute('SELECT COUNT(*) FROM jobs').fetchone()[0] == 0
