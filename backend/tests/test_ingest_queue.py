"""A dataset's pages are rendered outside the GPU queue (#140): it shows as ingesting while
a background ingester works through it, two datasets at a time, and joins the queue only
once every page is in - so a large PDF holds no GPU slot while only the CPU works."""
import io
import os

import pytest
from PIL import Image
from fastapi.testclient import TestClient

from app import ingest_queue, jobs, store
from app.deps import get_db
from app.main import app

SECRET = 'test-secret'
EDITOR = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'alice', 'X-Auth-Role': 'member',
          'X-Auth-Caps': 'pipeline.layout pipeline.lines pipeline.ocr'}


def png_bytes() -> bytes:
    buf = io.BytesIO()
    Image.new('RGB', (2, 2), 'white').save(buf, 'PNG')
    return buf.getvalue()


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    monkeypatch.setattr('app.config.JOBS_DIR', tmp_path / 'jobs')
    conn = store.connect(tmp_path / 'app.db')
    app.dependency_overrides[get_db] = lambda: conn
    yield TestClient(app), conn
    app.dependency_overrides.clear()
    conn.close()


def create(api, name: str, hold: bool = False) -> str:
    res = api.post('/api/jobs', data={'name': name, 'hold': str(hold).lower()}, headers=EDITOR,
                   files=[('files', ('p_001.png', png_bytes(), 'image/png'))])
    assert res.status_code == 200, res.text
    return res.json()['job_id']


def status(conn, job_id: str) -> str:
    return store.get_job(conn, job_id)['status']


def pid(conn, job_id: str) -> int | None:
    return conn.execute('SELECT pid FROM jobs WHERE id = ?', (job_id,)).fetchone()['pid']


def ingested(conn, job_id: str) -> None:
    conn.execute("UPDATE pages SET status = 'ingested' WHERE job_id = ?", (job_id,))
    conn.commit()


class TestWhereADatasetWaits:
    def test_a_new_dataset_is_ingested_before_it_is_queued(self, client):
        api, conn = client
        assert status(conn, create(api, 'Fresh')) == 'ingesting'

    def test_a_held_upload_waits_and_its_start_sends_it_to_the_ingester(self, client):
        api, conn = client
        job_id = create(api, 'Held', hold=True)
        assert status(conn, job_id) == 'uploading'
        assert api.post(f'/api/jobs/{job_id}/start', headers=EDITOR).status_code == 200
        assert status(conn, job_id) == 'ingesting'

    def test_pages_added_to_a_finished_dataset_are_ingested_first(self, client):
        api, conn = client
        job_id = create(api, 'Grown')
        ingested(conn, job_id)
        store.set_job_state(conn, job_id, status='done')
        res = api.post(f'/api/jobs/{job_id}/pages/upload', headers=EDITOR,
                       files=[('files', ('p_002.png', png_bytes(), 'image/png'))])
        assert res.status_code == 200, res.text
        assert status(conn, job_id) == 'ingesting'

    def test_a_dataset_with_nothing_left_to_ingest_is_queued_at_once(self, client):
        api, conn = client
        job_id = create(api, 'Ready', hold=True)
        ingested(conn, job_id)
        assert api.post(f'/api/jobs/{job_id}/start', headers=EDITOR).status_code == 200
        assert status(conn, job_id) == 'queued'


class FakeProcess:
    def __init__(self, pid: int):
        self.pid = pid
        self.returncode = None

    def poll(self):
        return self.returncode


class TestTheIngester:
    @pytest.fixture
    def ingester(self, client):
        api, conn = client
        spawned: list[tuple[str, FakeProcess]] = []

        def spawn(job_id: str) -> FakeProcess:
            process = FakeProcess(1000 + len(spawned))
            spawned.append((job_id, process))
            return process

        return ingest_queue.Ingester(spawn), spawned, api, conn

    def test_two_datasets_ingest_at_a_time_oldest_first(self, ingester):
        runner, spawned, api, conn = ingester
        first, second, third = (create(api, name) for name in ('First', 'Second', 'Third'))

        runner.tick(conn)
        assert [job_id for job_id, _ in spawned] == [first, second]
        assert [pid(conn, j) for j in (first, second, third)] == [1000, 1001, None]

        ingested(conn, first)
        spawned[0][1].returncode = 0
        runner.tick(conn)
        assert (status(conn, first), pid(conn, first)) == ('queued', None)
        assert [job_id for job_id, _ in spawned] == [first, second, third]

    def test_no_pages_are_added_while_the_pages_are_ingested(self, ingester):
        runner, spawned, api, conn = ingester
        job_id = create(api, 'Growing')
        runner.tick(conn)
        res = api.post(f'/api/jobs/{job_id}/pages/upload', headers=EDITOR,
                       files=[('files', ('p_002.png', png_bytes(), 'image/png'))])
        assert res.status_code == 409
        assert conn.execute('SELECT COUNT(*) FROM pages WHERE job_id = ?', (job_id,)).fetchone()[0] == 1

    def test_a_page_an_ingest_leaves_pending_goes_to_the_gpu_run_rather_than_round_again(self, ingester):
        # Spawned again instead, a page it cannot move would hold one of the two places for good.
        runner, spawned, api, conn = ingester
        job_id = create(api, 'Stuck')
        runner.tick(conn)
        spawned[0][1].returncode = 0
        runner.tick(conn)
        assert (status(conn, job_id), len(spawned)) == ('queued', 1)

    def test_an_ingest_that_fails_fails_its_dataset(self, ingester):
        runner, spawned, api, conn = ingester
        job_id = create(api, 'Broken')
        runner.tick(conn)
        spawned[0][1].returncode = 1
        runner.tick(conn)
        job = store.get_job(conn, job_id)
        assert (job['status'], pid(conn, job_id)) == ('error', None)
        assert job['error'] == 'Ingesting the pages stopped with exit code 1; see ingest.log'

    def test_a_cancel_stops_the_ingest(self, ingester, monkeypatch):
        runner, spawned, api, conn = ingester
        killed = []
        monkeypatch.setattr(jobs.os, 'kill', lambda pid, sig: killed.append(pid))
        job_id = create(api, 'Stopped')
        runner.tick(conn)

        assert jobs.cancel_job(conn, job_id) is True
        assert (status(conn, job_id), killed) == ('cancelled', [1000])
        spawned[0][1].returncode = -15
        runner.tick(conn)
        assert status(conn, job_id) == 'cancelled'

    def test_a_restart_takes_up_what_was_ingesting(self, ingester, monkeypatch):
        runner, spawned, api, conn = ingester
        job_id = create(api, 'Interrupted')
        conn.execute('UPDATE jobs SET pid = 4242 WHERE id = ?', (job_id,))
        conn.commit()
        monkeypatch.setattr(ingest_queue, 'live_ingest', lambda pid, job: False)
        ingest_queue.Ingester(runner.spawn).tick(conn)
        assert [j for j, _ in spawned] == [job_id]

    def test_an_ingest_left_running_by_a_restart_keeps_the_dataset_to_itself(self, ingester, monkeypatch):
        runner, spawned, api, conn = ingester
        job_id = create(api, 'Adopted')
        conn.execute('UPDATE jobs SET pid = 4242 WHERE id = ?', (job_id,))
        conn.commit()
        monkeypatch.setattr(ingest_queue, 'live_ingest', lambda pid, job: (pid, job) == (4242, job_id))

        ingest_queue.Ingester(runner.spawn).tick(conn)
        assert spawned == []
        assert pid(conn, job_id) == 4242

    def test_an_ingest_process_gone_since_the_restart_is_started_again(self, ingester, monkeypatch):
        runner, spawned, api, conn = ingester
        job_id = create(api, 'Restarted')
        conn.execute('UPDATE jobs SET pid = 4242 WHERE id = ?', (job_id,))
        conn.commit()
        monkeypatch.setattr(ingest_queue, 'live_ingest', lambda pid, job: False)

        ingest_queue.Ingester(runner.spawn).tick(conn)
        assert [j for j, _ in spawned] == [job_id]
        assert pid(conn, job_id) == 1000

    def test_a_live_pid_of_another_command_is_started_again(self, ingester, monkeypatch):
        runner, spawned, api, conn = ingester
        job_id = create(api, 'Reused')
        conn.execute('UPDATE jobs SET pid = 4242 WHERE id = ?', (job_id,))
        conn.commit()
        monkeypatch.setattr(ingest_queue.os, 'kill', lambda pid, sig: None)
        monkeypatch.setattr(ingest_queue, 'cmdline',
                            lambda pid: ['python', '-m', 'app.ingest_job', '--job-id', 'zzz'])
        ingest_queue.Ingester(runner.spawn).tick(conn)
        assert [j for j, _ in spawned] == [job_id]


class TestRecognisingALiveIngest:
    def test_the_ingest_command_is_its_module_and_its_dataset(self):
        argv = ['python', '-m', 'app.ingest_job', '--job-id', 'abc123',
                '--db-path', '/tmp/app.db', '--job-path', '/tmp/jobs/abc123']
        assert ingest_queue.is_ingest_command(argv, 'abc123') is True
        assert ingest_queue.is_ingest_command(['python', '-m', 'app.ingest_job', '--job-id', 'zzz'], 'abc123') is False
        assert ingest_queue.is_ingest_command(['sh', '-c', 'sleep 1'], 'abc123') is False

    def test_a_pid_no_process_holds_is_not_a_live_ingest(self):
        assert ingest_queue.live_ingest(2 ** 30, 'abc123') is False

    def test_a_live_command_that_is_not_an_ingest_is_not_taken_for_one(self):
        assert ingest_queue.live_ingest(os.getpid(), 'abc123') is False

    def test_a_live_ingest_of_the_dataset_says_so(self, monkeypatch):
        argv = ['python', '-m', 'app.ingest_job', '--job-id', 'abc123',
                '--db-path', '/tmp/app.db', '--job-path', '/tmp/jobs/abc123']
        monkeypatch.setattr(ingest_queue.os, 'kill', lambda pid, sig: None)
        monkeypatch.setattr(ingest_queue, 'cmdline', lambda pid: argv)
        assert ingest_queue.live_ingest(4242, 'abc123') is True


class TestIngestingIsBusy:
    def test_a_rerun_is_refused_while_the_pages_are_ingested(self, client):
        api, conn = client
        job_id = create(api, 'Busy')
        res = api.post(f'/api/jobs/{job_id}/rerun', headers=EDITOR, json={'from_phase': 'ocr'})
        assert res.status_code == 409
        assert status(conn, job_id) == 'ingesting'

    def test_the_gpu_queue_does_not_take_a_dataset_still_ingesting(self, client):
        api, conn = client
        job_id = create(api, 'Not yet')
        assert ('job', job_id) not in jobs.queued_work(conn)
