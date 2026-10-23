"""The same image ingested into two datasets is stored once: ingest replaces each
dataset's copy with a hard link into the content-addressed blob store, the rows act
as the pointers, and the blob goes when the last dataset pointing at it goes -
whether by deleting the dataset or purging the page.
"""
import hashlib
import io
import os

import pytest
from PIL import Image
from fastapi.testclient import TestClient

from app import config, map_ingest, store
from app.deps import get_db
from app.main import app

SECRET = 'test-secret'
ADMIN = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'root', 'X-Auth-Role': 'admin'}


def png_bytes() -> bytes:
    buf = io.BytesIO()
    Image.new('RGB', (32, 32), 'white').save(buf, 'PNG')
    return buf.getvalue()


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    monkeypatch.setattr('app.config.JOBS_DIR', tmp_path / 'jobs')
    conn = store.connect(tmp_path / 'app.db')
    app.dependency_overrides[get_db] = lambda: conn
    yield conn
    app.dependency_overrides.clear()
    conn.close()


def ingest_job(conn, job_id: str, scan_bytes: bytes):
    conn.execute("INSERT INTO jobs (id, name, owner, task, status) "
                 "VALUES (?, ?, 'root', 'map_segmentation', 'done')", (job_id, f'Job {job_id}'))
    job_dir = config.job_dir(job_id)
    (job_dir / 'uploads').mkdir(parents=True)
    scan = job_dir / 'uploads' / 'scan.png'
    scan.write_bytes(scan_bytes)
    conn.execute("INSERT INTO pages (job_id, idx, filename, source_file) "
                 "VALUES (?, 0, 'scan.png', ?)", (job_id, str(scan)))
    conn.commit()
    map_ingest.ingest_map_job(conn, job_id, job_dir, blobs_dir=config.BLOBS_DIR)
    return scan


def blob_of(scan_bytes: bytes):
    digest = hashlib.sha256(scan_bytes).hexdigest()
    return config.BLOBS_DIR / digest[:2] / f'{digest}.png'


def test_two_datasets_with_the_same_scan_share_one_stored_copy(env):
    conn = env
    scan_bytes = png_bytes()
    first = ingest_job(conn, 'j1', scan_bytes)
    second = ingest_job(conn, 'j2', scan_bytes)

    statuses = [r['status'] for r in conn.execute('SELECT status FROM pages ORDER BY id')]
    assert statuses == ['done', 'done']
    blob = blob_of(scan_bytes)
    assert blob.exists()
    assert os.stat(first).st_ino == os.stat(blob).st_ino
    assert os.stat(second).st_ino == os.stat(blob).st_ino
    assert os.stat(blob).st_nlink == 3


def test_an_external_scan_is_never_adopted(env, tmp_path):
    conn = env
    scan = tmp_path / 'archive' / 'scan.png'
    scan.parent.mkdir()
    scan.write_bytes(png_bytes())
    conn.execute("INSERT INTO jobs (id, name, owner, task, status) "
                 "VALUES ('j1', 'Job', 'root', 'map_segmentation', 'done')")
    job_dir = config.job_dir('j1')
    job_dir.mkdir(parents=True)
    conn.execute("INSERT INTO pages (job_id, idx, filename, source_file) "
                 "VALUES ('j1', 0, 'scan.png', ?)", (str(scan),))
    conn.commit()
    map_ingest.ingest_map_job(conn, 'j1', job_dir, blobs_dir=config.BLOBS_DIR)

    assert conn.execute('SELECT status FROM pages').fetchone()['status'] == 'done'
    assert list(config.BLOBS_DIR.rglob('*.png')) == []
    assert os.stat(scan).st_nlink == 1


def test_deleting_a_dataset_keeps_the_blob_until_the_last_one_goes(env):
    conn = env
    scan_bytes = png_bytes()
    ingest_job(conn, 'j1', scan_bytes)
    second = ingest_job(conn, 'j2', scan_bytes)
    blob = blob_of(scan_bytes)

    res = TestClient(app).delete('/api/jobs/j1', headers=ADMIN)
    assert res.status_code == 200
    assert blob.exists()
    assert os.stat(blob).st_nlink == 2
    assert second.read_bytes() == scan_bytes

    res = TestClient(app).delete('/api/jobs/j2', headers=ADMIN)
    assert res.status_code == 200
    assert not blob.exists()


def test_purging_the_last_pointer_releases_the_blob(env):
    conn = env
    scan_bytes = png_bytes()
    first = ingest_job(conn, 'j1', scan_bytes)
    ingest_job(conn, 'j2', scan_bytes)
    blob = blob_of(scan_bytes)

    conn.execute("UPDATE pages SET deleted = 1 WHERE job_id = 'j1'")
    conn.commit()
    res = TestClient(app).post('/api/jobs/j1/purge', headers=ADMIN)
    assert res.status_code == 200
    assert not first.exists()
    assert blob.exists(), 'j2 still points at these bytes'

    conn.execute("UPDATE pages SET deleted = 1 WHERE job_id = 'j2'")
    conn.commit()
    res = TestClient(app).post('/api/jobs/j2/purge', headers=ADMIN)
    assert res.status_code == 200
    assert not blob.exists()
