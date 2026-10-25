"""A failed evaluation is worth re-running: the three baselines of training 24 died on a
runner that held the whole valid split in memory, and once that was fixed there was no way
back to them short of editing the database by hand.
"""
import shutil

import pytest
from fastapi.testclient import TestClient

from app import evaluator, store
from app.deps import get_db
from app.main import app

SECRET = 'test-secret'
ADMIN = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'root', 'X-Auth-Role': 'admin'}
OWNER = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'eva', 'X-Auth-Role': 'member'}
STRANGER = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'tom', 'X-Auth-Role': 'member'}


def seed(conn, eval_id: int, status: str, owner: str = 'eva'):
    conn.execute(
        'INSERT INTO evaluations (id, model_id, source, decode, status, error, owner) '
        "VALUES (?, 9, '{\"snapshot\": 24}', 'beam', ?, ?, ?)",
        (eval_id, status, 'killed for using 54 GB' if status == 'error' else None, owner))
    conn.commit()


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    monkeypatch.setattr('app.config.TRAININGS_DIR', tmp_path / 'trainings')
    (tmp_path / 'trainings' / '24' / 'snapshot' / 'valid').mkdir(parents=True)
    conn = store.connect(tmp_path / 'app.db')
    conn.execute("INSERT INTO models (id, task, name, source, checkpoint) "
                 "VALUES (9, 'ocr', 'm', 'builtin', '/ckpt.pt')")
    conn.commit()
    app.dependency_overrides[get_db] = lambda: conn
    yield TestClient(app), conn
    app.dependency_overrides.clear()
    conn.close()


def test_retrying_a_failed_evaluation_queues_it_again(client):
    api, conn = client
    seed(conn, 1, 'error')
    response = api.post('/api/evaluations/1/retry', headers=OWNER)
    assert response.status_code == 200, response.text
    assert response.json()['status'] == 'queued'
    assert response.json()['error'] is None
    row = conn.execute('SELECT status, error, pid FROM evaluations WHERE id = 1').fetchone()
    assert (row['status'], row['error'], row['pid']) == ('queued', None, None)


def test_an_admin_may_retry_someone_elses(client):
    api, conn = client
    seed(conn, 1, 'error')
    assert api.post('/api/evaluations/1/retry', headers=ADMIN).status_code == 200
    assert conn.execute('SELECT status FROM evaluations WHERE id = 1').fetchone()['status'] == 'queued'


def test_another_member_may_not(client):
    api, conn = client
    seed(conn, 1, 'error')
    assert api.post('/api/evaluations/1/retry', headers=STRANGER).status_code == 403
    assert conn.execute('SELECT status FROM evaluations WHERE id = 1').fetchone()['status'] == 'error'


@pytest.mark.parametrize('status', ['done', 'queued', 'running'])
def test_only_a_failed_one_can_be_retried(client, status):
    api, conn = client
    seed(conn, 1, status)
    assert api.post('/api/evaluations/1/retry', headers=OWNER).status_code == 409
    assert conn.execute('SELECT status FROM evaluations WHERE id = 1').fetchone()['status'] == status


def test_a_missing_evaluation_is_a_404(client):
    api, _ = client
    assert api.post('/api/evaluations/77/retry', headers=OWNER).status_code == 404


def test_an_evaluation_whose_frozen_split_is_gone_is_refused(client, tmp_path):
    """Deleting a training takes its snapshot with it and leaves the failed evaluations
    that scored on it behind. Queueing one of those again only fails again, slowly."""
    api, conn = client
    shutil.rmtree(tmp_path / 'trainings' / '24')
    seed(conn, 1, 'error')
    response = api.post('/api/evaluations/1/retry', headers=OWNER)
    assert response.status_code == 409
    assert response.json()['detail'] == 'the frozen split it scored on is gone'
    assert conn.execute('SELECT status FROM evaluations WHERE id = 1').fetchone()['status'] == 'error'


@pytest.mark.parametrize('status', ['queued', 'running'])
def test_the_owner_may_cancel_a_waiting_or_running_evaluation(client, status):
    api, conn = client
    seed(conn, 1, status)
    response = api.post('/api/evaluations/1/cancel', headers=OWNER)
    assert response.status_code == 200, response.text
    assert conn.execute('SELECT status FROM evaluations WHERE id = 1').fetchone()['status'] == 'cancelled'


def test_cancelling_a_running_evaluation_stops_its_runner(client, monkeypatch):
    api, conn = client
    seed(conn, 1, 'running')
    conn.execute('UPDATE evaluations SET pid = 4242 WHERE id = 1')
    conn.commit()
    killed = []
    monkeypatch.setattr('app.evaluator.os.kill', lambda pid, sig: killed.append(pid))
    assert api.post('/api/evaluations/1/cancel', headers=OWNER).status_code == 200
    assert killed == [4242]


def test_an_admin_may_cancel_someone_elses(client):
    api, conn = client
    seed(conn, 1, 'queued')
    assert api.post('/api/evaluations/1/cancel', headers=ADMIN).status_code == 200
    assert conn.execute('SELECT status FROM evaluations WHERE id = 1').fetchone()['status'] == 'cancelled'


def test_another_member_may_not_cancel(client):
    api, conn = client
    seed(conn, 1, 'queued')
    assert api.post('/api/evaluations/1/cancel', headers=STRANGER).status_code == 403
    assert conn.execute('SELECT status FROM evaluations WHERE id = 1').fetchone()['status'] == 'queued'


@pytest.mark.parametrize('status', ['done', 'error', 'cancelled'])
def test_a_finished_evaluation_cannot_be_cancelled(client, status):
    api, conn = client
    seed(conn, 1, status)
    assert api.post('/api/evaluations/1/cancel', headers=OWNER).status_code == 409
    assert conn.execute('SELECT status FROM evaluations WHERE id = 1').fetchone()['status'] == status


def test_a_cancelled_evaluation_can_be_retried(client):
    api, conn = client
    seed(conn, 1, 'cancelled')
    assert api.post('/api/evaluations/1/retry', headers=OWNER).status_code == 200
    assert conn.execute('SELECT status FROM evaluations WHERE id = 1').fetchone()['status'] == 'queued'


def test_the_runner_finishing_late_does_not_undo_a_cancel(client):
    """The runner writes its scores itself; a cancel that lands just before must win."""
    _, conn = client
    seed(conn, 1, 'cancelled')
    evaluator.finish(conn, 1, status='done', cer=0.1, wer=0.2, line_count=5)
    row = conn.execute('SELECT status, cer FROM evaluations WHERE id = 1').fetchone()
    assert (row['status'], row['cer']) == ('cancelled', None)


def test_a_cancelled_run_discards_its_scored_lines(client, tmp_path, monkeypatch):
    _, conn = client
    monkeypatch.setattr('app.config.EVALS_DIR', tmp_path / 'evals')
    (tmp_path / 'evals').mkdir()
    seed(conn, 1, 'queued')

    class CancelledMidway:
        pid = 4242
        returncode = -15

        def wait(self, timeout=None):
            evaluator.lines_path(1).write_text('{"line_id": 1}\n')
            conn.execute("UPDATE evaluations SET status = 'cancelled' WHERE id = 1")
            conn.commit()

    monkeypatch.setattr(evaluator, '_spawn', lambda conn, ev: CancelledMidway())
    monkeypatch.setattr(evaluator, 'memory_ceiling', lambda: None)
    evaluator.run_local(conn, 1)
    assert conn.execute('SELECT status FROM evaluations WHERE id = 1').fetchone()['status'] == 'cancelled'
    assert conn.execute('SELECT COUNT(*) FROM eval_lines WHERE evaluation_id = 1').fetchone()[0] == 0
    assert not evaluator.lines_path(1).exists()
