"""A text job whose models are all on a model backend, run by DeepLabel's own interpreter:
ingest, layout, lines and OCR against a backend served from the test, with no model code."""
import json
import sys
import threading
from email.parser import BytesParser
from email.policy import default
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from PIL import Image

from app import backend_client, config, jobs, layout_templates, registry, store, text_job

SECRET = 'backend-secret'
# Deliberately out of reading order, and with a container: ordering and nesting are
# DeepLabel's, not the backend's.
DETECTIONS = [
    {'label': 'Paragraph', 'bbox': [0.1, 0.4, 0.9, 0.9], 'confidence': 0.8},
    {'label': 'Column', 'bbox': [0.05, 0.05, 0.95, 0.95], 'confidence': 0.7},
    {'label': 'PageNumber', 'bbox': [0.1, 0.1, 0.3, 0.2], 'confidence': 0.95},
]
# A crop's rows: the first split in two by a gap, which DeepLabel joins back into one.
CROP_LINES = [
    [[0.0, 0.1], [0.4, 0.1], [0.4, 0.3], [0.0, 0.3]],
    [[0.6, 0.1], [1.0, 0.1], [1.0, 0.3], [0.6, 0.3]],
    [[0.0, 0.6], [1.0, 0.6], [1.0, 0.8], [0.0, 0.8]],
]
PAGE_LINES = [
    [[0.2, 0.5], [0.8, 0.5], [0.8, 0.55], [0.2, 0.55]],
    [[0.2, 0.96], [0.8, 0.96], [0.8, 0.99], [0.2, 0.99]],
]


class Backend(BaseHTTPRequestHandler):
    calls: list = []

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
            return self.answer({'contract': '1.0', 'tasks': ['layout', 'lines', 'ocr'], 'weights': {'builtin': True},
                                'max_request_mb': 64,
                                'tasks_detail': {'lines': {'batch': {'max_items': 2}},
                                                 'layout': {'labels': ['Paragraph', 'Column', 'PageNumber']}}})
        self.answer({'state': 'loaded', 'facts': {}})

    def do_POST(self):
        body = self.rfile.read(int(self.headers['Content-Length']))
        message = BytesParser(policy=default).parsebytes(
            f'Content-Type: {self.headers["Content-Type"]}\r\n\r\n'.encode() + body)
        parts = {part.get_param('name', header='content-disposition'): part for part in message.iter_parts()}
        request = json.loads(parts['request'].get_content())
        task = self.path.rsplit('/', 1)[-1]
        Backend.calls.append((task, request['params'], [parts[i['image']].get_content_type()
                                                         for i in request['items']]))
        if task == 'layout':
            results = [{'id': i['id'], 'detections': DETECTIONS} for i in request['items']]
        elif task == 'lines':
            found = CROP_LINES if request['params']['scope'] == 'crop' else PAGE_LINES
            results = [{'id': i['id'], 'lines': [{'polygon': p, 'confidence': None} for p in found]}
                       for i in request['items']]
        else:
            results = [{'id': i['id'], 'text': f" {i['context']['element_class']} {i['context']['line_index']} ",
                        'confidence': 0.9, 'conf_profile': None} for i in request['items']]
        self.answer({'decode': 'beam', 'conventions': [], 'results': results})


@pytest.fixture
def backend(monkeypatch):
    Backend.calls = []
    server = ThreadingHTTPServer(('127.0.0.1', 0), Backend)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    monkeypatch.setattr(config, 'MODEL_BACKENDS', {
        'stub': config.ModelBackend('stub', f'http://127.0.0.1:{server.server_port}', SECRET, 'default')})
    yield
    server.shutdown()


@pytest.fixture
def conn(tmp_path, monkeypatch):
    monkeypatch.setattr('app.config.LINE_CROP_MASK', False)
    monkeypatch.setattr('app.config.BLOBS_DIR', tmp_path / 'blobs')
    monkeypatch.setattr('app.config.JOBS_DIR', tmp_path / 'jobs')
    scan = tmp_path / 'scan.jpg'
    Image.new('RGB', (400, 600), 'white').save(scan)
    connection = store.connect(tmp_path / 'app.db')
    connection.executescript(f"""
        INSERT INTO models (id, task, name, checkpoint, backend, is_default) VALUES
            (1, 'layout', 'RF-DETR served', '/l.pt', 'stub', 1),
            (2, 'lines', 'DB served', '/d.pt', 'stub', 1),
            (3, 'ocr', 'DeepOCR served', '/o.ckpt', 'stub', 1);
        INSERT INTO jobs (id, name, owner, status, task) VALUES ('j1', 'Volume', 'alice', 'running', 'text');
        INSERT INTO pages (id, job_id, idx, filename, source_file, status)
            VALUES (1, 'j1', 0, 'scan.jpg', '{scan}', 'pending');
    """)
    connection.commit()
    for task, model_id in (('layout', 1), ('lines', 2), ('ocr', 3)):
        monkeypatch.setenv(registry.MODEL_ID_ENV[task], str(model_id))
    yield connection
    connection.close()


def run(conn, tmp_path):
    text_job.run(conn, 'j1', tmp_path / 'jobs' / 'j1', layout_batch_size=4, ocr_chunk_lines=512)


def elements(conn):
    return [tuple(r) for r in conn.execute(
        'SELECT class_name, raw_class_name, kind, order_idx FROM elements WHERE deleted = 0 ORDER BY kind, order_idx')]


def lines_of(conn, class_name):
    return [(json.loads(r['polygon']), r['text']) for r in conn.execute(
        'SELECT l.polygon, l.text FROM lines l JOIN elements e ON l.element_id = e.id '
        'WHERE e.class_name = ? AND l.deleted = 0 ORDER BY l.order_idx', (class_name,))]


def test_a_job_whose_models_are_all_on_backends_runs_every_stage_there(conn, backend, tmp_path):
    run(conn, tmp_path)

    # Layout: the backend's labels mapped, its container told apart, the page number read
    # first by DeepLabel's own reading order.
    assert elements(conn) == [('Column', 'Column', 'container', 0),
                              ('Pagenumber', 'PageNumber', 'content', 0), ('Paragraph', 'Paragraph', 'content', 1)]
    # Lines: crops of the content boxes, the page number's box taken whole, the split row joined.
    paragraph = lines_of(conn, 'Paragraph')
    assert [p for p, _ in paragraph] == [
        [[0.1, 0.45], [0.9, 0.45], [0.9, 0.55], [0.1, 0.55]],
        [[0.1, 0.7], [0.9, 0.7], [0.9, 0.8], [0.1, 0.8]],
    ]
    assert lines_of(conn, 'Pagenumber') == [([[0.1, 0.1], [0.3, 0.1], [0.3, 0.2], [0.1, 0.2]], 'Pagenumber 0')]
    # OCR: each crop sent with its element and place, the text stripped.
    assert [t for _, t in paragraph] == ['Paragraph 0', 'Paragraph 1']

    tasks = [(task, params) for task, params, _ in Backend.calls]
    assert tasks == [('layout', {}), ('lines', {'scope': 'crop'}), ('ocr', {'decode': 'beam', 'convention': {}})]
    # The JPEG scan goes to layout as its own bytes; the crops as PNG.
    assert Backend.calls[0][2] == ['image/jpeg']
    assert Backend.calls[1][2] == ['image/png']
    job = conn.execute('SELECT status, phase FROM jobs').fetchone()
    assert tuple(job) == ('done', None)
    page = conn.execute('SELECT status, layout_model_id, lines_model_id FROM pages').fetchone()
    assert tuple(page) == ('done', 1, 2)
    authors = {r[0] for r in conn.execute('SELECT DISTINCT author FROM revisions')}
    assert {'model:layout@RF-DETR served', 'model:lines@DB served'} <= authors


def test_whole_page_detection_routes_lines_to_their_box_and_keeps_the_rest(conn, backend, tmp_path):
    conn.execute("UPDATE jobs SET line_mode = 'per_page'")
    conn.commit()

    run(conn, tmp_path)

    assert [p for p, _ in lines_of(conn, 'Paragraph')] == [PAGE_LINES[0]]
    # Below every box: an unassigned bucket, read like any other line.
    assert lines_of(conn, 'Unassigned') == [(PAGE_LINES[1], 'Unassigned 0')]
    assert ('lines', {'scope': 'page'}) in [(task, params) for task, params, _ in Backend.calls]


def test_a_stage_whose_model_is_on_no_backend_fails_the_job_saying_so(conn, backend, tmp_path):
    conn.execute("UPDATE models SET backend = NULL WHERE id = 2")
    conn.commit()

    with pytest.raises(RuntimeError):
        run(conn, tmp_path)

    assert store.get_job(conn, 'j1')['error'] == 'RuntimeError: the lines model (2) is not on a configured model backend'


def test_a_job_that_runs_no_model_ingests_and_finishes(conn, backend, tmp_path):
    conn.execute('UPDATE jobs SET run_layout = 0, run_lines = 0, run_ocr = 0')
    conn.commit()

    run(conn, tmp_path)

    assert store.get_job(conn, 'j1')['status'] == 'done'
    assert conn.execute('SELECT status FROM pages WHERE id = 1').fetchone()['status'] == 'layout_done'
    assert Backend.calls == []


def test_lines_a_dataset_brought_along_are_counted_when_nothing_reads_them(conn, backend, tmp_path):
    """An imported export arrives with its lines and runs no model at all."""
    conn.executescript("""
        UPDATE jobs SET run_layout = 0, run_lines = 0, run_ocr = 0;
        INSERT INTO elements (id, page_id, order_idx, class_name, bbox, kind)
            VALUES (1, 1, 0, 'Paragraph', '[0.1,0.1,0.9,0.9]', 'content');
        INSERT INTO lines (element_id, order_idx, polygon, text, checked) VALUES
            (1, 0, '[[0.1,0.1],[0.9,0.1],[0.9,0.2],[0.1,0.2]]', 'Pfarre Wien', 1),
            (1, 1, '[[0.1,0.3],[0.9,0.3],[0.9,0.4],[0.1,0.4]]', 'Kaplan Huber', 1);
    """)

    run(conn, tmp_path)

    counters = store.get_job(conn, 'j1')['counters']
    assert (counters['lines_total'], counters['lines_ocr_done'], counters['elements_total']) == (2, 2, 1)


class Spawned:
    def __init__(self, args, **kwargs):
        self.args, self.env, self.cwd = args, kwargs['env'], kwargs['cwd']


def test_the_worker_runs_a_text_job_under_the_apps_interpreter(conn, backend, monkeypatch):
    monkeypatch.setattr('app.jobs.subprocess.Popen', Spawned)
    monkeypatch.setattr('app.config.DB_PATH', conn.execute('PRAGMA database_list').fetchone()[2])
    config.job_dir('j1').mkdir(parents=True, exist_ok=True)
    conn.execute("UPDATE models SET backend = NULL WHERE id = 3")
    conn.commit()

    spawned = jobs._spawn_runner(conn, 'j1')

    assert spawned.args[:3] == [sys.executable, '-m', 'app.text_job']
    assert spawned.env['PYTHONPATH'] == str(jobs.BACKEND_DIR)
    assert (spawned.env['LAYOUT_MODEL_ID'], spawned.env['LINES_MODEL_ID'], spawned.env['OCR_MODEL_ID']) == ('1', '2', '3')


def test_the_layout_backend_is_sent_the_scaled_page_when_it_was_scaled(conn, backend, tmp_path, monkeypatch):
    monkeypatch.setattr(text_job, 'MAX_LAYOUT_HEIGHT', 300)

    run(conn, tmp_path)

    assert Backend.calls[0][2] == ['image/png']
    assert backend_client.client_for(conn, 1) is not None


def test_a_polygon_element_keeps_only_the_lines_inside_its_outline(conn, backend, tmp_path):
    conn.executescript("""
        UPDATE jobs SET layout_shape = 'polygon', run_layout = 0, run_ocr = 0;
        UPDATE pages SET status = 'done', width = 400, height = 600, content_hash = 'h';
        INSERT INTO elements (id, page_id, order_idx, class_name, bbox, kind, polygon)
            VALUES (1, 1, 0, 'Paragraph', '[0.1,0.4,0.9,0.9]', 'content', '[[0.1,0.4],[0.9,0.4],[0.1,0.9]]');
    """)
    conn.commit()

    run(conn, tmp_path)

    # The first row's centre is inside the triangle, the second's beyond its long side.
    assert [p for p, _ in lines_of(conn, 'Paragraph')] == [[[0.1, 0.45], [0.9, 0.45], [0.9, 0.55], [0.1, 0.55]]]


def test_a_box_dataset_reads_an_element_by_its_box_though_it_keeps_an_outline(conn, backend, tmp_path):
    conn.executescript("""
        UPDATE jobs SET run_layout = 0, run_ocr = 0;
        UPDATE pages SET status = 'done', width = 400, height = 600, content_hash = 'h';
        INSERT INTO elements (id, page_id, order_idx, class_name, bbox, kind, polygon)
            VALUES (1, 1, 0, 'Paragraph', '[0.1,0.4,0.9,0.9]', 'content', '[[0.1,0.4],[0.9,0.4],[0.1,0.9]]');
    """)
    conn.commit()

    run(conn, tmp_path)

    assert len(lines_of(conn, 'Paragraph')) == 2


def test_the_crop_is_painted_out_beyond_the_outline():
    crop = Image.new('RGB', (10, 10), 'black')
    crop.paste((255, 255, 255), (0, 0, 5, 10))

    painted = text_job._outside_painted(crop, [[0, 0], [0.5, 0], [0.5, 1], [0, 1]], (0, 0), (10, 10))

    assert painted.getpixel((8, 5)) == (255, 255, 255)
    assert painted.getpixel((2, 5)) == (255, 255, 255)


def test_a_dataset_of_its_own_classes_stores_the_models_labels_as_it_decided(conn, backend, tmp_path, capsys):
    """Paragraph is read as Body and Column as Panel; PageNumber, never decided, is left out."""
    template = conn.execute("INSERT INTO layout_templates (name, owner) VALUES ('Letters', 'alice')").lastrowid
    layout_templates.insert_classes(conn, 'layout_template_classes', 'template_id', template, [
        {'id': 1, 'name': 'Body', 'role': 'content', 'reads': None, 'color': None, 'position': 0},
        {'id': 2, 'name': 'Panel', 'role': 'container', 'reads': 'across', 'color': None, 'position': 1}])
    layout_templates.copy_into(conn, 'j1', template)
    assert [(p['label'], p['how']) for p in layout_templates.label_plan(
        conn, 'j1', 1, layout_templates.model_labels(conn, 1))] == [
        ('Paragraph', 'undecided'), ('Column', 'undecided'), ('PageNumber', 'undecided')]
    layout_templates.decide_labels(conn, 'j1', 1, {'Paragraph': 1, 'Column': 2})
    conn.commit()

    run(conn, tmp_path)

    assert elements(conn) == [('Panel', 'Panel', 'container', 0), ('Body', 'Body', 'content', 0)]
    assert [t for _, t in lines_of(conn, 'Body')] == ['Body 0', 'Body 1']
    assert 'left out boxes whose label this dataset has no class for: PageNumber (1)' in capsys.readouterr().out
