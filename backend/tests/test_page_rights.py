"""Rights and provenance (#42), the rest: a page may carry rights of its own for mixed material,
set one page at a time or for many at once, logged like the dataset's; the dataset list and
Search filter by them; exports and a re-imported DeepLabel export keep them."""
import io
import json
import zipfile

import pytest
from fastapi.testclient import TestClient

from app import export, imports, rights, store
from app.deps import get_db
from app.main import app

SECRET = 'test-secret'
ALICE = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'alice', 'X-Auth-Role': 'member'}
BOB = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'bob', 'X-Auth-Role': 'member'}
VERA = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'vera', 'X-Auth-Role': 'viewer'}
CC_BY = 'http://creativecommons.org/licenses/by/4.0/'
CC0 = 'http://creativecommons.org/publicdomain/zero/1.0/'
IN_COPYRIGHT = 'http://rightsstatements.org/vocab/InC/1.0/'
NO_PAGE_RIGHTS = {'status': None, 'credit': '', 'holder': '', 'source': '', 'note': ''}


@pytest.fixture
def conn(tmp_path, monkeypatch):
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    monkeypatch.setattr('app.config.JOBS_DIR', tmp_path / 'jobs')
    connection = store.connect(tmp_path / 'app.db')
    connection.executescript("""
        INSERT INTO jobs (id, name, owner, status, task) VALUES ('j1', 'Volume', 'alice', 'done', 'text'),
                                                                ('j2', 'Letters', 'alice', 'done', 'text');
        INSERT INTO job_assignees (job_id, username) VALUES ('j1', 'vera');
        INSERT INTO pages (id, job_id, idx, filename, source_file, status, width, height)
            VALUES (1, 'j1', 0, 'a.png', '/a.png', 'done', 400, 200),
                   (2, 'j1', 1, 'b.png', '/b.png', 'done', 400, 200),
                   (3, 'j1', 2, 'c.png', '/c.png', 'done', 400, 200),
                   (4, 'j2', 0, 'd.png', '/d.png', 'done', 400, 200);
        INSERT INTO elements (id, page_id, order_idx, class_name, bbox)
            VALUES (1, 1, 0, 'Paragraph', '[0,0,1,1]'), (2, 2, 0, 'Paragraph', '[0,0,1,1]'),
                   (3, 4, 0, 'Paragraph', '[0,0,1,1]');
        INSERT INTO lines (id, element_id, order_idx, polygon, text)
            VALUES (1, 1, 0, '[[0,0],[1,0],[1,1],[0,1]]', 'Pfarrer Huber'),
                   (2, 2, 0, '[[0,0],[1,0],[1,1],[0,1]]', 'Pfarrer Maier'),
                   (3, 3, 0, '[[0,0],[1,0],[1,1],[0,1]]', 'Pfarrer Gruber');
    """)
    rights.write(connection, 'j1', {'status': CC_BY, 'credit': 'Town archive'}, 'alice')
    connection.commit()
    yield connection
    connection.close()


@pytest.fixture
def api(conn):
    app.dependency_overrides[get_db] = lambda: conn
    yield TestClient(app)
    app.dependency_overrides.clear()


def set_pages(api, page_ids, held, headers=ALICE, job_id='j1'):
    return api.put(f'/api/jobs/{job_id}/page-rights', json={'page_ids': page_ids, 'rights': held}, headers=headers)


def page_rights(api, page_id, headers=ALICE):
    return api.get(f'/api/jobs/j1/pages/{page_id}/rights', headers=headers).json()


class TestAPageOfItsOwn:
    def test_a_page_follows_its_dataset_until_given_its_own(self, api):
        assert page_rights(api, 1) == {
            'own': None, 'imported': [], 'dataset': {**NO_PAGE_RIGHTS, 'status': CC_BY, 'credit': 'Town archive'},
            'history': []}
        assert api.get('/api/jobs/j1/pages/1', headers=ALICE).json()['rights_status'] is None

    def test_its_own_rights_are_kept_and_each_change_logged(self, api):
        response = set_pages(api, [2], {'status': 'https://rightsstatements.org/page/InC/1.0/', 'holder': 'A family'})

        assert response.status_code == 200, response.text
        assert response.json() == {'pages': 1}
        answer = page_rights(api, 2)
        assert answer['own'] == {**NO_PAGE_RIGHTS, 'status': IN_COPYRIGHT, 'holder': 'A family'}
        assert [(h['field'], h['old'], h['new'], h['author']) for h in answer['history']] == [
            ('holder', None, 'A family', 'alice'), ('status', None, IN_COPYRIGHT, 'alice')]
        assert api.get('/api/jobs/j1/pages/2', headers=ALICE).json()['rights_status'] == IN_COPYRIGHT

    def test_the_dataset_history_keeps_to_the_dataset(self, api):
        set_pages(api, [2], {'status': IN_COPYRIGHT})

        history = api.get('/api/jobs/j1/rights', headers=ALICE).json()['history']
        assert [h['field'] for h in history] == ['credit', 'status']

    def test_many_pages_at_once_each_logged_on_its_own(self, api):
        set_pages(api, [1, 2], {'status': CC0})

        assert [page_rights(api, p)['own'] for p in (1, 2, 3)] == [{**NO_PAGE_RIGHTS, 'status': CC0}] * 2 + [None]
        assert [len(page_rights(api, p)['history']) for p in (1, 2, 3)] == [1, 1, 0]

    def test_a_page_goes_back_to_its_datasets_rights(self, api):
        set_pages(api, [1, 2], {'status': IN_COPYRIGHT, 'credit': 'A family'})

        assert set_pages(api, [2], None).json() == {'pages': 1}

        assert page_rights(api, 2)['own'] is None
        assert page_rights(api, 1)['own']['status'] == IN_COPYRIGHT
        assert [(h['field'], h['old'], h['new']) for h in page_rights(api, 2)['history']][:2] == [
            ('credit', 'A family', None), ('status', IN_COPYRIGHT, None)]

    def test_saving_what_a_page_has_logs_nothing(self, api):
        set_pages(api, [1], {'status': CC0, 'credit': 'Here'})
        assert set_pages(api, [1], {'status': CC0, 'credit': 'Here', 'note': ''}).status_code == 200

        assert len(page_rights(api, 1)['history']) == 2

    def test_its_own_rights_need_a_statement(self, api):
        response = set_pages(api, [1], {'credit': 'Only a credit'})

        assert (response.status_code, response.json()['detail']) == (400, "a page's own rights need a rights statement")

    def test_a_statement_not_on_the_list_is_refused(self, api):
        response = set_pages(api, [1], {'status': 'https://example.org/terms'})

        assert (response.status_code, response.json()['detail']) == \
            (400, 'https://example.org/terms is not one of the rights statements on offer')

    def test_a_page_of_another_dataset_is_refused_and_nothing_changes(self, api):
        response = set_pages(api, [1, 4], {'status': CC0})

        assert (response.status_code, response.json()['detail']) == (400, 'page 4 is not a page of this dataset')
        assert page_rights(api, 1)['own'] is None

    def test_a_deleted_page_takes_none(self, api, conn):
        conn.execute('UPDATE pages SET deleted = 1 WHERE id = 3')
        conn.commit()

        response = set_pages(api, [3], {'status': CC0})

        assert (response.status_code, response.json()['detail']) == (400, 'page 3 is not a page of this dataset')
        assert page_rights(api, 3)['own'] is None

    def test_a_viewer_reads_them_but_does_not_change_them(self, api):
        set_pages(api, [1], {'status': CC0})

        assert set_pages(api, [1], {'status': CC_BY}, headers=VERA).status_code == 403
        assert page_rights(api, 1, VERA)['own']['status'] == CC0

    def test_somebody_who_cannot_open_the_dataset_may_not(self, api):
        assert set_pages(api, [1], {'status': CC0}, headers=BOB).status_code == 404
        assert api.get('/api/jobs/j1/pages/1/rights', headers=BOB).status_code == 404


class TestFound:
    def test_the_list_carries_every_statement_a_dataset_holds(self, api, conn):
        set_pages(api, [2], {'status': IN_COPYRIGHT})
        set_pages(api, [3], {'status': CC0})
        conn.execute('UPDATE pages SET deleted = 1 WHERE id = 3')
        conn.commit()

        listed = {job['id']: job['rights_statuses'] for job in api.get('/api/jobs', headers=ALICE).json()}

        assert listed == {'j1': [CC_BY, IN_COPYRIGHT], 'j2': [rights.NOT_EVALUATED]}

    @pytest.mark.parametrize('statement, found', [
        (CC_BY, ['Pfarrer Huber']), (IN_COPYRIGHT, ['Pfarrer Maier']), (rights.NOT_EVALUATED, ['Pfarrer Gruber']),
        ('https://creativecommons.org/licenses/by/4.0/legalcode', ['Pfarrer Huber']),
        ('https://www.rightsstatements.org/page/InC/1.0/', ['Pfarrer Maier'])])
    def test_search_finds_a_page_by_its_own_rights_else_its_datasets(self, api, statement, found):
        set_pages(api, [2], {'status': IN_COPYRIGHT})

        hits = api.get('/api/search', params={'q': 'Pfarrer', 'rights': statement}, headers=ALICE).json()['hits']

        assert [hit['text'] for hit in hits] == found

    def test_a_search_value_that_is_not_a_statement_is_refused(self, api):
        response = api.get('/api/search', params={'q': 'Pfarrer', 'rights': 'https://example.org/terms'},
                           headers=ALICE)

        assert (response.status_code, response.json()['detail']) == (
            400, 'https://example.org/terms is not one of the rights statements on offer')


class TestExported:
    def test_the_notice_names_the_pages_with_rights_of_their_own(self, api, conn):
        set_pages(api, [2], {'status': IN_COPYRIGHT, 'holder': 'A family'})

        notice = rights.notice(export.collect_job(conn, 'j1')['job'], export.collect_job(conn, 'j1')['pages'])

        assert notice == ('Facsimiles (the scans)\n'
                          f'Rights: CC BY 4.0 <{CC_BY}>\n'
                          'Credit line: Town archive\n\n'
                          'Pages with rights of their own\n'
                          f'b.png: In Copyright <{IN_COPYRIGHT}>\n'
                          '  Rights holder: A family\n\n'
                          'Transcriptions and annotations made in DeepLabel\n'
                          'Licence: not given\n')

    def test_a_deeplabel_export_brings_its_rights_back_marked_as_imported(self, api, conn):
        set_pages(api, [2], {'status': IN_COPYRIGHT, 'holder': 'A family'})
        data = export.collect_job(conn, 'j1')
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, 'w') as out:
            out.writestr('job.json', json.dumps(data))
            for page in data['pages']:
                out.writestr(f'images/{page["filename"]}', b'')

        brought = imports.read_export_zip(archive)

        assert imports.rights_of_export(archive) == {'status': CC_BY, 'credit': 'Town archive'}
        assert [page.get('rights') for page in brought] == [
            None, {**NO_PAGE_RIGHTS, 'status': IN_COPYRIGHT, 'holder': 'A family'}, None]

    def test_rights_an_export_gives_in_another_shape_are_left_out(self, conn):
        data = export.collect_job(conn, 'j1')
        data['job']['rights'] = {'status': 42, 'credit': ['Town archive'], 'holder': 'A family'}
        data['job']['transcription_licence'] = {'uri': CC0}
        data['pages'][0]['rights'] = 'In Copyright'
        data['pages'][1]['rights'] = {'status': [IN_COPYRIGHT], 'holder': 'A family'}
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, 'w') as out:
            out.writestr('job.json', json.dumps(data))
            for page in data['pages']:
                out.writestr(f'images/{page["filename"]}', b'')

        assert [page.get('rights') for page in imports.read_export_zip(archive)] == [None, None, None]
        assert imports.rights_of_export(archive) == {'holder': 'A family'}


def _png() -> bytes:
    from PIL import Image
    out = io.BytesIO()
    Image.new('RGB', (40, 30), 'white').save(out, 'PNG')
    return out.getvalue()


PAGE_XML = """<?xml version="1.0" encoding="UTF-8"?>
<PcGts xmlns="http://schema.primaresearch.org/PAGE/gts/pagecontent/2013-07-15">
  <Page imageFilename="f1.png" imageWidth="40" imageHeight="30"/>
</PcGts>"""

METS = """<?xml version="1.0" encoding="UTF-8"?>
<mets:mets xmlns:mets="http://www.loc.gov/METS/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <mets:dmdSec ID="d1"><mets:mdWrap MDTYPE="DC"><mets:xmlData>
    <dc:rights>https://rightsstatements.org/page/InC/1.0/?language=de</dc:rights>
  </mets:xmlData></mets:mdWrap></mets:dmdSec>
</mets:mets>"""


class TestImported:
    def made(self, api, archive):
        response = api.post('/api/jobs/import', headers=ALICE, data={'name': 'Brought', 'transcription_licence': CC0},
                            files=[('file', ('export.zip', archive.getvalue(), 'application/zip'))])
        assert response.status_code == 200, response.text
        return response.json()['job_id']

    def test_a_deeplabel_export_brings_the_rights_of_its_dataset_and_its_pages(self, api, conn):
        set_pages(api, [2], {'status': IN_COPYRIGHT, 'holder': 'A family'})
        data = export.collect_job(conn, 'j1')
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, 'w') as out:
            out.writestr('job.json', json.dumps(data))
            for page in data['pages']:
                out.writestr(f'images/{page["filename"]}', _png())

        job_id = self.made(api, archive)

        held = api.get(f'/api/jobs/{job_id}/rights', headers=ALICE).json()
        assert (held['status'], held['credit'], held['transcription_licence'], held['imported']) == (
            CC_BY, 'Town archive', CC0, ['credit', 'status'])
        own = {row['filename']: api.get(f'/api/jobs/{job_id}/pages/{row["id"]}/rights', headers=ALICE).json()
               for row in conn.execute('SELECT id, filename FROM pages WHERE job_id = ?', (job_id,))}
        assert {name: (page['own'], page['imported']) for name, page in own.items()} == {
            'a.png': (None, []), 'b.png': ({**NO_PAGE_RIGHTS, 'status': IN_COPYRIGHT, 'holder': 'A family'},
                                          ['status', 'holder']),
            'c.png': (None, [])}

    def test_a_transkribus_export_takes_its_rights_from_its_mets(self, api):
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, 'w') as out:
            out.writestr('doc/mets.xml', METS)
            out.writestr('doc/page/f1.xml', PAGE_XML)
            out.writestr('doc/f1.png', _png())

        job_id = self.made(api, archive)

        held = api.get(f'/api/jobs/{job_id}/rights', headers=ALICE).json()
        assert (held['status'], held['imported']) == (IN_COPYRIGHT, ['status'])
