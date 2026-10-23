"""The queue endpoint feeds the Queue tab: one GPU lane merging datasets, local
trainings and evaluations in the worker's oldest-first order, and a cluster lane
beside it. Names of datasets a user cannot access stay redacted.
"""
import pytest
from fastapi.testclient import TestClient

from app import store
from app.deps import get_db
from app.main import app

SECRET = 'test-secret'
ADMIN = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'root', 'X-Auth-Role': 'admin'}
MEMBER = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'bob', 'X-Auth-Role': 'member'}


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    monkeypatch.setattr('app.config.JOBS_DIR', tmp_path / 'jobs')
    conn = store.connect(tmp_path / 'app.db')
    app.dependency_overrides[get_db] = lambda: conn
    yield TestClient(app), conn
    app.dependency_overrides.clear()
    conn.close()


def fetch(api, headers=ADMIN):
    res = api.get('/api/queue', headers=headers)
    assert res.status_code == 200
    return res.json()


def test_the_gpu_lane_merges_kinds_oldest_first(client):
    api, conn = client
    conn.execute("INSERT INTO jobs (id, name, owner, status, created_at) "
                 "VALUES ('j-run', 'Running set', 'alice', 'running', '2026-01-01 10:00:00')")
    conn.execute("INSERT INTO jobs (id, name, owner, status, created_at) "
                 "VALUES ('j-wait', 'Waiting set', 'alice', 'queued', '2026-01-01 10:02:00')")
    conn.execute("INSERT INTO trainings (task, name, owner, target, status, created_at) "
                 "VALUES ('ocr', 'run-7', 'alice', 'local', 'queued', '2026-01-01 10:01:00')")
    conn.execute("INSERT INTO models (task, name, checkpoint) VALUES ('ocr', 'DeepOCR', '/ckpt')")
    conn.execute("INSERT INTO evaluations (model_id, source, owner, status, created_at) "
                 "VALUES (1, '{\"jobs\": [\"j-wait\"]}', 'alice', 'queued', '2026-01-01 10:03:00')")
    conn.commit()

    state = fetch(api)
    assert state['gpu']['running']['kind'] == 'dataset'
    assert state['gpu']['running']['name'] == 'Running set'
    assert [(e['kind'], e['name']) for e in state['gpu']['queued']] == [
        ('training', 'run-7'), ('dataset', 'Waiting set'), ('evaluation', 'DeepOCR on Waiting set')]
    assert state['cluster'] == []
    assert state['pending_reocr'] is None


def test_work_submitted_in_the_same_second_shows_in_the_order_the_worker_runs_it(client):
    """created_at has one-second resolution, so a burst of submissions ties on it. The
    submission id breaks the tie, and the lane must show exactly what the worker picks."""
    from app import jobs
    api, conn = client
    second = '2026-01-01 10:00:00'
    for job_id in ('j-zz', 'j-aa'):
        conn.execute("INSERT INTO jobs (id, name, owner, status, created_at) "
                     "VALUES (?, ?, 'alice', 'queued', ?)", (job_id, job_id, second))
    for training_id in (5, 3):
        conn.execute("INSERT INTO trainings (id, task, name, owner, target, status, created_at) "
                     "VALUES (?, 'ocr', ?, 'alice', 'local', 'queued', ?)",
                     (training_id, f'run-{training_id}', second))
    conn.execute("INSERT INTO models (task, name, checkpoint) VALUES ('ocr', 'DeepOCR', '/ckpt')")
    conn.execute("INSERT INTO evaluations (id, model_id, source, owner, status, created_at) "
                 "VALUES (1, 1, '{}', 'alice', 'queued', ?)", (second,))
    conn.commit()

    shown = [(e['kind'], e['id']) for e in fetch(api)['gpu']['queued']]

    table = {'job': 'jobs', 'training': 'trainings', 'evaluation': 'evaluations'}
    run = []
    while (work := jobs._next_work(conn)) is not None:
        kind, work_id = work
        run.append(('dataset' if kind == 'job' else kind, work_id))
        conn.execute(f"UPDATE {table[kind]} SET status = 'done' WHERE id = ?", (work_id,))
    assert run == [('dataset', 'j-zz'), ('dataset', 'j-aa'), ('training', 3), ('training', 5),
                   ('evaluation', 1)]
    assert shown == run


def test_datasets_a_user_cannot_access_are_redacted(client):
    api, conn = client
    conn.execute("INSERT INTO jobs (id, name, owner, status, created_at) "
                 "VALUES ('j-a', 'Secret set', 'alice', 'queued', '2026-01-01 10:04:00')")
    conn.execute("INSERT INTO jobs (id, name, owner, status, created_at) "
                 "VALUES ('j-b', 'Bobs set', 'bob', 'queued', '2026-01-01 10:05:00')")
    conn.execute("INSERT INTO models (task, name, checkpoint) VALUES ('ocr', 'DeepOCR', '/ckpt')")
    conn.execute("INSERT INTO evaluations (model_id, source, owner, status, created_at) "
                 "VALUES (1, '{\"jobs\": [\"j-a\"]}', 'alice', 'queued', '2026-01-01 10:06:00')")
    conn.commit()

    queued = fetch(api, MEMBER)['gpu']['queued']
    by_kind = {(e['kind'], e['id']): e for e in queued}
    assert by_kind[('dataset', 'j-a')]['name'] == 'another dataset'
    assert by_kind[('dataset', 'j-a')]['accessible'] is False
    assert by_kind[('dataset', 'j-b')]['name'] == 'Bobs set'
    assert by_kind[('dataset', 'j-b')]['accessible'] is True
    assert by_kind[('evaluation', 1)]['name'] == 'DeepOCR on another dataset'
    assert fetch(api, ADMIN)['gpu']['queued'][0]['name'] == 'Secret set'


def test_a_dataset_entry_carries_only_what_draws_its_progress(client):
    """The row is global, so what it carries beyond the redacted name must say nothing
    about the dataset - not its name again, nor who it was shared with or where it came
    from. Progress is all the row draws, for anyone."""
    api, conn = client
    conn.execute("INSERT INTO jobs (id, name, owner, status, phase, run_ocr, counters, "
                 "source_path, error, created_at) VALUES ('j-a', 'Secret set', 'alice', "
                 "'running', 'ocr', 0, '{\"pages_total\": 4}', '/srv/secret', 'Secret set failed', "
                 "'2026-01-01 10:04:00')")
    conn.execute("INSERT INTO job_assignees (job_id, username) VALUES ('j-a', 'confidant')")
    conn.commit()

    progress = {'status': 'running', 'counters': {'pages_total': 4}, 'run_layout': True,
                'run_lines': True, 'run_ocr': False, 'run_predict': False, 'run_tile': False}
    theirs = fetch(api, MEMBER)['gpu']['running']
    assert theirs == {'kind': 'dataset', 'id': 'j-a', 'name': 'another dataset', 'owner': 'alice',
                      'status': 'running', 'phase': 'ocr', 'created_at': '2026-01-01 10:04:00',
                      'queued_at': '2026-01-01 10:04:00', 'started_at': None, 'accessible': False,
                      'job': progress}
    mine = fetch(api, ADMIN)['gpu']['running']
    assert (mine['name'], mine['accessible'], mine['job']) == ('Secret set', True, progress)


def flag_lines(conn, job_id: str, count: int, run_ocr: int = 1, status: str = 'done',
               name: str | None = None, owner: str = 'alice'):
    conn.execute('INSERT INTO jobs (id, name, owner, status, run_ocr) VALUES (?, ?, ?, ?, ?)',
                 (job_id, name or f'Set {job_id}', owner, status, run_ocr))
    cur = conn.execute("INSERT INTO pages (job_id, idx, filename, source_file) "
                       "VALUES (?, 0, 'p.png', '/p.png')", (job_id,))
    cur = conn.execute("INSERT INTO elements (page_id, order_idx, class_name, bbox) "
                       "VALUES (?, 0, 'Paragraph', '[]')", (cur.lastrowid,))
    for i in range(count):
        conn.execute("INSERT INTO lines (element_id, order_idx, polygon, needs_ocr) "
                     "VALUES (?, ?, '[]', 1)", (cur.lastrowid, i))
    conn.commit()


def test_flagged_lines_show_as_pending_reread(client):
    """The pending block mirrors the batcher's sweep: what it counts is exactly what
    the next pass will re-queue - no run_ocr-less datasets, none already queued."""
    api, conn = client
    flag_lines(conn, 'j-ocr', 2, name='Secret set')
    flag_lines(conn, 'j-noocr', 1, run_ocr=0)
    flag_lines(conn, 'j-queued', 1, status='queued')

    pending = fetch(api, MEMBER)['pending_reocr']
    assert pending['lines'] == 2
    assert pending['datasets'] == [
        {'id': 'j-ocr', 'name': 'another dataset', 'lines': 2, 'accessible': False}]
    assert pending['next_pass_in'] is None, 'the batcher thread does not run under tests'
    assert fetch(api, ADMIN)['pending_reocr']['datasets'][0]['name'] == 'Secret set'


def test_cluster_runs_sit_in_their_own_lane(client):
    api, conn = client
    conn.execute("INSERT INTO trainings (task, name, owner, target, status, phase) "
                 "VALUES ('ocr', 'big-ocr-2', 'alice', 'slurm', 'running', 'slurm:PENDING (Priority)')")
    conn.execute("INSERT INTO trainings (task, name, owner, target, status) "
                 "VALUES ('ocr', 'old-run', 'alice', 'slurm', 'done')")
    conn.execute("INSERT INTO trainings (task, name, owner, target, status) "
                 "VALUES ('ocr', 'local-run', 'alice', 'local', 'preparing')")
    conn.commit()

    state = fetch(api)
    assert [(e['name'], e['phase']) for e in state['cluster']] == [
        ('big-ocr-2', 'slurm:PENDING (Priority)')]
    assert state['gpu']['running']['kind'] == 'training'
    assert state['gpu']['running']['name'] == 'local-run'
    assert state['gpu']['queued'] == []


def test_each_entry_says_when_it_started_and_waiting_work_has_not(client):
    api, conn = client
    conn.execute("INSERT INTO jobs (id, name, owner, status, created_at, started_at) "
                 "VALUES ('j-run', 'Running set', 'alice', 'running', '2026-01-01 10:00:00', '2026-01-01 10:05:00')")
    conn.execute("INSERT INTO trainings (task, name, owner, target, status, created_at, started_at) "
                 "VALUES ('lines', 'run-8', 'alice', 'slurm', 'running', '2026-01-01 09:00:00', '2026-01-01 09:01:00')")
    conn.execute("INSERT INTO trainings (task, name, owner, target, status, created_at) "
                 "VALUES ('ocr', 'run-9', 'alice', 'local', 'queued', '2026-01-01 10:01:00')")
    conn.commit()

    state = fetch(api)

    assert state['gpu']['running']['started_at'] == '2026-01-01 10:05:00'
    assert state['cluster'][0]['started_at'] == '2026-01-01 09:01:00'
    assert [e['started_at'] for e in state['gpu']['queued']] == [None]
