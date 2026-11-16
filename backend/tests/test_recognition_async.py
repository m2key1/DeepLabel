import io
import re
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app import backend_client, jobs, recognize, store
from app.backend_client import Encoded
from app.deps import get_db
from app.main import app

SECRET = 'test-secret'
ALICE = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'alice', 'X-Auth-Role': 'member', 'X-Auth-Caps': 'recognize'}
BOB = {**ALICE, 'X-Auth-User': 'bob'}
DEV = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'dev', 'X-Auth-Role': 'admin'}
READ_CONFIDENCE = 0.75
# Two lines on every page, the lower one first, so only the column sweep puts them in order.
TOP = [[0.1, 0.1], [0.9, 0.1], [0.9, 0.2], [0.1, 0.2]]
LOW = [[0.1, 0.5], [0.9, 0.5], [0.9, 0.6], [0.1, 0.6]]


def _png(width: int, height: int) -> bytes:
    out = io.BytesIO()
    Image.new('RGB', (width, height), 'white').save(out, format='PNG')
    return out.getvalue()


SCANS = {'a.png': _png(300, 200), 'b.png': _png(400, 200), 'c.png': _png(500, 200)}
LINE_IMAGES = {'one.png': _png(120, 20), 'two.png': _png(160, 20), 'three.png': _png(200, 20)}


def _width(image) -> int:
    if isinstance(image, Encoded):
        with Image.open(io.BytesIO(image.data)) as opened:
            return opened.width
    return image.width


class FakeBackend:
    """Every model backend at once: two lines on every page, and a reading that names the
    width of the image it read and the line's place, so each page reads differently."""

    def __init__(self, before_reading=None):
        self.sent: list[tuple[str, int]] = []
        self.before_reading = before_reading
        self.on_wait = None

    def load(self, conn, model_id):
        return None, {}

    def info(self):
        return {}

    def max_items(self, task):
        return 16

    def predict_all(self, task, weights, params, items):
        self.sent.append((task, len(items)))
        if task == 'lines':
            return {'results': [{'lines': [{'polygon': LOW}, {'polygon': TOP}]} for _ in items]}
        if self.before_reading:
            self.before_reading()
        return {'results': [{'text': f"{_width(item.image)} wide, line {item.context['line_index'] + 1}",
                             'confidence': READ_CONFIDENCE} for item in items]}


class Crash(BaseException):
    """What the worker meets when the backend stops under it: nothing it can catch."""


@pytest.fixture
def conn(tmp_path, monkeypatch):
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    monkeypatch.setattr('app.config.MODEL_BACKENDS', {})
    monkeypatch.setattr('app.config.JOBS_DIR', tmp_path / 'jobs')
    monkeypatch.setattr('app.config.BLOBS_DIR', tmp_path / 'blobs')
    monkeypatch.setattr('app.config.RECOGNITION_DIR', tmp_path / 'recognition', raising=False)
    connection = store.connect(tmp_path / 'app.db')
    for task in ('lines', 'ocr'):
        connection.execute('INSERT INTO models (task, name, checkpoint, is_default) VALUES (?, ?, ?, 1)',
                           (task, task.title(), f'{task}.ckpt'))
    connection.commit()
    yield connection
    connection.close()


@pytest.fixture
def client(conn):
    app.dependency_overrides[get_db] = lambda: conn
    yield TestClient(app)
    app.dependency_overrides.clear()


@pytest.fixture
def backend(monkeypatch) -> FakeBackend:
    served = FakeBackend()
    monkeypatch.setattr(backend_client, 'client_for', lambda conn, model_id: served)
    return served


def _send(client, names=('a.png', 'b.png'), route='pages', headers=ALICE, **fields):
    images = SCANS if route == 'pages' else LINE_IMAGES
    return client.post(f'/api/recognize/{route}', headers=headers, data={'async': 'true', **fields},
                       files=[('files', (name, images[name], 'image/png')) for name in names])


def _queue_dataset(conn, job_id='j1', status='queued'):
    conn.execute("INSERT INTO jobs (id, name, owner, task, status) VALUES (?, ?, 'carol', 'text', ?)",
                 (job_id, job_id, status))
    conn.commit()


def _run(conn, request_id):
    jobs._run_work(conn, 'recognition', request_id)


def _usage(conn, account='alice') -> dict:
    usage = recognize.month_usage(conn, account, datetime.now(UTC).strftime('%Y-%m'))
    return {key: usage[key] for key in ('requests', 'pages', 'lines')}


def _undated(answer: dict) -> dict:
    """A PAGE document says when it was made, which two requests never share."""
    return {**answer, 'pages': [{**page, 'document': re.sub(r'<(Created|LastChange)>[^<]*', r'<\1>', page['document'])}
                                for page in answer['pages']]}


def _stamp(text: str) -> datetime:
    return datetime.strptime(text, '%Y-%m-%d %H:%M:%S')


class TestSent:
    def test_it_is_answered_at_once_with_its_id_and_waits_in_the_queue_behind_work_sent_before_it(
            self, conn, client, backend):
        _queue_dataset(conn)
        sent = _send(client)

        assert sent.status_code == 202
        request_id = sent.json()['id']
        assert sent.headers['location'] == f'/api/recognize/{request_id}'
        assert sent.json() == {'id': request_id, 'status': 'queued', 'place': 2, 'files': 2, 'done': 0,
                               'submitted_at': sent.json()['submitted_at']}
        assert _stamp(sent.json()['submitted_at'])
        assert jobs._next_work(conn) == ('job', 'j1')
        assert backend.sent == []

        conn.execute("UPDATE jobs SET status = 'done' WHERE id = 'j1'")
        conn.commit()
        assert jobs._next_work(conn) == ('recognition', request_id)
        waiting = client.get(f'/api/recognize/{request_id}', headers=ALICE)
        assert (waiting.status_code, waiting.json()) == (202, {**sent.json(), 'place': 1})

    @pytest.mark.parametrize('fields, route, detail', [
        ({'format': 'docx'}, 'pages', 'format must be one of json, page, alto, hocr, txt'),
        ({'lines_model': '99'}, 'pages', 'not an available lines model'),
        ({'lines': '{"other.png": []}'}, 'pages', 'lines names other.png, which is not a file of this request'),
        ({'decode': 'psychic'}, 'lines', 'decode must be one of '),
    ])
    def test_what_an_answer_at_once_would_refuse_is_refused_when_sent(self, conn, client, backend, tmp_path,
                                                                       fields, route, detail):
        names = ('a.png',) if route == 'pages' else ('one.png',)
        refused = _send(client, names, route, **fields)

        assert refused.status_code == 400
        assert refused.json()['detail'].startswith(detail)
        assert jobs._next_work(conn) is None
        assert not (tmp_path / 'recognition').exists() or not any((tmp_path / 'recognition').iterdir())

    def test_the_async_limits_apply_rather_than_those_of_an_answer_at_once(self, client, backend, monkeypatch):
        monkeypatch.setattr('app.config.RECOGNIZE_MAX_PAGES', 1)
        monkeypatch.setattr('app.config.RECOGNIZE_MAX_LINES', 1)
        monkeypatch.setattr('app.config.RECOGNIZE_ASYNC_MAX_PAGES', 2, raising=False)
        monkeypatch.setattr('app.config.RECOGNIZE_ASYNC_MAX_LINES', 2, raising=False)

        assert _send(client, ('a.png', 'b.png')).status_code == 202
        too_many = _send(client, ('a.png', 'b.png', 'c.png'))
        assert (too_many.status_code, too_many.json()['detail']) == (
            413, 'at most 2 pages per async request, this one has 3')
        assert _send(client, ('one.png', 'two.png'), 'lines').status_code == 202
        too_long = _send(client, ('one.png', 'two.png', 'three.png'), 'lines')
        assert (too_long.status_code, too_long.json()['detail']) == (
            413, 'at most 2 lines per async request, this one has 3')
        outline = [[0, 0], [5, 0], [5, 2]]
        own = _send(client, ('a.png',), lines=f'{{"a.png": [{outline}, {outline}, {outline}]}}')
        assert (own.status_code, own.json()['detail']) == (413, 'at most 2 lines per async request, this one has 3')

    def test_the_async_size_limit_is_its_own(self, client, backend, monkeypatch):
        monkeypatch.setattr('app.config.RECOGNIZE_MAX_MB', 1)
        monkeypatch.setattr('app.config.RECOGNIZE_ASYNC_MAX_MB', 2, raising=False)
        files = [('files', (f'p{i}.png', b'x' * 600_000, 'image/png')) for i in range(2)]
        at_once = client.post('/api/recognize/pages', headers=ALICE, files=files)
        assert (at_once.status_code, at_once.json()['detail']) == (413, 'at most 1 MB per request')
        assert client.post('/api/recognize/pages', headers=ALICE, files=files,
                           data={'async': 'true'}).status_code == 202
        files += [('files', ('p2.png', b'x' * 1_000_000, 'image/png'))]
        too_large = client.post('/api/recognize/pages', headers=ALICE, files=files, data={'async': 'true'})
        assert (too_large.status_code, too_large.json()['detail']) == (
            413, 'at most 1 MB per request, 2 MB per async request')

    def test_an_account_has_a_few_unfinished_and_answers_at_once_are_not_held_up_by_them(
            self, conn, client, backend, monkeypatch):
        monkeypatch.setattr('app.config.RECOGNIZE_ASYNC_PER_ACCOUNT', 2, raising=False)
        first = _send(client).json()['id']
        assert _send(client).status_code == 202

        third = _send(client)
        assert (third.status_code, third.headers['retry-after'], third.json()['detail']) == (
            429, '60', 'this account has 2 async recognition requests unfinished; send more once one has finished')
        assert _send(client, headers=BOB).status_code == 202
        at_once = client.post('/api/recognize/pages', headers=ALICE,
                              files=[('files', ('a.png', SCANS['a.png'], 'image/png'))])
        assert at_once.status_code == 200

        _run(conn, first)
        assert _send(client).status_code == 202

    def test_the_cap_is_checked_when_it_is_sent_and_again_when_it_starts(self, conn, client, backend):
        recognize.set_cap(conn, 'alice', 1)
        request_id = _send(client).json()['id']
        recognize.record_usage(conn, 'alice', pages=1, lines=1, seconds=1.0)

        refused = _send(client)
        assert refused.status_code == 429
        assert refused.json()['detail'].startswith('this account has read its 1 lines for this month')

        _run(conn, request_id)
        failed = client.get(f'/api/recognize/{request_id}', headers=ALICE).json()
        assert (failed['status'], failed['error']) == ('error', refused.json()['detail'])
        assert backend.sent == []


class TestRun:
    def test_once_its_turn_comes_it_reads_in_batches_of_the_at_once_limit_and_answers_as_one_at_once_would(
            self, conn, client, backend, monkeypatch, tmp_path):
        monkeypatch.setattr('app.config.RECOGNIZE_MAX_PAGES', 2)
        names = ('a.png', 'b.png', 'c.png')
        request_id = _send(client, names, format='page').json()['id']

        _run(conn, request_id)

        assert backend.sent == [('lines', 1), ('lines', 1), ('ocr', 4), ('lines', 1), ('ocr', 2)]
        assert _usage(conn) == {'requests': 1, 'pages': 3, 'lines': 6}
        done = client.get(f'/api/recognize/{request_id}', headers=ALICE)
        assert done.status_code == 200
        answer = done.json()
        assert {key: answer.pop(key) for key in ('id', 'status', 'files', 'done')} == {
            'id': request_id, 'status': 'done', 'files': 3, 'done': 3}
        submitted, started, finished, expires = (_stamp(answer.pop(key)) for key in (
            'submitted_at', 'started_at', 'finished_at', 'expires_at'))
        assert submitted <= started <= finished
        assert expires - finished == timedelta(hours=24)
        assert [[(line['polygon'], line['text']) for line in page['lines']] for page in answer['pages']] == [
            [([[30, 20], [270, 20], [270, 40], [30, 40]], '240 wide, line 1'),
             ([[30, 100], [270, 100], [270, 120], [30, 120]], '240 wide, line 2')],
            [([[40, 20], [360, 20], [360, 40], [40, 40]], '320 wide, line 1'),
             ([[40, 100], [360, 100], [360, 120], [40, 120]], '320 wide, line 2')],
            [([[50, 20], [450, 20], [450, 40], [50, 40]], '400 wide, line 1'),
             ([[50, 100], [450, 100], [450, 120], [50, 120]], '400 wide, line 2')]]
        monkeypatch.setattr('app.config.RECOGNIZE_MAX_PAGES', 10)
        at_once = client.post('/api/recognize/pages', headers=ALICE, data={'format': 'page'},
                              files=[('files', (name, SCANS[name], 'image/png')) for name in names])
        assert [page['document'].count('<TextLine ') for page in answer['pages']] == [2, 2, 2]
        assert _undated(answer) == _undated(at_once.json())
        assert not (tmp_path / 'recognition' / request_id / 'files').exists()

    def test_line_images_sent_async_come_back_as_an_answer_at_once_gives_them(self, conn, client, backend,
                                                                              monkeypatch):
        monkeypatch.setattr('app.config.RECOGNIZE_MAX_LINES', 2)
        names = ('one.png', 'two.png', 'three.png')
        request_id = _send(client, names, 'lines').json()['id']

        _run(conn, request_id)

        assert backend.sent == [('ocr', 2), ('ocr', 1)]
        assert _usage(conn) == {'requests': 1, 'pages': 0, 'lines': 3}
        answer = client.get(f'/api/recognize/{request_id}', headers=ALICE).json()
        assert answer['lines'] == [
            {'id': 'one.png', 'text': '120 wide, line 1', 'confidence': READ_CONFIDENCE},
            {'id': 'two.png', 'text': '160 wide, line 2', 'confidence': READ_CONFIDENCE},
            {'id': 'three.png', 'text': '200 wide, line 3', 'confidence': READ_CONFIDENCE}]
        monkeypatch.setattr('app.config.RECOGNIZE_MAX_LINES', 10)
        at_once = client.post('/api/recognize/lines', headers=ALICE,
                              files=[('files', (name, LINE_IMAGES[name], 'image/png')) for name in names])
        assert {'models': answer['models'], 'lines': answer['lines']} == at_once.json()

    def test_kept_across_its_batches_the_pages_land_in_one_dataset_made_by_the_first(
            self, conn, client, backend, monkeypatch):
        monkeypatch.setattr('app.config.RECOGNIZE_MAX_PAGES', 2)
        request_id = _send(client, ('a.png', 'b.png', 'c.png'), keep='Volume').json()['id']

        _run(conn, request_id)

        kept = client.get(f'/api/recognize/{request_id}', headers=ALICE).json()['kept']
        assert kept == {'dataset': kept['dataset'], 'name': 'Volume', 'created': True, 'pages': 3, 'duplicates': []}
        assert [(r['filename'], r['lines']) for r in conn.execute(
            'SELECT p.filename, COUNT(l.id) lines FROM pages p JOIN elements e ON e.page_id = p.id '
            'JOIN lines l ON l.element_id = e.id WHERE p.job_id = ? GROUP BY p.id ORDER BY p.idx',
            (kept['dataset'],))] == [('a.png', 2), ('b.png', 2), ('c.png', 2)]

    def test_a_request_reading_when_the_backend_stops_resumes_after_its_last_finished_batch(
            self, conn, client, backend, monkeypatch):
        monkeypatch.setattr('app.config.RECOGNIZE_MAX_PAGES', 2)
        names = ('a.png', 'b.png', 'c.png')
        request_id = _send(client, names).json()['id']
        readings = iter([None, Crash()])

        def second_batch_crashes():
            if (crash := next(readings, None)) is not None:
                raise crash
        backend.before_reading = second_batch_crashes
        with pytest.raises(Crash):
            _run(conn, request_id)
        assert client.get(f'/api/recognize/{request_id}', headers=ALICE).json()['done'] == 2

        jobs.requeue_interrupted(conn)
        assert jobs._next_work(conn) == ('recognition', request_id)
        backend.sent.clear()
        _run(conn, request_id)

        assert backend.sent == [('lines', 1), ('ocr', 2)]
        assert _usage(conn) == {'requests': 1, 'pages': 3, 'lines': 6}
        answer = client.get(f'/api/recognize/{request_id}', headers=ALICE).json()
        assert [page['id'] for page in answer['pages']] == list(names)
        assert [line['text'] for line in answer['pages'][2]['lines']] == ['400 wide, line 1', '400 wide, line 2']


class TestFetchAndDelete:
    def test_only_its_owner_can_fetch_it_and_its_owner_or_an_admin_delete_it(self, conn, client, backend):
        request_id = _send(client).json()['id']

        for method in ('get', 'delete'):
            other = getattr(client, method)(f'/api/recognize/{request_id}', headers=BOB)
            assert (other.status_code, other.json()['detail']) == (404, 'no recognition request of yours has this id')
        assert client.get(f'/api/recognize/{request_id}', headers=DEV).status_code == 404
        assert client.delete(f'/api/recognize/{request_id}', headers=DEV).status_code == 204
        assert client.get(f'/api/recognize/{request_id}', headers=ALICE).status_code == 404

    def test_deleting_a_waiting_request_takes_it_off_the_queue_and_the_disk(self, conn, client, backend, tmp_path):
        request_id = _send(client).json()['id']
        assert (tmp_path / 'recognition' / request_id / 'files').is_dir()

        assert client.delete(f'/api/recognize/{request_id}', headers=ALICE).status_code == 204

        assert jobs._next_work(conn) is None
        assert not (tmp_path / 'recognition' / request_id).exists()
        assert client.get(f'/api/recognize/{request_id}', headers=ALICE).status_code == 404

    def test_deleting_a_request_while_it_reads_stops_it_after_the_batch_it_is_on(
            self, conn, client, backend, monkeypatch, tmp_path):
        monkeypatch.setattr('app.config.RECOGNIZE_MAX_PAGES', 2)
        request_id = _send(client, ('a.png', 'b.png', 'c.png')).json()['id']
        deleted = []
        backend.before_reading = lambda: deleted.append(
            client.delete(f'/api/recognize/{request_id}', headers=ALICE).status_code)

        _run(conn, request_id)

        assert deleted == [204]
        assert backend.sent == [('lines', 1), ('lines', 1), ('ocr', 4)]
        assert _usage(conn) == {'requests': 1, 'pages': 2, 'lines': 4}
        assert not (tmp_path / 'recognition' / request_id).exists()
        assert client.get(f'/api/recognize/{request_id}', headers=ALICE).status_code == 404

    def test_on_start_a_request_cancelled_while_it_read_and_the_files_of_a_cut_short_upload_are_let_go(
            self, conn, client, backend, tmp_path):
        from app import recognize_async
        kept = _send(client).json()['id']
        cancelled = _send(client).json()['id']
        conn.execute("UPDATE recognition_requests SET status = 'cancelled' WHERE id = ?", (cancelled,))
        conn.commit()
        (tmp_path / 'recognition' / 'cut0short000' / 'files').mkdir(parents=True)

        jobs.requeue_interrupted(conn)

        assert [row['id'] for row in conn.execute('SELECT id FROM recognition_requests')] == [kept]
        assert sorted(folder.name for folder in (tmp_path / 'recognition').iterdir()) == [kept]
        assert recognize_async.listed(conn, 'alice')[0]['status'] == 'queued'

    def test_a_result_is_deleted_a_day_after_it_finished_and_fetching_it_does_not(
            self, conn, client, backend, tmp_path):
        from app import recognize_async
        request_id = _send(client).json()['id']
        _run(conn, request_id)
        finished = _stamp(client.get(f'/api/recognize/{request_id}', headers=ALICE).json()['finished_at'])

        recognize_async.sweep(conn, finished + timedelta(hours=23, minutes=59))
        assert client.get(f'/api/recognize/{request_id}', headers=ALICE).status_code == 200

        recognize_async.sweep(conn, finished + timedelta(hours=24, minutes=1))
        assert client.get(f'/api/recognize/{request_id}', headers=ALICE).status_code == 404
        assert not (tmp_path / 'recognition' / request_id).exists()


class TestSeen:
    def test_the_queue_lists_it_in_its_place_and_names_its_owner_to_no_one_else(self, conn, client, backend):
        _queue_dataset(conn, 'j0', 'running')
        _queue_dataset(conn, 'j1')
        request_id = _send(client).json()['id']

        def listed(headers):
            entry = client.get('/api/queue', headers=headers).json()['gpu']['queued'][1]
            return {key: entry[key] for key in ('kind', 'id', 'name', 'owner', 'status', 'started_at', 'recognition')}
        expected = {'kind': 'recognition', 'id': request_id, 'name': 'Recognition request', 'owner': 'alice',
                    'status': 'queued', 'started_at': None, 'recognition': {'route': 'pages', 'files': 2, 'done': 0}}
        assert listed(ALICE) == expected
        assert listed(BOB) == {**expected, 'owner': ''}
        assert listed(DEV) == {**expected, 'owner': ''}

    def test_a_waiting_request_is_expected_to_take_as_long_per_file_as_the_last_ones_did(self, conn, client, backend):
        _queue_dataset(conn, 'j0', 'running')
        earlier = _send(client).json()['id']
        conn.execute("UPDATE recognition_requests SET status = 'done', started_at = '2026-11-01 10:00:00', "
                     "finished_at = '2026-11-01 10:00:40' WHERE id = ?", (earlier,))
        conn.commit()
        waiting = _send(client, ('a.png', 'b.png', 'c.png')).json()['id']

        entry = next(e for e in client.get('/api/queue', headers=ALICE).json()['gpu']['queued'] if e['id'] == waiting)
        assert entry['eta'] == {'seconds': 60, 'basis': 'history'}

    def test_the_offer_lists_the_callers_async_requests_and_the_async_limits(self, conn, client, backend):
        first = _send(client).json()['id']
        _send(client, headers=BOB)
        second = _send(client, ('one.png',), 'lines').json()['id']
        _run(conn, first)

        offer = client.get('/api/recognize', headers=ALICE).json()
        assert offer['limits'] == {'pages': 10, 'lines': 500, 'megabytes': 100,
                                   'async': {'pages': 1000, 'lines': 20000, 'megabytes': 2048, 'unfinished': 5,
                                             'kept_hours': 24}}
        assert [(r['id'], r['status'], r['files'], r['done']) for r in offer['requests']] == [
            (second, 'queued', 1, 0), (first, 'done', 2, 2)]
