"""Everything a training run is refused for. Starting one costs a GPU for hours, so each
refusal here is a person finding out in a second instead - and the messages are the whole
value, since "400" tells nobody which of a dozen fields was wrong.
"""
import pytest
from fastapi.testclient import TestClient

from app import remote_training, store, trainer
from app.deps import get_db
from app.main import app
from tests.fakes import FakeTrainer

SECRET = 'test-secret'
TRAINING_BACKEND = remote_training.training_backend
ADMIN = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'root', 'X-Auth-Role': 'admin'}
MEMBER = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'alice', 'X-Auth-Role': 'member',
          'X-Auth-Train-Local': '1'}
NO_GPU = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'bob', 'X-Auth-Role': 'member'}
VIEWER = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'vera', 'X-Auth-Role': 'viewer'}


@pytest.fixture
def conn(tmp_path, monkeypatch):
    monkeypatch.setattr('app.config.TRAININGS_DIR', tmp_path / 'trainings')
    connection = store.connect(tmp_path / 'app.db')
    connection.executescript("""
        INSERT INTO models (id, task, name, checkpoint) VALUES
            (1, 'ocr', 'Base OCR', '/models/base.pt'),
            (2, 'layout', 'Layout v3', '/models/layout.pt');
    """)
    connection.commit()
    yield connection
    connection.close()


@pytest.fixture
def client(conn, monkeypatch, training_backend):
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    app.dependency_overrides[get_db] = lambda: conn
    yield TestClient(app)
    app.dependency_overrides.clear()


def seed_checked_lines(conn, job_id: str, count: int = 3, owner: str = 'root'):
    conn.execute('INSERT INTO jobs (id, name, owner, status) VALUES (?, ?, ?, ?)',
                 (job_id, f'Set {job_id}', owner, 'done'))
    page = conn.execute("INSERT INTO pages (job_id, idx, filename, source_file) "
                        "VALUES (?, 0, 'p.png', '/p.png')", (job_id,)).lastrowid
    element = conn.execute("INSERT INTO elements (page_id, order_idx, class_name, bbox) "
                           "VALUES (?, 0, 'Paragraph', '[]')", (page,)).lastrowid
    for i in range(count):
        conn.execute("INSERT INTO lines (element_id, order_idx, polygon, text, checked) "
                     "VALUES (?, ?, '[]', 'x', 1)", (element, i))
    conn.commit()


def start(client, headers=ADMIN, **overrides):
    body = {'task': 'ocr', 'name': 'A run', 'dataset_job_ids': ['j-train'], **overrides}
    return client.post('/api/trainings', json=body, headers=headers)


def detail(response) -> str:
    return response.json()['detail']


def tmp_log(conn, training_id: int, text: str) -> str:
    """What the trainer would have written, where the route reads it from."""
    from app import config
    output = config.training_dir(training_id)
    output.mkdir(parents=True, exist_ok=True)
    (output / 'training.log').write_text(text)
    return text


@pytest.fixture
def data(conn):
    seed_checked_lines(conn, 'j-train')
    return conn


class TestWhatItIsCalled:
    def test_a_name_of_nothing_is_refused(self, client, data):
        assert start(client, name='   ').status_code == 400

    def test_a_name_another_model_of_that_task_already_has_is_refused(self, client, data):
        response = start(client, name='Base OCR')

        assert response.status_code == 409
        assert 'already exists' in detail(response)

    def test_a_name_a_queued_run_already_has_is_refused(self, client, data):
        """Two runs under one name both register a model when they finish, and nothing
        downstream - the picker, the default, an evaluation's source - can tell the pair
        apart afterwards."""
        assert start(client, name='Twice').status_code == 200
        response = start(client, name='Twice')

        assert response.status_code == 409
        assert detail(response) == 'a ocr training run named "Twice" is already queued or running'

    def test_the_run_clash_ignores_case(self, client, data):
        assert start(client, name='Twice').status_code == 200

        assert start(client, name='TWICE').status_code == 409

    def test_a_run_that_is_over_without_a_model_frees_its_name(self, client, data, conn):
        """A cancelled or failed run registered nothing, so its name is free to try again."""
        assert start(client, name='Again').status_code == 200
        conn.execute("UPDATE trainings SET status = 'cancelled' WHERE name = 'Again'")
        conn.commit()

        assert start(client, name='Again').status_code == 200

    def test_the_clash_is_scoped_to_the_task(self, client, data):
        """'Layout v3' is a layout model, so an OCR run may take that name - the check is
        per task, and models of different tasks never collide."""
        response = start(client, name='Layout v3')

        assert response.status_code == 200, response.text


class TestWhatItTrainsOn:
    def test_no_dataset_at_all_is_refused(self, client, data):
        response = start(client, dataset_job_ids=[])

        assert response.status_code == 400
        assert 'at least one dataset' in detail(response)

    def test_a_dataset_that_does_not_exist_is_refused_by_id(self, client, data):
        response = start(client, dataset_job_ids=['j-train', 'j-ghost'])

        assert response.status_code == 404

    def test_a_dataset_with_nothing_checked_has_nothing_to_train_on(self, client, conn):
        conn.execute("INSERT INTO jobs (id, name, owner, status) "
                     "VALUES ('j-empty', 'Empty', 'root', 'done')")
        conn.commit()

        response = start(client, dataset_job_ids=['j-empty'])

        assert response.status_code == 400

    def test_somebody_elses_dataset_is_not_theirs_to_train_on(self, client, conn):
        seed_checked_lines(conn, 'j-train', owner='root')

        assert start(client, headers=MEMBER).status_code == 404

    def test_lines_only_models_settled_are_nothing_to_train_on_for_a_person_only_run(
            self, client, conn):
        seed_checked_lines(conn, 'j-train')
        conn.execute("UPDATE lines SET check_source = 'llm'")
        conn.commit()

        refused = start(client, human_checked_only=True)
        assert refused.status_code == 400
        assert detail(refused) == 'the selected datasets contain no checked material for this task'
        assert start(client, name='With the models', human_checked_only=False).status_code == 200


class TestTheTaskAndTheBaseModel:
    def test_a_task_nobody_offers_is_refused_with_the_list(self, client, data):
        response = start(client, task='telepathy')

        assert response.status_code == 400
        assert 'task must be one of' in detail(response)

    def test_a_task_that_is_not_trainable_yet_says_so(self, client, data, monkeypatch):
        """A task the registry knows but the trainer cannot start yet - refused with what
        it can do, rather than with 'unknown task', which would be a lie. Every task can
        be trained now, so the guard is shown one that cannot."""
        monkeypatch.setattr(trainer, 'TRAINABLE_TASKS', ('ocr', 'lines'))

        response = start(client, task='layout')

        assert response.status_code == 400
        assert detail(response) == ('layout training is coming soon - '
                                    'only ocr, lines can be trained for now')

    def test_a_base_model_from_another_task_is_refused(self, client, data):
        response = start(client, base_model_id=2)

        assert response.status_code == 400
        assert 'same task' in detail(response)

    def test_a_base_model_that_does_not_exist_is_refused(self, client, data):
        assert start(client, base_model_id=99).status_code == 400

    def test_an_archived_base_model_is_refused_as_the_rerun_form_does(self, client, data, conn):
        conn.execute('UPDATE models SET archived = 1 WHERE id = 1')
        conn.commit()

        response = start(client, base_model_id=1)

        assert response.status_code == 409
        assert detail(response) == 'base model Base OCR is archived - unarchive it first'


class TestWhereItRuns:
    def test_a_target_nobody_offers_is_refused(self, client, data):
        response = start(client, target='somewhere-else')

        assert response.status_code == 400
        assert 'local or slurm' in detail(response)

    def test_someone_without_the_local_gpu_is_told_who_can_grant_it(self, client, data):
        data.execute("INSERT INTO job_assignees (job_id, username) VALUES ('j-train', 'bob')")
        data.commit()

        response = start(client, headers=NO_GPU, target='local')

        assert response.status_code == 403
        assert detail(response) == ('you may not train on the local GPU - '
                                    'ask an admin to grant it')

    def test_someone_who_may_only_look_cannot_start_one(self, client, data):
        assert start(client, headers=VIEWER).status_code == 403

    def test_the_cluster_needs_both_a_grant_and_a_cluster(self, client, data, monkeypatch):
        monkeypatch.setattr(trainer, 'slurm_available', lambda: False)

        response = start(client, target='slurm')

        assert response.status_code == 409
        assert 'no SLURM cluster' in detail(response)


    def test_a_run_no_backend_trains_is_refused_saying_so(self, client, data, monkeypatch):
        monkeypatch.setattr('app.remote_training.training_backend', TRAINING_BACKEND)
        monkeypatch.setattr('app.config.MODEL_BACKENDS', {})

        response = start(client)

        assert response.status_code == 400
        assert detail(response) == 'no configured model backend trains ocr'


class TestTheGpuAskedFor:
    def test_a_gpu_type_only_means_anything_on_the_cluster(self, client, data):
        response = start(client, target='local', gpu_type='rtx6000bb')

        assert response.status_code == 400
        assert 'only applies to SLURM' in detail(response)

    def test_a_gpu_count_without_a_type_is_refused(self, client, data):
        response = start(client, gpu_count=2)

        assert response.status_code == 400
        assert 'needs a gpu_type' in detail(response)

    def test_a_gpu_type_nobody_has_is_refused_with_the_list(self, client, data, monkeypatch):
        monkeypatch.setattr(trainer, 'slurm_available', lambda: True)

        response = start(client, target='slurm', gpu_type='quantum')

        assert response.status_code == 400
        assert 'gpu_type must be one of' in detail(response)

    def test_more_cards_than_that_type_has_is_refused_with_the_limit(self, client, data,
                                                                    monkeypatch):
        monkeypatch.setattr(trainer, 'slurm_available', lambda: True)
        gpu_type = sorted(trainer.GPU_TYPES)[0]
        limit = trainer.GPU_TYPES[gpu_type]

        response = start(client, target='slurm', gpu_type=gpu_type, gpu_count=limit + 1)

        assert response.status_code == 400
        assert str(limit) in detail(response)


class TestTheNumbers:
    def test_no_epochs_at_all_is_refused(self, client, data):
        assert start(client, epochs=0).status_code == 400

    def test_a_batch_of_nothing_is_refused(self, client, data):
        assert start(client, batch_size=0).status_code == 400

    def test_a_hyperparameter_nobody_defined_is_refused(self, client, data):
        response = start(client, hyperparams={'learning_rate_but_spelled_wrong': 0.1})

        assert response.status_code == 400


class TestHowTheSplitIsMade:
    def test_a_language_model_is_only_fitted_for_an_ocr_run(self, client, data):
        response = start(client, task='lines', build_lm=True)
        assert response.status_code == 400
        assert detail(response) == 'a language model is only fitted for an OCR run'

    def test_a_strategy_nobody_offers_is_refused_with_the_list(self, client, data):
        response = start(client, split_strategy='vibes')

        assert response.status_code == 400
        assert 'uniform, stratified, or holdout' in detail(response)

    def test_holdout_needs_something_to_hold_out(self, client, data):
        response = start(client, split_strategy='holdout', valid_job_ids=[])

        assert response.status_code == 400
        assert 'at least one validation dataset' in detail(response)

    def test_a_validation_dataset_cannot_also_be_trained_on(self, client, data):
        response = start(client, split_strategy='holdout', valid_job_ids=['j-train'])

        assert response.status_code == 400
        assert 'must not also be training datasets' in detail(response)

    def test_a_validation_dataset_with_nothing_checked_is_refused(self, client, conn):
        seed_checked_lines(conn, 'j-train')
        conn.execute("INSERT INTO jobs (id, name, owner, status) "
                     "VALUES ('j-valid', 'Valid', 'root', 'done')")
        conn.commit()

        response = start(client, split_strategy='holdout', valid_job_ids=['j-valid'])

        assert response.status_code == 400
        assert 'no checked material' in detail(response)

    def test_a_validation_dataset_only_models_settled_is_refused_for_a_person_only_run(
            self, client, conn):
        seed_checked_lines(conn, 'j-train')
        seed_checked_lines(conn, 'j-valid')
        conn.execute("UPDATE lines SET check_source = 'llm' WHERE element_id IN ("
                     "SELECT e.id FROM elements e JOIN pages p ON e.page_id = p.id "
                     "WHERE p.job_id = 'j-valid')")
        conn.commit()

        response = start(client, split_strategy='holdout', valid_job_ids=['j-valid'],
                         human_checked_only=True)

        assert response.status_code == 400
        assert detail(response) == ('the validation datasets contain no checked material '
                                    'for this task')

    def test_validation_datasets_mean_nothing_without_holdout(self, client, conn):
        seed_checked_lines(conn, 'j-train')
        seed_checked_lines(conn, 'j-valid')

        response = start(client, valid_job_ids=['j-valid'])

        assert response.status_code == 400
        assert 'only applies to the holdout strategy' in detail(response)

    @pytest.mark.parametrize('fraction', [0.0, 0.6, -0.1])
    def test_a_validation_fraction_outside_the_range_is_refused(self, client, data, fraction):
        response = start(client, val_fraction=fraction)

        assert response.status_code == 400
        assert 'between 0 and 0.5' in detail(response)


class TestTheTestSet:
    def test_a_test_dataset_cannot_also_be_trained_on(self, client, data):
        response = start(client, test_job_ids=['j-train'])

        assert response.status_code == 400
        assert 'must not also be training datasets' in detail(response)

    def test_a_test_dataset_with_nothing_checked_is_refused(self, client, conn):
        seed_checked_lines(conn, 'j-train')
        conn.execute("INSERT INTO jobs (id, name, owner, status) "
                     "VALUES ('j-test', 'Test', 'root', 'done')")
        conn.commit()

        response = start(client, test_job_ids=['j-test'])

        assert response.status_code == 400
        assert 'no checked material' in detail(response)

    def test_a_test_dataset_that_does_not_exist_is_refused(self, client, data):
        assert start(client, test_job_ids=['j-ghost']).status_code == 404


class TestAfterwards:
    def start_one(self, client, conn):
        response = start(client)
        assert response.status_code == 200, response.text
        return response.json()['id']

    def test_a_finished_run_can_be_removed(self, client, data, conn):
        training_id = self.start_one(client, conn)
        conn.execute("UPDATE trainings SET status = 'done' WHERE id = ?", (training_id,))
        conn.commit()

        assert client.delete(f'/api/trainings/{training_id}', headers=ADMIN).status_code == 200
        assert conn.execute('SELECT COUNT(*) c FROM trainings').fetchone()['c'] == 0

    def test_a_run_that_does_not_exist_is_a_404(self, client):
        assert client.delete('/api/trainings/999', headers=ADMIN).status_code == 404
        assert client.post('/api/trainings/999/cancel', headers=ADMIN).status_code == 404
        assert client.post('/api/trainings/999/retry', headers=ADMIN).status_code == 404

    def test_a_failed_run_can_be_tried_again(self, client, data, conn):
        training_id = self.start_one(client, conn)
        conn.execute("UPDATE trainings SET status = 'error', error = 'CUDA out of memory' "
                     'WHERE id = ?', (training_id,))
        conn.commit()

        response = client.post(f'/api/trainings/{training_id}/retry', headers=ADMIN)

        assert response.status_code == 200, response.text
        row = conn.execute('SELECT status, error FROM trainings WHERE id = ?',
                           (training_id,)).fetchone()
        assert (row['status'], row['error']) == ('queued', None)

    def test_a_run_that_did_not_fail_has_nothing_to_retry(self, client, data, conn):
        training_id = self.start_one(client, conn)
        conn.execute("UPDATE trainings SET status = 'done' WHERE id = ?", (training_id,))
        conn.commit()

        assert client.post(f'/api/trainings/{training_id}/retry',
                           headers=ADMIN).status_code == 409

    def test_a_failed_run_whose_base_model_was_archived_since_stays_failed(self, client, data,
                                                                         conn):
        training_id = self.start_one(client, conn)
        conn.execute("UPDATE trainings SET status = 'error', base_model_id = 1 WHERE id = ?",
                     (training_id,))
        conn.execute('UPDATE models SET archived = 1 WHERE id = 1')
        conn.commit()

        response = client.post(f'/api/trainings/{training_id}/retry', headers=ADMIN)

        assert response.status_code == 409
        assert detail(response) == 'base model Base OCR is archived - unarchive it first'
        assert self.status_of(conn, training_id) == 'error'

    def fail_as(self, client, conn, owner: str, target: str) -> int:
        training_id = self.start_one(client, conn)
        conn.execute("UPDATE trainings SET status = 'error', owner = ?, target = ? WHERE id = ?",
                     (owner, target, training_id))
        conn.commit()
        return training_id

    def status_of(self, conn, training_id: int) -> str:
        return conn.execute('SELECT status FROM trainings WHERE id = ?', (training_id,)).fetchone()[0]

    def test_the_owner_may_retry_a_local_run_while_they_hold_the_grant(self, client, data, conn):
        training_id = self.fail_as(client, conn, 'alice', 'local')

        assert client.post(f'/api/trainings/{training_id}/retry', headers=MEMBER).status_code == 200
        assert self.status_of(conn, training_id) == 'queued'

    def test_a_local_run_stays_failed_once_the_owner_lost_the_gpu_grant(self, client, data, conn):
        training_id = self.fail_as(client, conn, 'bob', 'local')

        response = client.post(f'/api/trainings/{training_id}/retry', headers=NO_GPU)

        assert response.status_code == 403
        assert detail(response) == 'you may not train on the local GPU - ask an admin to grant it'
        assert self.status_of(conn, training_id) == 'error'

    def test_a_cluster_run_stays_failed_once_the_owner_lost_cluster_access(self, client, data, conn,
                                                                          monkeypatch):
        monkeypatch.setattr(trainer, 'slurm_available', lambda: True)
        training_id = self.fail_as(client, conn, 'alice', 'slurm')

        response = client.post(f'/api/trainings/{training_id}/retry', headers=MEMBER)

        assert response.status_code == 403
        assert detail(response) == 'you do not have cluster access - ask an admin to grant it'
        assert self.status_of(conn, training_id) == 'error'

    def test_a_queued_run_can_be_cancelled(self, client, data, conn):
        training_id = self.start_one(client, conn)

        assert client.post(f'/api/trainings/{training_id}/cancel',
                           headers=ADMIN).status_code == 200
        assert conn.execute('SELECT status FROM trainings WHERE id = ?',
                            (training_id,)).fetchone()[0] == 'cancelled'

    def test_the_log_is_the_owners_alone(self, client, data, conn):
        """Everyone sees a run - the models page is shared - and the handler already keeps
        the names of datasets a caller cannot open out of it. The trainer's own log carries
        those same names and the paths beneath them, so it is not for passers-by."""
        training_id = self.start_one(client, conn)
        log = tmp_log(conn, training_id, 'Traceback: /data/jobs/j-train/snapshot exploded')

        mine = client.get(f'/api/trainings/{training_id}/progress', headers=ADMIN).json()
        theirs = client.get(f'/api/trainings/{training_id}/progress', headers=MEMBER).json()

        assert log in mine['log_tail']
        assert theirs['log_tail'] == ''
        # The run itself stays visible, redacted as it already was.
        assert theirs['datasets'] == {'j-train': 'another dataset'}

    def test_progress_is_reported_for_a_run_that_has_some(self, client, data, conn):
        training_id = self.start_one(client, conn)

        response = client.get(f'/api/trainings/{training_id}/progress', headers=ADMIN)

        assert response.status_code == 200
        body = response.json()
        assert body['points'] == [], 'nothing has been emitted yet'
        assert body['datasets'] == {'j-train': 'Set j-train'}, 'ids resolved to names'


class TestTheCardsATaskCanUse:
    def test_a_single_process_task_is_held_to_one_card(self, client, data):
        """train_db.py never reads WORLD_SIZE, so a second card would sit idle for hours."""
        response = start(client, task='lines', target='slurm', gpu_type='h200', gpu_count=2)

        assert response.status_code == 400
        assert detail(response) == ('gpu_count must be between 1 and 1: '
                                    'lines training runs on one card')

    def test_one_card_gets_past_the_check(self, client, data, monkeypatch):
        """The fixture has no line-checked pages, so this run is refused for its material
        and not for its cards - which is what says the cap let one card through."""
        response = start(client, task='lines', target='slurm', gpu_type='h200', gpu_count=1)

        assert response.status_code == 400
        assert detail(response) == 'the selected datasets contain no checked material for this task'

    def test_a_sharding_task_still_takes_the_whole_node(self, client, data):
        assert trainer.gpu_limit('ocr', 'h200') == trainer.GPU_TYPES['h200']
        assert trainer.gpu_limit('lines', 'h200') == 1


def test_a_finished_run_cannot_be_cancelled(client, conn):
    conn.execute("INSERT INTO trainings (id, name, task, status, owner, target) "
                 "VALUES (7, 'Finished', 'ocr', 'done', 'alice', 'local')")
    conn.commit()

    response = client.post('/api/trainings/7/cancel', headers=MEMBER)

    assert response.status_code == 409
    assert detail(response) == (
        'this training is already done - only a queued or running one can be cancelled')
    assert trainer.get_training(conn, 7)['status'] == 'done'


def seed_checked_page_lines(conn, job_id: str = 'j-lines'):
    conn.execute("INSERT INTO jobs (id, name, owner, status) VALUES (?, 'Lines', 'root', 'done')", (job_id,))
    page = conn.execute("INSERT INTO pages (job_id, idx, filename, source_file, content_hash, width, height, "
                        "lines_checked) VALUES (?, 0, 'p.png', '/p.png', 'h', 400, 300, 1)", (job_id,)).lastrowid
    element = conn.execute("INSERT INTO elements (page_id, order_idx, class_name, bbox) "
                           "VALUES (?, 0, 'Paragraph', '[]')", (page,)).lastrowid
    conn.execute("INSERT INTO lines (element_id, order_idx, polygon, text) "
                 "VALUES (?, 0, '[[0.1, 0.1], [0.9, 0.1], [0.9, 0.2], [0.1, 0.2]]', '')", (element,))
    conn.commit()


class TestTheShapeItsLinesTrainAs:
    """Polygons as drawn, rotated rectangles or upright boxes; each model has its default."""

    @pytest.fixture
    def lines(self, conn):
        seed_checked_page_lines(conn)
        return conn

    def stored(self, conn, response) -> str:
        assert response.status_code == 200, response.text
        return conn.execute('SELECT line_shape FROM trainings WHERE id = ?',
                            (response.json()['id'],)).fetchone()['line_shape']

    def test_only_a_lines_run_has_lines_to_shape(self, client, data):
        response = start(client, line_shape='box')

        assert response.status_code == 400
        assert detail(response) == 'line_shape only applies to a lines run'

    def test_a_shape_nobody_offers_is_refused_with_the_list(self, client, lines):
        response = start(client, task='lines', dataset_job_ids=['j-lines'], line_shape='circle')

        assert response.status_code == 400
        assert detail(response) == 'line_shape must be one of polygon, rotated, box'

    def test_the_shape_asked_for_is_the_one_kept(self, client, lines, conn):
        response = start(client, task='lines', dataset_job_ids=['j-lines'], line_shape='polygon')

        assert self.stored(conn, response) == 'polygon'

    def test_a_run_on_a_backend_takes_the_default_that_backend_declares(self, client, lines, conn, monkeypatch):
        monkeypatch.setattr(remote_training, 'training_backend',
                            lambda _conn, _training: FakeTrainer({'tunables': [], 'line_shape': 'box'}))

        assert self.stored(conn, start(client, task='lines', dataset_job_ids=['j-lines'])) == 'box'
        assert client.get('/api/trainings/options?task=lines', headers=ADMIN).json()['line_shape'] == 'box'

    def test_a_backend_that_declares_none_trains_on_polygons_as_before(self, client, lines, conn, monkeypatch):
        monkeypatch.setattr(remote_training, 'training_backend',
                            lambda _conn, _training: FakeTrainer({'tunables': []}))

        assert self.stored(conn, start(client, task='lines', dataset_job_ids=['j-lines'],
                                       name='Another run')) == 'polygon'
