"""A dataset on 'auto' reads with what suits its model when it reads, and a dataset that
follows the default model can be moved onto it."""
import pytest

from app import auto_decode, store


@pytest.fixture
def conn(tmp_path):
    connection = store.connect(tmp_path / 'app.db')
    connection.executescript("""
        INSERT INTO models (id, task, name, checkpoint, decoder) VALUES (1, 'ocr', 'token reader', '/a', 'token');
        INSERT INTO models (id, task, name, checkpoint, trained_from) VALUES (2, 'ocr', 'its fine-tune', '/b', 1);
        INSERT INTO models (id, task, name, checkpoint, decoder) VALUES (3, 'ocr', 'char reader', '/c', 'char');
        INSERT INTO models (id, task, name, checkpoint) VALUES (4, 'ocr', 'never loaded', '/d');
    """)
    yield connection
    connection.close()


@pytest.mark.parametrize('model_id, mode', [(1, 'decoder'), (2, 'decoder'), (3, 'rescored'), (4, 'rescored')])
def test_auto_reads_with_the_models_own_best(conn, model_id, mode):
    assert auto_decode.resolve(conn, model_id, 'auto') == mode


def test_a_mode_set_on_purpose_is_kept(conn):
    assert [auto_decode.resolve(conn, 1, mode) for mode in ('beam', 'rescored', 'greedy', 'decoder')] == \
        ['beam', 'rescored', 'greedy', 'decoder']


@pytest.fixture
def datasets(conn):
    conn.executescript("""
        INSERT INTO jobs (id, name, owner, status, ocr_decode) VALUES
            ('beam1', 'a', 'o', 'done', 'beam'), ('beam2', 'b', 'o', 'done', 'beam'),
            ('reranked', 'c', 'o', 'done', 'rescored'), ('fast', 'd', 'o', 'done', 'greedy'),
            ('already', 'e', 'o', 'done', 'auto');
        INSERT INTO jobs (id, name, owner, status, ocr_decode, model_ocr_id) VALUES
            ('pinned', 'f', 'o', 'done', 'beam', 3);
        INSERT INTO jobs (id, name, owner, status, ocr_decode, task) VALUES
            ('map', 'g', 'o', 'done', 'beam', 'map_segmentation');
    """)
    return conn


def _modes(conn) -> dict:
    return {row['id']: row['ocr_decode'] for row in conn.execute('SELECT id, ocr_decode FROM jobs')}


def test_a_dry_run_counts_the_datasets_it_would_move_and_moves_none(datasets):
    before = _modes(datasets)
    assert auto_decode.move_followers(datasets, apply=False) == {'beam': 2, 'rescored': 1}
    assert _modes(datasets) == before


def test_applied_it_moves_the_text_datasets_following_the_default_on_beam_or_rescored(datasets):
    assert auto_decode.move_followers(datasets, apply=True) == {'beam': 2, 'rescored': 1}
    assert _modes(datasets) == {'beam1': 'auto', 'beam2': 'auto', 'reranked': 'auto', 'fast': 'greedy',
                                'already': 'auto', 'pinned': 'beam', 'map': 'beam'}
    assert auto_decode.move_followers(datasets, apply=True) == {}


def test_the_command_says_what_it_would_do_and_does_it_with_apply(datasets, monkeypatch, capsys, tmp_path):
    monkeypatch.setattr('app.config.DB_PATH', tmp_path / 'app.db')
    datasets.commit()

    auto_decode.main([])
    assert capsys.readouterr().out.strip() == (
        '3 datasets follow the default OCR model on a fixed decode: 2 on beam, 1 on rescored. '
        'Run again with --apply to move them to auto.')
    auto_decode.main(['--apply'])
    assert capsys.readouterr().out.strip() == 'Moved 3 datasets to auto: 2 from beam, 1 from rescored.'
    assert _modes(store.connect(tmp_path / 'app.db'))['beam1'] == 'auto'
