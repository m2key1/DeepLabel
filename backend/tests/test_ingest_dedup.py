import json

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app import map_ingest, store
from app.deps import get_db
from app.main import app


@pytest.fixture
def job(tmp_path):
    conn = store.connect(tmp_path / 'app.db')
    conn.execute("INSERT INTO jobs (id, name, task) VALUES ('job1', 'Job', 'map_segmentation')")
    conn.commit()
    yield conn, tmp_path
    conn.close()


def add_page(conn, idx, source):
    cur = conn.execute(
        "INSERT INTO pages (job_id, idx, filename, source_file) VALUES ('job1', ?, ?, ?)",
        (idx, source.name, str(source)))
    conn.commit()
    return cur.lastrowid


def page_row(conn, page_id):
    return conn.execute('SELECT * FROM pages WHERE id = ?', (page_id,)).fetchone()


def test_taken_hashes_ignores_deleted_pages(job):
    conn, _ = job
    conn.execute("INSERT INTO pages (job_id, idx, filename, source_file, content_hash, deleted) "
                 "VALUES ('job1', 0, 'gone.png', '/gone.png', 'hash-gone', 1)")
    conn.execute("INSERT INTO pages (job_id, idx, filename, source_file, content_hash) "
                 "VALUES ('job1', 1, 'live.png', '/live.png', 'hash-live')")
    conn.commit()
    assert store.taken_hashes(conn, 'pages', 'job1') == {'hash-live'}


def test_taken_hashes_ignores_deleted_maps(job):
    conn, _ = job
    conn.execute("INSERT INTO job_maps (job_id, idx, filename, source_file, content_hash, deleted) "
                 "VALUES ('job1', 0, 'gone.tif', '/gone.tif', 'hash-gone', 1)")
    conn.execute("INSERT INTO job_maps (job_id, idx, filename, source_file, content_hash) "
                 "VALUES ('job1', 1, 'live.tif', '/live.tif', 'hash-live')")
    conn.commit()
    assert store.taken_hashes(conn, 'job_maps', 'job1') == {'hash-live'}


def test_reuploading_a_deleted_page_ingests_instead_of_duplicating(job):
    """Deleting a page and uploading the same file again has to give a usable page.
    Counting the deleted row's hash left the copy stuck as 'duplicate': never sized,
    no renditions, excluded from every export."""
    conn, tmp_path = job
    scan = tmp_path / 'scan.png'
    Image.new('RGB', (400, 300), 'white').save(scan)

    first = add_page(conn, 0, scan)
    map_ingest.ingest_map_job(conn, 'job1', tmp_path)
    assert page_row(conn, first)['status'] == 'done'

    conn.execute('UPDATE pages SET deleted = 1 WHERE id = ?', (first,))
    conn.commit()

    second = add_page(conn, 1, scan)
    map_ingest.ingest_map_job(conn, 'job1', tmp_path)

    row = page_row(conn, second)
    assert row['status'] == 'done'
    assert (row['width'], row['height']) == (400, 300)
    assert (tmp_path / 'renditions' / f'{second}_thumb.jpg').exists()


def test_a_live_duplicate_is_still_marked_duplicate(job):
    """The dedup itself must keep working - only deleted rows stop claiming a hash."""
    conn, tmp_path = job
    scan = tmp_path / 'scan.png'
    Image.new('RGB', (400, 300), 'white').save(scan)

    first = add_page(conn, 0, scan)
    second = add_page(conn, 1, scan)
    map_ingest.ingest_map_job(conn, 'job1', tmp_path)

    assert page_row(conn, first)['status'] == 'done'
    assert page_row(conn, second)['status'] == 'duplicate'


@pytest.mark.parametrize('table', ['pages', 'job_maps'])
def test_taken_hashes_ignores_duplicates(job, table):
    """A duplicate only points at content another row holds; it never holds it itself."""
    conn, _ = job
    conn.execute(f"INSERT INTO {table} (job_id, idx, filename, source_file, content_hash, status) "
                 "VALUES ('job1', 0, 'copy.png', '/copy.png', 'hash-copy', 'duplicate')")
    conn.execute(f"INSERT INTO {table} (job_id, idx, filename, source_file, content_hash, status) "
                 "VALUES ('job1', 1, 'live.png', '/live.png', 'hash-live', 'done')")
    conn.commit()
    assert store.taken_hashes(conn, table, 'job1') == {'hash-live'}


def test_reuploading_after_deleting_an_original_that_had_a_duplicate_ingests(job):
    """The duplicate left behind must not stand in for the deleted original, or the
    fresh upload of the same file lands as yet another unusable duplicate."""
    conn, tmp_path = job
    scan = tmp_path / 'scan.png'
    Image.new('RGB', (400, 300), 'white').save(scan)

    original = add_page(conn, 0, scan)
    copy = add_page(conn, 1, scan)
    map_ingest.ingest_map_job(conn, 'job1', tmp_path)
    assert (page_row(conn, original)['status'], page_row(conn, copy)['status']) == ('done', 'duplicate')

    conn.execute('UPDATE pages SET deleted = 1 WHERE id = ?', (original,))
    conn.commit()
    again = add_page(conn, 2, scan)
    map_ingest.ingest_map_job(conn, 'job1', tmp_path)

    row = page_row(conn, again)
    assert (row['status'], row['width'], row['height']) == ('done', 400, 300)


def test_a_map_jobs_tile_tally_leaves_its_duplicates_out(job, monkeypatch):
    """Two tiles and a copy of one: the copy is never rendered or exported, so it is
    neither a tile to review nor one that could be counted as reviewed."""
    conn, _ = job
    monkeypatch.setattr('app.config.FRONTEND_SECRET', 'secret')
    conn.executemany(
        "INSERT INTO pages (job_id, idx, filename, source_file, status, layout_checked) "
        "VALUES ('job1', ?, ?, '/x.png', ?, ?)",
        [(0, 'a.png', 'done', 1), (1, 'a_again.png', 'duplicate', 1), (2, 'b.png', 'done', 0)])
    conn.execute("INSERT INTO regions (page_id, order_idx, class_id, points, holes, kind) "
                 "SELECT id, 0, 1, '[[0,0],[1,0],[1,1]]', '[]', 'polygon' FROM pages")
    conn.commit()
    app.dependency_overrides[get_db] = lambda: conn
    try:
        body = TestClient(app).get('/api/jobs/job1', headers={
            'X-Frontend-Secret': 'secret', 'X-Auth-User': 'root', 'X-Auth-Role': 'admin'}).json()
    finally:
        app.dependency_overrides.clear()

    tally = {k: body[k] for k in ('tiles_total', 'tiles_annotated', 'tiles_reviewed', 'pages_checked')}
    assert tally == {'tiles_total': 2, 'tiles_annotated': 2, 'tiles_reviewed': 1, 'pages_checked': 1}
    assert [p['status'] for p in body['pages']] == ['done', 'duplicate', 'done']


def counters(conn):
    return json.loads(conn.execute("SELECT counters FROM jobs WHERE id = 'job1'").fetchone()['counters'])


def test_progress_totals_leave_duplicates_out(job):
    """A duplicate is no work, so the bars count it on neither side: a dataset whose every
    original is done reads 2/2, not 2/3 for ever."""
    conn, tmp_path = job
    scan, other = tmp_path / 'scan.png', tmp_path / 'other.png'
    Image.new('RGB', (400, 300), 'white').save(scan)
    Image.new('RGB', (400, 300), 'black').save(other)
    for idx, source in enumerate((scan, scan, other)):
        add_page(conn, idx, source)
    store.recount_pages(conn, 'job1')
    assert (counters(conn)['pages_total'], counters(conn)['pages_ingested']) == (3, 0)

    map_ingest.ingest_map_job(conn, 'job1', tmp_path)
    assert (counters(conn)['pages_total'], counters(conn)['pages_ingested']) == (2, 2)

    store.recount_pages(conn, 'job1')
    assert {key: counters(conn)[key] for key in ('pages_total', 'pages_ingested', 'pages_predicted')} == {
        'pages_total': 2, 'pages_ingested': 2, 'pages_predicted': 2}


def test_recount_leaves_duplicates_out_of_every_page_counter(job):
    conn, _ = job
    conn.execute("UPDATE jobs SET task = 'ocr' WHERE id = 'job1'")
    for idx, status in enumerate(('lines_done', 'duplicate', 'pending', 'duplicate')):
        conn.execute("INSERT INTO pages (job_id, idx, filename, source_file, status) "
                     "VALUES ('job1', ?, ?, ?, ?)", (idx, f'{idx}.png', f'/{idx}.png', status))
    conn.commit()
    assert store.recount_pages(conn, 'job1') == 2
    assert {key: counters(conn)[key] for key in ('pages_total', 'pages_ingested', 'pages_layout_done')} == {
        'pages_total': 2, 'pages_ingested': 1, 'pages_layout_done': 1}
