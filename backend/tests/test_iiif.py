"""Datasets made from IIIF manifests: reading both Presentation versions, the address
checks every fetch passes, the download at ingest, and the annotations exported back."""
import io
import json
import socket
import zipfile

import httpx
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app import config, export, iiif, store, text_job
from app.deps import get_db
from app.main import app

SECRET = 'test-secret'
MEMBER = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'alice', 'X-Auth-Role': 'member'}
ARCHIVE = 'https://archive.example'
ADDRESSES = {'archive.example': '93.184.216.34', 'intranet.example': '10.0.0.7',
             'local.example': '127.0.0.1', 'mapped.example': '::ffff:192.168.1.4', 'cgnat.example': '100.64.3.1'}


def jpeg(width: int, height: int, shade: int = 200) -> bytes:
    out = io.BytesIO()
    Image.new('RGB', (width, height), (shade, shade, shade)).save(out, 'JPEG')
    return out.getvalue()


V2 = {
    '@context': 'http://iiif.io/api/presentation/2/context.json', '@type': 'sc:Manifest',
    '@id': f'{ARCHIVE}/v2/manifest', 'label': 'Ratsprotokolle 1781',
    'attribution': 'Provided by <a href="https://archive.example">the town archive</a>',
    'license': 'https://creativecommons.org/licenses/by/4.0/',
    'sequences': [{'canvases': [
        {'@id': f'{ARCHIVE}/canvas/1', '@type': 'sc:Canvas', 'label': 'fol. 1r', 'width': 8000, 'height': 10000,
         'images': [{'resource': {'@id': f'{ARCHIVE}/img/1/full/full/0/default.jpg', 'width': 8000, 'height': 10000,
                                  'service': {'@context': 'http://iiif.io/api/image/2/context.json',
                                              '@id': f'{ARCHIVE}/img/1',
                                              'profile': 'http://iiif.io/api/image/2/level1.json'}}}]},
        {'@id': f'{ARCHIVE}/canvas/2', '@type': 'sc:Canvas', 'label': [{'@value': 'fol. 1v', '@language': 'en'},
                                                                        {'@value': 'Bl. 1v', '@language': 'de'}],
         'width': 4000, 'height': 5000,
         'images': [{'resource': {'@id': f'{ARCHIVE}/img/2/full/full/0/default.jpg', 'width': 4000, 'height': 5000,
                                  'service': {'@context': 'http://iiif.io/api/image/2/context.json',
                                              '@id': f'{ARCHIVE}/img/2/'}}}]},
    ]}],
}

V3 = {
    '@context': 'http://iiif.io/api/presentation/3/context.json', 'type': 'Manifest',
    'id': f'{ARCHIVE}/v3/manifest', 'label': {'de': ['Ratsprotokolle'], 'en': ['Council minutes']},
    'requiredStatement': {'label': {'en': ['Attribution']}, 'value': {'en': ['Town archive, Nr. 17']}},
    'rights': 'http://creativecommons.org/publicdomain/mark/1.0/',
    'items': [
        {'id': f'{ARCHIVE}/c3/1', 'type': 'Canvas', 'label': {'none': ['1']}, 'width': 2000, 'height': 3000,
         'items': [{'type': 'AnnotationPage', 'items': [{'type': 'Annotation', 'motivation': 'painting', 'body': {
             'id': f'{ARCHIVE}/plain/1.jpg', 'type': 'Image', 'width': 2000, 'height': 3000}}]}],
         'thumbnail': [{'id': f'{ARCHIVE}/plain/1-thumb.jpg', 'type': 'Image'}]},
        {'id': f'{ARCHIVE}/c3/2', 'type': 'Canvas', 'label': {'none': ['2']}, 'width': 2000, 'height': 3000,
         'items': [{'type': 'AnnotationPage', 'items': [{'type': 'Annotation', 'body': {'type': 'Choice', 'items': [
             {'id': f'{ARCHIVE}/img3/2/full/max/0/default.jpg', 'type': 'Image', 'width': 2000,
              'service': [{'id': f'{ARCHIVE}/img3/2', 'type': 'ImageService3'}]}]}}]}]},
    ],
}


@pytest.fixture
def archive(monkeypatch):
    """A fake archive behind fake DNS: every request is recorded, every host resolves to
    the address ADDRESSES gives it."""
    requested = []
    routes = {}

    def resolve(host, *args, **kwargs):
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, '', (ADDRESSES[host], 0))]

    def handle(request: httpx.Request) -> httpx.Response:
        requested.append(str(request.url))
        answer = routes.get(str(request.url))
        if answer is None:
            return httpx.Response(404)
        return answer() if callable(answer) else answer

    monkeypatch.setattr(iiif.socket, 'getaddrinfo', resolve)
    monkeypatch.setattr(iiif, '_client', lambda: httpx.Client(transport=httpx.MockTransport(handle)))
    monkeypatch.setattr('app.config.IIIF_ALLOWED_HOSTS', frozenset())
    monkeypatch.setattr('app.config.IIIF_MAX_WIDTH', 6000)
    return routes, requested


class TestReadingManifests:
    def test_a_v2_manifest_gives_its_canvases_with_capped_image_requests(self):
        manifest = iiif.parse(V2, V2['@id'])

        assert manifest['version'] == 2
        assert manifest['label'] == 'Ratsprotokolle 1781'
        assert manifest['attribution'] == 'Provided by the town archive'
        assert manifest['rights'] == 'https://creativecommons.org/licenses/by/4.0/'
        assert manifest['canvases'] == [
            {'canvas': f'{ARCHIVE}/canvas/1', 'label': 'fol. 1r', 'width': 8000, 'height': 10000,
             'image': f'{ARCHIVE}/img/1/full/6000,/0/default.jpg',
             'thumbnail': f'{ARCHIVE}/img/1/full/240,/0/default.jpg'},
            {'canvas': f'{ARCHIVE}/canvas/2', 'label': 'fol. 1v', 'width': 4000, 'height': 5000,
             'image': f'{ARCHIVE}/img/2/full/4000,/0/default.jpg',
             'thumbnail': f'{ARCHIVE}/img/2/full/240,/0/default.jpg'},
        ]

    def test_a_v3_manifest_reads_language_maps_choices_and_plain_images(self):
        manifest = iiif.parse(V3, V3['id'])

        assert (manifest['version'], manifest['label'], manifest['attribution'], manifest['rights']) == (
            3, 'Council minutes', 'Town archive, Nr. 17', 'http://creativecommons.org/publicdomain/mark/1.0/')
        assert [(c['label'], c['image'], c['thumbnail']) for c in manifest['canvases']] == [
            ('1', f'{ARCHIVE}/plain/1.jpg', f'{ARCHIVE}/plain/1-thumb.jpg'),
            ('2', f'{ARCHIVE}/img3/2/full/2000,/0/default.jpg', f'{ARCHIVE}/img3/2/full/240,/0/default.jpg'),
        ]

    def test_collections_of_either_version_list_their_members(self):
        v2 = {'@context': 'http://iiif.io/api/presentation/2/context.json', '@type': 'sc:Collection', 'label': 'All',
              'manifests': [{'@id': f'{ARCHIVE}/m/1', 'label': '1779'}],
              'collections': [{'@id': f'{ARCHIVE}/coll/2', '@type': 'sc:Collection', 'label': 'Later'}]}
        v3 = {'@context': 'http://iiif.io/api/presentation/3/context.json', 'type': 'Collection',
              'label': {'en': ['All']},
              'items': [{'id': f'{ARCHIVE}/m/3', 'type': 'Manifest', 'label': {'en': ['1781']}}]}

        assert iiif.parse(v2, 'u')['members'] == [
            {'url': f'{ARCHIVE}/m/1', 'label': '1779', 'kind': 'manifest'},
            {'url': f'{ARCHIVE}/coll/2', 'label': 'Later', 'kind': 'collection'}]
        assert iiif.parse(v3, 'u')['members'] == [{'url': f'{ARCHIVE}/m/3', 'label': '1781', 'kind': 'manifest'}]

    def test_anything_else_is_refused_with_a_reason(self):
        with pytest.raises(iiif.IiifError, match='neither a IIIF manifest nor a collection'):
            iiif.parse({'type': 'Annotation'}, 'u')
        with pytest.raises(iiif.IiifError, match='no canvas with an image'):
            iiif.parse({**V3, 'items': []}, 'u')


class TestAddressChecks:
    @pytest.mark.parametrize('host', ['intranet.example', 'local.example', 'mapped.example', 'cgnat.example'])
    def test_an_internal_address_is_never_fetched(self, archive, host):
        routes, requested = archive

        with pytest.raises(iiif.IiifError, match='private or internal address'):
            iiif.read(f'https://{host}/manifest')
        assert requested == []

    def test_a_redirect_into_the_network_is_refused_before_it_is_followed(self, archive):
        routes, requested = archive
        routes[f'{ARCHIVE}/manifest'] = httpx.Response(302, headers={'location': 'https://intranet.example/secret'})

        with pytest.raises(iiif.IiifError, match='intranet.example is a private or internal address'):
            iiif.read(f'{ARCHIVE}/manifest')
        assert requested == [f'{ARCHIVE}/manifest']

    def test_a_host_the_deployment_allows_may_be_internal(self, archive, monkeypatch):
        routes, requested = archive
        monkeypatch.setattr('app.config.IIIF_ALLOWED_HOSTS', frozenset({'intranet.example'}))
        routes['https://intranet.example/manifest'] = httpx.Response(200, json=V2)

        assert len(iiif.read('https://intranet.example/manifest')['canvases']) == 2

    def test_only_http_and_https_are_fetched(self, archive):
        with pytest.raises(iiif.IiifError, match='not an http or https address'):
            iiif.read('file:///etc/passwd')

    @pytest.mark.parametrize('declared', [True, False], ids=['declared size', 'streamed'])
    def test_an_image_over_the_limit_is_refused(self, archive, monkeypatch, tmp_path, declared):
        routes, _ = archive
        monkeypatch.setattr('app.config.IIIF_MAX_MB', 1)
        body = jpeg(400, 400, 10) + b'\0' * (3 << 19)
        routes[f'{ARCHIVE}/big.jpg'] = lambda: httpx.Response(
            200, content=body if declared else iter([body[i:i + 65536] for i in range(0, len(body), 65536)]))

        with pytest.raises(iiif.IiifError, match='the image is larger than 1 MB'):
            iiif.download(f'{ARCHIVE}/big.jpg', tmp_path / 'x.jpg')
        assert not (tmp_path / 'x.jpg').exists()


class TestDownload:
    def test_a_plain_image_wider_than_the_cap_is_shrunk(self, archive, monkeypatch, tmp_path):
        routes, _ = archive
        monkeypatch.setattr('app.config.IIIF_MAX_WIDTH', 500)
        routes[f'{ARCHIVE}/plain.jpg'] = httpx.Response(200, content=jpeg(1000, 1400))

        written = iiif.download(f'{ARCHIVE}/plain.jpg', tmp_path / 'pages' / 'p.jpg')

        assert Image.open(written).size == (500, 700)

    def test_something_that_is_no_image_says_so(self, archive, tmp_path):
        routes, _ = archive
        routes[f'{ARCHIVE}/x.jpg'] = httpx.Response(200, content=b'<html>login</html>')

        with pytest.raises(iiif.IiifError, match='did not send a readable image'):
            iiif.download(f'{ARCHIVE}/x.jpg', tmp_path / 'x.jpg')


@pytest.fixture
def api(tmp_path, monkeypatch, archive):
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    monkeypatch.setattr('app.config.JOBS_DIR', tmp_path / 'jobs')
    monkeypatch.setattr('app.config.BLOBS_DIR', None)
    conn = store.connect(tmp_path / 'app.db')
    app.dependency_overrides[get_db] = lambda: conn
    routes, requested = archive
    routes[V2['@id']] = httpx.Response(200, json=V2)
    yield TestClient(app), conn, routes, requested
    app.dependency_overrides.clear()
    conn.close()


def create(client, canvases: list[str], **extra):
    return client.post('/api/jobs/iiif', headers=MEMBER, json={
        'name': 'Minutes', 'manifest': V2['@id'], 'canvases': canvases,
        'run_layout': False, 'run_lines': False, 'run_ocr': False, **extra})


class TestImport:
    def test_inspect_answers_the_manifest_and_the_page_limit(self, api):
        client, *_ = api
        answer = client.post('/api/iiif/inspect', headers=MEMBER, json={'url': V2['@id']})

        assert answer.status_code == 200
        assert answer.json()['kind'] == 'manifest'
        assert [c['label'] for c in answer.json()['canvases']] == ['fol. 1r', 'fol. 1v']
        assert (answer.json()['max_pages'], answer.json()['max_width']) == (2000, 6000)

    def test_the_chosen_canvases_become_pages_that_download_at_ingest(self, api):
        client, conn, routes, requested = api
        routes[f'{ARCHIVE}/img/2/full/4000,/0/default.jpg'] = httpx.Response(200, content=jpeg(400, 500))

        made = create(client, [f'{ARCHIVE}/canvas/2'])
        assert made.status_code == 200
        job_id = made.json()['job_id']
        page = conn.execute('SELECT * FROM pages WHERE job_id = ?', (job_id,)).fetchone()
        assert page['filename'] == '0002_fol-1v.jpg'
        assert json.loads(page['iiif']) == {'canvas': f'{ARCHIVE}/canvas/2', 'label': 'fol. 1v', 'width': 4000,
                                            'height': 5000, 'image': f'{ARCHIVE}/img/2/full/4000,/0/default.jpg'}
        assert json.loads(conn.execute('SELECT iiif_source FROM jobs WHERE id = ?', (job_id,)).fetchone()[0]) == {
            'manifest': V2['@id'], 'label': 'Ratsprotokolle 1781',
            'attribution': 'Provided by the town archive', 'rights': 'https://creativecommons.org/licenses/by/4.0/'}

        text_job.phase_ingest(conn, job_id, config.job_dir(job_id))

        page = conn.execute('SELECT status, width, height FROM pages WHERE job_id = ?', (job_id,)).fetchone()
        assert tuple(page) == ('ingested', 400, 500)
        assert requested.count(f'{ARCHIVE}/img/2/full/4000,/0/default.jpg') == 1

    def test_a_page_whose_image_fails_is_unreadable_alone_and_comes_back_on_retry(self, api):
        client, conn, routes, _ = api
        routes[f'{ARCHIVE}/img/1/full/6000,/0/default.jpg'] = httpx.Response(200, content=jpeg(600, 750, 90))
        job_id = create(client, [f'{ARCHIVE}/canvas/1', f'{ARCHIVE}/canvas/2']).json()['job_id']

        text_job.phase_ingest(conn, job_id, config.job_dir(job_id))

        rows = conn.execute('SELECT filename, status, error FROM pages WHERE job_id = ? ORDER BY idx',
                            (job_id,)).fetchall()
        assert [tuple(r) for r in rows] == [
            ('0001_fol-1r.jpg', 'ingested', None),
            ('0002_fol-1v.jpg', 'unreadable', '0002_fol-1v.jpg: the server answered 404 for the image')]
        conn.execute("UPDATE jobs SET status = 'done' WHERE id = ?", (job_id,))
        conn.commit()

        routes[f'{ARCHIVE}/img/2/full/4000,/0/default.jpg'] = httpx.Response(200, content=jpeg(400, 500, 30))
        assert client.post(f'/api/jobs/{job_id}/iiif/retry', headers=MEMBER).json() == {'retried': 1}
        assert conn.execute('SELECT status FROM jobs WHERE id = ?', (job_id,)).fetchone()[0] == 'queued'
        text_job.phase_ingest(conn, job_id, config.job_dir(job_id))

        assert [r[0] for r in conn.execute('SELECT status FROM pages WHERE job_id = ? ORDER BY idx', (job_id,))] == [
            'ingested', 'ingested']
        assert client.post(f'/api/jobs/{job_id}/iiif/retry', headers=MEMBER).status_code == 409

    def test_the_manifest_is_read_again_so_a_canvas_it_lacks_is_no_page(self, api):
        client, *_ = api
        answer = create(client, [f'{ARCHIVE}/canvas/99'])

        assert (answer.status_code, answer.json()['detail']) == (400, 'choose at least one page')

    def test_more_pages_than_the_limit_are_refused(self, api, monkeypatch):
        client, *_ = api
        monkeypatch.setattr('app.config.IIIF_MAX_PAGES', 1)

        answer = create(client, [f'{ARCHIVE}/canvas/1', f'{ARCHIVE}/canvas/2'])

        assert (answer.status_code, answer.json()['detail']) == (
            400, '2 pages is more than the 1 one dataset may import from IIIF')

    def test_only_text_datasets_come_from_iiif(self, api):
        client, *_ = api
        answer = create(client, [f'{ARCHIVE}/canvas/1'], task='map_segmentation')

        assert (answer.status_code, answer.json()['detail']) == (400, 'a IIIF manifest makes a text dataset')


class TestExport:
    PAGE = {'id': 7, 'idx': 0, 'filename': '0001_fol-1r.jpg', 'width': 600, 'height': 750,
            'iiif': {'canvas': f'{ARCHIVE}/canvas/1', 'label': 'fol. 1r', 'width': 8000, 'height': 10000},
            'elements': [{'class_name': 'Paragraph', 'lines': [
                {'id': 31, 'polygon': [[0.1, 0.2], [0.5, 0.2], [0.5, 0.25], [0.1, 0.25]],
                 'text': 'Raht', 'corrected_text': 'Rath', 'checked': True, 'confidence': 0.9}]}]}

    def test_a_line_is_annotated_on_its_canvas_in_canvas_coordinates(self):
        page = iiif.annotation_page(self.PAGE, 'job1')

        assert page['type'] == 'AnnotationPage'
        [annotation] = page['items']
        assert annotation['motivation'] == 'supplementing'
        assert annotation['body'] == {'type': 'TextualBody', 'value': 'Rath', 'format': 'text/plain'}
        assert annotation['target']['source'] == f'{ARCHIVE}/canvas/1'
        fragment, svg = annotation['target']['selector']
        assert fragment['value'] == 'xywh=800,2000,3200,500'
        assert 'points="800,2000 4000,2000 4000,2500 800,2500"' in svg['value']

    def test_the_export_holds_annotations_for_iiif_pages_and_the_source_note(self, api):
        client, conn, routes, _ = api
        routes[f'{ARCHIVE}/img/1/full/6000,/0/default.jpg'] = httpx.Response(200, content=jpeg(600, 750))
        job_id = create(client, [f'{ARCHIVE}/canvas/1']).json()['job_id']
        text_job.phase_ingest(conn, job_id, config.job_dir(job_id))
        page_id = conn.execute('SELECT id FROM pages WHERE job_id = ?', (job_id,)).fetchone()[0]
        element = conn.execute("INSERT INTO elements (page_id, order_idx, class_name, bbox, kind) "
                               "VALUES (?, 0, 'Paragraph', '[0,0,1,1]', 'text')", (page_id,)).lastrowid
        conn.execute('INSERT INTO lines (element_id, order_idx, polygon, text) VALUES (?, 0, ?, ?)',
                     (element, json.dumps([[0.1, 0.2], [0.5, 0.2], [0.5, 0.25], [0.1, 0.25]]), 'Rath'))
        conn.commit()

        answer = client.get(f'/api/jobs/{job_id}/export?format=iiif', headers=MEMBER)

        assert answer.status_code == 200
        archive = zipfile.ZipFile(io.BytesIO(answer.content))
        assert sorted(archive.namelist()) == ['SOURCE.txt', 'annotations/0001_fol-1r.json']
        annotations = json.loads(archive.read('annotations/0001_fol-1r.json'))
        assert [a['body']['value'] for a in annotations['items']] == ['Rath']
        assert archive.read('SOURCE.txt').decode() == (
            f'Imported from the IIIF manifest: {V2["@id"]}\nTitle: Ratsprotokolle 1781\n'
            'Attribution: Provided by the town archive\nRights: https://creativecommons.org/licenses/by/4.0/\n')

    def test_the_tei_header_and_page_xml_name_the_source(self, api):
        client, conn, routes, _ = api
        routes[f'{ARCHIVE}/img/1/full/6000,/0/default.jpg'] = httpx.Response(200, content=jpeg(600, 750))
        job_id = create(client, [f'{ARCHIVE}/canvas/1']).json()['job_id']
        text_job.phase_ingest(conn, job_id, config.job_dir(job_id))
        data = export.collect_job(conn, job_id)

        tei = export.standard_files(data, 'tei')['tei.xml']
        page_xml = export.standard_files(data, 'page')['page/0001_fol-1r.xml']

        assert ('<sourceDesc><bibl><title>Ratsprotokolle 1781</title>'
                f'<idno type="IIIF-manifest">{V2["@id"]}</idno><availability>'
                '<licence target="https://creativecommons.org/licenses/by/4.0/">Provided by the town archive'
                '</licence></availability></bibl></sourceDesc>') in tei
        assert (f'<Comments>IIIF manifest {V2["@id"]}; Provided by the town archive; '
                'https://creativecommons.org/licenses/by/4.0/</Comments>') in page_xml

    def test_a_dataset_without_iiif_pages_has_nothing_to_export_that_way(self, api, tmp_path):
        client, conn, *_ = api
        conn.execute("INSERT INTO jobs (id, name, owner) VALUES ('plain', 'Plain', 'alice')")
        conn.commit()

        answer = client.get('/api/jobs/plain/export?format=iiif', headers=MEMBER)

        assert (answer.status_code, answer.json()['detail']) == (400, 'no page of this dataset was imported from IIIF')
