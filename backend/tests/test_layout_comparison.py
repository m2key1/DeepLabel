"""A layout run compared with its base model (#150): both detect boxes on the pages the run
held out - its test split, else its validation split, as the snapshot froze them - scored
against the checked boxes and recorded page by page, at the end of every layout run and on
request for a run that finished before."""
import json

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app import config, eval_run, evaluator, layout_comparison, store, trainer
from app.deps import get_db
from app.main import app
from app.remote_models import Detection, PageLayout

SECRET = 'test-secret'
ALICE = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'alice', 'X-Auth-Role': 'manager'}
BOB = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'bob', 'X-Auth-Role': 'manager'}
HASH = 'abcdef0123456789'
W, H = 200, 100


@pytest.fixture
def conn(tmp_path, monkeypatch):
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    monkeypatch.setattr('app.config.EVALS_DIR', tmp_path / 'evaluations')
    monkeypatch.setattr('app.config.TRAININGS_DIR', tmp_path / 'trainings')
    (tmp_path / 'evaluations').mkdir()
    scan = tmp_path / 'p1.png'
    Image.new('RGB', (W, H), 'white').save(scan)
    connection = store.connect(tmp_path / 'app.db')
    connection.executescript(f"""
        INSERT INTO jobs (id, name, owner, status) VALUES ('j1', 'Register', 'alice', 'done');
        INSERT INTO pages (id, job_id, idx, filename, source_file, content_hash, status, layout_checked)
            VALUES (1, 'j1', 0, 'p1.png', '{scan}', '{HASH}', 'done', 1);
        INSERT INTO job_layout_classes (job_id, class_id, name, position) VALUES ('j1', 1, 'text', 0), ('j1', 2, 'node', 1);
        INSERT INTO models (id, task, name, checkpoint) VALUES (1, 'layout', 'Schematismus', '/s.pt'),
                                                               (2, 'layout', 'CHIGC', '/c.pt');
        -- The base model's own label, mapped onto the dataset's class as a reading maps it.
        INSERT INTO layout_label_maps (job_id, model_id, label, class_id) VALUES ('j1', 1, 'Paragraph', 1);
        INSERT INTO trainings (id, task, name, owner, base_model_id, model_id, target, status, dataset_job_ids)
            VALUES (5, 'layout', 'CHIGC', 'alice', 1, 2, 'slurm', 'done', '["j1"]');
    """)
    connection.commit()
    freeze(5, 'valid', scan)
    yield connection
    connection.close()


TEXT = [20, 10, 160, 30]      # x, y, w, h in page pixels, as the snapshot's COCO holds them
NODE = [20, 60, 60, 20]


def freeze(training_id: int, split: str, scan, boxes=((1, TEXT), (2, NODE)),
           categories=({'id': 1, 'name': 'text'}, {'id': 2, 'name': 'node'})):
    """What the run's snapshot froze for a split: the page, its checked boxes and its dataset."""
    folder = config.training_dir(training_id) / 'snapshot' / split
    (folder / 'images').mkdir(parents=True, exist_ok=True)
    name = f'j1_{HASH[:8]}_p1.png'
    Image.open(scan).save(folder / 'images' / name)
    (folder / '_annotations.coco.json').write_text(json.dumps({
        'images': [{'id': 1, 'file_name': name, 'width': W, 'height': H}],
        'annotations': [{'id': i, 'image_id': 1, 'category_id': c, 'bbox': b} for i, (c, b) in enumerate(boxes, 1)],
        'categories': list(categories)}))
    (config.training_dir(training_id) / 'snapshot' / 'manifest.json').write_text(json.dumps({name[:-4]: 'j1'}))


def normalised(x, y, w, h):
    return [x / W, y / H, (x + w) / W, (y + h) / H]


class Model:
    """A layout model that finds the same boxes on any page, labelled as it labels them."""

    def __init__(self, boxes):
        self.boxes = boxes

    def detect(self, images, sources):
        return [PageLayout([Detection(label, label, bbox, confidence) for label, bbox, confidence in self.boxes],
                           [], ordered=False) for _ in images]


def evaluation_of(conn, model_id: int) -> dict:
    eval_id = evaluator.create(conn, model_id, {'snapshot': 5, 'split': 'valid'}, '', 'alice', 5)
    evaluator.set_state(conn, eval_id, status='running')
    return evaluator.get_evaluation(conn, eval_id)


class TestScoring:
    def test_the_trained_model_is_scored_on_the_frozen_pages_and_each_page_recorded(self, conn):
        evaluation = evaluation_of(conn, 2)
        found = Model([('text', normalised(*TEXT), 0.9), ('node', normalised(*NODE), 0.8)])
        eval_run.score_layout(conn, evaluation, lambda job_id: found, evaluator.pages_path(evaluation['id']))

        done = evaluator.get_evaluation(conn, evaluation['id'])
        metrics = json.loads(done['metrics'])
        assert (done['status'], metrics['mAP_50'], metrics['mAP_50_95'], metrics['split']) == ('done', 1.0, 1.0, 'valid')
        record = json.loads(evaluator.pages_path(evaluation['id']).read_text().splitlines()[0])
        assert (record['page_id'], record['map_50']) == (1, 1.0)
        assert record['boxes']['truth'] == [{'class': 'text', 'bbox': normalised(*TEXT)},
                                            {'class': 'node', 'bbox': normalised(*NODE)}]
        assert [box['class'] for box in record['boxes']['found']] == ['text', 'node']

    def test_the_base_models_labels_are_placed_as_a_dataset_reading_places_them(self, conn):
        evaluation = evaluation_of(conn, 1)
        # 'Paragraph' is mapped onto text; 'Footnote' the dataset never decided on, so it is left out.
        found = Model([('Paragraph', normalised(*TEXT), 0.9), ('Footnote', normalised(*NODE), 0.8)])
        eval_run.score_layout(conn, evaluation, lambda job_id: found, evaluator.pages_path(evaluation['id']))

        metrics = json.loads(evaluator.get_evaluation(conn, evaluation['id'])['metrics'])
        assert metrics['per_class'] == {
            'node': {'ap_50': 0.0, 'ap_50_95': 0.0, 'truth': 1, 'found': 0},
            'text': {'ap_50': 1.0, 'ap_50_95': 1.0, 'truth': 1, 'found': 1}}

    def test_a_schematismus_class_is_scored_under_the_label_its_checked_boxes_carry(self, conn, tmp_path):
        # A dataset on the Schematismus classes stores a PageNumber box as Pagenumber, but its
        # snapshot names the class by the checkpoint's label, as its training data does.
        conn.execute("DELETE FROM job_layout_classes WHERE job_id = 'j1'")
        freeze(5, 'valid', tmp_path / 'p1.png', boxes=((1, TEXT),), categories=({'id': 1, 'name': 'PageNumber'},))
        evaluation = evaluation_of(conn, 2)
        found = Model([('PageNumber', normalised(*TEXT), 0.9)])
        eval_run.score_layout(conn, evaluation, lambda job_id: found, evaluator.pages_path(evaluation['id']))

        metrics = json.loads(evaluator.get_evaluation(conn, evaluation['id'])['metrics'])
        assert metrics['per_class'] == {'PageNumber': {'ap_50': 1.0, 'ap_50_95': 1.0, 'truth': 1, 'found': 1}}


class TestWhenItRuns:
    def scheduled(self, conn) -> list[tuple]:
        return [(r['model_id'], json.loads(r['source'])) for r in conn.execute(
            'SELECT model_id, source FROM evaluations WHERE training_id = 5 ORDER BY model_id')]

    def test_a_finished_layout_run_schedules_both_models_on_its_validation_pages(self, conn):
        layout_comparison.schedule(conn, dict(conn.execute('SELECT * FROM trainings WHERE id = 5').fetchone()), 2)
        assert self.scheduled(conn) == [(1, {'snapshot': 5, 'split': 'valid'}), (2, {'snapshot': 5, 'split': 'valid'})]

    def test_a_layout_run_is_compared_as_its_model_is_registered(self, conn, tmp_path, monkeypatch):
        monkeypatch.setattr('app.weights.store_model_files', lambda conn, model_id: None)
        conn.execute("UPDATE trainings SET model_id = NULL, status = 'running' WHERE id = 5")
        out = tmp_path / 'out'
        out.mkdir()
        (out / trainer.CHECKPOINT_NAME).write_bytes(b'weights')
        model_id = trainer.register_result(conn, trainer.get_training(conn, 5), out)
        assert self.scheduled(conn) == [(1, {'snapshot': 5, 'split': 'valid'}), (model_id, {'snapshot': 5, 'split': 'valid'})]

    def test_a_run_with_a_test_split_is_compared_on_that(self, conn, tmp_path):
        freeze(5, 'test', tmp_path / 'p1.png')
        layout_comparison.schedule(conn, dict(conn.execute('SELECT * FROM trainings WHERE id = 5').fetchone()), 2)
        assert {source['split'] for _, source in self.scheduled(conn)} == {'test'}

    @pytest.fixture
    def client(self, conn):
        app.dependency_overrides[get_db] = lambda: conn
        yield TestClient(app)
        app.dependency_overrides.clear()

    def test_a_run_that_finished_before_is_compared_on_request_once(self, client, conn):
        assert client.post('/api/trainings/5/compare', headers=BOB).status_code == 403
        res = client.post('/api/trainings/5/compare', headers=ALICE)
        assert res.status_code == 200, res.text
        assert [model_id for model_id, _ in self.scheduled(conn)] == [1, 2]
        again = client.post('/api/trainings/5/compare', headers=ALICE)
        assert (again.status_code, again.json()['detail']) == (409, 'this run is already compared with its base model')


class TestPageByPage:
    @pytest.fixture
    def client(self, conn):
        app.dependency_overrides[get_db] = lambda: conn
        yield TestClient(app)
        app.dependency_overrides.clear()

    def test_the_pages_are_listed_by_score_and_each_opens_with_its_boxes(self, client, conn):
        evaluation = evaluation_of(conn, 2)
        found = Model([('text', normalised(*TEXT), 0.9)])
        eval_run.score_layout(conn, evaluation, lambda job_id: found, evaluator.pages_path(evaluation['id']))

        listed = client.get(f"/api/evaluations/{evaluation['id']}/pages", headers=ALICE).json()['pages']
        assert listed == [{'page_id': 1, 'job_id': 'j1', 'map_50': 0.5, 'page_idx': 0, 'filename': 'p1.png'}]
        opened = client.get(f"/api/evaluations/{evaluation['id']}/pages/1", headers=ALICE).json()
        assert ([b['class'] for b in opened['boxes']['truth']], [b['class'] for b in opened['boxes']['found']]) == (
            ['text', 'node'], ['text'])
