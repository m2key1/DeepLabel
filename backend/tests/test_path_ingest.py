"""A dataset read from a directory on the server, sub-folders and all.

Volumes scanned into folders of their own restart their numbering, so the same name turns
up once per folder. The folders are the reading order, and a transcription belongs to the
scan beside it - never to a namesake in another folder.
"""
import pytest
from fastapi.testclient import TestClient

from app import store
from app.deps import get_db
from app.main import app

SECRET = 'test-secret'
ADMIN = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'alice', 'X-Auth-Role': 'admin'}
PNG = b'\x89PNG\r\n\x1a\n'


@pytest.fixture
def api(tmp_path, monkeypatch):
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    monkeypatch.setattr('app.config.JOBS_DIR', tmp_path / 'jobs')
    conn = store.connect(tmp_path / 'app.db')
    app.dependency_overrides[get_db] = lambda: conn
    yield TestClient(app), conn
    app.dependency_overrides.clear()
    conn.close()


def write_tree(root, files: dict[str, str | None]):
    for name, text in files.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(PNG) if text is None else path.write_text(text, encoding='utf-8')


def ingest(client, root) -> str:
    response = client.post('/api/jobs/path', headers=ADMIN, json={
        'name': 'nested volumes', 'server_path': str(root), 'run_layout': False})
    assert response.status_code == 200
    return response.json()['job_id']


def pages(conn, job_id: str) -> list[tuple]:
    return [(row['filename'], row['source_file'], row['gt_text']) for row in conn.execute(
        'SELECT filename, source_file, gt_text FROM pages WHERE job_id = ? ORDER BY idx',
        (job_id,))]


class TestSubFolders:
    def test_pages_keep_folder_order_each_with_its_own_transcription(self, api, tmp_path):
        client, conn = api
        root = tmp_path / 'scans'
        write_tree(root, {
            'vol1/001.png': None, 'vol1/001.txt': 'first of one',
            'vol1/002.png': None, 'vol1/002.txt': 'second of one',
            'vol2/001.png': None, 'vol2/001.txt': 'first of two',
            'vol2/002.png': None, 'vol2/002.txt': 'second of two',
        })
        job_id = ingest(client, root)

        assert pages(conn, job_id) == [
            ('001.png', str(root / 'vol1/001.png'), 'first of one'),
            ('002.png', str(root / 'vol1/002.png'), 'second of one'),
            ('001.png', str(root / 'vol2/001.png'), 'first of two'),
            ('002.png', str(root / 'vol2/002.png'), 'second of two'),
        ]

    def test_a_text_file_with_no_scan_beside_it_is_a_corpus_document(self, api, tmp_path):
        """A namesake scan in another folder does not make it a transcription."""
        client, conn = api
        root = tmp_path / 'scans'
        write_tree(root, {'vol1/003.png': None, 'vol2/003.txt': 'a letter of its own'})
        job_id = ingest(client, root)

        assert pages(conn, job_id) == [('003.png', str(root / 'vol1/003.png'), None)]
        assert [(row['name'], row['text']) for row in conn.execute(
            'SELECT name, text FROM job_documents WHERE job_id = ?', (job_id,))] == [
            ('vol2/003', 'a letter of its own')]

    def test_documents_of_the_same_name_in_different_folders_are_both_kept(self, api, tmp_path):
        client, conn = api
        root = tmp_path / 'scans'
        write_tree(root, {'scan.png': None, 'vol1/letter.txt': 'from volume one',
                          'vol2/letter.txt': 'from volume two', 'preface.txt': 'at the top'})
        job_id = ingest(client, root)

        assert documents(conn, job_id) == [
            ('preface', 'at the top'), ('vol1/letter', 'from volume one'),
            ('vol2/letter', 'from volume two')]


def documents(conn, job_id: str) -> list[tuple]:
    return [(row['name'], row['text']) for row in conn.execute(
        'SELECT name, text FROM job_documents WHERE job_id = ? ORDER BY idx', (job_id,))]


class TestTranscriptionNames:
    def test_an_upper_case_transcription_pairs_with_its_scan(self, api, tmp_path):
        client, conn = api
        root = tmp_path / 'scans'
        write_tree(root, {'IMG1.jpg': None, 'IMG1.TXT': 'upper case', 'img2.png': None,
                          'IMG2.txt': 'mixed case'})
        job_id = ingest(client, root)

        assert pages(conn, job_id) == [
            ('IMG1.jpg', str(root / 'IMG1.jpg'), 'upper case'),
            ('img2.png', str(root / 'img2.png'), 'mixed case')]
        assert documents(conn, job_id) == []


class TestTranscriptionEncodings:
    @pytest.mark.parametrize('raw', [
        b'\xef\xbb\xbfM\xc3\xbcnchen Stra\xc3\x9fe',
        'M\u00fcnchen Stra\u00dfe'.encode('utf-16'),
        'M\u00fcnchen Stra\u00dfe'.encode('utf-8'),
    ])
    def test_utf8_with_or_without_a_bom_and_utf16_with_one_are_read(self, api, tmp_path, raw):
        client, conn = api
        root = tmp_path / 'scans'
        write_tree(root, {'scan.png': None})
        (root / 'scan.txt').write_bytes(raw)
        (root / 'letter.txt').write_bytes(raw)
        job_id = ingest(client, root)

        assert pages(conn, job_id) == [('scan.png', str(root / 'scan.png'), 'M\u00fcnchen Stra\u00dfe')]
        assert documents(conn, job_id) == [('letter', 'M\u00fcnchen Stra\u00dfe')]

    @pytest.mark.parametrize('name', ['scan.txt', 'vol1/letter.txt'])
    def test_any_other_encoding_is_refused_naming_the_file(self, api, tmp_path, name):
        client, conn = api
        root = tmp_path / 'scans'
        write_tree(root, {'scan.png': None})
        (root / name).parent.mkdir(parents=True, exist_ok=True)
        (root / name).write_bytes('M\u00fcnchen Stra\u00dfe'.encode('cp1252'))
        response = client.post('/api/jobs/path', headers=ADMIN, json={
            'name': 'cp1252', 'server_path': str(root), 'run_layout': False})

        assert response.status_code == 400
        assert response.json()['detail'] == (
            f'{name} is not UTF-8 text - save it as UTF-8 and add it again')
        assert conn.execute('SELECT COUNT(*) c FROM jobs').fetchone()['c'] == 0
