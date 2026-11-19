"""Early stopping (decision 313): on by default for a run from a trained model, and a way to
end a running run as finished, keeping its best epoch."""
import json

import pytest
from fastapi.testclient import TestClient

from app import config, store, trainer
from app.deps import get_db
from app.main import app
from tests.test_training_validation import ADMIN, MEMBER, SECRET, seed_checked_lines, start

OTHER_MEMBER = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'mallory', 'X-Auth-Role': 'member'}


@pytest.fixture
def conn(tmp_path, monkeypatch):
    monkeypatch.setattr('app.config.TRAININGS_DIR', tmp_path / 'trainings')
    connection = store.connect(tmp_path / 'app.db')
    connection.execute("INSERT INTO models (id, task, name, checkpoint) VALUES (1, 'ocr', 'Base OCR', '/models/base.pt')")
    connection.commit()
    seed_checked_lines(connection, 'j-train')
    yield connection
    connection.close()


@pytest.fixture
def client(conn, monkeypatch, training_backend):
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    app.dependency_overrides[get_db] = lambda: conn
    yield TestClient(app)
    app.dependency_overrides.clear()


def hyperparams_of(conn, response) -> dict:
    assert response.status_code == 200, response.text
    row = conn.execute('SELECT hyperparams FROM trainings WHERE id = ?', (response.json()['id'],)).fetchone()
    return json.loads(row['hyperparams'])


class TestByDefault:
    def test_a_run_from_a_trained_model_stops_after_ten_validations_without_improving(self, client, conn):
        assert hyperparams_of(conn, start(client, base_model_id=1)) == {'patience': 10}

    def test_a_run_from_scratch_trains_every_epoch(self, client, conn):
        assert hyperparams_of(conn, start(client)) == {}

    def test_a_run_that_turns_it_off_keeps_it_off(self, client, conn):
        assert hyperparams_of(conn, start(client, base_model_id=1, hyperparams={'patience': None})) == {}

    def test_a_chosen_patience_stands(self, client, conn):
        assert hyperparams_of(conn, start(client, base_model_id=1, hyperparams={'patience': 4})) == {'patience': 4}

    def test_a_backend_without_early_stopping_is_sent_none(self, client, conn, training_backend):
        training_backend.train['tunables'] = [t for t in training_backend.train['tunables'] if t['key'] != 'patience']

        assert hyperparams_of(conn, start(client, base_model_id=1)) == {}


def running(conn, target: str = 'local', status: str = 'running', owner: str = 'alice') -> int:
    conn.execute("INSERT INTO trainings (id, name, task, status, phase, owner, target, backend, backend_train_id, "
                 "slurm_job_id) VALUES (7, 'Long run', 'ocr', ?, 'training', ?, ?, 'trainer', 'run-1', ?)",
                 (status, owner, target, '4242' if target == 'slurm' else None))
    conn.commit()
    return 7


class TestStoppingAndKeepingTheBestEpoch:
    def test_a_local_run_is_handed_to_its_backend_to_finish(self, client, conn, training_backend):
        training_backend.train['finish'] = True
        running(conn)

        response = client.post('/api/trainings/7/finish', headers=MEMBER)

        assert response.status_code == 200, response.text
        assert training_backend.calls == [('POST', '/v1/train/run-1/finish')]
        row = trainer.get_training(conn, 7)
        assert (row['status'], row['phase']) == ('running', 'finishing')

    def test_a_cluster_run_finds_the_finish_file_beside_its_output(self, client, conn, training_backend, monkeypatch):
        training_backend.train['finish'] = True
        sent = []
        monkeypatch.setattr(trainer, '_ssh', lambda command: sent.append(command) or
                            type('Done', (), {'returncode': 0, 'stdout': '', 'stderr': ''})())
        running(conn, target='slurm')

        response = client.post('/api/trainings/7/finish', headers=MEMBER)

        assert response.status_code == 200, response.text
        assert sent == [['touch', f'{config.SLURM_REMOTE_DIR}/7/output/finish']]
        assert training_backend.calls == []
        assert trainer.get_training(conn, 7)['phase'] == 'finishing'

    def test_a_backend_that_cannot_end_a_run_early_says_so(self, client, conn, training_backend):
        running(conn)

        response = client.post('/api/trainings/7/finish', headers=MEMBER)

        assert response.status_code == 409
        assert response.json()['detail'] == 'model backend "trainer" cannot end a run early - cancel it instead'
        assert training_backend.calls == []

    def test_a_run_that_is_over_cannot_be_stopped(self, client, conn, training_backend):
        training_backend.train['finish'] = True
        running(conn, status='done')

        response = client.post('/api/trainings/7/finish', headers=MEMBER)

        assert response.status_code == 409
        assert response.json()['detail'] == 'this training is done - only a running one can be stopped'

    def test_only_its_owner_or_an_admin_may_stop_it(self, client, conn, training_backend):
        training_backend.train['finish'] = True
        running(conn)

        assert client.post('/api/trainings/7/finish', headers=OTHER_MEMBER).status_code == 403
        assert training_backend.calls == []
        assert client.post('/api/trainings/7/finish', headers=ADMIN).status_code == 200
        assert training_backend.calls == [('POST', '/v1/train/run-1/finish')]

    @pytest.mark.parametrize('finish, status, headers, expected', [
        (True, 'running', MEMBER, True),
        (True, 'running', OTHER_MEMBER, False),
        (False, 'running', MEMBER, False),
        (True, 'done', MEMBER, False),
    ], ids=['own running run', "someone else's", 'backend cannot', 'over'])
    def test_the_run_page_is_told_whether_it_may_offer_the_stop(
            self, client, conn, training_backend, finish, status, headers, expected):
        training_backend.train['finish'] = finish
        running(conn, status=status)

        assert client.get('/api/trainings/7/progress', headers=headers).json()['can_finish'] is expected
