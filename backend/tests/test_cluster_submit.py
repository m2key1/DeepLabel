"""Who is allowed to report on a cluster run, and what a cancel reaches.

Both come from one morning: a retry started a second attempt while the first attempt's
transfer was still running, and when that one was killed its thread wrote `SIGTERM` over
the healthy run that had replaced it. The transfer itself ignored the cancel and kept
pushing 160 GB, which is what took the machine off the network.
"""
import subprocess

import pytest
from fastapi import HTTPException

from app import store, trainer
from app.routes import trainings as training_routes
from tests.fakes import FakeTrainer


@pytest.fixture
def conn(tmp_path, monkeypatch):
    monkeypatch.setattr('app.config.TRAININGS_DIR', tmp_path / 'trainings')
    monkeypatch.setattr('app.config.SLURM_HOST', 'cluster.example')
    connection = store.connect(tmp_path / 'app.db')
    connection.execute(
        "INSERT INTO trainings (id, name, task, status, owner, target, dataset_job_ids) "
        "VALUES (1, 'A run', 'ocr', 'error', 'alice', 'slurm', '[]')")
    connection.commit()
    yield connection
    connection.close()


def status(conn):
    row = conn.execute('SELECT status, error, phase, attempt, pid FROM trainings WHERE id = 1').fetchone()
    return dict(row)


class TestReportingOnTheRightAttempt:
    def test_the_attempt_that_is_running_writes(self, conn):
        trainer.set_state(conn, 1, status='running', attempt=2)

        assert trainer.set_state_for_attempt(conn, 1, 2, phase='slurm:PENDING') is True
        assert status(conn)['phase'] == 'slurm:PENDING'

    def test_the_attempt_that_was_replaced_does_not(self, conn):
        """The exact shape of the incident: attempt 1's transfer is killed, its thread
        reports the failure, and attempt 2 is by then running on the cluster."""
        trainer.set_state(conn, 1, status='running', phase='slurm:RUNNING', attempt=2, error=None)

        wrote = trainer.set_state_for_attempt(conn, 1, 1, status='error', error='rsync: SIGTERM')

        assert wrote is False
        assert status(conn) == {'status': 'running', 'error': None, 'phase': 'slurm:RUNNING',
                                'attempt': 2, 'pid': None}

    def test_a_run_that_is_gone_takes_no_writes(self, conn):
        conn.execute('DELETE FROM trainings WHERE id = 1')
        conn.commit()

        assert trainer.set_state_for_attempt(conn, 1, 1, status='error') is False


class TestClaimingARetry:
    def test_the_first_claim_moves_the_run_on(self, conn):
        assert trainer.claim_retry(conn, 1) == 2
        assert status(conn) == {'status': 'queued', 'error': None, 'phase': None,
                                'attempt': 2, 'pid': None}

    def test_the_second_finds_nothing_to_claim(self, conn):
        """Two retries racing, or a double click: only one may start a transfer, because
        the second would push the same snapshot to the same place alongside the first."""
        assert trainer.claim_retry(conn, 1) == 2

        assert trainer.claim_retry(conn, 1) is None
        assert status(conn)['attempt'] == 2

    def test_a_run_that_did_not_fail_is_not_claimable(self, conn):
        trainer.set_state(conn, 1, status='running')

        assert trainer.claim_retry(conn, 1) is None


class TestWhatACancelReaches:
    def _submit(self, conn, monkeypatch, on_transfer):
        """submit_slurm with the cluster replaced at its edges: what is under test is the
        order it does things in and what it records, not ssh. A submit only ever starts
        on a queued run - a new one, or a failed one a retry has claimed."""
        trainer.set_state(conn, 1, status='queued')
        monkeypatch.setattr(trainer, 'probe_cluster', lambda: None)
        monkeypatch.setattr(trainer, 'prepare_snapshot', lambda conn, training, **kwargs: {})
        monkeypatch.setattr(trainer, 'write_augmentation', lambda training: None)
        backend = FakeTrainer({'entrypoint': ['/srv/train.py']})
        monkeypatch.setattr('app.remote_training.training_backend', lambda _conn, _training: backend)
        monkeypatch.setattr('app.remote_training.prepare_cluster_run', lambda *a, **k: None)
        monkeypatch.setattr(trainer, '_ssh', lambda cmd: subprocess.CompletedProcess(
            cmd, 0, stdout='4711\n', stderr=''))

        def fake_rsync(src, dst, on_pid=None):
            if on_pid is not None:
                on_pid(31337)
            return on_transfer(src, dst)

        monkeypatch.setattr(trainer, '_rsync', fake_rsync)
        (trainer.config.training_dir(1)).mkdir(parents=True, exist_ok=True)
        trainer.submit_slurm(conn, 1)

    def test_the_transfer_is_killable_while_it_runs(self, conn, monkeypatch):
        seen = []

        def transfer(src, dst):
            seen.append(status(conn)['pid'])
            return subprocess.CompletedProcess(['rsync'], 0, stdout='', stderr='')

        self._submit(conn, monkeypatch, transfer)

        # The pid of the running rsync is on the row while it runs - that is what cancel
        # sends its signal to - and gone once it is over.
        assert seen == [31337]
        assert status(conn)['pid'] is None
        assert status(conn)['status'] == 'running'

    def test_a_cancelled_transfer_ends_cancelled_rather_than_failed(self, conn, monkeypatch):
        def transfer(src, dst):
            trainer.cancel(conn, 1)
            return subprocess.CompletedProcess(['rsync'], 20, stdout='',
                                               stderr='rsync error: received SIGINT')

        self._submit(conn, monkeypatch, transfer)

        assert status(conn)['status'] == 'cancelled'
        assert status(conn)['error'] is None
        assert status(conn)['pid'] is None

    def test_a_transfer_that_really_fails_still_says_so(self, conn, monkeypatch):
        def transfer(src, dst):
            return subprocess.CompletedProcess(['rsync'], 23, stdout='',
                                               stderr='rsync: mkdir failed: No space left on device')

        self._submit(conn, monkeypatch, transfer)

        assert status(conn)['status'] == 'error'
        assert 'No space left on device' in status(conn)['error']


class TestWhatTheProbeReports:
    """The probe is one ssh to the cluster, in front of the snapshot so a dead session is
    found out before minutes of cutting. What it reports has to name the cure: the dialog
    when the cluster wants its second factor, the host and the network when it never
    answered - a 2FA dialog cures nothing about a black-holed port or a name that does not
    resolve, and the repr of a timed-out command names no cure at all."""

    SECOND_FACTOR = 'the cluster asked for its second factor - connect to it from the training dialog'
    UNREACHABLE = 'the cluster could not be reached ({detail}) - check the host and the network, then retry'

    def _submit(self, conn, monkeypatch, ssh):
        trainer.set_state(conn, 1, status='queued')
        monkeypatch.setattr(trainer, '_cluster_reachable', True)
        cut = []
        monkeypatch.setattr(trainer, 'prepare_snapshot', lambda conn, training, **kwargs: cut.append(training['id']))
        monkeypatch.setattr(trainer, '_ssh', ssh)
        trainer.submit_slurm(conn, 1)
        return cut

    @staticmethod
    def _refused(stderr):
        return lambda cmd: subprocess.CompletedProcess(cmd, 255, '', stderr)

    @staticmethod
    def _hangs(cmd):
        raise subprocess.TimeoutExpired(['ssh', 'e2e@cluster.invalid', 'true'], 120)

    def test_a_connect_nobody_answers_names_the_host_and_the_network(self, conn, monkeypatch):
        cut = self._submit(conn, monkeypatch, self._hangs)

        assert cut == []
        assert status(conn) == {'status': 'error', 'phase': None, 'attempt': 1, 'pid': None,
                                'error': self.UNREACHABLE.format(detail='no answer within 120 s')}

    def test_a_host_that_does_not_resolve_is_quoted(self, conn, monkeypatch):
        cut = self._submit(conn, monkeypatch, self._refused(
            'ssh: Could not resolve hostname cluster.invalid: Name or service not known\n'))

        assert cut == []
        assert status(conn)['error'] == self.UNREACHABLE.format(
            detail='ssh: Could not resolve hostname cluster.invalid: Name or service not known')

    def test_a_cluster_asking_for_its_factor_names_the_dialog(self, conn, monkeypatch):
        cut = self._submit(conn, monkeypatch, self._refused(
            'e2e@10.0.0.1: Permission denied (keyboard-interactive).\n'))

        assert cut == []
        assert status(conn)['error'] == self.SECOND_FACTOR

    def test_either_way_the_cluster_is_reported_lost(self, conn, monkeypatch):
        self._submit(conn, monkeypatch, self._hangs)

        assert trainer.cluster_reachable() is False

    def test_a_cluster_that_answers_gives_no_reason(self, conn, monkeypatch):
        monkeypatch.setattr(trainer, '_cluster_reachable', False)
        monkeypatch.setattr(trainer, '_ssh', lambda cmd: subprocess.CompletedProcess(cmd, 0, '', ''))

        assert trainer.probe_cluster() is None
        assert trainer.cluster_reachable() is True


def test_two_retries_that_both_saw_the_failure_start_one_transfer(conn, monkeypatch):
    """The race the status check cannot catch: two requests that both read the run while
    it still said error. Only the claim tells them apart, and the loser must not start a
    second push of the same snapshot."""
    failed = dict(conn.execute('SELECT * FROM trainings WHERE id = 1').fetchone())
    # Each request's first read is the stale one; whatever it reads after that is live.
    live = trainer.get_training
    stale_reads = iter([failed, failed])
    monkeypatch.setattr(trainer, 'get_training',
                        lambda conn, training_id: next(stale_reads, None) or live(conn, training_id))
    started = []
    monkeypatch.setattr(training_routes.threading, 'Thread',
                        lambda target, args, daemon: type('T', (), {'start': lambda self: started.append(args)})())
    user = {'username': 'alice', 'role': 'admin'}

    training_routes.retry_training(1, conn=conn, user=user)
    with pytest.raises(Exception) as refused:
        training_routes.retry_training(1, conn=conn, user=user)

    assert getattr(refused.value, 'status_code', None) == 409
    assert refused.value.detail == 'this run is already being retried'
    assert started == [(1, 2)]


def test_a_retry_is_refused_once_a_model_has_taken_the_name(conn, monkeypatch):
    """A failed run registered nothing, so its name is free again and the next run takes
    it - and registers a model under it. Retrying the first would register a second model
    under that name, the very pair a new run under it is refused for, so the retry is
    refused the same way and the run stays as it was."""
    conn.execute("INSERT INTO models (task, name, checkpoint) VALUES ('ocr', 'A run', '/m.pt')")
    conn.commit()
    started = []
    monkeypatch.setattr(training_routes.threading, 'Thread',
                        lambda target, args, daemon: type('T', (), {'start': lambda self: started.append(args)})())

    with pytest.raises(HTTPException) as refused:
        training_routes.retry_training(1, conn=conn, user={'username': 'alice', 'role': 'admin'})

    assert refused.value.status_code == 409
    assert refused.value.detail == 'a ocr model named "A run" already exists'
    assert status(conn) == {'status': 'error', 'error': None, 'phase': None, 'attempt': 1, 'pid': None}
    assert started == []


def test_a_retry_of_a_run_deleted_between_its_two_reads_is_not_found(conn, monkeypatch):
    """The name rule reads the run a second time; one deleted in between is gone, not a
    server error."""
    conn.execute("INSERT INTO models (task, name, checkpoint) VALUES ('ocr', 'A run', '/m.pt')")
    conn.commit()
    reads = iter([dict(conn.execute('SELECT * FROM trainings WHERE id = 1').fetchone()), None])
    monkeypatch.setattr(trainer, 'get_training', lambda conn, training_id: next(reads))

    with pytest.raises(HTTPException) as refused:
        training_routes.retry_training(1, conn=conn, user={'username': 'alice', 'role': 'admin'})

    assert refused.value.status_code == 404
