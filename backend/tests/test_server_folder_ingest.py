"""What a server folder or an export zip carries besides the scans.

A NAS keeps a thumbnail folder named after every image (Synology's @eaDir/IMG1.jpg/), a Mac
leaves a ._ twin beside every file, and a recycle bin keeps old copies under the same names.
None of them is a page. A server path is the backend host's file system, so it has to be
absolute, and INGEST_ROOTS can fence it in.
"""
import io
import zipfile

import pytest
from fastapi.testclient import TestClient

from app import config, store
from app.deps import get_db
from app.main import app

SECRET = 'test-secret'
ADMIN = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'alice', 'X-Auth-Role': 'admin'}
PNG = b'\x89PNG\r\n\x1a\n'


@pytest.fixture
def api(tmp_path, monkeypatch):
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    monkeypatch.setattr('app.config.JOBS_DIR', tmp_path / 'jobs')
    monkeypatch.setattr('app.config.INGEST_ROOTS', (), raising=False)
    conn = store.connect(tmp_path / 'app.db')
    app.dependency_overrides[get_db] = lambda: conn
    yield TestClient(app), conn
    app.dependency_overrides.clear()
    conn.close()


def write_tree(root, files: dict[str, bytes | None]):
    for name, content in files.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(PNG if content is None else content)


def create(client, path, name='folder'):
    return client.post('/api/jobs/path', headers=ADMIN, json={
        'name': name, 'server_path': str(path), 'run_layout': False})


def pages(conn, job_id: str) -> list[str]:
    return [row['source_file'] for row in conn.execute(
        'SELECT source_file FROM pages WHERE job_id = ? ORDER BY idx', (job_id,))]


def documents(conn, job_id: str) -> list[str]:
    return [row['name'] for row in conn.execute(
        'SELECT name FROM job_documents WHERE job_id = ? ORDER BY name', (job_id,))]


class TestSystemEntries:
    def test_nas_and_mac_leftovers_are_not_pages(self, api, tmp_path):
        client, conn = api
        root = tmp_path / 'scans'
        write_tree(root, {
            'vol1/IMG1.jpg': None,
            'vol1/._IMG1.jpg': b'\x00\x05\x16\x07AppleDouble',
            'vol1/@eaDir/IMG1.jpg/SYNOPHOTO_THUMB_M.jpg': None,
            '@eaDir/vol1/SYNOPHOTO_THUMB_XL.jpg': None,
            '#recycle/IMG0.jpg': None,
            '$RECYCLE.BIN/IMG0.jpg': None,
            '__MACOSX/vol1/._IMG1.jpg': None,
            '.trash/IMG9.png': None,
            'vol1/Thumbs.db': b'thumbs',
            'vol1/desktop.ini': b'[.ShellClassInfo]',
            'vol1/._letter.txt': b'\x00\x05\x16\x07AppleDouble',
            'vol1/.notes.txt': b'hidden',
        })

        response = create(client, root)

        assert response.status_code == 200, response.text
        job_id = response.json()['job_id']
        assert pages(conn, job_id) == [str(root / 'vol1/IMG1.jpg')]
        assert documents(conn, job_id) == []

    def test_a_folder_named_like_an_image_is_walked_into_not_ingested(self, api, tmp_path):
        client, conn = api
        root = tmp_path / 'scans'
        write_tree(root, {'odd.png/inner.png': None, 'vol1/a.png': None})

        response = create(client, root)

        assert response.status_code == 200, response.text
        assert pages(conn, response.json()['job_id']) == [
            str(root / 'odd.png/inner.png'), str(root / 'vol1/a.png')]

    def test_a_root_inside_a_hidden_folder_is_still_read(self, api, tmp_path):
        """Only what lies below the chosen folder is judged, not the path leading to it."""
        client, conn = api
        root = tmp_path / '.cache' / 'scans'
        write_tree(root, {'a.png': None})

        response = create(client, root)

        assert response.status_code == 200, response.text
        assert pages(conn, response.json()['job_id']) == [str(root / 'a.png')]

    def test_an_export_zip_ignores_a_recycled_namesake(self, api, tmp_path):
        client, conn = api
        page_xml = (
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<PcGts xmlns="http://schema.primaresearch.org/PAGE/gts/pagecontent/2019-07-15">'
            '<Page imageFilename="folio_1.png" imageWidth="1000" imageHeight="2000"/></PcGts>')
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, 'w') as zf:
            zf.writestr('folio_1.xml', page_xml)
            zf.writestr('#recycle/folio_1.png', PNG + b'an old copy')
            zf.writestr('.Trash/folio_1.png', PNG + b'a deleted copy')
            zf.writestr('scans/folio_1.png', PNG + b'the real scan')
        buf.seek(0)

        response = client.post('/api/jobs/import', headers=ADMIN, data={'name': 'export'},
                               files={'file': ('export.zip', buf, 'application/zip')})

        assert response.status_code == 200, response.text
        [source] = pages(conn, response.json()['job_id'])
        with open(source, 'rb') as saved:
            assert saved.read() == PNG + b'the real scan'


class TestSymlinks:
    def test_a_linked_folder_is_skipped_and_named(self, api, tmp_path):
        client, conn = api
        root = tmp_path / 'scans'
        write_tree(root, {'vol1/a.png': None})
        write_tree(tmp_path / 'elsewhere', {'b.png': None})
        (root / 'vol2').symlink_to(tmp_path / 'elsewhere', target_is_directory=True)

        response = create(client, root)

        assert response.status_code == 200, response.text
        assert response.json()['skipped_symlinks'] == ['vol2']
        assert pages(conn, response.json()['job_id']) == [str(root / 'vol1/a.png')]

    def test_a_linked_file_is_read_when_no_roots_are_set(self, api, tmp_path):
        client, conn = api
        root = tmp_path / 'scans'
        write_tree(root, {'a.png': None})
        write_tree(tmp_path / 'elsewhere', {'b.png': None})
        (root / 'b.png').symlink_to(tmp_path / 'elsewhere' / 'b.png')

        response = create(client, root)

        assert response.status_code == 200, response.text
        assert response.json()['skipped_symlinks'] == []
        assert pages(conn, response.json()['job_id']) == [str(root / 'a.png'), str(root / 'b.png')]

    def test_appending_names_the_skipped_links_too(self, api, tmp_path):
        client, conn = api
        root = tmp_path / 'scans'
        write_tree(root, {'a.png': None})
        job_id = create(client, root).json()['job_id']
        conn.execute("UPDATE jobs SET status = 'done' WHERE id = ?", (job_id,))
        more = tmp_path / 'more'
        write_tree(more, {'c.png': None})
        write_tree(tmp_path / 'elsewhere', {'b.png': None})
        (more / 'linked').symlink_to(tmp_path / 'elsewhere', target_is_directory=True)

        response = client.post(f'/api/jobs/{job_id}/pages/path', headers=ADMIN,
                               json={'server_path': str(more)})

        assert response.status_code == 200, response.text
        assert response.json()['skipped_symlinks'] == ['linked']
        assert pages(conn, job_id) == [str(root / 'a.png'), str(more / 'c.png')]


class TestWhereAPathMayPoint:
    @pytest.mark.parametrize('path', ['scans', './scans', '~/scans'])
    def test_a_relative_path_is_refused(self, api, tmp_path, monkeypatch, path):
        client, conn = api
        write_tree(tmp_path / 'scans', {'a.png': None})
        monkeypatch.chdir(tmp_path)
        monkeypatch.setenv('HOME', str(tmp_path))

        response = create(client, path)

        assert response.status_code == 400
        assert response.json()['detail'] == f'the server path must be absolute: {path}'
        assert conn.execute('SELECT COUNT(*) c FROM jobs').fetchone()['c'] == 0

    def test_appending_refuses_a_relative_path(self, api, tmp_path):
        client, conn = api
        write_tree(tmp_path / 'scans', {'a.png': None})
        job_id = create(client, tmp_path / 'scans').json()['job_id']
        conn.execute("UPDATE jobs SET status = 'done' WHERE id = ?", (job_id,))

        response = client.post(f'/api/jobs/{job_id}/pages/path', headers=ADMIN,
                               json={'server_path': 'scans'})

        assert response.status_code == 400
        assert response.json()['detail'] == 'the server path must be absolute: scans'
        assert len(pages(conn, job_id)) == 1

    def test_ingest_roots_admit_a_folder_inside_them(self, api, tmp_path, monkeypatch):
        client, conn = api
        monkeypatch.setattr('app.config.INGEST_ROOTS', ((tmp_path / 'allowed').resolve(),), raising=False)
        write_tree(tmp_path / 'allowed' / 'scans', {'a.png': None})

        response = create(client, tmp_path / 'allowed' / 'scans')

        assert response.status_code == 200, response.text
        assert len(pages(conn, response.json()['job_id'])) == 1

    @pytest.mark.parametrize('relative', ['other', 'allowed/../other', 'allowed/escape'])
    def test_ingest_roots_refuse_a_folder_outside_them(self, api, tmp_path, monkeypatch, relative):
        client, conn = api
        allowed = (tmp_path / 'allowed').resolve()
        monkeypatch.setattr('app.config.INGEST_ROOTS', (allowed,), raising=False)
        write_tree(tmp_path / 'other', {'a.png': None})
        allowed.mkdir()
        (allowed / 'escape').symlink_to(tmp_path / 'other', target_is_directory=True)
        path = tmp_path / relative

        response = create(client, path)

        assert response.status_code == 400
        assert response.json()['detail'] == (
            f'{path} is outside the folders this server reads from (INGEST_ROOTS: {allowed})')
        assert conn.execute('SELECT COUNT(*) c FROM jobs').fetchone()['c'] == 0

    def test_a_link_out_of_the_roots_is_skipped_and_named(self, api, tmp_path, monkeypatch):
        client, conn = api
        monkeypatch.setattr('app.config.INGEST_ROOTS', ((tmp_path / 'allowed').resolve(),), raising=False)
        root = tmp_path / 'allowed' / 'scans'
        write_tree(root, {'a.png': None})
        write_tree(tmp_path / 'other', {'b.png': None})
        (root / 'b.png').symlink_to(tmp_path / 'other' / 'b.png')

        response = create(client, root)

        assert response.status_code == 200, response.text
        assert response.json()['skipped_symlinks'] == ['b.png']
        assert pages(conn, response.json()['job_id']) == [str(root / 'a.png')]


class TestIngestRootsSetting:
    def test_comma_separated_absolute_folders(self, monkeypatch, tmp_path):
        monkeypatch.setenv('INGEST_ROOTS', f' {tmp_path}/a , {tmp_path}/b ,')

        assert config._folders('INGEST_ROOTS') == ((tmp_path / 'a').resolve(), (tmp_path / 'b').resolve())

    def test_unset_or_empty_means_anywhere(self, monkeypatch):
        monkeypatch.setenv('INGEST_ROOTS', '')

        assert config._folders('INGEST_ROOTS') == ()

    def test_a_relative_root_ends_the_process_with_its_name(self, monkeypatch):
        monkeypatch.setenv('INGEST_ROOTS', '/data,scans')

        with pytest.raises(ValueError, match='INGEST_ROOTS must list absolute folders, not "scans"'):
            config._folders('INGEST_ROOTS')
