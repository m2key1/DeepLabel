"""A dataset's name is what people find it by, so it is trimmed, never blank, and unique in
any letter case. SQLite's lower() folds ASCII only, which let "Äpfel" and "äpfel" stand side
by side; every way a dataset comes to have a name goes through the same rule.
"""
import io
import zipfile

import pytest
from fastapi.testclient import TestClient

from app import store
from app.deps import get_db
from app.main import app

SECRET = 'test-secret'
ADMIN = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'alice', 'X-Auth-Role': 'admin'}
BOB = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'bob', 'X-Auth-Role': 'member'}
PNG = b'\x89PNG\r\n\x1a\n'
PAGE_XML = (
    '<?xml version="1.0" encoding="UTF-8"?>'
    '<PcGts xmlns="http://schema.primaresearch.org/PAGE/gts/pagecontent/2019-07-15">'
    '<Page imageFilename="folio_1.png" imageWidth="1000" imageHeight="2000"/></PcGts>')


@pytest.fixture
def api(tmp_path, monkeypatch):
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    monkeypatch.setattr('app.config.JOBS_DIR', tmp_path / 'jobs')
    conn = store.connect(tmp_path / 'app.db')
    app.dependency_overrides[get_db] = lambda: conn
    yield TestClient(app), conn
    app.dependency_overrides.clear()
    conn.close()


@pytest.fixture
def folder(tmp_path):
    root = tmp_path / 'scans'
    root.mkdir()
    (root / 'a.png').write_bytes(PNG)
    return root


def upload(client, name):
    return client.post('/api/jobs', headers=ADMIN, data={'name': name, 'run_layout': 'false'},
                       files=[('files', ('a.png', PNG, 'image/png'))])


def from_path(client, name, folder):
    return client.post('/api/jobs/path', headers=ADMIN, json={
        'name': name, 'server_path': str(folder), 'run_layout': False})


def from_export(client, name):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w') as zf:
        zf.writestr('folio_1.xml', PAGE_XML)
        zf.writestr('folio_1.png', PNG)
    buf.seek(0)
    return client.post('/api/jobs/import', headers=ADMIN, data={'name': name},
                       files={'file': ('export.zip', buf, 'application/zip')})


CREATORS = {
    'upload': lambda client, name, folder: upload(client, name),
    'path': from_path,
    'import': lambda client, name, folder: from_export(client, name),
}


def names(conn) -> list[str]:
    return [row['name'] for row in conn.execute('SELECT name FROM jobs ORDER BY rowid')]


@pytest.mark.parametrize('how', CREATORS)
class TestCreating:
    def test_the_name_is_stored_trimmed(self, api, folder, how):
        client, conn = api

        response = CREATORS[how](client, '  Äpfel  ', folder)

        assert response.status_code == 200, response.text
        assert names(conn) == ['Äpfel']

    @pytest.mark.parametrize('blank', ['   ', '\t\n'])
    def test_a_blank_name_is_refused(self, api, folder, how, blank):
        client, conn = api

        response = CREATORS[how](client, blank, folder)

        assert response.status_code == 400
        assert response.json()['detail'] == 'a dataset needs a name'
        assert names(conn) == []

    @pytest.mark.parametrize('taken, wanted', [
        ('Äpfel', 'äpfel'), ('STRASSE', 'straße'), ('Äpfel', 'Äpfel'), ('Wien', ' wien ')])
    def test_a_name_taken_in_another_case_is_refused(self, api, folder, how, taken, wanted):
        client, conn = api
        assert upload(client, taken).status_code == 200

        response = CREATORS[how](client, wanted, folder)

        assert response.status_code == 409
        assert response.json()['detail'] == f'a dataset named "{wanted.strip()}" already exists'
        assert names(conn) == [taken]


class TestRenaming:
    def test_a_name_taken_in_another_case_is_refused(self, api):
        client, conn = api
        assert upload(client, 'Äpfel').status_code == 200
        job_id = upload(client, 'Birnen').json()['job_id']

        response = client.patch(f'/api/jobs/{job_id}', headers=ADMIN, json={'name': 'äpfel'})

        assert response.status_code == 409
        assert response.json()['detail'] == 'a dataset named "äpfel" already exists'
        assert names(conn) == ['Äpfel', 'Birnen']

    def test_changing_only_the_case_of_its_own_name_is_allowed(self, api):
        client, conn = api
        job_id = upload(client, 'äpfel').json()['job_id']

        response = client.patch(f'/api/jobs/{job_id}', headers=ADMIN, json={'name': ' Äpfel '})

        assert response.status_code == 200, response.text
        assert names(conn) == ['Äpfel']

    def test_a_blank_rename_is_refused(self, api):
        client, conn = api
        job_id = upload(client, 'Äpfel').json()['job_id']

        response = client.patch(f'/api/jobs/{job_id}', headers=ADMIN, json={'name': '  '})

        assert response.status_code == 400
        assert response.json()['detail'] == 'a dataset needs a name'
        assert names(conn) == ['Äpfel']


class TestNameCheck:
    """The form asks before its first step lets on, by the same rule creating applies."""

    def test_a_taken_name_in_any_case_is_taken_and_its_dataset_named(self, api):
        client, conn = api
        conn.execute("INSERT INTO jobs (id, name, owner, status) VALUES ('j1', 'Äpfel', 'alice', 'done')")
        conn.commit()

        assert client.get('/api/jobs/name-check', params={'name': ' äPFEL '}, headers=ADMIN).json() == \
            {'taken': True, 'job_id': 'j1', 'name': 'Äpfel'}
        assert client.get('/api/jobs/name-check', params={'name': 'Birnen'}, headers=ADMIN).json() == \
            {'taken': False, 'job_id': None, 'name': None}
        assert upload(client, ' äPFEL ').status_code == 409, 'the check and creating agree'

    def test_a_dataset_the_asker_cannot_open_is_taken_but_not_named(self, api):
        client, conn = api
        conn.execute("INSERT INTO jobs (id, name, owner, status) VALUES ('j1', 'Private', 'alice', 'done')")
        conn.commit()

        assert client.get('/api/jobs/name-check', params={'name': 'private'}, headers=BOB).json() == \
            {'taken': True, 'job_id': None, 'name': None}

    def test_a_blank_name_is_not_taken(self, api):
        client, _ = api
        assert client.get('/api/jobs/name-check', params={'name': '  '}, headers=ADMIN).json() == \
            {'taken': False, 'job_id': None, 'name': None}
