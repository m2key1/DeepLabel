"""Reading through a model backend, from DeepLabel's side: the OCR loop every engine shares,
the evaluation that needs no torch, and the interpreter an evaluation is spawned under."""
import json
import sys

import pytest
from PIL import Image

from app import config, eval_run, evaluator, ocr_phase, store


@pytest.fixture
def conn(tmp_path, monkeypatch):
    monkeypatch.setattr('app.config.LINE_CROP_MASK', False)
    scan = tmp_path / 'p.png'
    Image.new('RGB', (400, 200), 'white').save(scan)
    connection = store.connect(tmp_path / 'app.db')
    connection.executescript(f"""
        INSERT INTO models (id, task, name, checkpoint) VALUES (1, 'ocr', 'DeepOCR v12', '/o.ckpt');
        INSERT INTO jobs (id, name, owner, status, task) VALUES ('j1', 'Volume', 'alice', 'running', 'text');
        INSERT INTO pages (id, job_id, idx, filename, source_file, status, width, height)
            VALUES (1, 'j1', 0, 'p.png', '{scan}', 'lines_done', 400, 200);
        INSERT INTO elements (id, page_id, order_idx, class_name, bbox, kind)
            VALUES (1, 1, 0, 'Header', '[0,0,1,0.5]', 'content');
        INSERT INTO lines (id, element_id, order_idx, polygon, text, needs_ocr, checked) VALUES
            (1, 1, 0, '[[0.1,0.1],[0.9,0.1],[0.9,0.2],[0.1,0.2]]', NULL, 0, 0),
            (2, 1, 1, '[[0.1,0.25],[0.6,0.25],[0.6,0.35],[0.1,0.35]]', 'old reading', 1, 0),
            (3, 1, 2, '[[0.1,0.4],[0.9,0.4],[0.9,0.45],[0.1,0.45]]', 'kept', 0, 1);
    """)
    connection.commit()
    yield connection
    connection.close()


def test_the_shared_loop_reads_what_is_unread_or_queued_and_credits_the_model(conn):
    seen = []

    def read(images, contexts):
        seen.extend(contexts)
        return ([f"line {c['line_index']}" for c in contexts], [0.5] * len(images),
                [[{'x0': 0.0, 'x1': 1.0, 'c': 50}]] * len(images))

    ocr_phase.run(conn, 'j1', read, 'model:ocr@DeepOCR v12', 1, chunk_lines=512)

    rows = {r['id']: r for r in conn.execute('SELECT * FROM lines')}
    assert sorted(seen, key=lambda c: c['line_index']) == [
        {'element_class': 'Header', 'line_index': 0}, {'element_class': 'Header', 'line_index': 1}]
    assert (rows[1]['text'], rows[2]['text'], rows[3]['text']) == ('line 0', 'line 1', 'kept')
    assert (rows[1]['ocr_model_id'], rows[2]['ocr_model_id'], rows[3]['ocr_model_id']) == (1, 1, None)
    assert rows[2]['needs_ocr'] == 0 and json.loads(rows[1]['conf_profile']) == [{'x0': 0.0, 'x1': 1.0, 'c': 50}]
    assert json.loads(conn.execute("SELECT counters FROM jobs").fetchone()[0])['lines_ocr_done'] == 3
    assert conn.execute("SELECT status FROM pages").fetchone()[0] == 'done'
    authors = {r[0] for r in conn.execute("SELECT author FROM revisions WHERE target_type = 'line'")}
    assert authors == {'model:ocr@DeepOCR v12'}


def test_an_evaluation_scores_what_the_engine_reads(conn, tmp_path):
    conn.execute("UPDATE lines SET text = 'Anno', checked = 1")
    conn.commit()
    eval_id = evaluator.create(conn, 1, {'jobs': ['j1']}, 'beam', 'alice')
    evaluator.set_state(conn, eval_id, status='running')

    class Engine:
        def predict_batch(self, images, contexts=None):
            return ['Anno' if c['line_index'] else 'Anna' for c in contexts], [0.9] * len(images), [None] * len(images)

    eval_run.score(conn, evaluator.get_evaluation(conn, eval_id), Engine, tmp_path / 'lines.jsonl')

    done = evaluator.get_evaluation(conn, eval_id)
    assert (done['status'], done['line_count']) == ('done', 3)
    assert done['cer'] == pytest.approx(1 / 12)
    assert len((tmp_path / 'lines.jsonl').read_text().splitlines()) == 3


def test_an_evaluation_of_a_model_on_no_backend_fails_saying_so(conn, tmp_path, monkeypatch):
    eval_id = evaluator.create(conn, 1, {'jobs': ['j1']}, 'beam', 'alice')
    evaluator.set_state(conn, eval_id, status='running')
    monkeypatch.setattr(sys, 'argv', ['eval_run', '--evaluation-id', str(eval_id),
                                      '--db-path', conn.execute('PRAGMA database_list').fetchone()[2]])

    eval_run.main()

    failed = evaluator.get_evaluation(conn, eval_id)
    assert (failed['status'], failed['error']) == ('error', 'model 1 is not on a configured model backend')


class Spawned:
    def __init__(self, args, **kwargs):
        self.args, self.env = args, kwargs['env']


def test_an_evaluation_runs_under_the_apps_own_interpreter(conn, monkeypatch, tmp_path):
    monkeypatch.setattr('app.config.EVALS_DIR', tmp_path / 'evals')
    monkeypatch.setattr('app.evaluator.subprocess.Popen', Spawned)
    eval_id = evaluator.create(conn, 1, {'jobs': ['j1']}, 'beam', 'alice')

    spawned = evaluator._spawn(conn, evaluator.get_evaluation(conn, eval_id))

    assert spawned.args[:3] == [sys.executable, '-m', 'app.eval_run']
    assert spawned.env['PYTHONPATH'] == str(evaluator.BACKEND_DIR)


def test_a_tall_line_is_read_turned_and_keeps_the_orientation_read_best(tmp_path, monkeypatch):
    """A line much taller than wide is read along its length both ways - top to
    bottom (0) and bottom to top (180) - and keeps whichever reading is more confident, with
    its orientation; a wide line is read once."""
    from PIL import ImageDraw

    from app import linecrop
    monkeypatch.setattr('app.config.LINE_CROP_MASK', False)
    scan = tmp_path / 'p.png'
    image = Image.new('RGB', (400, 400), 'white')
    ImageDraw.Draw(image).rectangle((40, 160, 52, 200), fill='black')  # written bottom to top: it starts low
    image.save(scan)
    conn = store.connect(tmp_path / 'app.db')
    tall = [[0.1, 0.0], [0.13, 0.0], [0.13, 0.5], [0.1, 0.5]]
    conn.executescript(f"""
        INSERT INTO jobs (id, name, owner, status, task) VALUES ('j1', 'Postcards', 'alice', 'running', 'text');
        INSERT INTO pages (id, job_id, idx, filename, source_file, status, width, height)
            VALUES (1, 'j1', 0, 'p.png', '{scan}', 'lines_done', 400, 400);
        INSERT INTO elements (id, page_id, order_idx, class_name, bbox, kind)
            VALUES (1, 1, 0, 'Paragraph', '[0,0,1,1]', 'content');
        INSERT INTO lines (id, element_id, order_idx, polygon, text) VALUES
            (1, 1, 0, '{json.dumps(tall)}', NULL),
            (2, 1, 1, '[[0.3,0.6],[0.9,0.6],[0.9,0.65],[0.3,0.65]]', NULL);
    """)
    conn.commit()
    reads = []

    def starts_dark(crop) -> bool:
        return crop.width > crop.height and crop.convert('L').crop((0, 0, crop.width // 5, crop.height)).getextrema()[0] < 50

    def read(images, contexts):
        reads.extend(images)
        return (['Herrn Professor' if starts_dark(i) else 'xyz' for i in images],
                [0.9 if starts_dark(i) else 0.2 for i in images], [None] * len(images))

    ocr_phase.run(conn, 'j1', read, 'model:ocr@DeepOCR', None, chunk_lines=512)

    expected = next(q for q in (0, 180)
                    if starts_dark(linecrop.crop_line(image, [[x * 400, y * 400] for x, y in tall], q, mask=False)))
    assert expected == 180
    rows = {r['id']: r for r in conn.execute('SELECT * FROM lines')}
    assert (rows[1]['text'], rows[1]['orientation'], rows[1]['confidence']) == ('Herrn Professor', expected, 0.9)
    assert (rows[2]['orientation'], len(reads)) == (0, 3)
    conn.close()


def test_a_tall_line_a_person_turned_is_read_only_as_turned(tmp_path, monkeypatch):
    monkeypatch.setattr('app.config.LINE_CROP_MASK', False)
    scan = tmp_path / 'p.png'
    Image.new('RGB', (400, 400), 'white').save(scan)
    conn = store.connect(tmp_path / 'app.db')
    conn.executescript(f"""
        INSERT INTO jobs (id, name, owner, status, task) VALUES ('j1', 'Postcards', 'alice', 'running', 'text');
        INSERT INTO pages (id, job_id, idx, filename, source_file, status, width, height)
            VALUES (1, 'j1', 0, 'p.png', '{scan}', 'lines_done', 400, 400);
        INSERT INTO elements (id, page_id, order_idx, class_name, bbox, kind)
            VALUES (1, 1, 0, 'Paragraph', '[0,0,1,1]', 'content');
        INSERT INTO lines (id, element_id, order_idx, polygon, text, orientation) VALUES
            (1, 1, 0, '[[0.1,0.0],[0.13,0.0],[0.13,0.5],[0.1,0.5]]', NULL, 270);
    """)
    conn.commit()
    count = []
    ocr_phase.run(conn, 'j1', lambda images, contexts: (count.extend(images) or (['a'] * len(images), [0.5] * len(images),
                                                                                  [None] * len(images))),
                  'model:ocr@DeepOCR', None, chunk_lines=512)
    assert len(count) == 1
    assert conn.execute('SELECT orientation FROM lines').fetchone()[0] == 270
    conn.close()
