"""Rights and provenance (#42), first part: a dataset's rights from a closed list with a credit
line, holder, source and note beside it, and the licence of what is transcribed in DeepLabel.
Every change is logged; an import fills them and says so; every export carries them."""
import io
import json
import zipfile

import pytest
from fastapi.testclient import TestClient

from app import export, formats, rights, store
from app.deps import get_db
from app.main import app

SECRET = 'test-secret'
ALICE = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'alice', 'X-Auth-Role': 'member'}
BOB = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'bob', 'X-Auth-Role': 'member'}
VERA = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'vera', 'X-Auth-Role': 'viewer'}
CC_BY = 'http://creativecommons.org/licenses/by/4.0/'
IN_COPYRIGHT_EDU = 'http://rightsstatements.org/vocab/InC-EDU/1.0/'


@pytest.fixture
def conn(tmp_path, monkeypatch):
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    monkeypatch.setattr('app.config.JOBS_DIR', tmp_path / 'jobs')
    connection = store.connect(tmp_path / 'app.db')
    connection.executescript("""
        INSERT INTO jobs (id, name, owner, status, task) VALUES ('j1', 'Volume', 'alice', 'done', 'text');
        INSERT INTO job_assignees (job_id, username) VALUES ('j1', 'vera');
        INSERT INTO pages (id, job_id, idx, filename, source_file, status, width, height)
            VALUES (1, 'j1', 0, 'a.png', '/a.png', 'done', 400, 200);
    """)
    connection.commit()
    yield connection
    connection.close()


@pytest.fixture
def api(conn):
    app.dependency_overrides[get_db] = lambda: conn
    yield TestClient(app)
    app.dependency_overrides.clear()


def put(api, body, headers=ALICE):
    return api.put('/api/jobs/j1/rights', json=body, headers=headers)


def held(api, headers=ALICE):
    return api.get('/api/jobs/j1/rights', headers=headers).json()


class TestTheList:
    def test_not_evaluated_is_offered_first(self, api):
        statements = api.get('/api/rights/statements', headers=ALICE).json()['statements']

        assert statements[0] == {'uri': rights.NOT_EVALUATED, 'label': 'Copyright Not Evaluated'}
        assert {'uri': CC_BY, 'label': 'CC BY 4.0'} in statements

    @pytest.mark.parametrize('given', [
        'https://creativecommons.org/licenses/by/4.0/legalcode', 'http://creativecommons.org/licenses/by/4.0',
        'https://www.creativecommons.org/licenses/by/4.0/deed.de'])
    def test_a_creative_commons_address_is_read_in_any_form(self, given):
        assert rights.canonical(given) == CC_BY

    def test_the_scheme_and_host_are_read_in_any_case(self):
        assert rights.canonical('HTTPS://WWW.CreativeCommons.org/licenses/by/4.0/') == CC_BY

    def test_a_rights_statements_page_is_read_as_its_vocabulary_uri(self):
        assert rights.canonical('https://rightsstatements.org/page/InC-EDU/1.0/?language=en') == IN_COPYRIGHT_EDU

    @pytest.mark.parametrize('given', ['https://example.org/terms', 'http://creativecommons.org/licenses/by/3.0/', ''])
    def test_anything_else_is_none_of_them(self, given):
        assert rights.canonical(given) is None


class TestADataset:
    def test_it_starts_not_evaluated(self, api):
        assert held(api) == {'status': None, 'credit': '', 'holder': '', 'source': '', 'note': '',
                             'transcription_licence': None, 'imported': [], 'history': [],
                             'training': {'restrictive': False, 'permitted': None}}
        assert api.get('/api/jobs/j1', params={'pages': 'false'}, headers=ALICE).json()['rights_status'] is None

    def test_what_is_set_is_kept_and_each_change_logged(self, api):
        response = put(api, {'status': 'https://creativecommons.org/licenses/by/4.0/', 'credit': 'Town archive'})

        assert response.status_code == 200, response.text
        answer = held(api)
        assert (answer['status'], answer['credit'], answer['holder']) == (CC_BY, 'Town archive', '')
        assert [(h['field'], h['old'], h['new'], h['author']) for h in answer['history']] == [
            ('credit', '', 'Town archive', 'alice'), ('status', None, CC_BY, 'alice')]
        assert api.get('/api/jobs/j1', params={'pages': 'false'}, headers=ALICE).json()['rights_status'] == CC_BY

    def test_saving_what_is_there_logs_nothing(self, api):
        put(api, {'credit': 'Town archive'})
        put(api, {'credit': 'Town archive', 'holder': ''})

        assert len(held(api)['history']) == 1

    def test_a_statement_not_on_the_list_is_refused(self, api):
        response = put(api, {'status': 'https://example.org/terms'})

        assert (response.status_code, response.json()['detail']) == \
            (400, 'https://example.org/terms is not one of the rights statements on offer')
        assert held(api)['status'] is None

    def test_the_transcription_licence_is_from_the_same_list(self, api):
        assert put(api, {'transcription_licence': CC_BY}).status_code == 200
        assert held(api)['transcription_licence'] == CC_BY
        assert put(api, {'transcription_licence': 'mine'}).status_code == 400

    def test_a_viewer_reads_them_but_does_not_change_them(self, api):
        put(api, {'credit': 'Town archive'})

        assert put(api, {'credit': 'Mine'}, headers=VERA).status_code == 403
        assert held(api, VERA)['credit'] == 'Town archive'

    def test_somebody_who_cannot_open_the_dataset_may_not(self, api):
        assert put(api, {'credit': 'Mine'}, headers=BOB).status_code == 404

    def test_an_import_fills_only_what_is_empty(self, api, conn):
        """Read again, a source must not take back what somebody corrected by hand."""
        put(api, {'credit': 'Corrected by hand'})

        rights.write(conn, 'j1', {'credit': 'From the manifest', 'source': 'A manifest'}, 'import', imported=True)

        answer = held(api)
        assert (answer['credit'], answer['source'], answer['imported']) == ('Corrected by hand', 'A manifest', ['source'])

    def test_editing_an_imported_field_by_hand_unmarks_it(self, api, conn):
        rights.write(conn, 'j1', {'credit': 'From the manifest', 'source': 'A manifest'}, 'import', imported=True)
        conn.commit()

        put(api, {'credit': 'Corrected'})

        assert held(api)['imported'] == ['source']


class TestMadeWithOne:
    def test_an_upload_carries_the_licence_chosen_for_its_transcriptions(self, api, conn, tmp_path):
        response = api.post('/api/jobs', headers=ALICE, data={'name': 'Licensed', 'transcription_licence': CC_BY,
                                                              'run_layout': 'false', 'run_lines': 'false', 'run_ocr': 'false'},
                            files=[('files', ('a.png', _png(), 'image/png'))])

        assert response.status_code == 200, response.text
        job_id = response.json()['job_id']
        made = conn.execute('SELECT transcription_licence FROM jobs WHERE id = ?', (job_id,)).fetchone()[0]
        assert made == CC_BY
        assert [(h['field'], h['new']) for h in rights.history(conn, job_id)] == [('transcription_licence', CC_BY)]

    def test_a_licence_not_on_the_list_refuses_the_upload(self, api):
        response = api.post('/api/jobs', headers=ALICE, data={'name': 'Bad', 'transcription_licence': 'mine'},
                            files=[('files', ('a.png', _png(), 'image/png'))])

        assert response.status_code == 400


class TestFromAManifest:
    def test_its_rights_and_attribution_fill_the_fields_and_are_marked(self):
        fields = rights.from_iiif({'url': 'https://archive.example/m', 'label': 'Ratsprotokolle',
                                   'attribution': 'Town archive', 'rights': 'https://creativecommons.org/licenses/by/4.0/'})

        assert fields == {'status': CC_BY, 'credit': 'Town archive', 'source': 'Ratsprotokolle - https://archive.example/m'}

    def test_rights_not_on_the_list_are_kept_in_the_note(self):
        fields = rights.from_iiif({'url': 'https://archive.example/m', 'label': '', 'attribution': '',
                                   'rights': 'https://archive.example/terms'})

        assert fields == {'source': 'https://archive.example/m',
                          'note': 'Rights as the source gives them: https://archive.example/terms'}


class TestReadingTheSourceAgain:
    MANIFEST = 'https://archive.example/m'

    def test_what_the_manifest_says_now_fills_only_what_is_empty(self, api, conn, monkeypatch):
        conn.execute('UPDATE jobs SET iiif_source = ? WHERE id = ?', (json.dumps({'manifest': self.MANIFEST}), 'j1'))
        conn.commit()
        put(api, {'credit': 'Corrected by hand'})
        read = []
        monkeypatch.setattr('app.iiif.read', lambda url: read.append(url) or {
            'url': url, 'label': 'Ratsprotokolle', 'attribution': 'Town archive', 'rights': CC_BY})

        response = api.post('/api/jobs/j1/rights/refresh', headers=ALICE)

        assert response.status_code == 200, response.text
        answer = response.json()
        assert read == [self.MANIFEST]
        assert (answer['status'], answer['credit'], answer['source'], answer['imported']) == (
            CC_BY, 'Corrected by hand', f'Ratsprotokolle - {self.MANIFEST}', ['source', 'status'])

    def test_a_dataset_not_made_from_a_manifest_has_none_to_read(self, api):
        response = api.post('/api/jobs/j1/rights/refresh', headers=ALICE)

        assert (response.status_code, response.json()['detail']) == (400, 'This dataset was not made from a IIIF manifest')

    def test_a_viewer_may_not(self, api):
        assert api.post('/api/jobs/j1/rights/refresh', headers=VERA).status_code == 403


class TestExported:
    def test_every_archive_carries_a_rights_notice(self, api, conn):
        put(api, {'status': IN_COPYRIGHT_EDU, 'credit': 'Town archive', 'transcription_licence': CC_BY})
        out = io.BytesIO()

        export.write_archive(conn, export.collect_job(conn, 'j1'), {'transcript.txt': ''}, out, scans=False)

        notice = zipfile.ZipFile(out).read('RIGHTS.txt').decode()
        assert notice == ('Facsimiles (the scans)\n'
                          f'Rights: In Copyright - Educational Use Permitted <{IN_COPYRIGHT_EDU}>\n'
                          'Credit line: Town archive\n\n'
                          'Transcriptions and annotations made in DeepLabel\n'
                          f'Licence: CC BY 4.0 <{CC_BY}>\n')

    def test_a_dataset_nobody_evaluated_says_so(self, conn):
        assert rights.notice(export.collect_job(conn, 'j1')['job']) == (
            'Facsimiles (the scans)\nRights: Copyright Not Evaluated\n\n'
            'Transcriptions and annotations made in DeepLabel\nLicence: not given\n')

    def test_the_tei_header_licenses_the_text_and_says_the_scans_rights(self, api, conn):
        put(api, {'status': IN_COPYRIGHT_EDU, 'credit': 'Town archive', 'transcription_licence': CC_BY})

        tei = formats.tei(export.collect_job(conn, 'j1'))

        assert (f'<publicationStmt><distributor>DeepLabel</distributor><availability>'
                f'<licence target="{CC_BY}">CC BY 4.0</licence></availability></publicationStmt>') in tei
        assert (f'<sourceDesc><bibl><title>Volume</title><availability><licence target="{IN_COPYRIGHT_EDU}">'
                'In Copyright - Educational Use Permitted</licence><p>Town archive</p></availability></bibl>'
                '</sourceDesc>') in tei


def _png() -> bytes:
    from PIL import Image
    out = io.BytesIO()
    Image.new('RGB', (40, 30), 'white').save(out, 'PNG')
    return out.getvalue()
