import json
from datetime import datetime

import pytest

from app import queue_eta, store

NOW = datetime(2026, 1, 1, 12, 0, 0)


@pytest.fixture
def conn(tmp_path):
    connection = store.connect(tmp_path / 'app.db')
    connection.execute("INSERT INTO models (id, task, name, checkpoint) VALUES (1, 'ocr', 'DeepOCR', '/ckpt')")
    yield connection
    connection.close()


def add_job(conn, job_id, status, pages, started=None, finished=None, counters=None):
    conn.execute('INSERT INTO jobs (id, name, owner, status, started_at, finished_at, counters) '
                 "VALUES (?, ?, 'alice', ?, ?, ?, ?)",
                 (job_id, job_id, status, started, finished, json.dumps(counters or {})))
    for i in range(pages):
        conn.execute("INSERT INTO pages (job_id, idx, filename, source_file, status) VALUES (?, ?, 'p', 'p', 'done')",
                     (job_id, i))


def add_training(conn, status, epochs, task='ocr', started=None, finished=None):
    return conn.execute(
        'INSERT INTO trainings (task, name, owner, target, status, epochs, started_at, finished_at) '
        "VALUES (?, 'run', 'alice', 'local', ?, ?, ?, ?)", (task, status, epochs, started, finished)).lastrowid


class TestFinishedAt:
    @pytest.mark.parametrize('table, insert', [
        ('jobs', "INSERT INTO jobs (id, name, status) VALUES ('j', 'J', 'running')"),
        ('trainings', "INSERT INTO trainings (task, name, owner, target, status) VALUES ('ocr', 'r', 'a', 'local', 'running')"),
        ('evaluations', "INSERT INTO evaluations (model_id, source, owner, status) VALUES (1, '{}', 'a', 'running')"),
    ])
    def test_leaving_the_run_stamps_when_it_finished(self, conn, table, insert):
        conn.execute(insert)
        assert conn.execute(f'SELECT finished_at FROM {table}').fetchone()[0] is None

        conn.execute(f"UPDATE {table} SET status = 'done'")

        assert conn.execute(f'SELECT finished_at FROM {table}').fetchone()[0] is not None


class TestDatasets:
    def test_a_waiting_dataset_takes_as_long_per_page_as_recent_ones_did(self, conn):
        add_job(conn, 'a', 'done', 10, '2026-01-01 10:00:00', '2026-01-01 10:01:40')
        add_job(conn, 'b', 'done', 20, '2026-01-01 10:00:00', '2026-01-01 10:03:20')
        add_job(conn, 'w', 'queued', 5)

        assert queue_eta.dataset(conn, 'w', NOW) == {'seconds': 50, 'basis': 'history'}

    def test_a_running_dataset_goes_on_at_the_pace_it_has_so_far(self, conn):
        counters = {'pages_total': 4, 'pages_ingested': 4, 'pages_layout_done': 2,
                    'elements_total': 0, 'lines_total': 0}
        add_job(conn, 'r', 'running', 4, started='2026-01-01 11:58:20', counters=counters)
        conn.execute("UPDATE jobs SET run_lines = 0, run_ocr = 0 WHERE id = 'r'")

        # Ingest is through and layout half way: three quarters done after 100 s.
        assert queue_eta.dataset(conn, 'r', NOW) == {'seconds': 33, 'basis': 'progress'}

    def test_with_nothing_to_go_by_it_says_so(self, conn):
        add_job(conn, 'w', 'queued', 5)
        assert queue_eta.dataset(conn, 'w', NOW) == {'seconds': None, 'basis': 'unknown'}


class TestTrainings:
    def test_a_running_training_takes_as_long_per_epoch_as_its_epochs_so_far(self, conn):
        run = add_training(conn, 'running', 10, started='2026-01-01 11:56:40')
        progress = {'epoch': 2}

        assert queue_eta.training(conn, run, progress, NOW) == {'seconds': 800, 'basis': 'progress'}

    def test_a_waiting_training_takes_its_epochs_at_the_task_s_recent_pace(self, conn):
        add_training(conn, 'done', 10, started='2026-01-01 10:00:00', finished='2026-01-01 10:10:00')
        add_training(conn, 'done', 4, task='layout', started='2026-01-01 10:00:00', finished='2026-01-01 11:00:00')
        run = add_training(conn, 'queued', 5)

        assert queue_eta.training(conn, run, None, NOW) == {'seconds': 300, 'basis': 'history'}


class TestEvaluations:
    def test_an_evaluation_takes_as_long_as_recent_ones(self, conn):
        for start, end in (('10:00:00', '10:00:20'), ('10:00:00', '10:00:40'), ('10:00:00', '10:01:00')):
            conn.execute("INSERT INTO evaluations (model_id, source, owner, status, started_at, finished_at) "
                         f"VALUES (1, '{{}}', 'a', 'done', '2026-01-01 {start}', '2026-01-01 {end}')")
        waiting = conn.execute("INSERT INTO evaluations (model_id, source, owner, status) "
                               "VALUES (1, '{}', 'a', 'queued')").lastrowid

        assert queue_eta.evaluation(conn, waiting, NOW) == {'seconds': 40, 'basis': 'history'}
