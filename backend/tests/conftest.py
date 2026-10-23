import os

# The cards the suite's cluster offers, read by app.config at import.
os.environ.setdefault('SLURM_GPUS', 'h200:8,rtx6000bb:7,l40s:4:inference')

import pytest

from tests.fakes import FakeTrainer


@pytest.fixture(autouse=True)
def _isolated_blob_store(tmp_path_factory, monkeypatch):
    """Ingest adoption and delete/purge release both touch config.BLOBS_DIR; tests must
    never reach the real data directory."""
    monkeypatch.setattr('app.config.BLOBS_DIR', tmp_path_factory.mktemp('blobs'))


@pytest.fixture(autouse=True)
def _drained_training_queue():
    """app.training keeps one queue for the whole process, and any test that corrects a
    line through a route puts a line id in it. A later test that asserts on what it just
    enqueued would then read somebody else's id.

    It does not bite today only because this deployment's .env sets SAVE_OCR_DATA=false,
    so nothing is ever enqueued - which is why the suite passes here and fails from a
    `git archive` copy, where the untracked .env is absent and the flag falls back to its
    default. A test suite whose isolation depends on a deployment flag is not isolated.
    """
    from app import training
    while not training._queue.empty():
        training._queue.get_nowait()
    yield
    while not training._queue.empty():
        training._queue.get_nowait()


@pytest.fixture(autouse=True)
def _isolated_weight_store(tmp_path_factory, monkeypatch):
    """A registered training result is copied into the weight store; never the real one."""
    monkeypatch.setattr('app.config.WEIGHTS_DIR', tmp_path_factory.mktemp('weights'))


@pytest.fixture
def training_backend(monkeypatch):
    """Every run trains on one fake backend."""
    trainer = FakeTrainer()
    monkeypatch.setattr('app.remote_training.training_backend', lambda _conn, _training: trainer)
    return trainer
