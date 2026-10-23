import json

import pytest

from app import provenance, store


@pytest.fixture
def conn(tmp_path):
    connection = store.connect(tmp_path / 'app.db')
    connection.executescript("""
        INSERT INTO models (id, task, name, checkpoint, is_default) VALUES
            (1, 'layout', 'RF-DETR 2XL', '/l.pt', 1),
            (2, 'lines', 'DB ppocrv6', '/d.pt', 1),
            (3, 'ocr', 'DeepOCR v12', '/o12.ckpt', 1),
            (4, 'ocr', 'DeepOCR v11', '/o11.ckpt', 0);
        INSERT INTO model_files (model_id, role, filename, sha256, size) VALUES
            (3, 'weights', 'model.ckpt', '41d0e8aa' || hex(randomblob(28)), 10);
        INSERT INTO jobs (id, name, owner, task) VALUES ('j1', 'Volume', 'alice', 'text');
        INSERT INTO pages (id, job_id, idx, filename, source_file) VALUES (1, 'j1', 0, 'p.png', '/p.png');
        INSERT INTO elements (id, page_id, order_idx, class_name, bbox) VALUES (1, 1, 0, 'Paragraph', '[0,0,1,1]');
    """)
    yield connection
    connection.close()


def add_line(conn, line_id, text='Anno', model=None, by_hand=0, corrected=None, corrected_by=None, deleted=0):
    conn.execute('INSERT INTO lines (id, element_id, order_idx, polygon, text, ocr_model_id, ocr_run_at, by_hand, '
                 'corrected_text, corrected_by, deleted) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                 (line_id, line_id, json.dumps([]), text, model, model and '2026-10-16 10:00:00', by_hand,
                  corrected, corrected_by, deleted))


def page(conn):
    return conn.execute('SELECT * FROM pages WHERE id = 1').fetchone()


def test_each_stage_names_its_model_and_when_it_ran(conn):
    store.note_page_model(conn, 1, 'layout', 1)
    store.note_page_model(conn, 1, 'lines', 2)

    shown = provenance.page_provenance(conn, page(conn))

    assert shown['layout']['id'] == 1 and shown['layout']['name'] == 'RF-DETR 2XL'
    assert shown['layout']['hash'] is None
    assert shown['layout']['at'] is not None
    assert shown['lines']['name'] == 'DB ppocrv6'


def test_lines_read_by_different_models_are_counted_apart_largest_first(conn):
    for line_id in (1, 2, 3):
        add_line(conn, line_id, model=3)
    add_line(conn, 4, model=4)
    add_line(conn, 5, model=4, deleted=1)
    add_line(conn, 6, text=None)

    readers = provenance.page_provenance(conn, page(conn))['ocr']

    assert [(r['model']['name'], r['lines']) for r in readers] == [('DeepOCR v12', 3), ('DeepOCR v11', 1)]
    assert readers[0]['model']['hash'] == '41d0e8a'
    assert readers[0]['at'] == '2026-10-16 10:00:00'


def test_hand_work_is_counted_and_machine_corrections_are_not(conn):
    add_line(conn, 1, model=3, by_hand=1)
    add_line(conn, 2, model=3, corrected='Anno 1754', corrected_by='alice')
    add_line(conn, 3, model=3, corrected='Anno 1755', corrected_by='align:corpus@0.98')
    add_line(conn, 4, model=3, corrected='Anno 1756', corrected_by=None)

    shown = provenance.page_provenance(conn, page(conn))

    assert (shown['lines_total'], shown['lines_by_hand'], shown['ocr_corrected']) == (4, 1, 2)


def test_a_page_never_read_names_no_model(conn):
    shown = provenance.page_provenance(conn, page(conn))

    assert (shown['layout'], shown['lines'], shown['ocr']) == (None, None, [])
