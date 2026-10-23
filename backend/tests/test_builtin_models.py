"""A fresh install's default models come from its backends: a backend with
builtin weights gets one model row per text task it is the task's backend for."""
import pytest

from app import store, weights
from tests.fakes import seed_defaults

STUB_INFO = {'model_type': 'stub', 'tasks': ['layout', 'lines', 'ocr', 'edges'], 'weights': {'builtin': True}}


@pytest.fixture
def conn(tmp_path):
    connection = store.connect(tmp_path / 'app.db')
    yield connection
    connection.close()


def models(conn) -> list[tuple]:
    return [tuple(r) for r in conn.execute(
        'SELECT task, name, source, checkpoint, backend, model_type, is_default FROM models ORDER BY id')]


def test_a_backend_with_builtin_weights_becomes_the_default_of_its_task(conn):
    added = weights.adopt_builtins(conn, 'ocr', STUB_INFO)

    assert len(added) == 1
    assert models(conn) == [('ocr', 'stub (builtin)', 'backend', '', 'ocr', 'stub', 1)]


def test_each_task_takes_its_own_backends_builtin(conn):
    for name in ('layout', 'lines', 'ocr', 'edges', 'stub'):
        weights.adopt_builtins(conn, name, STUB_INFO)

    assert models(conn) == [('layout', 'stub (builtin)', 'backend', '', 'layout', 'stub', 1),
                            ('lines', 'stub (builtin)', 'backend', '', 'lines', 'stub', 1),
                            ('ocr', 'stub (builtin)', 'backend', '', 'ocr', 'stub', 1)]


def test_a_builtin_is_adopted_once(conn):
    weights.adopt_builtins(conn, 'ocr', STUB_INFO)

    assert weights.adopt_builtins(conn, 'ocr', STUB_INFO) == []
    assert len(models(conn)) == 1


def test_a_builtin_leaves_a_default_already_chosen(conn):
    seed_defaults(conn)

    weights.adopt_builtins(conn, 'lines', {'model_type': 'kraken-blla', 'tasks': ['lines'],
                                           'weights': {'builtin': True}})

    assert [(r['name'], r['is_default']) for r in conn.execute(
        "SELECT name, is_default FROM models WHERE task = 'lines' ORDER BY id")] == [
        ('DB ppocrv6', 1), ('kraken-blla (builtin)', 0)]


def test_a_backend_without_builtin_weights_adds_nothing(conn):
    assert weights.adopt_builtins(conn, 'ocr', {'model_type': 'deepocr', 'tasks': ['ocr'],
                                                'weights': {'builtin': False}}) == []
    assert models(conn) == []


def test_the_adopted_model_is_read_on_its_backend(conn, monkeypatch):
    monkeypatch.setattr('app.config.MODEL_BACKENDS', {'ocr': weights.config.ModelBackend('ocr', 'http://ocr:9100', 's', 'g')})
    [model_id] = weights.adopt_builtins(conn, 'ocr', STUB_INFO)

    row = conn.execute('SELECT * FROM models WHERE id = ?', (model_id,)).fetchone()
    assert weights.serving_backend(row) == 'ocr'
    assert weights.model_files(conn, model_id) == []


def test_a_backend_that_is_not_up_yet_is_asked_again(conn, monkeypatch):
    from app import backend_client
    up = weights.config.ModelBackend('ocr', 'http://ocr:9100', 's', 'g')
    down = weights.config.ModelBackend('lines', 'http://lines:9100', 's', 'g')

    def info(client):
        if client.backend is down:
            raise backend_client.BackendError('unreachable', 'lines is starting')
        return STUB_INFO
    monkeypatch.setattr(backend_client.BackendClient, 'info', info)

    assert weights.ask_for_builtins(conn, [up, down]) == [down]
    assert models(conn) == [('ocr', 'stub (builtin)', 'backend', '', 'ocr', 'stub', 1)]
