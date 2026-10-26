"""Scoring a model on a training's frozen valid split. Two evaluations answer the only
question a training run is asked - did it help? - so the baseline and the result have to be
scored on byte-identical data, and every decode mode has to be scored, because they
disagree by more than a point of CER on material the beam LM was not built for.
"""
import json
import subprocess

import pytest

from app import decode, evaluator, store, trainer


@pytest.fixture
def conn(tmp_path, monkeypatch):
    monkeypatch.setattr('app.config.TRAININGS_DIR', tmp_path / 'trainings')
    connection = store.connect(tmp_path / 'app.db')
    connection.executescript("""
        INSERT INTO models (id, task, name, checkpoint) VALUES
            (1, 'ocr', 'Base OCR', '/models/base.pt'),
            (2, 'ocr', 'Trained OCR', '/models/trained.pt');
        INSERT INTO trainings (id, name, task, status, owner, base_model_id, created_at)
            VALUES (1, 'Sweep', 'ocr', 'running', 'alice', 1, '2026-01-01 00:00:00');
    """)
    connection.commit()
    yield connection
    connection.close()


@pytest.fixture
def training(conn):
    return dict(conn.execute('SELECT * FROM trainings WHERE id = 1').fetchone())


def write_split(tmp_path, training_id=1, pairs=(('line_1', 'Wien'),)):
    valid = tmp_path / 'trainings' / str(training_id) / 'snapshot' / 'valid'
    valid.mkdir(parents=True, exist_ok=True)
    for stem, text in pairs:
        (valid / f'{stem}.txt').write_text(text)
        (valid / f'{stem}.png').write_bytes(b'PNG' + stem.encode())
    return valid


def evaluations(conn):
    return conn.execute('SELECT * FROM evaluations ORDER BY id').fetchall()


class TestFingerprintingTheSplit:
    def test_a_training_with_no_snapshot_has_no_fingerprint(self, conn, tmp_path):
        assert evaluator.split_fingerprint(1) is None

    def test_an_empty_split_has_no_fingerprint(self, conn, tmp_path):
        (tmp_path / 'trainings' / '1' / 'snapshot' / 'valid').mkdir(parents=True)

        assert evaluator.split_fingerprint(1) is None

    def test_the_same_data_hashes_the_same_across_trainings(self, conn, tmp_path):
        """Crop names carry the line ids, so two snapshots of untouched data are
        byte-identical - which is what lets a previous score be reused."""
        write_split(tmp_path, 1)
        write_split(tmp_path, 2)

        assert evaluator.split_fingerprint(1) == evaluator.split_fingerprint(2)

    def test_changed_ground_truth_changes_it(self, conn, tmp_path):
        write_split(tmp_path, 1)
        before = evaluator.split_fingerprint(1)

        write_split(tmp_path, 1, pairs=(('line_1', 'Wien corrected'),))

        assert evaluator.split_fingerprint(1) != before

    def test_a_text_with_no_image_beside_it_is_not_part_of_the_split(self, conn, tmp_path):
        valid = write_split(tmp_path, 1)
        before = evaluator.split_fingerprint(1)

        (valid / 'orphan.txt').write_text('no image for this one')

        assert evaluator.split_fingerprint(1) == before


class TestTheBaselineScore:
    def test_every_decode_mode_is_queued(self, conn, training, tmp_path):
        """They disagree by more than a point of CER, and one number cannot show that."""
        write_split(tmp_path)

        evaluator.create_baseline(conn, training)

        assert sorted(e['decode'] for e in evaluations(conn)) == sorted(decode.OCR_DECODES)

    def test_it_scores_the_base_model_on_this_trainings_split(self, conn, training, tmp_path):
        write_split(tmp_path)

        evaluator.create_baseline(conn, training)

        first = evaluations(conn)[0]
        assert first['model_id'] == 1
        assert json.loads(first['source']) == {'snapshot': 1}
        assert first['status'] == 'queued'

    def test_a_training_from_scratch_has_no_baseline_to_score(self, conn, training):
        training['base_model_id'] = None

        evaluator.create_baseline(conn, training)

        assert evaluations(conn) == []

    def test_a_base_model_that_has_left_the_registry_is_not_scored(self, conn, training):
        training['base_model_id'] = 999

        evaluator.create_baseline(conn, training)

        assert evaluations(conn) == []


class TestNotPayingForTheSameScoreTwice:
    def test_a_previous_score_on_identical_data_is_copied_rather_than_re_run(
            self, conn, training, tmp_path):
        write_split(tmp_path)
        fingerprint = evaluator.split_fingerprint(1)
        conn.execute(
            'INSERT INTO evaluations (model_id, decode, owner, fingerprint, status, cer, wer, '
            "line_count) VALUES (1, ?, 'alice', ?, 'done', 0.042, 0.11, 500)",
            (decode.OCR_DECODES[0], fingerprint))
        conn.commit()

        evaluator.create_baseline(conn, training)

        copied = [e for e in evaluations(conn)
                  if e['training_id'] == 1 and e['decode'] == decode.OCR_DECODES[0]]
        assert len(copied) == 1
        assert copied[0]['status'] == 'done'
        assert (copied[0]['cer'], copied[0]['wer'], copied[0]['line_count']) == (0.042, 0.11, 500)

    def test_a_score_on_different_data_is_not_reused(self, conn, training, tmp_path):
        write_split(tmp_path)
        conn.execute(
            'INSERT INTO evaluations (model_id, decode, owner, fingerprint, status, cer) '
            "VALUES (1, ?, 'alice', 'a-different-split', 'done', 0.042)",
            (decode.OCR_DECODES[0],))
        conn.commit()

        evaluator.create_baseline(conn, training)

        queued = [e for e in evaluations(conn) if e['training_id'] == 1]
        assert all(e['status'] == 'queued' for e in queued)

    def test_a_score_that_never_finished_is_not_reused(self, conn, training, tmp_path):
        write_split(tmp_path)
        fingerprint = evaluator.split_fingerprint(1)
        conn.execute(
            'INSERT INTO evaluations (model_id, decode, owner, fingerprint, status, cer) '
            "VALUES (1, ?, 'alice', ?, 'error', NULL)", (decode.OCR_DECODES[0], fingerprint))
        conn.commit()

        evaluator.create_baseline(conn, training)

        assert [e['status'] for e in evaluations(conn) if e['training_id'] == 1] == \
            ['queued'] * len(decode.OCR_DECODES)

    def test_a_split_that_cannot_be_fingerprinted_is_always_re_run(self, conn, training):
        """No snapshot on disk means nothing to compare, so nothing may be assumed equal."""
        evaluator.create_baseline(conn, training)

        assert all(e['status'] == 'queued' for e in evaluations(conn))


class TestWhenTheyAreScheduled:
    """Both scores are scheduled when the run finishes. Scheduling the baseline at submit
    put a long local GPU job beside a 160 GB snapshot transfer, and on 2026-09-11 the two
    together took the machine off the network - the evaluation was then killed by the
    kernel for holding 54 GB, three times over."""

    def test_registering_the_result_schedules_the_baseline_beside_it(self, conn, training,
                                                                     tmp_path):
        write_split(tmp_path)

        evaluator.create_baseline(conn, training)
        evaluator.create_result_eval(conn, training, new_model_id=2)

        scored = {row['model_id'] for row in evaluations(conn)}
        assert scored == {1, 2}, 'the base model and what came out of the run'

    def test_a_baseline_is_not_scheduled_before_there_is_anything_to_compare(self, conn):
        """Nothing here schedules it; the trainer does, once the run has produced a model."""
        import inspect

        submit = inspect.getsource(trainer.submit_slurm)
        local = inspect.getsource(trainer.run_local)
        assert 'create_baseline' not in submit
        assert 'create_baseline' not in local
        assert 'create_baseline' in inspect.getsource(trainer.register_result)


class TestScoringWhatCameOut:
    def test_the_new_model_is_scored_on_the_same_split_in_every_mode(self, conn, training,
                                                                     tmp_path):
        write_split(tmp_path)

        evaluator.create_result_eval(conn, training, new_model_id=2)

        scored = evaluations(conn)
        assert {e['model_id'] for e in scored} == {2}
        assert sorted(e['decode'] for e in scored) == sorted(decode.OCR_DECODES)

    def test_the_pair_shares_a_fingerprint_so_the_two_numbers_are_comparable(
            self, conn, training, tmp_path):
        write_split(tmp_path)

        evaluator.create_baseline(conn, training)
        evaluator.create_result_eval(conn, training, new_model_id=2)

        assert len({e['fingerprint'] for e in evaluations(conn)}) == 1


class TestAnEmptyValidSplit:
    """The form warns when nothing would land in validation, and says what follows: the
    baseline/result comparison is skipped. A score over no lines is not a score - six of
    them came back done with a CER measured on nothing, and sat on the run page and the
    model cards as if they meant something."""

    @pytest.fixture
    def unsplit(self, training):
        training['snapshot_counts'] = json.dumps({'train': 6, 'val': 0})
        return training

    def test_the_base_model_is_not_scored(self, conn, unsplit):
        evaluator.create_baseline(conn, unsplit)

        assert evaluations(conn) == []

    def test_what_came_out_is_not_scored_either(self, conn, unsplit):
        evaluator.create_result_eval(conn, unsplit, new_model_id=2)

        assert evaluations(conn) == []

    def test_a_split_with_pairs_in_it_is_scored_as_before(self, conn, training):
        training['snapshot_counts'] = json.dumps({'train': 6, 'val': 2})

        evaluator.create_baseline(conn, training)
        evaluator.create_result_eval(conn, training, new_model_id=2)

        assert [e['model_id'] for e in evaluations(conn)] == \
            [1] * len(decode.OCR_DECODES) + [2] * len(decode.OCR_DECODES)

    def test_a_held_out_test_set_is_still_scored(self, conn, tmp_path):
        """A test set is material of its own, not the valid split: an empty split says
        nothing about it."""

        conn.execute("UPDATE trainings SET snapshot_counts = ?, test_job_ids = ? WHERE id = 1",
                     (json.dumps({'train': 6, 'val': 0}), json.dumps(['j-test'])))
        conn.commit()
        out = tmp_path / 'trainings' / '1' / 'output'
        out.mkdir(parents=True)
        (out / trainer.CHECKPOINT_NAME).write_bytes(b'ckpt')

        model_id = trainer.register_result(conn, trainer.get_training(conn, 1), out)

        assert [(e['model_id'], json.loads(e['source'])) for e in evaluations(conn)] == [
            (model_id, {'jobs': ['j-test'], 'test_pages': True}), (1, {'jobs': ['j-test'], 'test_pages': True})]


class TestTheCeiling:
    """An evaluation that eats the machine is the machine's problem, not just its own: on
    2026-09-11 one reached 54 GB and the kernel killed the largest process three times
    over. It could as easily have chosen the backend."""

    class Runner:
        """A subprocess that will not finish, holding whatever it is told to hold."""

        def __init__(self, held, waits_before_exit=None):
            self.pid = 4242
            self.held = held
            self.returncode = None
            self.killed = False
            self.waits = 0
            self.waits_before_exit = waits_before_exit

        def wait(self, timeout=None):
            self.waits += 1
            if self.waits_before_exit is not None and self.waits >= self.waits_before_exit:
                self.returncode = 0
                return 0
            if timeout is None:
                self.returncode = 0
                return 0
            raise subprocess.TimeoutExpired('eval', timeout)

        def kill(self):
            self.killed = True
            self.returncode = -9

    def test_a_run_that_grows_past_it_is_stopped(self, monkeypatch):
        monkeypatch.setattr(evaluator, 'MEMORY_POLL_SECONDS', 0.01)
        monkeypatch.setattr(evaluator, 'process_memory', lambda pid: 9 * 1024 ** 3)
        proc = self.Runner(held=9)

        overrun = evaluator._wait_within(proc, ceiling=8 * 1024 ** 3)

        assert proc.killed
        assert overrun == 9 * 1024 ** 3

    def test_a_run_that_stays_under_it_is_left_alone(self, monkeypatch):
        monkeypatch.setattr(evaluator, 'MEMORY_POLL_SECONDS', 0.01)
        monkeypatch.setattr(evaluator, 'process_memory', lambda pid: 1 * 1024 ** 3)
        proc = self.Runner(held=1, waits_before_exit=3)

        overrun = evaluator._wait_within(proc, ceiling=8 * 1024 ** 3)

        assert not proc.killed
        assert overrun is None

    def test_the_stop_is_recorded_in_words_that_say_what_happened(self, conn, training, tmp_path,
                                                                  monkeypatch):
        write_split(tmp_path)
        evaluator.create_baseline(conn, training)
        eval_id = evaluations(conn)[0]['id']
        monkeypatch.setattr(evaluator, 'memory_ceiling', lambda: 8 * 1024 ** 3)
        monkeypatch.setattr(evaluator, '_spawn', lambda *a: self.Runner(held=54))
        monkeypatch.setattr(evaluator, '_wait_within', lambda proc, ceiling: 54 * 1024 ** 3)

        evaluator.run_local(conn, eval_id)

        stored = evaluator.get_evaluation(conn, eval_id)
        assert stored['status'] == 'error'
        assert stored['error'] == 'stopped at 54.0 GB, over the 8 GB an evaluation may hold'

    def test_half_the_host_is_the_ceiling_when_nobody_configured_one(self, monkeypatch):
        monkeypatch.setattr('app.config.EVAL_MEMORY_LIMIT_GB', None)
        monkeypatch.setattr(evaluator, 'host_memory_bytes', lambda: 64 * 1024 ** 3)

        assert evaluator.memory_ceiling() == 32 * 1024 ** 3

    def test_a_configured_ceiling_wins(self, monkeypatch):
        monkeypatch.setattr('app.config.EVAL_MEMORY_LIMIT_GB', 12.0)

        assert evaluator.memory_ceiling() == 12 * 1024 ** 3

    def test_a_host_that_will_not_say_how_much_it_has_is_not_guessed_at(self, monkeypatch):
        monkeypatch.setattr('app.config.EVAL_MEMORY_LIMIT_GB', None)
        monkeypatch.setattr(evaluator, 'host_memory_bytes', lambda: None)

        assert evaluator.memory_ceiling() is None


class TestState:
    def test_a_run_can_be_moved_along_and_read_back(self, conn, training, tmp_path):
        write_split(tmp_path)
        evaluator.create_baseline(conn, training)
        eval_id = evaluations(conn)[0]['id']

        evaluator.set_state(conn, eval_id, status='done', cer=0.03)

        stored = evaluator.get_evaluation(conn, eval_id)
        assert (stored['status'], stored['cer']) == ('done', 0.03)

    def test_a_run_that_does_not_exist_reads_as_nothing(self, conn):
        assert evaluator.get_evaluation(conn, 999) is None

    def test_the_payload_parses_what_was_stored_as_json(self, conn, training, tmp_path):
        write_split(tmp_path)
        evaluator.create_baseline(conn, training)

        body = evaluator.payload(evaluations(conn)[0])

        assert body['source'] == {'snapshot': 1}


class TestDeletedWhileRunning:
    def test_a_run_whose_row_is_deleted_mid_run_ends_quietly(self, conn, training, tmp_path,
                                                            monkeypatch):
        write_split(tmp_path)
        evaluator.create_baseline(conn, training)
        eval_id = evaluations(conn)[0]['id']
        monkeypatch.setattr(evaluator, 'memory_ceiling', lambda: None)
        monkeypatch.setattr(evaluator, '_spawn', lambda *a: TestTheCeiling.Runner(held=1))

        def deleted_meanwhile(proc, ceiling):
            conn.execute('DELETE FROM evaluations WHERE id = ?', (eval_id,))
            conn.commit()

        monkeypatch.setattr(evaluator, '_wait_within', deleted_meanwhile)

        evaluator.run_local(conn, eval_id)

        assert evaluator.get_evaluation(conn, eval_id) is None


class TestLinesThatWillNotImport:
    def test_the_run_ends_in_error_rather_than_done_with_no_lines(self, conn, training, tmp_path,
                                                                 monkeypatch):
        monkeypatch.setattr('app.config.EVALS_DIR', tmp_path / 'evaluations')
        write_split(tmp_path)
        evaluator.create_baseline(conn, training)
        eval_id = evaluations(conn)[0]['id']
        monkeypatch.setattr(evaluator, 'memory_ceiling', lambda: None)
        monkeypatch.setattr(evaluator, '_spawn', lambda *a: TestTheCeiling.Runner(held=1))

        def wrote_a_torn_file(proc, ceiling):
            evaluator.lines_path(eval_id).parent.mkdir(parents=True, exist_ok=True)
            evaluator.lines_path(eval_id).write_text('{"line_id": 1, "trut\n')

        monkeypatch.setattr(evaluator, '_wait_within', wrote_a_torn_file)

        evaluator.run_local(conn, eval_id)

        stored = evaluator.get_evaluation(conn, eval_id)
        assert (stored['status'], stored['pid']) == ('error', None)
        assert stored['error'].startswith('could not import the scored lines: JSONDecodeError')
        assert conn.execute('SELECT COUNT(*) FROM eval_lines').fetchone()[0] == 0
