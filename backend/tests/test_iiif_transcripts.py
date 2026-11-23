"""Transcriptions an archive publishes with its manifest (#63): per page a seeAlso ALTO (or
PAGE, or hOCR) file wins and text annotations are the fallback; a transcribed page keeps the
transcript's lines and geometry, with no boxes, and skips line detection and reading."""
import json

import httpx
import pytest

from app import config, iiif, iiif_transcripts, text_job
from tests.test_iiif import ARCHIVE, MEMBER, api, archive, jpeg  # noqa: F401 - fixtures

W, H = 1000, 2000

ALTO = f"""<?xml version="1.0" encoding="UTF-8"?>
<alto xmlns="http://www.loc.gov/standards/alto/ns-v4#"><Layout><Page WIDTH="{W}" HEIGHT="{H}"><PrintSpace>
  <TextBlock ID="b1" HPOS="100" VPOS="200" WIDTH="800" HEIGHT="300">
    <TextLine ID="l1" HPOS="100" VPOS="200" WIDTH="800" HEIGHT="100"><String CONTENT="Johann"/><SP/><String CONTENT="Müller"/></TextLine>
    <TextLine ID="l2" HPOS="100" VPOS="400" WIDTH="500" HEIGHT="100"><String CONTENT="Pfarrer"/></TextLine>
  </TextBlock>
</PrintSpace></Page></Layout></alto>""".encode()


def canvas(n: int, **extra) -> dict:
    return {'id': f'{ARCHIVE}/t3/{n}', 'type': 'Canvas', 'label': {'none': [str(n)]}, 'width': W, 'height': H,
            'items': [{'type': 'AnnotationPage', 'items': [{'type': 'Annotation', 'motivation': 'painting', 'body': {
                'id': f'{ARCHIVE}/plain/t{n}.jpg', 'type': 'Image', 'width': W, 'height': H}}]}], **extra}


def transcribing(n: int, lines: list[tuple[str, str]]) -> dict:
    return {'id': f'{ARCHIVE}/anno-page/{n}', 'type': 'AnnotationPage', 'items': [
        {'id': f'{ARCHIVE}/anno/{n}/{i}', 'type': 'Annotation', 'motivation': 'supplementing',
         'body': {'type': 'TextualBody', 'value': text, 'format': 'text/plain'},
         'target': f'{ARCHIVE}/t3/{n}#xywh={where}'} for i, (text, where) in enumerate(lines)]}


MANIFEST = {
    '@context': 'http://iiif.io/api/presentation/3/context.json', 'type': 'Manifest',
    'id': f'{ARCHIVE}/t3/manifest', 'label': {'en': ['Baptisms']},
    'items': [
        # ALTO and annotations both: the ALTO file wins.
        canvas(1, seeAlso=[{'id': f'{ARCHIVE}/alto/1.xml', 'type': 'Dataset', 'format': 'application/xml',
                            'profile': 'http://www.loc.gov/standards/alto/v4/alto.xsd'}],
               annotations=[transcribing(1, [('ignored', '0,0,10,10')])]),
        # Annotations alone, one of them outlined by an SVG selector.
        canvas(2, annotations=[{'id': f'{ARCHIVE}/anno-page/2', 'type': 'AnnotationPage', 'items': [
            {'type': 'Annotation', 'motivation': 'supplementing',
             'body': {'type': 'TextualBody', 'value': 'Taufbuch'}, 'target': f'{ARCHIVE}/t3/2#xywh=100,100,400,100'},
            {'type': 'Annotation', 'motivation': 'commenting',
             'body': {'type': 'TextualBody', 'value': 'a note, not a reading'}, 'target': f'{ARCHIVE}/t3/2'},
            {'type': 'Annotation', 'motivation': 'transcribing',
             'body': {'type': 'TextualBody', 'value': 'der Pfarre'},
             'target': {'source': f'{ARCHIVE}/t3/2', 'selector': {
                 'type': 'SvgSelector', 'value': '<svg><polygon points="100,300 600,300 600,400 100,400"/></svg>'}}},
        ]}]),
        # Nothing at all.
        canvas(3),
        # Annotations by reference, fetched at import.
        canvas(4, annotations=[{'id': f'{ARCHIVE}/anno-page/4', 'type': 'AnnotationPage'}]),
    ],
}


def lines_of(conn, job_id: str) -> dict[str, list]:
    rows = conn.execute(
        'SELECT p.filename, l.polygon, l.text, l.checked, e.kind FROM lines l JOIN elements e ON l.element_id = e.id '
        'JOIN pages p ON e.page_id = p.id WHERE p.job_id = ? AND l.deleted = 0 ORDER BY p.idx, l.order_idx',
        (job_id,)).fetchall()
    out: dict[str, list] = {}
    for r in rows:
        out.setdefault(r['filename'], []).append((r['text'], json.loads(r['polygon']), bool(r['checked']), r['kind']))
    return out


class TestWhatAManifestOffers:
    def test_each_canvas_names_its_transcription_with_the_file_first(self):
        canvases = iiif.parse(MANIFEST, MANIFEST['id'])['canvases']
        assert [c.get('transcript', {}).get('kind') for c in canvases] == ['alto', 'annotations', None, 'annotations']
        assert canvases[0]['transcript'] == {'kind': 'alto', 'url': f'{ARCHIVE}/alto/1.xml'}
        assert canvases[3]['transcript'] == {'kind': 'annotations', 'pages': [{'url': f'{ARCHIVE}/anno-page/4'}]}

    def test_a_v2_manifest_offers_its_annotation_lists(self):
        v2 = {'@context': 'http://iiif.io/api/presentation/2/context.json', '@type': 'sc:Manifest',
              '@id': f'{ARCHIVE}/v2t', 'label': 'x', 'sequences': [{'canvases': [{
                  '@id': f'{ARCHIVE}/v2t/1', '@type': 'sc:Canvas', 'label': '1', 'width': W, 'height': H,
                  'images': [{'resource': {'@id': f'{ARCHIVE}/plain/v.jpg', 'width': W, 'height': H}}],
                  'otherContent': [{'@id': f'{ARCHIVE}/list/1', '@type': 'sc:AnnotationList'}]}]}]}
        assert iiif.parse(v2, v2['@id'])['canvases'][0]['transcript'] == {
            'kind': 'annotations', 'pages': [{'url': f'{ARCHIVE}/list/1'}]}

    def test_the_wizard_hears_how_many_pages_offer_one_from_a_sample(self, api):
        client, conn, routes, _ = api
        routes[MANIFEST['id']] = httpx.Response(200, json=MANIFEST)
        routes[f'{ARCHIVE}/alto/1.xml'] = httpx.Response(200, content=ALTO)
        routes[f'{ARCHIVE}/anno-page/4'] = httpx.Response(200, json=transcribing(4, [('Anna', '100,100,300,80')]))
        answer = client.post('/api/iiif/inspect', headers=MEMBER, json={'url': MANIFEST['id']}).json()
        assert answer['transcriptions'] == {'pages': 3, 'kinds': ['alto', 'annotations'],
                                            'sampled': 3, 'sampled_with_text': 3, 'sampled_lines': 5}


@pytest.fixture
def archived(api):
    client, conn, routes, requested = api
    routes[MANIFEST['id']] = httpx.Response(200, json=MANIFEST)
    routes[f'{ARCHIVE}/alto/1.xml'] = httpx.Response(200, content=ALTO)
    routes[f'{ARCHIVE}/anno-page/4'] = httpx.Response(200, json=transcribing(4, [('Anna', '100,100,300,80')]))
    for n in range(1, 5):
        # A shade of its own, or the pages after the first would be kept as duplicates of it.
        routes[f'{ARCHIVE}/plain/t{n}.jpg'] = httpx.Response(200, content=jpeg(500, 1000, 40 * n))
    return client, conn, requested

def make(client, **options) -> str:
    res = client.post('/api/jobs/iiif', headers=MEMBER, json={
        'name': 'Baptisms', 'manifest': MANIFEST['id'], 'canvases': [c['id'] for c in MANIFEST['items']],
        'run_layout': True, 'run_lines': True, 'run_ocr': True, **options})
    assert res.status_code == 200, res.text
    return res.json()['job_id']


class TestImportingThem:
    def test_transcribed_pages_keep_their_lines_and_skip_detection_and_reading(self, archived):
        client, conn, requested = archived
        job_id = make(client)
        text_job.phase_ingest(conn, job_id, config.job_dir(job_id))

        assert lines_of(conn, job_id) == {
            '0001_1.jpg': [('Johann Müller', [[0.1, 0.1], [0.9, 0.1], [0.9, 0.15], [0.1, 0.15]], False, 'orphan'),
                           ('Pfarrer', [[0.1, 0.2], [0.6, 0.2], [0.6, 0.25], [0.1, 0.25]], False, 'orphan')],
            '0002_2.jpg': [('Taufbuch', [[0.1, 0.05], [0.5, 0.05], [0.5, 0.1], [0.1, 0.1]], False, 'orphan'),
                           ('der Pfarre', [[0.1, 0.15], [0.6, 0.15], [0.6, 0.2], [0.1, 0.2]], False, 'orphan')],
            '0004_4.jpg': [('Anna', [[0.1, 0.05], [0.4, 0.05], [0.4, 0.09], [0.1, 0.09]], False, 'orphan')],
        }
        statuses = dict(conn.execute('SELECT filename, status FROM pages WHERE job_id = ?', (job_id,)).fetchall())
        assert statuses == {'0001_1.jpg': 'done', '0002_2.jpg': 'done', '0003_3.jpg': 'ingested', '0004_4.jpg': 'done'}
        assert f'{ARCHIVE}/anno-page/4' in requested

    def test_marked_reviewed_they_arrive_checked(self, archived):
        client, conn, _ = archived
        job_id = make(client, transcriptions_reviewed=True)
        text_job.phase_ingest(conn, job_id, config.job_dir(job_id))
        assert {page: [checked for *_, checked, _ in lines] for page, lines in lines_of(conn, job_id).items()} == {
            '0001_1.jpg': [True, True], '0002_2.jpg': [True, True], '0004_4.jpg': [True]}

    def test_left_out_they_are_not_fetched_and_every_page_runs_the_pipeline(self, archived):
        client, conn, requested = archived
        job_id = make(client, use_transcriptions=False)
        text_job.phase_ingest(conn, job_id, config.job_dir(job_id))
        assert lines_of(conn, job_id) == {}
        assert not any('/alto/' in url or '/anno-page/' in url for url in requested)

    def test_a_transcription_that_cannot_be_had_leaves_its_page_to_the_pipeline(self, archived, api):
        client, conn, requested = archived
        routes = api[2]
        routes[f'{ARCHIVE}/alto/1.xml'] = httpx.Response(404)
        job_id = make(client)
        text_job.phase_ingest(conn, job_id, config.job_dir(job_id))
        statuses = dict(conn.execute('SELECT filename, status FROM pages WHERE job_id = ?', (job_id,)).fetchall())
        assert statuses['0001_1.jpg'] == 'ingested'
        assert '0001_1.jpg' not in lines_of(conn, job_id)


class TestWhatTheReviewFound:
    def test_a_malformed_outline_skips_its_annotation_and_keeps_the_rest(self):
        page = {'annotations': [
            {'motivation': 'supplementing', 'body': {'type': 'TextualBody', 'value': 'broken svg'},
             'target': {'source': 'c', 'selector': {'type': 'SvgSelector', 'value': '<polygon points="1,2 3,4 5,"/>'}}},
            {'motivation': 'supplementing', 'body': {'type': 'TextualBody', 'value': 'broken box'},
             'target': 'c#xywh=1.2.3,4,5,6'},
            {'motivation': 'supplementing', 'body': {'type': 'TextualBody', 'value': 'Taufbuch'},
             'target': 'c#xywh=100,100,400,100'}]}
        assert iiif_transcripts.lines({'kind': 'annotations', 'pages': [page]}, W, H) == [
            {'polygon': [[0.1, 0.05], [0.5, 0.05], [0.5, 0.1], [0.1, 0.1]], 'text': 'Taufbuch'}]

    def test_a_canvas_without_a_size_takes_its_images(self):
        v2 = {'@context': 'http://iiif.io/api/presentation/2/context.json', '@type': 'sc:Manifest',
              '@id': f'{ARCHIVE}/v2n', 'label': 'x', 'sequences': [{'canvases': [{
                  '@id': f'{ARCHIVE}/v2n/1', '@type': 'sc:Canvas', 'label': '1',
                  'images': [{'resource': {'@id': f'{ARCHIVE}/plain/n.jpg', 'width': '1000', 'height': 2000}}]}]}]}
        canvas = iiif.parse(v2, v2['@id'])['canvases'][0]
        assert (canvas['width'], canvas['height']) == (1000, 2000)

    def test_a_file_too_deep_or_a_page_of_the_wrong_shape_leaves_its_page_to_the_pipeline(self, archived, api):
        client, conn, _ = archived
        routes = api[2]
        nested = '<span>' * 5000 + '</span>' * 5000
        routes[f'{ARCHIVE}/hocr/1.html'] = httpx.Response(200, content=(
            f'<html><body><div class="ocr_page" title="bbox 0 0 {W} {H}"><span class="ocr_line" '
            f'title="bbox 1 1 9 9">{nested}</span></div></body></html>').encode())
        routes[f'{ARCHIVE}/anno-page/4'] = httpx.Response(200, json={'type': 'AnnotationPage', 'items': 5})
        manifest = json.loads(json.dumps(MANIFEST))
        manifest['items'][0]['seeAlso'] = [{'id': f'{ARCHIVE}/hocr/1.html', 'format': 'text/vnd.hocr+html'}]
        routes[MANIFEST['id']] = httpx.Response(200, json=manifest)
        assert client.post('/api/iiif/inspect', headers=MEMBER, json={'url': MANIFEST['id']}).status_code == 200
        job_id = make(client)
        text_job.phase_ingest(conn, job_id, config.job_dir(job_id))
        statuses = dict(conn.execute('SELECT filename, status FROM pages WHERE job_id = ?', (job_id,)).fetchall())
        assert statuses == {'0001_1.jpg': 'ingested', '0002_2.jpg': 'done', '0003_3.jpg': 'ingested', '0004_4.jpg': 'ingested'}

    def test_the_wizard_fetches_one_annotation_page_a_canvas_at_most(self, api):
        client, conn, routes, requested = api
        many = {**MANIFEST, 'items': [canvas(1, annotations=[
            {'id': f'{ARCHIVE}/many/{i}', 'type': 'AnnotationPage'} for i in range(6)])]}
        routes[MANIFEST['id']] = httpx.Response(200, json=many)
        for i in range(6):
            routes[f'{ARCHIVE}/many/{i}'] = httpx.Response(200, json=transcribing(1, [('Anna', '100,100,300,80')]))
        client.post('/api/iiif/inspect', headers=MEMBER, json={'url': MANIFEST['id']})
        assert [url for url in requested if '/many/' in url] == [f'{ARCHIVE}/many/0']

    def test_a_fetch_that_drips_on_past_its_deadline_is_given_up(self, archive, monkeypatch):
        routes, _ = archive
        routes[f'{ARCHIVE}/slow.xml'] = lambda: httpx.Response(200, content=iter([b'x'] * 50))
        clock = iter(range(0, 10_000, 10))
        monkeypatch.setattr(iiif.time, 'monotonic', lambda: next(clock))
        with pytest.raises(iiif.IiifError, match='took longer than'):
            iiif.fetch(f'{ARCHIVE}/slow.xml', 1 << 20, 'the transcription')

    def test_a_transcribed_page_counts_as_through_every_step(self, archived):
        client, conn, _ = archived
        job_id = make(client)
        text_job.phase_ingest(conn, job_id, config.job_dir(job_id))
        assert conn.execute("SELECT SUM(layout_skipped) FROM pages WHERE job_id = ?", (job_id,)).fetchone()[0] == 0
        from app import store
        store.recount_pages(conn, job_id)
        assert store.get_job(conn, job_id)['counters']['pages_layout_done'] == 3
