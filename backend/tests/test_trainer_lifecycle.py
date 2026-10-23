"""Reading a training run, and taking one away. The two things that carry real risk are
here: the account a cluster run is charged to, which is written into an #SBATCH directive,
and deleting a run, which takes the checkpoint of any model it produced with it - so every
reference to that model has to be cleared or the app points at a file that is gone.

The SSH and rsync plumbing is not here; it talks to a cluster, and mocking it end to end
would test the mock.
"""
import os

import pytest

from app import store, trainer
from tests.fakes import FakeTrainer


@pytest.fixture
def conn(tmp_path, monkeypatch):
    monkeypatch.setattr('app.config.TRAININGS_DIR', tmp_path / 'trainings')
    monkeypatch.setattr('app.config.SLURM_HOST', '')
    connection = store.connect(tmp_path / 'app.db')
    connection.executescript("""
        INSERT INTO models (id, task, name, checkpoint) VALUES
            (1, 'ocr', 'Base OCR', '/models/base.pt'),
            (2, 'ocr', 'What it produced', '/trainings/1/output/best_model.pt');
        INSERT INTO jobs (id, name, owner, status, model_ocr_id)
            VALUES ('j1', 'Volume', 'alice', 'done', 2);
        INSERT INTO trainings (id, name, task, status, owner, target, model_id, base_model_id,
                               created_at)
            VALUES (1, 'A run', 'ocr', 'done', 'alice', 'local', 2, 1, '2026-01-01 00:00:00');
    """)
    connection.commit()
    yield connection
    connection.close()


@pytest.fixture
def training(conn):
    return trainer.get_training(conn, 1)


def write_log(tmp_path, name, text, training_id=1):
    directory = tmp_path / 'trainings' / str(training_id)
    directory.mkdir(parents=True, exist_ok=True)
    (directory / name).write_text(text)
    return directory / name


class TestReadingProgress:
    def test_a_run_that_has_written_nothing_has_no_points(self, tmp_path):
        assert trainer.parse_progress(tmp_path / 'absent.jsonl') == []

    def test_the_lines_of_one_epoch_are_merged_into_one_point(self, tmp_path):
        """The trainer emits a loss line and a cer line separately."""
        path = tmp_path / 'progress.jsonl'
        path.write_text('{"epoch": 1, "loss": 0.5}\n{"epoch": 1, "cer": 0.08}\n')

        assert trainer.parse_progress(path) == [{'epoch': 1, 'loss': 0.5, 'cer': 0.08}]

    def test_epochs_keep_the_order_they_arrived_in(self, tmp_path):
        path = tmp_path / 'progress.jsonl'
        path.write_text('{"epoch": 2, "loss": 0.4}\n{"epoch": 1, "loss": 0.5}\n')

        assert [p['epoch'] for p in trainer.parse_progress(path)] == [2, 1]

    def test_a_half_written_line_is_skipped_rather_than_fatal(self, tmp_path):
        """The file is read while it is being appended to."""
        path = tmp_path / 'progress.jsonl'
        path.write_text('{"epoch": 1, "loss": 0.5}\n{"epoch": 2, "los\n')

        assert trainer.parse_progress(path) == [{'epoch': 1, 'loss': 0.5}]

    def test_a_line_that_is_not_an_object_is_skipped(self, tmp_path):
        path = tmp_path / 'progress.jsonl'
        path.write_text('[1, 2, 3]\n\n{"epoch": 1, "loss": 0.5}\n')

        assert trainer.parse_progress(path) == [{'epoch': 1, 'loss': 0.5}]

    def test_lines_without_an_epoch_are_kept_as_their_own_points(self, tmp_path):
        path = tmp_path / 'progress.jsonl'
        path.write_text('{"loss": 0.5}\n{"loss": 0.4}\n')

        assert len(trainer.parse_progress(path)) == 2


class TestWhyItDied:
    def test_the_named_exception_is_what_comes_back(self, tmp_path):
        error = trainer.extract_error(
            'Epoch 1 done\nTraceback (most recent call last):\n'
            '  File "train.py", line 1\nRuntimeError: CUDA out of memory\n')

        assert error == 'RuntimeError: CUDA out of memory'

    def test_a_named_exception_beats_a_generic_error_line(self, tmp_path):
        """srun's exit-code notice is not the reason anything failed."""
        error = trainer.extract_error(
            'ValueError: no checked lines\nsrun: error: node1: task 0: Exited with code 1\n')

        assert error.startswith('ValueError')

    def test_a_generic_error_is_better_than_nothing(self, tmp_path):
        assert trainer.extract_error('srun: error: node1: task 0: Exited with code 1') == \
            'error: node1: task 0: Exited with code 1'

    def test_a_log_that_names_nothing_gives_nothing(self, tmp_path):
        assert trainer.extract_error('Epoch 1 done\nEpoch 2 done\n') is None

    def test_a_very_long_line_is_cut_rather_than_stored_whole(self, tmp_path):
        error = trainer.extract_error('RuntimeError: ' + 'x' * 1000)

        assert len(error) <= 300


class TestTheLogTail:
    def test_a_local_run_reads_its_own_log(self, conn, training, tmp_path):
        write_log(tmp_path, 'training.log', 'first\nsecond\n')

        assert trainer.read_log_tail(training) == 'first\nsecond'

    def test_a_run_with_no_log_yet_reads_as_empty(self, conn, training):
        assert trainer.read_log_tail(training) == ''

    def test_a_cluster_run_prefers_the_full_log_it_fetched(self, conn, tmp_path):
        # The order a real run writes them in: the tail all through the job, the full
        # log once it finishes.
        tail = write_log(tmp_path, 'slurm.tail', 'only the tail')
        full = write_log(tmp_path, 'slurm.out', 'the whole thing')
        os.utime(tail, (1, 1))
        os.utime(full, (2, 2))
        slurm = {**dict(trainer.get_training(conn, 1)), 'target': 'slurm'}

        assert trainer.read_log_tail(slurm) == 'the whole thing'

    def test_a_retried_run_shows_the_live_tail_over_the_last_attempts_log(self, conn, tmp_path):
        """A failed attempt leaves a full slurm.out behind. Preferring it outright showed
        the dead attempt's output for the whole of the next run, which is what 'the
        terminal feed is not live' looked like."""
        stale = write_log(tmp_path, 'slurm.out', 'the attempt that died')
        live = write_log(tmp_path, 'slurm.tail', 'epoch 7 of the run going on now')
        os.utime(stale, (1, 1))
        os.utime(live, (2, 2))
        slurm = {**dict(trainer.get_training(conn, 1)), 'target': 'slurm'}

        assert trainer.read_log_tail(slurm) == 'epoch 7 of the run going on now'

    def test_and_falls_back_to_the_tail_it_has(self, conn, tmp_path):
        write_log(tmp_path, 'slurm.tail', 'only the tail')
        slurm = {**dict(trainer.get_training(conn, 1)), 'target': 'slurm'}

        assert trainer.read_log_tail(slurm) == 'only the tail'

    def test_only_the_last_lines_are_kept(self, conn, tmp_path):
        write_log(tmp_path, 'training.log',
                  '\n'.join(str(i) for i in range(trainer.LOG_TAIL_LINES + 50)))
        training = trainer.get_training(conn, 1)

        assert len(trainer.read_log_tail(training).splitlines()) == trainer.LOG_TAIL_LINES


class TestWhatComesBackFromTheCluster:
    def test_a_log_tail_cut_mid_character_does_not_kill_the_poll(self, monkeypatch):
        """srun writes tqdm bars, and `tail -n 80` cuts one mid-character. Decoding that
        strictly raised out of every poll from the first bar on: the live log, the run's
        phase and its progress all froze for the rest of the job, and only the final
        fetch - which decodes leniently - ever landed."""
        monkeypatch.setattr(trainer, '_ssh_base',
                            lambda: ['bash', '-c', r'printf "Epoch 1/20 \xe2\x96"'])

        out = trainer._ssh(['tail', '-n', '80', 'slurm.out'])

        assert out.returncode == 0
        assert out.stdout.startswith('Epoch 1/20 ')


class TestTheAccountARunIsChargedTo:
    """It ends up in an #SBATCH directive, so anything that is not an account name is
    dropped rather than escaped."""

    @pytest.mark.parametrize('value', ['admin', 'proj_2026', 'a-b.c', 'A1'])
    def test_an_account_name_passes_through(self, value):
        assert trainer.sanitize_slurm_account(value) == value

    @pytest.mark.parametrize('value', [
        'admin; rm -rf /', 'admin && curl evil', '$(whoami)', '`id`', 'admin\nmore',
        'admin"', "admin'", 'admin/../root', '', '   ', None,
    ])
    def test_anything_that_is_not_one_is_dropped_entirely(self, value):
        assert trainer.sanitize_slurm_account(value) == ''

    def test_surrounding_space_is_trimmed_rather_than_making_it_invalid(self):
        assert trainer.sanitize_slurm_account('  admin  ') == 'admin'


class TestTheBatchForTheCardItLandsOn:
    """The batch per GPU is what the run's backend measured for the card it lands on."""

    @pytest.fixture(autouse=True)
    def measured(self, monkeypatch):
        backend = FakeTrainer({'resources': {'batch_by_gpu': {'h200': 76, 'l40s': 22},
                                             'default_batch': {'local': 8, 'cluster': 16}}})
        monkeypatch.setattr('app.remote_training.training_backend', lambda _conn, _training: backend)
        return backend

    @staticmethod
    def batch(target='slurm', gpu_type=None, asked=None) -> int:
        return trainer.run_scaling(None, 'ocr', target, gpu_type, 1, None, asked)['batch_size']

    def test_each_card_takes_the_batch_its_backend_measured(self):
        assert (self.batch(gpu_type='h200'), self.batch(gpu_type='l40s')) == (76, 22)

    def test_with_no_choice_it_follows_what_the_cluster_default_names(self, monkeypatch):
        """The job script falls back to SLURM_GRES, so the batch has to follow the same
        card - asking for an h200 batch on an l40s is an out-of-memory crash."""
        monkeypatch.setattr('app.config.SLURM_GRES', 'gpu:l40s:2')

        assert self.batch() == 22

    def test_a_card_the_backend_did_not_measure_takes_its_cluster_default(self, monkeypatch):
        monkeypatch.setattr('app.config.SLURM_GRES', 'gpu:2')

        assert (self.batch(gpu_type='rtx6000bb'), self.batch()) == (16, 16)

    def test_a_local_run_takes_the_backends_local_default(self):
        assert self.batch(target='local') == 8

    def test_a_batch_asked_for_wins(self):
        assert self.batch(gpu_type='h200', asked=12) == 12

    def test_a_backend_that_declares_no_batch_leaves_the_fallback(self, measured):
        measured.train['resources'] = {}

        assert (self.batch(gpu_type='h200'), self.batch(target='local')) == (
            trainer.FALLBACK_BATCH, trainer.FALLBACK_BATCH)


class TestCancelling:
    def test_a_queued_run_is_simply_marked(self, conn):
        trainer.set_state(conn, 1, status='queued')

        assert trainer.cancel(conn, 1) is True
        assert trainer.get_training(conn, 1)['status'] == 'cancelled'

    def test_a_running_one_has_its_process_signalled(self, conn, monkeypatch):
        trainer.set_state(conn, 1, status='running', pid=4242)
        killed = []
        monkeypatch.setattr(os, 'kill', lambda pid, sig: killed.append(pid))

        trainer.cancel(conn, 1)

        assert killed == [4242]

    def test_a_process_that_has_already_gone_is_not_an_error(self, conn, monkeypatch):
        trainer.set_state(conn, 1, status='running', pid=4242)

        def gone(pid, sig):
            raise ProcessLookupError

        monkeypatch.setattr(os, 'kill', gone)

        assert trainer.cancel(conn, 1) is True

    def test_a_run_that_is_still_preparing_can_be_stopped(self, conn):
        trainer.set_state(conn, 1, status='preparing')

        assert trainer.cancel(conn, 1) is True
        assert trainer.get_training(conn, 1)['status'] == 'cancelled'

    @pytest.mark.parametrize('finished', ['done', 'error', 'cancelled'])
    def test_a_run_that_is_over_stays_as_it_ended(self, conn, monkeypatch, finished):
        """A stale tab's Cancel must not turn a finished run - and the model it
        registered - into one that looks as if it never completed."""
        trainer.set_state(conn, 1, status=finished, pid=4242)
        killed = []
        monkeypatch.setattr(os, 'kill', lambda pid, sig: killed.append(pid))

        assert trainer.cancel(conn, 1) is False
        assert trainer.get_training(conn, 1)['status'] == finished
        assert killed == []

    def test_a_run_that_does_not_exist_cannot_be_cancelled(self, conn):
        assert trainer.cancel(conn, 999) is False


class TestDeleting:
    def test_the_directory_and_the_row_go(self, conn, training, tmp_path):
        directory = tmp_path / 'trainings' / '1'
        directory.mkdir(parents=True)
        (directory / 'training.log') .write_text('log')

        trainer.delete(conn, training)

        assert not directory.exists()
        assert trainer.get_training(conn, 1) is None

    def test_the_model_it_produced_goes_with_it(self, conn, training):
        """Its checkpoint lives in the deleted directory, so leaving the row behind
        would point the app at a file that is gone."""
        trainer.delete(conn, training)

        assert conn.execute('SELECT COUNT(*) c FROM models WHERE id = 2').fetchone()['c'] == 0

    def test_every_reference_to_that_model_is_cleared_first(self, conn, training):
        """A dataset set to run it falls back to the task default rather than breaking."""
        trainer.delete(conn, training)

        assert conn.execute("SELECT model_ocr_id FROM jobs WHERE id = 'j1'").fetchone()[0] is None

    def test_a_training_that_used_it_as_a_base_loses_the_reference(self, conn, training):
        conn.execute("INSERT INTO trainings (id, name, task, status, owner, target, "
                     "base_model_id, created_at) VALUES (2, 'Later', 'ocr', 'queued', 'alice', "
                     "'local', 2, '2026-02-01 00:00:00')")
        conn.commit()

        trainer.delete(conn, training)

        assert conn.execute('SELECT base_model_id FROM trainings WHERE id = 2').fetchone()[0] is None

    def test_queued_scores_go_because_the_split_they_would_read_is_gone(self, conn, training):
        conn.execute("INSERT INTO evaluations (model_id, training_id, decode, owner, status) "
                     "VALUES (1, 1, 'greedy', 'alice', 'queued')")
        conn.commit()

        trainer.delete(conn, training)

        assert conn.execute('SELECT COUNT(*) c FROM evaluations').fetchone()['c'] == 0

    def test_a_finished_score_of_another_model_is_kept_but_unlinked(self, conn, training):
        conn.execute("INSERT INTO evaluations (model_id, training_id, decode, owner, status, cer) "
                     "VALUES (1, 1, 'greedy', 'alice', 'done', 0.04)")
        conn.commit()

        trainer.delete(conn, training)

        row = conn.execute('SELECT training_id, cer FROM evaluations').fetchone()
        assert (row['training_id'], row['cer']) == (None, 0.04)


class TestReadingOneBack:
    def test_a_run_that_does_not_exist_reads_as_nothing(self, conn):
        assert trainer.get_training(conn, 999) is None

    def test_the_payload_parses_the_lists_it_stores_as_json(self, conn):
        body = trainer.training_payload(
            conn.execute('SELECT * FROM trainings WHERE id = 1').fetchone())

        assert isinstance(body['dataset_job_ids'], list)
        assert body['task'] == 'ocr'

    def test_cancellation_is_visible_to_the_runner_mid_flight(self, conn):
        assert trainer.is_cancelled(conn, 1) is False

        trainer.set_state(conn, 1, status='cancelled')

        assert trainer.is_cancelled(conn, 1) is True


class TestTheLanguageModelOfARetriedRun:
    """A retry rebuilds the run's language model. Until it has, the folder the attempt
    before left behind says nothing about how this attempt's build goes."""

    @pytest.mark.parametrize('artefacts', [('domain.bin', 'domain.dict'), ()])
    @pytest.mark.parametrize('status', ['queued', 'preparing'])
    def test_the_old_attempts_folder_is_not_reported(self, conn, tmp_path, artefacts, status):
        conn.execute("UPDATE trainings SET status = 'error', build_lm = 1, lm_build = 'failed' "
                     'WHERE id = 1')
        conn.commit()
        lm_dir = tmp_path / 'trainings' / '1' / 'lm'
        lm_dir.mkdir(parents=True)
        for name in artefacts:
            (lm_dir / name).write_bytes(b'lm')

        assert trainer.claim_retry(conn, 1) is not None
        trainer.set_state(conn, 1, status=status)

        row = conn.execute('SELECT * FROM trainings WHERE id = 1').fetchone()
        assert trainer.training_payload(row)['lm_build'] is None

    def test_a_retry_that_fails_before_its_build_reports_no_language_model(self, conn, tmp_path):
        conn.execute("UPDATE trainings SET status = 'error', build_lm = 1, lm_build = 'built' "
                     'WHERE id = 1')
        conn.commit()
        lm_dir = tmp_path / 'trainings' / '1' / 'lm'
        lm_dir.mkdir(parents=True)
        for name in ('domain.bin', 'domain.dict'):
            (lm_dir / name).write_bytes(b'lm')

        assert trainer.claim_retry(conn, 1) is not None
        trainer.set_state(conn, 1, status='error', error='snapshot transfer failed')

        row = conn.execute('SELECT * FROM trainings WHERE id = 1').fetchone()
        assert trainer.training_payload(row)['lm_build'] is None
        assert trainer.lm_paths(1) is None
