import json

import pytest

from app import export, store


@pytest.fixture
def conn(tmp_path):
    connection = store.connect(tmp_path / 'app.db')
    yield connection
    connection.close()


def _seed(conn):
    conn.execute("INSERT INTO jobs (id, name, owner) VALUES ('j1', 'Chronik', 'eva')")
    conn.execute(
        "INSERT INTO pages (id, job_id, idx, filename, source_file, status, width, height) "
        "VALUES (1, 'j1', 0, 'scan_1.png', '/data/scan_1.png', 'done', 800, 1100)")
    conn.execute(
        "INSERT INTO elements (id, page_id, order_idx, class_name, bbox, kind) "
        "VALUES (1, 1, 0, 'Paragraph', '[0,0,1,1]', 'content')")
    for order_idx, text, checked in [(0, 'Pfarre Wien', 1), (1, 'Kaplan Huber', 0)]:
        conn.execute(
            "INSERT INTO lines (element_id, order_idx, polygon, text, checked) "
            'VALUES (1, ?, ?, ?, ?)', (order_idx, json.dumps([[0, 0], [1, 1]]), text, checked))
    conn.commit()


def test_checked_only_export_keeps_exactly_the_reviewed_lines(conn):
    _seed(conn)
    data = export.collect_job(conn, 'j1', checked_only=True)
    texts = [l['text'] for e in data['pages'][0]['elements'] for l in e['lines']]
    assert texts == ['Pfarre Wien']
    assert export.to_text(data) == 'Pfarre Wien'


def test_full_export_carries_the_checked_flag(conn):
    _seed(conn)
    data = export.collect_job(conn, 'j1')
    lines = data['pages'][0]['elements'][0]['lines']
    assert [(l['text'], l['checked']) for l in lines] == [
        ('Pfarre Wien', True), ('Kaplan Huber', False)]


def test_export_names_the_page_and_line_it_read(conn):
    # The transcript view draws a scan and a box over the line being read, and both need a
    # row to ask for rather than a position in a list.
    _seed(conn)
    page = export.collect_job(conn, 'j1')['pages'][0]
    assert page['id'] == 1
    ids = [l['id'] for e in page['elements'] for l in e['lines']]
    assert ids == [row['id'] for row in conn.execute(
        'SELECT id FROM lines WHERE element_id = 1 ORDER BY order_idx')]


def test_the_geometry_is_sent_at_a_sane_precision(conn):
    """A double spells one corner in seventeen digits; five places is a tenth of a pixel on
    a ten-thousand pixel scan, and over a volume the difference is most of the payload."""
    conn.execute("INSERT INTO jobs (id, name, owner) VALUES ('j2', 'Precise', 'eva')")
    conn.execute(
        "INSERT INTO pages (id, job_id, idx, filename, source_file, status) "
        "VALUES (2, 'j2', 0, 's.png', '/s.png', 'done')")
    conn.execute("INSERT INTO elements (id, page_id, order_idx, class_name, bbox, kind) "
                 "VALUES (2, 2, 0, 'Paragraph', ?, 'content')",
                 (json.dumps([0.1, 0.07833333333333334, 0.9, 0.2]),))
    conn.execute("INSERT INTO lines (element_id, order_idx, polygon, text) VALUES (2, 0, ?, 'x')",
                 (json.dumps([[0.1, 0.07833333333333334], [0.9, 0.2]]),))
    conn.commit()

    element = export.collect_job(conn, 'j2')['pages'][0]['elements'][0]
    assert element['lines'][0]['polygon'] == [[0.1, 0.07833], [0.9, 0.2]]
    assert element['bbox'] == [0.1, 0.07833, 0.9, 0.2]


def test_text_and_markdown_include_the_lines_inside_containers(conn):
    _seed(conn)
    conn.execute(
        "INSERT INTO elements (id, page_id, order_idx, class_name, bbox, kind) "
        "VALUES (2, 1, 1, 'Table', '[0,0,1,1]', 'container')")
    conn.execute(
        "INSERT INTO lines (element_id, order_idx, polygon, text) "
        "VALUES (2, 0, '[[0,0],[1,1]]', 'Taufen 1876')")
    conn.commit()
    data = export.collect_job(conn, 'j1')

    assert export.to_text(data) == 'Pfarre Wien\nKaplan Huber\nTaufen 1876'
    assert export.to_markdown(data) == (
        '# Chronik\n\n## Page 1: scan_1.png\n\n'
        '**Paragraph**\n\nPfarre Wien\nKaplan Huber\n\n'
        '**Table**\n\nTaufen 1876\n')


def test_a_polygon_dataset_exports_each_elements_outline_beside_its_box(conn):
    _seed(conn)
    outline = [[0.1, 0.1], [0.9, 0.12], [0.5, 0.9]]
    conn.execute('UPDATE elements SET polygon = ?', (json.dumps(outline),))
    conn.commit()
    assert 'polygon' not in export.collect_job(conn, 'j1')['pages'][0]['elements'][0]

    conn.execute("UPDATE jobs SET layout_shape = 'polygon'")
    conn.commit()
    [element] = export.collect_job(conn, 'j1')['pages'][0]['elements']
    assert (element['bbox'], element['polygon']) == ([0, 0, 1, 1], outline)


def test_a_polygon_datasets_coco_export_carries_the_outline_and_training_does_not(conn):
    from app import coco
    _seed(conn)
    conn.execute("UPDATE jobs SET layout_shape = 'polygon'")
    conn.execute("UPDATE pages SET layout_checked = 1, content_hash = 'h'")
    conn.execute("UPDATE elements SET polygon = '[[0,0],[1,0],[0,1]]'")
    conn.commit()

    exported, _ = coco.collect(conn, 'j1', outlines=True)
    trained, _ = coco.collect(conn, 'j1')

    assert exported['doc']['annotations'][0]['segmentation'] == [[0, 0, 800, 0, 0, 1100]]
    assert trained['doc']['annotations'][0]['segmentation'] == []
