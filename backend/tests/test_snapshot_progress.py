"""A large snapshot cuts tens of thousands of crops before training starts. Without a
count it reads as a hang, and users killed runs that were working - so the cut reports
its progress, and a cancel during it actually stops, instead of the run carrying on to
start a training nobody asked for.
"""
import json

import pytest
from PIL import Image

from app import store, train_snapshot, trainer


@pytest.fixture
def seeded(tmp_path, monkeypatch):
    monkeypatch.setattr('app.config.TRAININGS_DIR', tmp_path / 'trainings')
    conn = store.connect(tmp_path / 'app.db')
    scan = tmp_path / 'scan.png'
    Image.new('RGB', (400, 300), 'white').save(scan)
    conn.execute("INSERT INTO jobs (id, name) VALUES ('job1', 'Job')")
    poly = json.dumps([[0.1, 0.1], [0.9, 0.1], [0.9, 0.3], [0.1, 0.3]])
    for page_id in (1, 2, 3):
        conn.execute(
            "INSERT INTO pages (id, job_id, idx, filename, source_file, status) "
            "VALUES (?, 'job1', ?, 'scan.png', ?, 'done')", (page_id, page_id - 1, str(scan)))
        conn.execute("INSERT INTO elements (id, page_id, order_idx, class_name, bbox, kind) "
                     "VALUES (?, ?, 0, 'Paragraph', '[0.1,0.1,0.9,0.9]', 'content')",
                     (page_id, page_id))
        for i in range(4):
            conn.execute('INSERT INTO lines (element_id, order_idx, polygon, text, checked) '
                         'VALUES (?, ?, ?, ?, 1)', (page_id, i, poly, f'line {page_id}.{i}'))
    conn.execute("INSERT INTO trainings (id, task, name, owner, dataset_job_ids) "
                 "VALUES (7, 'ocr', 'run', 'root', '[\"job1\"]')")
    conn.commit()
    yield conn
    conn.close()


def test_the_cut_reports_progress_up_to_its_total(seeded, tmp_path):
    seen = []
    counts = train_snapshot.build(seeded, 7, 'ocr', ['job1'], val_fraction=0.0,
                                  on_progress=lambda done, total: seen.append((done, total)))
    assert counts['train'] == 12
    assert seen[0] == (0, 12)          # the total is known before any work is done
    assert seen[-1] == (12, 12)
    assert [done for done, _total in seen] == sorted(done for done, _total in seen)


def test_a_cancel_during_the_cut_stops_it(seeded, tmp_path):
    with pytest.raises(train_snapshot.SnapshotCancelled):
        train_snapshot.build(seeded, 7, 'ocr', ['job1'], val_fraction=0.0,
                             should_stop=lambda: True)


def test_progress_lands_on_the_training_row(seeded):
    training = trainer.get_training(seeded, 7)
    trainer.prepare_snapshot(seeded, training)
    row = seeded.execute('SELECT snapshot_counts, snapshot_progress FROM trainings '
                         'WHERE id = 7').fetchone()
    assert json.loads(row['snapshot_counts'])['train'] > 0
    # Cleared once the cut is done, so a finished run shows no stale bar.
    assert row['snapshot_progress'] is None


def test_a_run_cancelled_while_preparing_never_starts(seeded, monkeypatch, training_backend):
    spawned = []
    monkeypatch.setattr(trainer.remote_training, 'run',
                        lambda *a: spawned.append(a) or pytest.fail('the backend was asked to train'))
    monkeypatch.setattr(trainer.evaluator, 'create_baseline', lambda *a: None)
    # Cancelled the moment the snapshot finishes, which is what a click during the cut does.
    monkeypatch.setattr(trainer, 'prepare_snapshot',
                        lambda conn, t, **kwargs: seeded.execute(
                            "UPDATE trainings SET status = 'cancelled' WHERE id = 7") and None)
    trainer.run_local(seeded, 7)
    assert spawned == []
    assert trainer.get_training(seeded, 7)['status'] == 'cancelled'


def test_the_cut_does_not_fork_the_threaded_api(seeded, monkeypatch):
    # A forked worker inherits whatever lock another API thread held at that moment and
    # can wait on it forever, leaving the run in 'preparing' and the queue behind it.
    started = []

    class Recording(train_snapshot.ProcessPoolExecutor):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            started.append(self._mp_context.get_start_method())

    monkeypatch.setattr(train_snapshot, 'ProcessPoolExecutor', Recording)
    train_snapshot.build(seeded, 7, 'ocr', ['job1'], val_fraction=0.0)
    assert started and 'fork' not in started
