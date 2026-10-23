import subprocess

import pytest

from app import store, trainer
from tests.fakes import FakeTrainer


def test_parse_progress_merges_loss_and_cer_lines_per_epoch(tmp_path):
    f = tmp_path / 'progress.jsonl'
    f.write_text('{"epoch": 1, "loss": 2.5}\n'
                 '{"epoch": 1, "cer": 0.4, "best_cer": 0.4}\n'
                 'garbage line\n'
                 '{"epoch": 2, "loss": 1.9}\n', encoding='utf-8')
    assert trainer.parse_progress(f) == [
        {'epoch': 1, 'loss': 2.5, 'cer': 0.4, 'best_cer': 0.4},
        {'epoch': 2, 'loss': 1.9},
    ]


def test_parse_progress_of_a_missing_file_is_empty(tmp_path):
    assert trainer.parse_progress(tmp_path / 'nope.jsonl') == []


def test_extract_error_finds_the_exception_line():
    log = ('Epoch 1/1: 0it\n'
           'Traceback (most recent call last):\n'
           '  File "train.py", line 425, in main\n'
           'FileNotFoundError: No valid image-text pairs found in directory: /snap/train\n'
           'srun: error: task 0: Exited with exit code 1\n')
    assert trainer.extract_error(log) == (
        'FileNotFoundError: No valid image-text pairs found in directory: /snap/train')


def test_extract_error_returns_none_for_clean_logs():
    assert trainer.extract_error('Epoch 1/1 done\nBest CER so far: 0.08\n') is None


@pytest.fixture
def slurm_config(monkeypatch):
    monkeypatch.setattr('app.config.SLURM_PARTITION', 'compute')
    monkeypatch.setattr('app.config.SLURM_ACCOUNT', 'admin-test-0005')
    monkeypatch.setattr('app.config.SLURM_GRES', 'gpu:h200:1')
    monkeypatch.setattr('app.config.SLURM_CPUS', '16')
    monkeypatch.setattr('app.config.SLURM_MEM', '64G')
    monkeypatch.setattr('app.config.SLURM_TIME', '')


IMAGE = '/images/ocr.sqsh'


def sbatch(training: dict) -> str:
    return trainer._backend_sbatch_script(training, IMAGE, ['/srv/.venv/bin/python', '/srv/train.py'])


def test_sbatch_script_requests_the_configured_resources(slurm_config):
    script = sbatch({'task': 'ocr', 'id': 7, 'epochs': 3, 'batch_size': 8})
    assert '#SBATCH --job-name=deeplabel-ocr-7' in script
    assert '#SBATCH --partition=compute' in script
    assert '#SBATCH --account=admin-test-0005' in script
    assert '#SBATCH --gres=gpu:h200:1' in script
    # One GPU asks for one GPU's share; SLURM_CPUS/SLURM_MEM are the ceiling, not the ask.
    assert '#SBATCH --cpus-per-task=12' in script
    assert '#SBATCH --mem=64G' in script
    assert '--time' not in script


def test_sbatch_script_honors_the_gpu_choice(slurm_config):
    script = sbatch({'task': 'ocr', 'id': 7, 'gpu_type': 'h200', 'gpu_count': 5})
    assert '#SBATCH --gres=gpu:h200:5' in script
    assert '#SBATCH --partition=compute' in script
    assert 'export TRAIN_GPUS="5"' in script


def test_sbatch_script_moves_l40s_jobs_to_the_inference_partition(slurm_config):
    script = sbatch({'task': 'ocr', 'id': 7, 'gpu_type': 'l40s', 'gpu_count': 4})
    assert '#SBATCH --gres=gpu:l40s:4' in script
    assert '#SBATCH --partition=inference' in script
    assert '#SBATCH --partition=compute' not in script


def test_sbatch_script_without_gpu_choice_falls_back_to_the_env_gres(slurm_config):
    script = sbatch({'task': 'ocr', 'id': 7})
    assert '#SBATCH --gres=gpu:h200:1' in script
    assert 'export TRAIN_GPUS="1"' in script


def test_sbatch_script_runs_the_entrypoint_inside_the_backends_image(slurm_config):
    script = sbatch({'task': 'ocr', 'id': 7})
    assert ('srun --container-image=/images/ocr.sqsh --container-mounts="${SLURM_SUBMIT_DIR}:${SLURM_SUBMIT_DIR}"'
            ' --container-workdir="${SLURM_SUBMIT_DIR}" /srv/.venv/bin/python /srv/train.py') in script


def completed(returncode, stderr='', stdout=''):
    return subprocess.CompletedProcess(['ssh', 'host', 'true'], returncode, stdout=stdout, stderr=stderr)


def test_a_failed_remote_command_reports_what_the_cluster_said():
    """check_returncode() only carries the exit status, so a refused login reached the
    user as 'returned non-zero exit status 255' with the reason thrown away."""
    proc = completed(255, stderr='someone@10.0.0.1: Permission denied (publickey).\n')
    with pytest.raises(RuntimeError) as excinfo:
        trainer._check(proc, 'ssh to the cluster')
    message = str(excinfo.value)
    assert 'Permission denied (publickey)' in message
    assert 'ssh to the cluster' in message


def test_a_missing_second_factor_points_at_the_unlock():
    """The one remote failure the user can cure themselves, so it names the cure
    rather than leaving them with ssh's wording."""
    proc = completed(255, stderr='someone@10.0.0.1: Permission denied (keyboard-interactive).\n')
    with pytest.raises(RuntimeError, match='second factor') as excinfo:
        trainer._check(proc, 'ssh to the cluster')
    assert 'training dialog' in str(excinfo.value)
    assert 'keyboard-interactive' in str(excinfo.value)


def test_a_failed_remote_command_falls_back_to_stdout():
    proc = completed(1, stdout='sbatch: error: Invalid account\n')
    with pytest.raises(RuntimeError, match='Invalid account'):
        trainer._check(proc, 'sbatch')


def test_a_failed_remote_command_with_no_output_still_reports_the_code():
    with pytest.raises(RuntimeError, match='127'):
        trainer._check(completed(127), 'rsync to the cluster')


def test_a_successful_remote_command_passes_through():
    proc = completed(0, stdout='12345\n')
    assert trainer._check(proc, 'sbatch') is proc


def running_slurm_training(tmp_path):
    from app import store
    conn = store.connect(tmp_path / 'app.db')
    conn.execute("INSERT INTO jobs (id, name) VALUES ('job1', 'data')")
    conn.execute("INSERT INTO trainings (id, task, name, target, status, phase, slurm_job_id) "
                 "VALUES (5, 'ocr', 'run', 'slurm', 'running', 'slurm:RUNNING', '1455')")
    conn.commit()
    return conn


def test_an_unreachable_cluster_is_reported_without_touching_the_run(tmp_path, monkeypatch):
    """A dropped session must not fail a training: the job is on the cluster either
    way, so the run keeps its state and only reachability flips."""
    conn = running_slurm_training(tmp_path)
    monkeypatch.setattr(trainer, '_ssh', lambda _cmd: completed(
        255, stderr='someone@10.0.0.1: Permission denied (keyboard-interactive).\n'))
    trainer._poll_slurm_once(conn)

    assert trainer.cluster_reachable() is False
    row = conn.execute('SELECT status, phase, error FROM trainings WHERE id = 5').fetchone()
    assert (row['status'], row['phase'], row['error']) == ('running', 'slurm:RUNNING', None)
    conn.close()


def test_a_reachable_cluster_clears_the_flag_again(tmp_path, monkeypatch):
    conn = running_slurm_training(tmp_path)
    monkeypatch.setattr(trainer, '_ssh', lambda _cmd: completed(255))
    trainer._poll_slurm_once(conn)
    assert trainer.cluster_reachable() is False

    monkeypatch.setattr(trainer, '_ssh', lambda _cmd: completed(0, stdout='PENDING\n'))
    monkeypatch.setattr(trainer, '_pending_reason', lambda _id: 'Priority')
    trainer._poll_slurm_once(conn)

    assert trainer.cluster_reachable() is True
    assert conn.execute('SELECT phase FROM trainings WHERE id = 5').fetchone()['phase'] == 'slurm:PENDING (Priority)'
    conn.close()


@pytest.fixture
def offline_cluster(monkeypatch, tmp_path):
    monkeypatch.setattr('app.config.SLURM_HOST', '10.0.0.1')
    monkeypatch.setattr('app.config.TRAININGS_DIR', tmp_path / 'trainings')
    monkeypatch.setattr(trainer, '_ssh', lambda cmd: subprocess.CompletedProcess(
        cmd, 255, '', 'user@10.0.0.1: Permission denied (keyboard-interactive).'))


def test_a_closed_session_is_reported_before_the_snapshot_is_cut(offline_cluster, training_backend, monkeypatch,
                                                                 tmp_path):
    """A 19 GB snapshot took minutes to cut and was then thrown away by a submit that
    could never have worked. The session is checked first, so the run fails in seconds."""
    cut = []
    monkeypatch.setattr(trainer, 'prepare_snapshot', lambda *a, **k: cut.append(1))
    from app import store
    conn = store.connect(tmp_path / 'app.db')
    conn.execute("INSERT INTO trainings (id, task, name, target, status) "
                 "VALUES (20, 'ocr', 't', 'slurm', 'queued')")
    conn.commit()
    trainer.submit_slurm(conn, 20)
    row = conn.execute('SELECT status, error FROM trainings WHERE id = 20').fetchone()
    assert cut == [], 'the snapshot must not be cut when the cluster cannot be reached'
    assert row['status'] == 'error'
    assert 'second factor' in row['error']
    conn.close()


def test_a_finished_snapshot_is_reused_instead_of_recut(tmp_path, monkeypatch):
    """A retry must not pay for the snapshot again - it is frozen material, and the
    counts on the row say it already completed."""
    monkeypatch.setattr('app.config.TRAININGS_DIR', tmp_path)
    (tmp_path / '20' / 'snapshot' / 'train').mkdir(parents=True)
    built = []
    monkeypatch.setattr('app.train_snapshot.build', lambda *a, **k: built.append(1) or {})
    from app import store
    conn = store.connect(tmp_path / 'app.db')
    conn.execute("INSERT INTO trainings (id, task, name, target, status, snapshot_counts) "
                 "VALUES (20, 'ocr', 't', 'slurm', 'error', '{\"train\": 5, \"val\": 1}')")
    conn.commit()
    training = trainer.get_training(conn, 20)
    assert trainer.prepare_snapshot(conn, training) == {'train': 5, 'val': 1}
    assert built == [], 'an already-cut snapshot must not be rebuilt'
    conn.close()


def _fake_popen(sent):
    """An rsync that never runs, recording the command it was given and the wall clock it
    was waited on."""
    class Fake:
        def __init__(self, cmd, **kwargs):
            self.args, self.pid, self.returncode = cmd, 4242, 0
            sent['cmd'] = cmd

        def communicate(self, timeout=None):
            sent['timeout'] = timeout
            return '', ''

    return Fake


def test_the_transfer_is_uncompressed_resumable_and_stall_aware(monkeypatch):
    """A snapshot is PNG crops - compressing them spends CPU for nothing - and the push is
    long enough that only a stall should end it. What it must never do is take the uplink
    with it: on 2026-09-11 an unthrottled 160 GB transfer made the host unreachable."""
    sent = {}

    monkeypatch.setattr(trainer.subprocess, 'Popen', _fake_popen(sent))
    monkeypatch.setattr('app.config.SLURM_RSYNC_BWLIMIT', '')

    trainer._rsync('/data/trainings/24/', 'user@cluster:dir/')

    assert '-z' not in sent['cmd'], 'PNG crops do not compress'
    assert '-a' in sent['cmd'] and '--partial' in sent['cmd']
    assert '--timeout=600' in sent['cmd'], 'ends a stalled transfer, not a slow one'
    assert sent['timeout'] == 86400.0
    assert not [f for f in sent['cmd'] if f.startswith('--bwlimit')], 'unset means no limit'


def test_a_rate_limit_is_passed_through_when_the_deployment_sets_one(monkeypatch):
    sent = {}
    monkeypatch.setattr(trainer.subprocess, 'Popen', _fake_popen(sent))
    monkeypatch.setattr('app.config.SLURM_RSYNC_BWLIMIT', '5m')

    trainer._rsync('/src/', 'user@cluster:dst/')

    assert '--bwlimit=5m' in sent['cmd']


@pytest.fixture
def cluster_trainer(monkeypatch):
    """A backend that trains on the cluster in its image, with what it writes beside the
    snapshot stubbed out."""
    backend = FakeTrainer({'entrypoint': ['/srv/train.py']})
    monkeypatch.setattr('app.remote_training.training_backend', lambda _conn, _training: backend)
    monkeypatch.setattr('app.remote_training.prepare_cluster_run', lambda *a, **k: None)
    return backend


def test_a_session_that_closed_during_the_snapshot_says_so(tmp_path, monkeypatch, cluster_trainer):
    """Cutting a snapshot takes as long as it takes - 270,000 crops on 2026-09-10 - and the
    cluster session can drop while it runs; a backend restart is enough. Asking only before
    the cut left the transfer to fail with rsync's exit code, which names nothing."""
    monkeypatch.setattr('app.config.SLURM_HOST', '10.0.0.1')
    monkeypatch.setattr('app.config.TRAININGS_DIR', tmp_path / 'trainings')
    (tmp_path / 'trainings' / '22').mkdir(parents=True)
    asked = []

    def probe():
        asked.append(True)
        # Open before the cut, asking for its factor again by the time it is transferred.
        return None if len(asked) == 1 else trainer.SECOND_FACTOR_NEEDED

    monkeypatch.setattr(trainer, 'probe_cluster', probe)
    monkeypatch.setattr(trainer, 'prepare_snapshot', lambda *a, **k: {'train': 1, 'val': 1})
    monkeypatch.setattr(trainer, '_rsync', lambda *a, **k: subprocess.CompletedProcess([], 255, '', 'boom'))
    monkeypatch.setattr(trainer, '_ssh', lambda cmd: subprocess.CompletedProcess(cmd, 0, '', ''))
    from app import store
    conn = store.connect(tmp_path / 'app.db')
    conn.execute("INSERT INTO trainings (id, task, name, target, status) "
                 "VALUES (22, 'ocr', 't', 'slurm', 'queued')")
    conn.commit()

    trainer.submit_slurm(conn, 22)

    row = conn.execute('SELECT status, error FROM trainings WHERE id = 22').fetchone()
    assert row['status'] == 'error'
    assert row['error'] == trainer.SECOND_FACTOR_NEEDED
    assert 'rsync' not in row['error'], 'the exit code is not what went wrong'
    conn.close()


def test_a_successful_submit_clears_the_previous_failure(tmp_path, monkeypatch, cluster_trainer):
    monkeypatch.setattr('app.config.SLURM_HOST', '10.0.0.1')
    monkeypatch.setattr('app.config.TRAININGS_DIR', tmp_path / 'trainings')
    (tmp_path / 'trainings' / '21').mkdir(parents=True)  # normally made by the snapshot
    monkeypatch.setattr(trainer, 'probe_cluster', lambda: None)
    monkeypatch.setattr(trainer, 'prepare_snapshot', lambda *a, **k: {'train': 1, 'val': 1})
    monkeypatch.setattr(trainer, '_rsync', lambda *a, **k: subprocess.CompletedProcess([], 0, '', ''))
    monkeypatch.setattr(trainer, '_ssh', lambda cmd: subprocess.CompletedProcess(cmd, 0, '1736\n', ''))
    from app import store
    conn = store.connect(tmp_path / 'app.db')
    conn.execute("INSERT INTO trainings (id, task, name, target, status, error) "
                 "VALUES (21, 'ocr', 't', 'slurm', 'queued', 'closed session')")
    conn.commit()
    trainer.submit_slurm(conn, 21)
    row = conn.execute('SELECT status, slurm_job_id, error, backend FROM trainings WHERE id = 21').fetchone()
    assert (row['status'], row['slurm_job_id'], row['error'], row['backend']) == ('running', '1736', None, 'trainer')
    assert 'srun --container-image=/images/trainer.sqsh' in (tmp_path / 'trainings' / '21' / 'train.sbatch').read_text()
    conn.close()


class TestWhatOneRunIsCharged:
    """The cluster bills what a job asks for. A fixed request sized for the biggest run
    made a two-GPU H200 job pay for 48 cores and 384 GB while using 7 and 158."""

    @pytest.fixture(autouse=True)
    def sizes(self, slurm_config, monkeypatch):
        monkeypatch.setattr('app.config.SLURM_CPUS', '48')
        monkeypatch.setattr('app.config.SLURM_MEM', '384G')
        monkeypatch.setattr('app.config.SLURM_CPUS_PER_GPU', 12)
        monkeypatch.setattr('app.config.SLURM_MEM_PER_GPU', '96G')

    def test_two_gpus_ask_for_two_gpus_worth(self):
        script = sbatch({'task': 'ocr', 'id': 7, 'gpu_type': 'h200', 'gpu_count': 2})

        assert '#SBATCH --cpus-per-task=24' in script
        assert '#SBATCH --mem=192G' in script

    def test_a_big_run_still_stops_at_what_one_job_may_have(self):
        script = sbatch({'task': 'ocr', 'id': 7, 'gpu_type': 'h200', 'gpu_count': 8})

        assert '#SBATCH --cpus-per-task=48' in script
        assert '#SBATCH --mem=384G' in script

    def test_a_backend_run_asks_for_the_cores_and_memory_its_backend_declares(self):
        script = trainer._backend_sbatch_script(
            {'task': 'lines', 'id': 7, 'gpu_type': 'l40s', 'gpu_count': 1}, '/images/kraken.sqsh', ['train'],
            resources={'cpus_per_gpu': 16, 'memory_per_gpu_gb': 24})

        assert '#SBATCH --cpus-per-task=16' in script
        assert '#SBATCH --mem=24G' in script

    def test_what_a_backend_declares_still_stops_at_what_one_job_may_have(self):
        script = trainer._backend_sbatch_script(
            {'task': 'lines', 'id': 7, 'gpu_type': 'h200', 'gpu_count': 4}, '/images/rfdetr.sqsh', ['train'],
            resources={'cpus_per_gpu': 32, 'memory_per_gpu_gb': 128})

        assert '#SBATCH --cpus-per-task=48' in script
        assert '#SBATCH --mem=384G' in script

    def test_the_gres_default_decides_it_when_no_gpu_was_chosen(self, monkeypatch):
        monkeypatch.setattr('app.config.SLURM_GRES', 'gpu:h200:4')

        script = sbatch({'task': 'ocr', 'id': 7})

        assert '#SBATCH --cpus-per-task=48' in script
        assert '#SBATCH --mem=384G' in script

    def test_a_memory_ceiling_it_cannot_read_is_left_to_the_cluster(self, monkeypatch):
        """Refusing to guess beats halving a request that was spelled some other way."""
        monkeypatch.setattr('app.config.SLURM_MEM', 'whatever')

        script = sbatch({'task': 'ocr', 'id': 7, 'gpu_type': 'h200', 'gpu_count': 2})

        assert '#SBATCH --mem=192G' in script


class TestATimedOutRunResumes:
    """6.9: a cluster run on a backend that can resume is resubmitted from its last
    checkpoint when it hits the time limit, up to SLURM_MAX_RESUMES, as the same run."""

    @pytest.fixture
    def cluster(self, tmp_path, monkeypatch):
        from types import SimpleNamespace

        from app import config, remote_training, store
        monkeypatch.setattr(config, 'TRAININGS_DIR', tmp_path / 'trainings')
        monkeypatch.setattr(config, 'SLURM_MAX_RESUMES', 3)
        conn = store.connect(tmp_path / 'app.db')
        conn.execute("INSERT INTO trainings (id, task, name, target, status, phase, slurm_job_id, backend, gpu_count) "
                     "VALUES (5, 'ocr', 'run', 'slurm', 'running', 'slurm:RUNNING', '1455', 'ocr', 1)")
        conn.commit()
        declared = {'resume': True, 'entrypoint': ['/srv/.venv/bin/python', '-m', 'deeplabel_backend.fallback',
                                                   '/srv/train.py']}
        client = SimpleNamespace(backend=SimpleNamespace(name='ocr', cluster_image='/images/ocr.sqsh'),
                                 info=lambda: {'train': declared})
        monkeypatch.setattr(remote_training, 'training_backend', lambda _conn, _training: client)
        sent = []

        def ssh(cmd):
            sent.append(cmd)
            if cmd[0] == 'sacct':
                return completed(0, stdout='TIMEOUT\n')
            return completed(0, stdout='1456\n')

        monkeypatch.setattr(trainer, '_ssh', ssh)
        monkeypatch.setattr(trainer, '_rsync', lambda source, dest, **_: sent.append(('rsync', source, dest))
                            or completed(0))
        monkeypatch.setattr(trainer, '_fetch_full_log', lambda *_: 'slurmstepd: *** JOB 1455 CANCELLED DUE TO TIME LIMIT ***')
        yield SimpleNamespace(conn=conn, sent=sent, declared=declared, dir=tmp_path / 'trainings' / '5')
        conn.close()

    def run(self, conn):
        return dict(conn.execute('SELECT status, phase, error, slurm_job_id, resumes FROM trainings WHERE id = 5')
                    .fetchone())

    def test_it_is_resubmitted_from_its_checkpoint(self, cluster):
        trainer._poll_slurm_once(cluster.conn)

        assert self.run(cluster.conn) == {'status': 'running', 'phase': 'slurm:PENDING (resumed 1 of 3)',
                                          'error': None, 'slurm_job_id': '1456', 'resumes': 1}
        script = (cluster.dir / 'train.sbatch').read_text()
        assert 'export TRAIN_RESUME="${TRAIN_OUTPUT}"' in script
        assert ' /srv/train.py' in script
        assert any(cmd[0] == 'bash' and 'sbatch --parsable train.sbatch' in cmd[-1] for cmd in cluster.sent
                   if isinstance(cmd, list))

    def test_it_stops_at_the_limit_and_says_why(self, cluster):
        cluster.conn.execute('UPDATE trainings SET resumes = 3 WHERE id = 5')
        trainer._poll_slurm_once(cluster.conn)

        run = self.run(cluster.conn)
        assert (run['status'], run['resumes']) == ('error', 3)
        assert run['error'].startswith('slurm state TIMEOUT') and 'resumed 3 times' in run['error']

    def test_a_backend_that_cannot_resume_fails_the_run_as_before(self, cluster):
        cluster.declared['resume'] = False
        trainer._poll_slurm_once(cluster.conn)

        run = self.run(cluster.conn)
        assert (run['status'], run['slurm_job_id'], run['resumes']) == ('error', '1455', 0)
        assert run['error'].startswith('slurm state TIMEOUT')


def test_a_run_counts_from_its_preparation_not_from_reaching_slurm(tmp_path):
    conn = store.connect(tmp_path / 'app.db')
    conn.execute("INSERT INTO trainings (id, task, name, owner, status) VALUES (91, 'ocr', 'r', 'dev', 'queued')")
    conn.commit()
    trainer.set_state(conn, 91, status='preparing', phase='snapshot')
    conn.execute("UPDATE trainings SET started_at = '2026-01-01 00:00:00' WHERE id = 91")
    trainer.set_state(conn, 91, status='running', phase='slurm:PENDING')

    assert conn.execute('SELECT started_at FROM trainings WHERE id = 91').fetchone()[0] == '2026-01-01 00:00:00'
