"""A map model on its model backend: tiles ingested and pre-annotated by DeepLabel's own
interpreter, the backend doing the windowing and the polygonising (4.6)."""
import json
import threading
from email.parser import BytesParser
from email.policy import default
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from PIL import Image

from app import config, jobs, map_job, map_ingest, store

SQUARE = [[0.1, 0.1], [0.5, 0.1], [0.5, 0.5], [0.1, 0.5]]
HOLE = [[0.2, 0.2], [0.3, 0.2], [0.3, 0.3], [0.2, 0.3]]
# Running along the tile's top edge, which line tracing drops as the cut, not a boundary.
ON_THE_CUT = [[0.0, 0.0], [1.0, 0.0], [1.0, 0.3], [0.0, 0.3]]


class Backend(BaseHTTPRequestHandler):
    asked: list = []

    def log_message(self, *args):
        pass

    def answer(self, body: dict):
        data = json.dumps(body).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == '/v1/info':
            return self.answer({'contract': '1.0', 'tasks': ['map_segmentation'], 'weights': {'builtin': True},
                                'tasks_detail': {'map_segmentation': {'batch': {'max_items': 1}}}})
        self.answer({'state': 'loaded', 'facts': {}})

    def do_POST(self):
        body = self.rfile.read(int(self.headers['Content-Length']))
        message = BytesParser(policy=default).parsebytes(
            f'Content-Type: {self.headers["Content-Type"]}\r\n\r\n'.encode() + body)
        request = json.loads(next(message.iter_parts()).get_content())
        Backend.asked.append(request['params'])
        self.answer({'results': [{'id': item['id'], 'regions': [
            {'class_id': 2, 'points': SQUARE, 'holes': [HOLE]},
            {'class_id': 3, 'points': ON_THE_CUT, 'holes': []}]} for item in request['items']]})


@pytest.fixture
def conn(tmp_path, monkeypatch):
    Backend.asked = []
    server = ThreadingHTTPServer(('127.0.0.1', 0), Backend)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    monkeypatch.setattr(config, 'MODEL_BACKENDS', {
        'stub': config.ModelBackend('stub', f'http://127.0.0.1:{server.server_port}', 's', 'default')})
    monkeypatch.setattr('app.config.JOBS_DIR', tmp_path / 'jobs')
    connection = store.connect(tmp_path / 'app.db')
    connection.executescript("""
        INSERT INTO models (id, task, name, checkpoint, ref, backend)
            VALUES (7, 'map_segmentation', 'Cadastre UPerNet', '/m.pth', 'cadastre', 'stub');
        INSERT INTO jobs (id, name, owner, status, task, model_id, run_predict)
            VALUES ('m1', 'Kataster', 'alice', 'running', 'map_segmentation', 'cadastre', 1);
    """)
    for i, shade in enumerate(('white', 'gray')):
        tile = tmp_path / f'tile{i}.png'
        Image.new('RGB', (512, 512), shade).save(tile)
        connection.execute("INSERT INTO pages (job_id, idx, filename, source_file, status) "
                           "VALUES ('m1', ?, ?, ?, 'pending')", (i, tile.name, str(tile)))
    connection.commit()
    yield connection
    connection.close()
    server.shutdown()


def regions(conn):
    return [(r['class_id'], json.loads(r['points']), json.loads(r['holes']), r['kind'])
            for r in conn.execute('SELECT * FROM regions WHERE page_id = 1 ORDER BY order_idx')]


def predict(conn, tmp_path, **kwargs):
    map_ingest.ingest_map_job(conn, 'm1', tmp_path, final_status='ingested')
    client, model_id = map_job.served_model(conn, store.get_job(conn, 'm1'))
    map_job.phase_predict(conn, 'm1', client, model_id, [2, 3], 2.0, 12, **kwargs)


def test_every_tile_is_pre_annotated_with_what_the_backend_found(conn, tmp_path):
    predict(conn, tmp_path)

    assert regions(conn) == [(2, SQUARE, [HOLE], 'polygon'), (3, ON_THE_CUT, [], 'polygon')]
    assert Backend.asked == [{'class_ids': [2, 3], 'epsilon': 2.0, 'min_area': 12}] * 2
    assert [r['status'] for r in conn.execute('SELECT status FROM pages ORDER BY idx')] == ['done', 'done']
    assert store.get_job(conn, 'm1')['counters']['pages_predicted'] == 2
    author = conn.execute("SELECT DISTINCT author FROM revisions WHERE target_type = 'region'").fetchone()[0]
    assert author == 'model:mapseg@Cadastre UPerNet'


def test_a_line_job_keeps_the_outlines_on_its_one_class_and_drops_the_cut(conn, tmp_path):
    predict(conn, tmp_path, region_kind='polyline', merge_class_id=9)

    kept = regions(conn)
    assert {class_id for class_id, *_ in kept} == {9}
    assert {kind for *_, kind in kept} == {'polyline'}
    # The square's outline and its hole's, closed; of the strip, which lies along the cut on
    # three sides, only its bottom edge.
    assert [points for _, points, _, _ in kept] == [SQUARE + SQUARE[:1], HOLE + HOLE[:1], [[1.0, 0.3], [0.0, 0.3]]]


def test_a_model_not_on_a_backend_is_not_served(conn):
    conn.execute('UPDATE models SET backend = NULL')
    conn.commit()
    assert map_job.served_model(conn, store.get_job(conn, 'm1')) is None
    conn.executescript("UPDATE models SET backend = 'stub'; UPDATE jobs SET model_id = NULL")
    conn.commit()
    assert map_job.served_model(conn, store.get_job(conn, 'm1')) is None


class Spawned:
    def __init__(self, args, **kwargs):
        self.args, self.pid, self.returncode = args, 1, 0

    def wait(self):
        return 0


def test_the_worker_needs_no_map_venv_for_a_served_model_with_nothing_to_cut(conn, monkeypatch, tmp_path):
    spawned = []
    monkeypatch.setattr('app.jobs.subprocess.Popen', lambda args, **kw: spawned.append(Spawned(args)) or spawned[-1])
    monkeypatch.setattr('app.config.DB_PATH', tmp_path / 'app.db')
    monkeypatch.setattr('app.config.MAPSEG_PYTHON', None)
    monkeypatch.setattr('app.model_registry.get_model', lambda ref: {'id': ref, 'checkpoint': 'cadastre.pth', 'classes': [
        {'id': 0, 'name': 'background'}, {'id': 2, 'name': 'Parcel'}, {'id': 3, 'name': 'Road'}]})
    config.job_dir('m1').mkdir(parents=True, exist_ok=True)

    jobs._run_work(conn, 'job', 'm1')

    assert spawned[0].args[1:3] == ['-m', 'app.map_job']
    assert store.get_job(conn, 'm1')['error'] is None

    # Cutting maps into tiles still needs the map venv, which is not there.
    conn.execute("UPDATE jobs SET run_tile = 1, status = 'queued'")
    conn.commit()
    jobs._run_work(conn, 'job', 'm1')
    assert 'MAPSEG_PYTHON is not set' in store.get_job(conn, 'm1')['error']
