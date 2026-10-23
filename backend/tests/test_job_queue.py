"""Which piece of work the single GPU takes next, and the two rules around it: datasets,
trainings and evaluations share one queue oldest-first, and a map-predict run has to be
resolved to a checkpoint and a class list before it can be spawned at all.

The worker loop and the subprocess spawn are not here - they are threads around this logic,
and the e2e stack drives them for real.
"""
import sqlite3

import pytest

from app import jobs, map_classes, store


@pytest.fixture
def conn(tmp_path):
    connection = store.connect(tmp_path / 'app.db')
    yield connection
    connection.close()


def queue_job(conn, job_id='j1', created_at='2026-01-02 00:00:00', status='queued'):
    conn.execute('INSERT INTO jobs (id, name, owner, status, created_at) VALUES (?,?,?,?,?)',
                 (job_id, job_id, 'alice', status, created_at))
    conn.commit()


def queue_training(conn, training_id=1, created_at='2026-01-01 00:00:00', target='local',
                   status='queued'):
    conn.execute('INSERT INTO trainings (id, name, task, status, owner, target, created_at) '
                 "VALUES (?,?,'ocr',?,'alice',?,?)",
                 (training_id, f'training {training_id}', status, target, created_at))
    conn.commit()


def queue_evaluation(conn, evaluation_id=1, created_at='2026-01-03 00:00:00', status='queued'):
    conn.execute("INSERT OR IGNORE INTO models (id, task, name, checkpoint) "
                 "VALUES (1, 'ocr', 'Shipped', '/models/ocr.pt')")
    conn.execute('INSERT INTO evaluations (id, model_id, status, owner, created_at) '
                 'VALUES (?,1,?,?,?)', (evaluation_id, status, 'alice', created_at))
    conn.commit()


class TestWhatRunsNext:
    def test_nothing_queued_means_nothing_to_do(self, conn):
        assert jobs._next_work(conn) is None

    def test_a_queued_dataset_is_work(self, conn):
        queue_job(conn)

        assert jobs._next_work(conn) == ('job', 'j1')

    def test_the_oldest_of_the_three_kinds_goes_first(self, conn):
        """One GPU, one queue: a training queued before a dataset is not overtaken by it."""
        queue_job(conn, created_at='2026-01-02 00:00:00')
        queue_training(conn, created_at='2026-01-01 00:00:00')

        assert jobs._next_work(conn) == ('training', 1)

    def test_an_evaluation_waits_its_turn_like_the_rest(self, conn):
        queue_evaluation(conn, created_at='2026-01-01 00:00:00')
        queue_job(conn, created_at='2026-01-02 00:00:00')

        assert jobs._next_work(conn) == ('evaluation', 1)

    def test_a_training_bound_for_the_cluster_does_not_hold_the_local_gpu(self, conn):
        queue_training(conn, target='slurm', created_at='2026-01-01 00:00:00')
        queue_job(conn, created_at='2026-01-02 00:00:00')

        assert jobs._next_work(conn) == ('job', 'j1')

    def test_work_that_is_not_waiting_is_not_picked_up(self, conn):
        queue_job(conn, status='running')
        queue_training(conn, status='done')
        queue_evaluation(conn, status='error')

        assert jobs._next_work(conn) is None

    def test_the_oldest_of_several_datasets_goes_first(self, conn):
        queue_job(conn, 'later', created_at='2026-01-05 00:00:00')
        queue_job(conn, 'earlier', created_at='2026-01-01 00:00:00')

        assert jobs._next_work(conn) == ('job', 'earlier')


class TestWhenWorkWasQueued:
    """A dataset made long ago and re-run today queues today: it waits behind what was
    queued before it, and its wait is counted from when it was queued."""

    def test_an_old_dataset_run_again_waits_behind_what_was_queued_first(self, conn):
        queue_job(conn, 'old', created_at='2025-11-01 00:00:00', status='done')
        queue_job(conn, 'new', created_at='2026-01-02 00:00:00')
        conn.execute("UPDATE jobs SET status = 'queued' WHERE id = 'old'")

        assert jobs._next_work(conn) == ('job', 'new')

    def test_its_wait_counts_from_when_it_was_queued(self, conn):
        queue_job(conn, 'old', created_at='2025-11-01 00:00:00', status='done')
        conn.execute("UPDATE jobs SET status = 'queued' WHERE id = 'old'")

        queued_at, now = conn.execute("SELECT queued_at, datetime('now') FROM jobs WHERE id = 'old'").fetchone()
        assert queued_at == now

    def test_a_run_interrupted_by_a_restart_keeps_its_place(self, conn):
        queue_job(conn, 'old', created_at='2025-11-01 00:00:00', status='done')
        conn.execute("UPDATE jobs SET status = 'queued' WHERE id = 'old'")
        conn.execute("UPDATE jobs SET queued_at = '2026-01-01 00:00:00' WHERE id = 'old'")
        conn.execute("UPDATE jobs SET status = 'running' WHERE id = 'old'")
        queue_job(conn, 'new', created_at='2026-01-02 00:00:00')
        conn.execute("UPDATE jobs SET status = 'queued' WHERE id = 'old'")

        assert jobs._next_work(conn) == ('job', 'old')

    def test_a_training_retried_waits_behind_what_was_queued_first(self, conn):
        queue_training(conn, created_at='2025-11-01 00:00:00', status='error')
        queue_job(conn, created_at='2026-01-02 00:00:00')
        conn.execute("UPDATE trainings SET status = 'queued' WHERE id = 1")

        assert jobs._next_work(conn) == ('job', 'j1')


class TestCancelling:
    def test_a_dataset_that_never_started_is_simply_marked(self, conn):
        queue_job(conn)

        assert jobs.cancel_job(conn, 'j1') is True
        assert conn.execute("SELECT status FROM jobs WHERE id = 'j1'").fetchone()[0] == 'cancelled'

    def test_a_running_one_has_its_process_signalled(self, conn, monkeypatch):
        queue_job(conn, status='running')
        conn.execute("UPDATE jobs SET pid = 4242 WHERE id = 'j1'")
        conn.commit()
        killed = []
        monkeypatch.setattr('app.jobs.os.kill', lambda pid, sig: killed.append((pid, sig)))

        jobs.cancel_job(conn, 'j1')

        assert killed and killed[0][0] == 4242

    def test_a_process_that_has_already_gone_is_not_an_error(self, conn, monkeypatch):
        queue_job(conn, status='running')
        conn.execute("UPDATE jobs SET pid = 4242 WHERE id = 'j1'")
        conn.commit()

        def gone(pid, sig):
            raise ProcessLookupError

        monkeypatch.setattr('app.jobs.os.kill', gone)

        assert jobs.cancel_job(conn, 'j1') is True

    def test_a_dataset_that_does_not_exist_cannot_be_cancelled(self, conn):
        assert jobs.cancel_job(conn, 'nope') is False

    @pytest.mark.parametrize('finished', ['done', 'error', 'cancelled'])
    def test_a_dataset_that_is_over_stays_as_it_ended(self, conn, monkeypatch, finished):
        queue_job(conn, status=finished)
        conn.execute("UPDATE jobs SET pid = 4242 WHERE id = 'j1'")
        conn.commit()
        killed = []
        monkeypatch.setattr('app.jobs.os.kill', lambda pid, sig: killed.append(pid))

        assert jobs.cancel_job(conn, 'j1') is False
        assert conn.execute("SELECT status FROM jobs WHERE id = 'j1'").fetchone()[0] == finished
        assert killed == []


class TestTheReReadSweep:
    def test_it_says_nothing_until_the_batcher_has_started(self, monkeypatch):
        monkeypatch.setattr('app.jobs._next_reocr_pass', 0.0)

        assert jobs.next_reocr_pass_in() is None

    def test_it_counts_down_to_the_next_sweep(self, monkeypatch):
        import time
        monkeypatch.setattr('app.jobs._next_reocr_pass', time.time() + 30)

        assert 0 < jobs.next_reocr_pass_in() <= 30

    def test_a_sweep_already_due_reads_as_no_wait_rather_than_a_negative(self, monkeypatch):
        import time
        monkeypatch.setattr('app.jobs._next_reocr_pass', time.time() - 10)

        assert jobs.next_reocr_pass_in() == 0.0


class TestWhichClassesAPredictRunExtracts:
    def test_a_polygon_job_takes_what_it_and_the_model_share(self, conn):
        """A class the user deleted from the job is never re-introduced by prediction."""
        assert jobs.predict_classes('map_segmentation', [1, 2, 3], {2, 3, 4}) == ([2, 3], None)

    def test_a_polygon_job_falls_back_to_the_models_own_set(self, conn):
        """Sharing nothing would extract nothing, which is worse than offering everything."""
        assert jobs.predict_classes('map_segmentation', [9], {2, 3}) == ([2, 3], None)

    def test_a_line_job_takes_every_surface_the_model_finds(self, conn):
        """Its vocabulary is the single edge-lines class, so intersecting would extract
        only that id's surfaces and silently lose every other outline."""
        class_ids, merge = jobs.predict_classes('map_lines', [7], {2, 3, 4})

        assert class_ids == [2, 3, 4]
        assert merge == 7, 'all merged onto the one class the job has'

    def test_a_line_job_with_no_classes_of_its_own_uses_the_shipped_one(self, conn):
        _, merge = jobs.predict_classes('map_lines', [], {2, 3})

        assert merge == map_classes.LINE_CLASS_ID


class TestResolvingAMapPredictRun:
    """Everything the runner needs, and a readable failure for each way it can be missing -
    the alternative is a subprocess that dies with a traceback nobody sees."""

    def seed(self, conn, task='map_segmentation', model_id=None, classes=((1, 'Building'),)):
        conn.execute('INSERT INTO jobs (id, name, owner, status, task, model_id) '
                     "VALUES ('m1', 'Map', 'alice', 'queued', ?, ?)", (task, model_id))
        for class_id, name in classes:
            conn.execute('INSERT INTO job_classes (job_id, class_id, name, color, priority_rank) '
                         "VALUES ('m1', ?, ?, '\"#fff\"', ?)", (class_id, name, class_id))
        conn.commit()

    def test_a_job_with_no_model_falls_back_to_the_shipped_checkpoint(self, conn, tmp_path,
                                                                     monkeypatch):
        checkpoint = tmp_path / 'mapseg.pt'
        checkpoint.write_bytes(b'weights')
        monkeypatch.setattr('app.config.MAPSEG_CHECKPOINT', str(checkpoint))
        self.seed(conn)

        ckpt, num_classes, class_ids, merge = jobs._map_runner_config(conn, 'm1')

        assert (ckpt, num_classes, merge) == (checkpoint, 6, None)
        assert class_ids == [1]

    def test_a_model_that_has_left_the_registry_is_named_in_the_failure(self, conn, monkeypatch):
        monkeypatch.setattr('app.model_registry.get_model', lambda model_id: None)
        self.seed(conn, model_id='gone-model')

        with pytest.raises(RuntimeError, match='gone-model'):
            jobs._map_runner_config(conn, 'm1')

    def test_a_checkpoint_that_is_not_on_disk_is_named_in_the_failure(self, conn, tmp_path,
                                                                     monkeypatch):
        monkeypatch.setattr('app.config.MAPSEG_CHECKPOINT', str(tmp_path / 'absent.pt'))
        self.seed(conn)

        with pytest.raises(RuntimeError, match='absent.pt'):
            jobs._map_runner_config(conn, 'm1')

    def test_the_head_size_comes_from_the_model_rather_than_the_job(self, conn, tmp_path,
                                                                   monkeypatch):
        checkpoint = tmp_path / 'model.pt'
        checkpoint.write_bytes(b'weights')
        model = {'id': 'm', 'classes': [{'id': 0, 'name': 'background'},
                                        {'id': 1, 'name': 'Building'},
                                        {'id': 2, 'name': 'Water'}]}
        monkeypatch.setattr('app.model_registry.get_model', lambda model_id: model)
        monkeypatch.setattr('app.model_registry.checkpoint_path', lambda m: checkpoint)
        self.seed(conn, model_id='m', classes=((1, 'Building'),))

        _, num_classes, class_ids, _ = jobs._map_runner_config(conn, 'm1')

        assert num_classes == 3, 'the checkpoint head size, not what the job draws'
        assert class_ids == [1], 'and a class the job dropped is not re-introduced'


class TestTheWorkerSurvivesAFailingPiece:
    class Stop(BaseException):
        pass

    def test_one_failing_evaluation_is_marked_and_the_next_work_is_picked_up(
            self, conn, tmp_path, monkeypatch):
        monkeypatch.setattr('app.config.DB_PATH', tmp_path / 'app.db')
        queue_evaluation(conn, 1, status='queued')
        polls = []

        def next_work(worker_conn):
            polls.append(1)
            if len(polls) == 1:
                return ('evaluation', 1)
            raise self.Stop

        def broken(worker_conn, eval_id):
            raise RuntimeError('boom')

        monkeypatch.setattr(jobs, '_next_work', next_work)
        monkeypatch.setattr(jobs.evaluator, 'run_local', broken)

        with pytest.raises(self.Stop):
            jobs._worker_loop()

        assert len(polls) == 2
        row = conn.execute('SELECT status, error FROM evaluations WHERE id = 1').fetchone()
        assert (row['status'], row['error']) == ('error', 'RuntimeError: boom')

    def test_a_failure_that_cannot_be_recorded_does_not_stop_the_worker(
            self, conn, tmp_path, monkeypatch):
        monkeypatch.setattr('app.config.DB_PATH', tmp_path / 'app.db')
        polls = []

        def next_work(worker_conn):
            polls.append(1)
            if len(polls) == 1:
                return ('evaluation', 1)
            raise self.Stop

        def broken(worker_conn, eval_id):
            raise RuntimeError('boom')

        def locked(*args):
            raise sqlite3.OperationalError('database is locked')

        monkeypatch.setattr(jobs, '_next_work', next_work)
        monkeypatch.setattr(jobs.evaluator, 'run_local', broken)
        monkeypatch.setattr(jobs, '_fail_work', locked)

        with pytest.raises(self.Stop):
            jobs._worker_loop()

        assert len(polls) == 2


class TestAFinishedRunIsAlwaysSynced:
    class Runner:
        pid = 4242
        returncode = 0

        def wait(self):
            return 0

    def test_the_dataset_is_rebuilt_even_when_recording_the_end_raises(self, conn, tmp_path,
                                                                      monkeypatch):
        monkeypatch.setattr('app.config.JOBS_DIR', tmp_path / 'jobs')
        queue_job(conn, 'j1')
        synced = []
        writes = []
        record = store.set_job_state

        def set_job_state(state_conn, job_id, **fields):
            writes.append(fields)
            if len(writes) == 2:
                raise sqlite3.OperationalError('database is locked')
            record(state_conn, job_id, **fields)

        monkeypatch.setattr(jobs, '_spawn_runner', lambda *a: self.Runner())
        monkeypatch.setattr(jobs.store, 'set_job_state', set_job_state)
        monkeypatch.setattr(jobs.dataset_sync, 'enqueue', synced.append)

        with pytest.raises(sqlite3.OperationalError):
            jobs._run_work(conn, 'job', 'j1')

        assert writes[0] == {'status': 'running', 'pid': 4242}
        assert synced == ['j1']
