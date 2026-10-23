"""The area-detect endpoint: what the detector returns has to arrive as regions that look
like machine output, and everything that can go wrong on the way has to say so rather than
500.

The detector itself needs OpenCV, which this venv does not have — so these drive a stub CLI
written into tmp_path and run by this same interpreter. That is exactly how the route talks
to the real one (PYTHONPATH + `-m detect.cli`), so the contract under test is the real
contract; only the pixels are fake.
"""
import json
import sys
import textwrap
import threading
from email.parser import BytesParser
from email.policy import default
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app import config, store
from app.deps import get_db
from app.main import app
from app.routes import maps

SECRET = 'test-secret'
HEADERS = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'alice', 'X-Auth-Role': 'member'}
LINES = [[[0.2, 0.2], [0.4, 0.45]], [[0.5, 0.5], [0.6, 0.6], [0.7, 0.55]]]
AREA = [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]]

STUB = """
import argparse, json, sys
p = argparse.ArgumentParser()
for flag in ('--image', '--area', '--method', '--params', '--checkpoint'):
    p.add_argument(flag)
args = p.parse_args()
{body}
"""


def write_stub(root, body: str):
    """A fake detect.cli that this interpreter can run — no OpenCV involved."""
    pkg = root / 'detect'
    pkg.mkdir(parents=True, exist_ok=True)
    (pkg / '__init__.py').write_text('', encoding='utf-8')
    (pkg / 'cli.py').write_text(textwrap.dedent(STUB.format(body=body)), encoding='utf-8')


@pytest.fixture
def env(tmp_path, monkeypatch):
    """A line-tracing job with one tile, and a configured edge detector."""
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    root = tmp_path / 'edge_repo'
    write_stub(root, f'print(json.dumps({{"polylines": {json.dumps(LINES)}}}))')
    registry = tmp_path / 'edge' / 'registry.json'
    registry.parent.mkdir()
    registry.write_text(json.dumps({'methods': [
        {'id': 'centreline', 'label': 'Ink centreline',
         'params': {'block_size': {'default': 21}}}]}), encoding='utf-8')
    monkeypatch.setattr('app.config.EDGE_DETECT_ROOT', root)
    monkeypatch.setattr('app.config.EDGE_DETECT_PYTHON', __import__('pathlib').Path(sys.executable))
    monkeypatch.setattr('app.config.EDGE_REGISTRY', registry)

    tile_png = tmp_path / 'tile.png'
    tile_png.write_bytes(b'not really a png, the stub never opens it')

    conn = store.connect(tmp_path / 'app.db')
    conn.execute("INSERT INTO jobs (id, name, owner, task, status) "
                 "VALUES ('lines', 'traces', 'alice', 'map_lines', 'done')")
    store.seed_job_classes(conn, 'lines', [
        {'id': 0, 'name': 'background', 'color': [0, 0, 0], 'priority': 1},
        {'id': 1, 'name': 'edge lines', 'color': [255, 200, 0], 'priority': 0},
    ])
    tile = conn.execute(
        "INSERT INTO pages (job_id, idx, filename, source_file, status, width, height) "
        "VALUES ('lines', 0, 't.png', ?, 'done', 512, 512)", (str(tile_png),)).lastrowid
    conn.commit()
    app.dependency_overrides[get_db] = lambda: conn
    yield TestClient(app), conn, tile, root
    app.dependency_overrides.clear()
    conn.close()


def detect(client, tile, **over):
    body = {'method': 'centreline', 'area': AREA, 'class_id': 1, **over}
    return client.post(f'/api/pages/{tile}/regions/detect', json=body, headers=HEADERS)


def test_detected_lines_become_polyline_regions(env):
    client, conn, tile, _ = env
    res = detect(client, tile)
    assert res.status_code == 200
    regions = res.json()['regions']
    assert [r['points'] for r in regions] == LINES
    assert all(r['kind'] == 'polyline' and r['holes'] == [] for r in regions)


def test_detections_arrive_unreviewed(env):
    """checked=0, unlike a hand-drawn region — they are proposals until someone looks."""
    client, conn, tile, _ = env
    assert all(r['checked'] is False for r in detect(client, tile).json()['regions'])


def test_detections_are_authored_as_model_output(env):
    client, conn, tile, _ = env
    ids = [r['id'] for r in detect(client, tile).json()['regions']]
    authors = [conn.execute(
        "SELECT author FROM revisions WHERE target_type = 'region' AND target_id = ?",
        (rid,)).fetchone()['author'] for rid in ids]
    assert authors == ['model:edge@centreline'] * len(ids)


def test_untouched_detections_are_discardable_by_a_repredict(env):
    """The `model:` prefix is what makes the re-predict scope treat them as machine work."""
    client, conn, tile, _ = env
    detect(client, tile)
    scope = maps._repredict_scope(conn, 'lines', force=False)
    assert (scope['regions_discard'], scope['regions_kept']) == (len(LINES), 0)


def test_regions_are_appended_after_existing_ones(env):
    client, conn, tile, _ = env
    conn.execute('INSERT INTO regions (page_id, order_idx, class_id, points, holes, kind) '
                 "VALUES (?, 7, 1, '[[0,0],[0.1,0.1]]', '[]', 'polyline')", (tile,))
    conn.commit()
    assert [r['order_idx'] for r in detect(client, tile).json()['regions']] == [8, 9]


def test_finding_nothing_is_a_success(env, tmp_path):
    client, conn, tile, root = env
    write_stub(root, 'print(json.dumps({"polylines": []}))')
    res = detect(client, tile)
    assert res.status_code == 200 and res.json() == {'regions': [], 'span': {'from': 0, 'to': 0}}


def test_malformed_lines_are_skipped_not_fatal(env):
    client, conn, tile, root = env
    write_stub(root, 'print(json.dumps({"polylines": ['
                     '[[0.1,0.1]],'                      # too short
                     '[[0.2,0.2],[2.0,0.3]],'            # out of range
                     '[[0.3,0.3],[0.4,0.4]]]}))')        # the only usable one
    regions = detect(client, tile).json()['regions']
    assert [r['points'] for r in regions] == [[[0.3, 0.3], [0.4, 0.4]]]


def test_the_area_and_method_reach_the_cli(env):
    """Guards the argv contract: a rename on either side has to fail here."""
    client, conn, tile, root = env
    write_stub(root, 'print(json.dumps({"polylines": [[[0.0,0.0],'
                     '[len(json.loads(args.area)) / 10, 0.0]]], "method": args.method}))')
    regions = detect(client, tile).json()['regions']
    assert regions[0]['points'][1][0] == pytest.approx(0.4)  # the 4-corner ring arrived


def test_default_params_reach_the_cli(env):
    client, conn, tile, root = env
    write_stub(root, 'v = json.loads(args.params)["block_size"] / 100\n'
                     'print(json.dumps({"polylines": [[[0.0, 0.0], [v, v]]]}))')
    assert detect(client, tile).json()['regions'][0]['points'][1] == [0.21, 0.21]


def test_an_unconfigured_server_says_so(env, monkeypatch):
    client, conn, tile, _ = env
    monkeypatch.setattr('app.config.EDGE_DETECT_PYTHON', None)
    res = detect(client, tile)
    assert res.status_code == 503 and 'EDGE_DETECT_PYTHON' in res.json()['detail']


def test_a_missing_repo_says_so(env, monkeypatch, tmp_path):
    client, conn, tile, _ = env
    monkeypatch.setattr('app.config.EDGE_DETECT_ROOT', tmp_path / 'gone')
    res = detect(client, tile)
    assert res.status_code == 503 and 'EDGE_DETECT_ROOT' in res.json()['detail']


def test_an_unknown_method_is_rejected(env):
    client, conn, tile, _ = env
    res = detect(client, tile, method='pidinet')
    assert res.status_code == 400 and 'centreline' in res.json()['detail']


def test_a_crashing_detector_surfaces_its_message(env):
    client, conn, tile, root = env
    write_stub(root, 'print("boom: no model", file=sys.stderr); sys.exit(1)')
    res = detect(client, tile)
    assert res.status_code == 502 and 'boom: no model' in res.json()['detail']


def test_garbage_on_stdout_is_rejected(env):
    client, conn, tile, root = env
    write_stub(root, 'print("this is not json")')
    assert detect(client, tile).status_code == 502


def test_a_polygon_job_cannot_detect(env, conn=None):
    client, conn, tile, _ = env
    conn.execute("UPDATE jobs SET task = 'map_segmentation' WHERE id = 'lines'")
    conn.commit()
    res = detect(client, tile)
    assert res.status_code == 400 and 'line-tracing' in res.json()['detail']


def test_a_class_from_another_palette_is_rejected(env):
    client, conn, tile, _ = env
    assert detect(client, tile, class_id=99).status_code == 400


def test_an_area_that_is_not_a_ring_is_rejected(env):
    client, conn, tile, _ = env
    assert detect(client, tile, area=[[0.1, 0.1], [0.5, 0.5]]).status_code == 400


def test_a_missing_tile_image_is_reported(env, tmp_path):
    client, conn, tile, _ = env
    conn.execute('UPDATE pages SET source_file = ? WHERE id = ?', (str(tmp_path / 'gone.png'), tile))
    conn.commit()
    res = detect(client, tile)
    assert res.status_code == 409 and 'tile image' in res.json()['detail']


def test_a_viewer_cannot_detect(env):
    client, conn, tile, _ = env
    res = client.post(f'/api/pages/{tile}/regions/detect',
                      json={'method': 'centreline', 'area': AREA, 'class_id': 1},
                      headers={**HEADERS, 'X-Auth-Role': 'viewer'})
    assert res.status_code == 403


class EdgesBackend(BaseHTTPRequestHandler):
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
        self.answer({'contract': '1.0', 'tasks': ['edges'], 'weights': {'builtin': True}, 'tasks_detail': {
            'edges': {'methods': [{'id': 'ridges', 'label': 'Ridge filter', 'needs_weights': False,
                                   'params': {'sigma': {'type': 'number', 'default': 1.5}}}]}}})

    def do_POST(self):
        body = self.rfile.read(int(self.headers['Content-Length']))
        message = BytesParser(policy=default).parsebytes(
            f'Content-Type: {self.headers["Content-Type"]}\r\n\r\n'.encode() + body)
        request = json.loads(next(message.iter_parts()).get_content())
        EdgesBackend.asked.append(request['params'])
        self.answer({'results': [{'id': request['items'][0]['id'], 'polylines': LINES + [[[2, 2], [3, 3]]]}]})


@pytest.fixture
def backend(env, tmp_path, monkeypatch):
    EdgesBackend.asked = []
    server = ThreadingHTTPServer(('127.0.0.1', 0), EdgesBackend)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    monkeypatch.setattr('app.config.MODEL_BACKENDS', {
        'edges': config.ModelBackend('edges', f'http://127.0.0.1:{server.server_port}', 's', 'default')})
    # Nothing local to fall back on: the backend is the detector.
    monkeypatch.setattr('app.config.EDGE_DETECT_PYTHON', None)
    _client, conn, tile, _root = env
    Image.new('RGB', (64, 64), 'white').save(conn.execute('SELECT source_file FROM pages WHERE id = ?',
                                                         (tile,)).fetchone()[0], format='PNG')
    yield env
    server.shutdown()


def test_an_edges_backend_offers_its_own_methods_and_detects_with_them(backend):
    client, conn, tile, _root = backend

    listed = client.get('/api/edge-methods', headers=HEADERS).json()
    assert listed == {'configured': True, 'methods': [
        {'id': 'ridges', 'label': 'Ridge filter', 'params': {'sigma': {'type': 'number', 'default': 1.5}},
         'available': True}]}

    response = detect(client, tile, method='ridges')

    assert response.status_code == 200, response.text
    # The out-of-range line costs only itself.
    assert [r['points'] for r in response.json()['regions']] == LINES
    assert EdgesBackend.asked == [{'method': 'ridges', 'area': AREA, 'method_params': {'sigma': 1.5}}]
    assert detect(client, tile, method='centreline').status_code == 400
