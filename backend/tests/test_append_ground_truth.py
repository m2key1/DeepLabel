"""Appending pages must pair sibling transcriptions exactly like creating a dataset does.

Both create routes attach ground truth (routes/jobs.py create_job / create_job_from_path),
and phase_align re-runs over every page with gt_text when the append requeues the job. So a
page that arrives through an append has to reach that phase carrying its transcription too,
otherwise the same folder yields corrections or nothing depending only on arrival time.
"""
import pytest
from fastapi.testclient import TestClient

from app import store
from app.deps import get_db
from app.main import app

SECRET = 'test-secret'
ADMIN = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'alice', 'X-Auth-Role': 'admin'}

TRANSCRIPTION = 'Pfarre Wien\nKaplan Huber'


@pytest.fixture
def client(tmp_path, monkeypatch):
    """Alice owns a finished text dataset with one page already ingested."""
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    monkeypatch.setattr('app.config.JOBS_DIR', tmp_path / 'jobs')
    conn = store.connect(tmp_path / 'app.db')
    conn.execute("INSERT INTO jobs (id, name, owner, status) VALUES ('job1', 'alice set', 'alice', 'done')")
    conn.execute("INSERT INTO pages (job_id, idx, filename, source_file, status) "
                 "VALUES ('job1', 0, 'scan_1.png', '/nonexistent/scan_1.png', 'done')")
    conn.commit()
    app.dependency_overrides[get_db] = lambda: conn
    yield TestClient(app), conn
    app.dependency_overrides.clear()
    conn.close()


def gt_text(conn, filename: str):
    row = conn.execute("SELECT gt_text FROM pages WHERE job_id = 'job1' AND filename = ?",
                       (filename,)).fetchone()
    assert row is not None, f'{filename} was not ingested'
    return row['gt_text']


def gt_in_page_order(conn) -> list:
    return [row['gt_text'] for row in conn.execute(
        "SELECT gt_text FROM pages WHERE job_id = 'job1' ORDER BY idx")]


def gt_source(conn, filename: str):
    return conn.execute("SELECT gt_source FROM pages WHERE job_id = 'job1' AND filename = ?",
                        (filename,)).fetchone()['gt_source']


class TestAppendUploads:
    def test_sibling_transcription_lands_on_the_appended_page(self, client):
        api, conn = client
        response = api.post('/api/jobs/job1/pages/upload', headers=ADMIN, files=[
            ('files', ('scan_2.png', b'\x89PNG\r\n\x1a\n', 'image/png')),
            ('files', ('scan_2.txt', TRANSCRIPTION.encode(), 'text/plain')),
        ])
        assert response.status_code == 200
        assert response.json()['added'] == 1  # the .txt is transcription, not a page
        assert gt_text(conn, 'scan_2.png') == TRANSCRIPTION
        assert gt_source(conn, 'scan_2.png') == 'sidecar'

    def test_transcription_without_its_image_is_not_an_upload_of_nothing(self, client):
        """A lone .txt pairs with no page, so the request has added no pages at all."""
        api, _ = client
        response = api.post('/api/jobs/job1/pages/upload', headers=ADMIN, files=[
            ('files', ('scan_9.txt', TRANSCRIPTION.encode(), 'text/plain')),
        ])
        assert response.status_code == 400

    def test_pages_without_a_transcription_keep_none(self, client):
        api, conn = client
        api.post('/api/jobs/job1/pages/upload', headers=ADMIN, files=[
            ('files', ('scan_3.png', b'\x89PNG\r\n\x1a\n', 'image/png')),
        ])
        assert gt_text(conn, 'scan_3.png') is None

    def test_a_new_scan_named_like_an_old_one_keeps_its_own_transcription(self, client):
        api, conn = client
        conn.execute("UPDATE pages SET gt_text = 'Original text' WHERE filename = 'scan_1.png'")
        conn.commit()
        api.post('/api/jobs/job1/pages/upload', headers=ADMIN, files=[
            ('files', ('scan_1.png', b'\x89PNG\r\n\x1a\n', 'image/png')),
            ('files', ('scan_1.txt', TRANSCRIPTION.encode(), 'text/plain')),
        ])
        assert gt_in_page_order(conn) == ['Original text', TRANSCRIPTION]


class TestAppendPath:
    def test_sibling_transcription_is_read_from_the_directory(self, client, tmp_path):
        api, conn = client
        source = tmp_path / 'volume-2'
        source.mkdir()
        (source / 'scan_4.png').write_bytes(b'\x89PNG\r\n\x1a\n')
        (source / 'scan_4.txt').write_text(TRANSCRIPTION, encoding='utf-8')
        (source / 'scan_5.png').write_bytes(b'\x89PNG\r\n\x1a\n')

        response = api.post('/api/jobs/job1/pages/path', headers=ADMIN,
                            json={'server_path': str(source)})
        assert response.status_code == 200
        assert response.json()['added'] == 2
        assert gt_text(conn, 'scan_4.png') == TRANSCRIPTION
        assert gt_text(conn, 'scan_5.png') is None

    def test_existing_pages_are_left_alone(self, client, tmp_path):
        """attach_ground_truth sweeps the whole job; a page the append did not
        mention must not lose or gain text."""
        api, conn = client
        conn.execute("UPDATE pages SET gt_text = 'Original text' WHERE filename = 'scan_1.png'")
        conn.commit()
        source = tmp_path / 'volume-3'
        source.mkdir()
        (source / 'scan_6.png').write_bytes(b'\x89PNG\r\n\x1a\n')
        (source / 'scan_6.txt').write_text(TRANSCRIPTION, encoding='utf-8')

        api.post('/api/jobs/job1/pages/path', headers=ADMIN, json={'server_path': str(source)})
        assert gt_text(conn, 'scan_1.png') == 'Original text'
        assert gt_text(conn, 'scan_6.png') == TRANSCRIPTION

    def test_a_new_scan_named_like_an_old_one_keeps_its_own_transcription(self, client, tmp_path):
        api, conn = client
        conn.execute("UPDATE pages SET gt_text = 'Original text' WHERE filename = 'scan_1.png'")
        conn.commit()
        source = tmp_path / 'volume-4'
        source.mkdir()
        (source / 'scan_1.png').write_bytes(b'\x89PNG\r\n\x1a\n')
        (source / 'scan_1.txt').write_text(TRANSCRIPTION, encoding='utf-8')

        api.post('/api/jobs/job1/pages/path', headers=ADMIN, json={'server_path': str(source)})
        assert gt_in_page_order(conn) == ['Original text', TRANSCRIPTION]

    def test_a_text_file_named_after_no_scan_is_kept_as_a_corpus_document(self, client, tmp_path):
        """As an upload keeps it: the same folder must not lose its corpus depending only
        on whether it was uploaded or read from the server."""
        api, conn = client
        source = tmp_path / 'volume-5'
        source.mkdir()
        (source / 'scan_9.png').write_bytes(b'\x89PNG\r\n\x1a\n')
        (source / 'letter-02.txt').write_text('Ein Brief\nmit zwei Zeilen\n', encoding='utf-8')

        response = api.post('/api/jobs/job1/pages/path', headers=ADMIN,
                            json={'server_path': str(source)})
        assert response.json() == {'ok': True, 'added': 1, 'documents': 1, 'skipped_symlinks': []}
        assert [(row['name'], row['text']) for row in conn.execute(
            "SELECT name, text FROM job_documents WHERE job_id = 'job1'")] == [
            ('letter-02', 'Ein Brief\nmit zwei Zeilen\n')]
        assert gt_text(conn, 'scan_9.png') is None
