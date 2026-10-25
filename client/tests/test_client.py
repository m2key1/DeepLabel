"""The client is what a power user actually touches, so its request building is pinned
against a real HTTP server rather than a mock: a wrong field name or a missing
Authorization header is a support ticket, not a stack trace.
"""
import json
import re
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from deeplabel import DeepLabel, DeepLabelError

RECORDED = []


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def _record(self):
        length = int(self.headers.get('Content-Length') or 0)
        RECORDED.append({'method': self.command, 'path': self.path,
                         'headers': dict(self.headers), 'body': self.rfile.read(length)})
        return RECORDED[-1]

    def _reply(self, status: int, payload):
        body = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self._record()
        if self.path.startswith('/api/jobs/denied'):
            return self._reply(403, {'detail': 'read-only API token'})
        if self.path.startswith('/api/jobs/j1/export'):
            return self._reply(200, b'EXPORTED')
        if self.path.startswith('/api/jobs/j1/documents'):
            return self._reply(200, {'documents': [
                {'name': 'letter-01', 'idx': 0, 'characters': 40, 'lines': 2, 'pages': 3}]})
        if self.path.startswith('/api/jobs/j1/reference'):
            return self._reply(200, {'total': 1, 'pages': [
                {'page_id': 7, 'idx': 0, 'filename': 'leaf_1.png', 'document': 'letter-01',
                 'anchors': 2, 'score': 0.97, 'text': 'a span', 'gt_source': None}]})
        if self.path.startswith('/api/jobs/j1/groundtruth/preview'):
            return self._reply(200, {'pages': 2, 'calls': 2, 'models': []})
        if self.path.startswith('/api/jobs/j1/groundtruth/status'):
            return self._reply(200, {'pending': 0, 'running': 0, 'done': 2, 'error': 0,
                                     'errors': [], 'pages': 2})
        if self.path.startswith('/api/jobs/j1'):
            return self._reply(200, {'id': 'j1', 'status': 'done', 'phase': None})
        if self.path.startswith('/api/jobs/held'):
            # A held upload that got as far as one scan and one PDF.
            return self._reply(200, {'id': 'held', 'status': 'uploading', 'pages': [
                {'filename': 'scan_1.png'}, {'filename': 'deed_p0001.png'}, {'filename': 'deed_p0002.png'}]})
        return self._reply(200, [{'id': 'j1', 'name': 'set', 'status': 'done', 'counters': {}},
                                 {'id': 'held', 'name': 'volume', 'status': 'uploading', 'counters': {}}])

    def do_DELETE(self):
        self._record()
        self._reply(200, {'documents': 0})

    def do_POST(self):
        self._record()
        if self.path.endswith('/reference/cut'):
            return self._reply(200, {'documents': 1, 'pages': 3, 'placed': 3, 'unanchored': 0})
        if self.path.endswith('/groundtruth/read'):
            return self._reply(200, {'queued': 3, 'reused': 0, 'pages': 3})
        if self.path.endswith('/documents'):
            return self._reply(200, {'stored': 2, 'skipped': [], 'documents': 2})
        # Exactly what the backend returns - a stub that also offers 'id' would hide
        # a client reading a key the API has never sent.
        self._reply(200, {'job_id': 'new', 'pages': 2, 'lines': 5})


@pytest.fixture(scope='module')
def server():
    RECORDED.clear()
    httpd = HTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield f'http://127.0.0.1:{httpd.server_port}'
    httpd.shutdown()


@pytest.fixture
def client(server):
    RECORDED.clear()
    return DeepLabel(server, 'dlp_test')


def test_every_call_carries_the_token(client):
    client.jobs()
    assert RECORDED[-1]['headers']['Authorization'] == 'Bearer dlp_test'


def test_missing_url_or_token_fails_before_any_request():
    with pytest.raises(ValueError, match='DEEPLABEL_URL'):
        DeepLabel('', 'dlp_test')
    with pytest.raises(ValueError, match='DEEPLABEL_TOKEN'):
        DeepLabel('http://x', '')


def test_upload_sends_the_fields_the_backend_expects(client, tmp_path):
    scan = tmp_path / 'folio_1.png'
    scan.write_bytes(b'PNGDATA')
    (tmp_path / 'folio_1.txt').write_text('Lieber Herr Doctor!')

    client.upload('My set', [tmp_path], run_ocr=False, gt_autocheck=True)
    sent = RECORDED[-1]
    body = sent['body'].decode('utf-8', 'replace')
    assert sent['path'] == '/api/jobs'
    assert sent['headers']['Content-Type'].startswith('multipart/form-data; boundary=')
    assert 'name="name"\r\n\r\nMy set' in body
    # Booleans have to arrive as the lowercase form values FastAPI parses.
    assert 'name="run_ocr"\r\n\r\nfalse' in body
    assert 'name="gt_autocheck"\r\n\r\ntrue' in body
    # A directory contributes its files, transcription siblings included.
    assert 'filename="folio_1.png"' in body and 'filename="folio_1.txt"' in body
    assert body.count('name="files"') == 2


def sent_files(record) -> list[str]:
    return re.findall(r'filename="([^"]+)"', record['body'].decode('utf-8', 'replace'))


def form_field(record, name: str) -> str | None:
    found = re.search(rf'name="{name}"\r\n\r\n([^\r]*)', record['body'].decode('utf-8', 'replace'))
    return found.group(1) if found else None


class TestALargeUpload:
    """A volume is sent in batches: the dataset is created held, every later batch is
    appended, and only then is it started - so the queue never runs it on part of it."""

    def volume(self, tmp_path, scans: int):
        for i in range(1, scans + 1):
            (tmp_path / f'scan_{i}.png').write_bytes(b'PNGDATA')
        (tmp_path / 'scan_2.txt').write_text('Lieber Herr Doctor!')
        return tmp_path

    def test_it_is_created_held_appended_in_batches_and_started(self, client, tmp_path):
        result = client.upload('volume', [self.volume(tmp_path, 5)], batch_size=2, run_ocr=False)

        assert result['job_id'] == 'new'
        assert [r['path'] for r in RECORDED] == [
            '/api/jobs', '/api/jobs/new/pages/upload', '/api/jobs/new/pages/upload', '/api/jobs/new/start']
        assert form_field(RECORDED[0], 'hold') == 'true'
        assert form_field(RECORDED[0], 'run_ocr') == 'false'
        # A transcription travels in the batch of the scan it belongs to.
        assert [sent_files(r) for r in RECORDED[:3]] == [
            ['scan_1.png', 'scan_2.png', 'scan_2.txt'], ['scan_3.png', 'scan_4.png'], ['scan_5.png']]

    def test_one_batch_is_one_request_as_before(self, client, tmp_path):
        client.upload('volume', [self.volume(tmp_path, 2)], batch_size=2)

        assert [r['path'] for r in RECORDED] == ['/api/jobs']
        assert form_field(RECORDED[0], 'hold') is None

    def test_progress_is_reported_per_batch(self, client, tmp_path):
        seen = []
        client.upload('volume', [self.volume(tmp_path, 5)], batch_size=2,
                      on_progress=lambda done, total: seen.append((done, total)))

        assert seen == [(3, 6), (5, 6), (6, 6)]

    def test_resuming_sends_only_what_the_held_dataset_lacks_and_starts_it(self, client, tmp_path):
        self.volume(tmp_path, 3)
        (tmp_path / 'deed.pdf').write_bytes(b'%PDF')
        (tmp_path / 'will.pdf').write_bytes(b'%PDF')

        result = client.upload('volume', [tmp_path], batch_size=10, resume=True)

        assert result['job_id'] == 'held'
        posts = [r for r in RECORDED if r['method'] == 'POST']
        assert [r['path'] for r in posts] == ['/api/jobs/held/pages/upload', '/api/jobs/held/start']
        assert sent_files(posts[0]) == ['scan_2.png', 'scan_2.txt', 'scan_3.png', 'will.pdf']

    def test_resuming_needs_a_dataset_that_is_still_uploading(self, client, tmp_path):
        with pytest.raises(ValueError, match='no dataset "set" is waiting for its upload'):
            client.upload('set', [self.volume(tmp_path, 1)], resume=True)


def test_upload_refuses_an_empty_selection(client, tmp_path):
    with pytest.raises(ValueError, match='no files'):
        client.upload('empty', [tmp_path])


def test_export_returns_raw_bytes_and_passes_the_filters(client):
    assert client.export('j1', format='txt', reviewed_only=True) == b'EXPORTED'
    assert 'format=txt' in RECORDED[-1]['path']
    assert 'checked_only=true' in RECORDED[-1]['path']


def test_an_http_error_surfaces_the_servers_own_message(client):
    with pytest.raises(DeepLabelError) as caught:
        client.job('denied')
    assert caught.value.status == 403
    assert caught.value.detail == 'read-only API token'


def test_an_unreachable_deployment_says_so(tmp_path):
    with pytest.raises(DeepLabelError, match='cannot reach'):
        DeepLabel('http://127.0.0.1:1', 'dlp_test').jobs()


def test_wait_returns_once_the_dataset_stops(client):
    assert client.wait('j1', poll=0)['status'] == 'done'


def test_the_cli_uploads_and_reports_the_new_dataset(client, server, tmp_path, capsys, monkeypatch):
    from deeplabel import cli
    (tmp_path / 'folio_1.png').write_bytes(b'PNGDATA')
    monkeypatch.setenv('DEEPLABEL_URL', server)
    monkeypatch.setenv('DEEPLABEL_TOKEN', 'dlp_test')
    assert cli.main(['upload', 'set', str(tmp_path)]) == 0
    assert capsys.readouterr().out.strip() == 'new'


def test_the_cli_resumes_a_held_upload(client, server, tmp_path, capsys, monkeypatch):
    from deeplabel import cli
    (tmp_path / 'scan_1.png').write_bytes(b'PNGDATA')
    (tmp_path / 'scan_9.png').write_bytes(b'PNGDATA')
    monkeypatch.setenv('DEEPLABEL_URL', server)
    monkeypatch.setenv('DEEPLABEL_TOKEN', 'dlp_test')
    assert cli.main(['upload', 'volume', str(tmp_path), '--resume']) == 0
    assert capsys.readouterr().out.strip() == 'held'
    assert [sent_files(r) for r in RECORDED if r['path'].endswith('/pages/upload')] == [['scan_9.png']]


def test_the_cli_reports_a_refusal_without_a_traceback(server, capsys, monkeypatch):
    from deeplabel import cli
    monkeypatch.setenv('DEEPLABEL_URL', server)
    monkeypatch.setenv('DEEPLABEL_TOKEN', 'dlp_test')
    assert cli.main(['show', 'denied']) == 1
    assert 'read-only API token' in capsys.readouterr().err


class TestTheCorpusCalls:
    """The corpus workflow is what a 452-dataset volume is driven with, so its request
    building is pinned as firmly as upload's."""

    def test_only_text_files_are_sent_as_corpus_documents(self, client, tmp_path):
        (tmp_path / 'letter-01.txt').write_text('Mein lieber Freund')
        (tmp_path / 'letter-02.txt').write_text('Lieber Elias')
        (tmp_path / 'leaf_1.png').write_bytes(b'PNGDATA')

        assert client.upload_documents('j1', [tmp_path])['stored'] == 2
        sent = RECORDED[-1]
        body = sent['body'].decode('utf-8', 'replace')
        assert sent['path'] == '/api/jobs/j1/documents'
        assert body.count('name="files"') == 2
        assert 'filename="letter-01.txt"' in body and 'filename="letter-02.txt"' in body
        assert 'filename="leaf_1.png"' not in body

    def test_a_selection_with_no_text_file_fails_before_any_request(self, client, tmp_path):
        (tmp_path / 'leaf_1.png').write_bytes(b'PNGDATA')
        with pytest.raises(ValueError, match='no .txt files'):
            client.upload_documents('j1', [tmp_path])

    def test_cutting_reports_what_was_placed(self, client):
        assert client.cut_reference('j1') == {
            'documents': 1, 'pages': 3, 'placed': 3, 'unanchored': 0}
        assert RECORDED[-1]['path'] == '/api/jobs/j1/reference/cut'
        assert RECORDED[-1]['method'] == 'POST'

    def test_the_reference_listing_passes_its_window(self, client):
        body = client.reference('j1', limit=50, offset=10)
        assert body['pages'][0]['anchors'] == 2
        assert 'limit=50' in RECORDED[-1]['path']
        assert 'offset=10' in RECORDED[-1]['path']

    def test_a_document_can_be_deleted_by_name(self, client):
        assert client.delete_document('j1', 'letter-01') == {'documents': 0}
        assert RECORDED[-1]['method'] == 'DELETE'
        assert RECORDED[-1]['path'] == '/api/jobs/j1/documents/letter-01'

    def test_a_repeated_query_parameter_is_sent_once_per_value(self, client):
        """urlencode without doseq would send model_ids=[1, 2] as one bracketed string,
        which FastAPI reads as no model at all."""
        client.groundtruth_preview('j1', model_ids=[1, 2])
        assert 'model_ids=1&model_ids=2' in RECORDED[-1]['path']

    def test_a_diplomatic_run_sends_json_the_backend_parses(self, client):
        assert client.read_groundtruth('j1', refresh=True)['queued'] == 3
        sent = RECORDED[-1]
        assert sent['headers']['Content-Type'] == 'application/json'
        assert json.loads(sent['body']) == {
            'model_ids': None, 'refresh': True, 'page_ids': None}

    def test_waiting_returns_once_nothing_is_in_flight(self, client):
        assert client.wait_groundtruth('j1', poll=0)['done'] == 2


class TestTheCorpusCommands:
    def test_the_cli_cuts_and_reports_the_placement(self, server, capsys, monkeypatch):
        from deeplabel import cli
        monkeypatch.setenv('DEEPLABEL_URL', server)
        monkeypatch.setenv('DEEPLABEL_TOKEN', 'dlp_test')
        assert cli.main(['cut', 'j1']) == 0
        assert capsys.readouterr().out.strip() == (
            '3/3 pages placed from 1 document(s), 0 without an anchor')

    def test_the_cli_lists_the_corpus(self, server, capsys, monkeypatch):
        from deeplabel import cli
        monkeypatch.setenv('DEEPLABEL_URL', server)
        monkeypatch.setenv('DEEPLABEL_TOKEN', 'dlp_test')
        assert cli.main(['corpus', 'j1']) == 0
        out = capsys.readouterr().out
        assert 'letter-01' in out and '2 lines' in out and '3 pages' in out
