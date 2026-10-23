import pytest

from app import store
from app.routes import pages as pages_route


@pytest.fixture
def job(tmp_path, monkeypatch):
    monkeypatch.setattr('app.config.JOBS_DIR', tmp_path / 'jobs')
    conn = store.connect(tmp_path / 'app.db')
    conn.execute("INSERT INTO jobs (id, name) VALUES ('job1', 'Job')")
    conn.commit()
    (tmp_path / 'jobs' / 'job1' / 'uploads').mkdir(parents=True)
    (tmp_path / 'jobs' / 'job1' / 'renditions').mkdir(parents=True)
    yield conn, tmp_path / 'jobs' / 'job1'
    conn.close()


def add_deleted_page(conn, page_id, source):
    conn.execute("INSERT INTO pages (id, job_id, idx, filename, source_file, deleted) "
                 "VALUES (?, 'job1', ?, 'scan.jpg', ?, 1)", (page_id, page_id, str(source)))
    conn.commit()


def test_pages_with_nothing_left_to_free_are_not_purge_targets(job):
    """Purge keeps the page rows, so a second purge would otherwise keep offering the
    same pages forever: "Purge 3" that frees 0 B and never counts down."""
    conn, job_path = job
    scan = job_path / 'uploads' / 'kept.jpg'
    scan.write_bytes(b'x' * 2048)
    add_deleted_page(conn, 1, scan)
    add_deleted_page(conn, 2, job_path / 'uploads' / 'already-purged.jpg')

    targets = pages_route._purge_targets(conn, 'job1')
    assert [t['page_id'] for t in targets] == [1]

    manifest = pages_route._purge_manifest(targets)
    assert manifest == {'pages': 1, 'files': 1, 'bytes': 2048, 'external_sources': 0}


def test_manifest_is_empty_once_everything_is_purged(job):
    conn, job_path = job
    scan = job_path / 'uploads' / 'scan.jpg'
    scan.write_bytes(b'x' * 2048)
    add_deleted_page(conn, 1, scan)

    scan.unlink()
    assert pages_route._purge_manifest(pages_route._purge_targets(conn, 'job1')) == {
        'pages': 0, 'files': 0, 'bytes': 0, 'external_sources': 0}


def test_renditions_of_a_never_ingested_page_still_count(job):
    conn, job_path = job
    scan = job_path / 'uploads' / 'scan.jpg'
    scan.write_bytes(b'x' * 1024)
    add_deleted_page(conn, 7, scan)
    (job_path / 'renditions' / '7_thumb.jpg').write_bytes(b'x' * 512)

    manifest = pages_route._purge_manifest(pages_route._purge_targets(conn, 'job1'))
    assert manifest['pages'] == 1
    assert manifest['files'] == 2
    assert manifest['bytes'] == 1536


def test_an_external_scan_is_reported_but_never_unlinked(job):
    """A path-ingested page points at the user's own archive; only its renditions
    are ours to free, and the page must still be flagged as external."""
    conn, job_path = job
    outside = job_path.parent.parent / 'archive.jpg'
    outside.write_bytes(b'x' * 4096)
    add_deleted_page(conn, 3, outside)
    (job_path / 'renditions' / '3_thumb.jpg').write_bytes(b'x' * 256)

    targets = pages_route._purge_targets(conn, 'job1')
    assert [t['page_id'] for t in targets] == [3]
    assert outside not in targets[0]['files']
    assert pages_route._purge_manifest(targets) == {
        'pages': 1, 'files': 1, 'bytes': 256, 'external_sources': 1}


def test_a_pages_tile_pyramid_is_counted_tile_by_tile(job):
    """The pyramid is hundreds of small files and the biggest thing a page leaves behind
    after its scan; counted as one file - or not at all - purge would under-report what
    it is about to free by megabytes a page."""
    conn, job_path = job
    scan = job_path / 'uploads' / 'scan.jpg'
    scan.write_bytes(b'x' * 2048)
    add_deleted_page(conn, 1, scan)
    level = job_path / 'renditions' / '1_tiles' / '9'
    level.mkdir(parents=True)
    for name in ('0_0.jpg', '0_1.jpg', '1_0.jpg'):
        (level / name).write_bytes(b'y' * 512)

    manifest = pages_route._purge_manifest(pages_route._purge_targets(conn, 'job1'))

    assert manifest == {'pages': 1, 'files': 4, 'bytes': 2048 + 3 * 512, 'external_sources': 0}


def test_purging_takes_the_tile_pyramid_away_with_the_page(job):
    conn, job_path = job
    scan = job_path / 'uploads' / 'scan.jpg'
    scan.write_bytes(b'x' * 2048)
    add_deleted_page(conn, 1, scan)
    tiles = job_path / 'renditions' / '1_tiles'
    (tiles / '9').mkdir(parents=True)
    (tiles / '9' / '0_0.jpg').write_bytes(b'y' * 512)

    for target in pages_route._purge_targets(conn, 'job1'):
        for path in target['files']:
            path.unlink(missing_ok=True)
        pages_route.shutil.rmtree(target['tiles'], ignore_errors=True)

    assert not tiles.exists()
    assert not scan.exists()


def test_a_page_whose_only_leftover_is_its_pyramid_is_still_a_target(job):
    conn, job_path = job
    add_deleted_page(conn, 1, job_path / 'uploads' / 'gone.jpg')
    level = job_path / 'renditions' / '1_tiles' / '0'
    level.mkdir(parents=True)
    (level / '0_0.jpg').write_bytes(b'z' * 128)

    targets = pages_route._purge_targets(conn, 'job1')

    assert [t['page_id'] for t in targets] == [1]
    assert pages_route._purge_manifest(targets)['bytes'] == 128
