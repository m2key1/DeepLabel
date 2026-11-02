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


def read_by(conn, job_id, model_id):
    """One line on the dataset's first page, read by the given OCR model."""
    page = conn.execute('SELECT id FROM pages WHERE job_id = ? ORDER BY idx LIMIT 1', (job_id,)).fetchone()[0]
    element = conn.execute("INSERT INTO elements (page_id, order_idx, class_name, bbox) VALUES (?, 0, 'Text', '[0,0,1,1]')",
                           (page,)).lastrowid
    conn.execute("INSERT INTO lines (element_id, order_idx, polygon, text, ocr_model_id) VALUES (?, 0, '[]', 'x', ?)",
                 (element, model_id))


class TestPacePerKindOfRun:
    """A waiting dataset takes the pace of recent ones that ran the same way: the same OCR
    model, no OCR at all, or the same map task."""

    @pytest.fixture
    def history(self, conn):
        conn.execute("INSERT INTO models (id, task, name, checkpoint) VALUES (2, 'ocr', 'Slow reader', '/slow')")
        conn.execute("UPDATE models SET is_default = 1 WHERE id = 1")
        add_job(conn, 'fast', 'done', 10, '2026-01-01 10:00:00', '2026-01-01 10:01:40')
        read_by(conn, 'fast', 1)
        add_job(conn, 'slow', 'done', 10, '2026-01-01 10:00:00', '2026-01-01 10:16:40')
        read_by(conn, 'slow', 2)
        return conn

    def test_a_dataset_for_the_slow_model_takes_the_slow_pace(self, history):
        add_job(history, 'w', 'queued', 5)
        history.execute("UPDATE jobs SET model_ocr_id = 2 WHERE id = 'w'")

        assert queue_eta.dataset(history, 'w', NOW) == {'seconds': 500, 'basis': 'history'}

    def test_one_left_to_the_default_takes_the_default_model_s_pace(self, history):
        add_job(history, 'w', 'queued', 5)

        assert queue_eta.dataset(history, 'w', NOW) == {'seconds': 50, 'basis': 'history'}

    def test_a_finished_dataset_counts_for_the_model_that_read_it(self, history):
        history.execute("UPDATE jobs SET model_ocr_id = 1 WHERE id = 'slow'")
        add_job(history, 'w', 'queued', 5)
        history.execute("UPDATE jobs SET model_ocr_id = 2 WHERE id = 'w'")

        assert queue_eta.dataset(history, 'w', NOW)['seconds'] == 500

    def test_a_model_with_no_history_falls_back_to_every_recent_dataset(self, history):
        history.execute("INSERT INTO models (id, task, name, checkpoint) VALUES (3, 'ocr', 'New', '/new')")
        add_job(history, 'w', 'queued', 5)
        history.execute("UPDATE jobs SET model_ocr_id = 3 WHERE id = 'w'")

        # The median of 10 s and 100 s a page.
        assert queue_eta.dataset(history, 'w', NOW)['seconds'] == 275

    def test_without_ocr_it_takes_the_pace_of_datasets_without_ocr(self, history):
        add_job(history, 'lines', 'done', 10, '2026-01-01 10:00:00', '2026-01-01 10:00:20')
        history.execute("UPDATE jobs SET run_ocr = 0 WHERE id IN ('lines')")
        add_job(history, 'w', 'queued', 5)
        history.execute("UPDATE jobs SET run_ocr = 0 WHERE id = 'w'")

        assert queue_eta.dataset(history, 'w', NOW)['seconds'] == 10

    def test_a_map_dataset_takes_the_pace_of_map_datasets(self, history):
        add_job(history, 'map', 'done', 10, '2026-01-01 10:00:00', '2026-01-01 10:00:30')
        history.execute("UPDATE jobs SET task = 'map_segmentation' WHERE id = 'map'")
        add_job(history, 'w', 'queued', 5)
        history.execute("UPDATE jobs SET task = 'map_segmentation' WHERE id = 'w'")

        assert queue_eta.dataset(history, 'w', NOW)['seconds'] == 15


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
