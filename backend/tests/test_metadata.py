"""Free metadata on datasets and pages (#40): a date, a folio, a shelfmark - kept in the order
it was written, edited by anyone who can edit the dataset, and carried into the TEI header and
the PAGE metadata of an export."""
import pytest
from fastapi.testclient import TestClient

from app import export, formats, metadata, store
from app.deps import get_db
from app.main import app

SECRET = 'test-secret'
ALICE = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'alice', 'X-Auth-Role': 'member'}
BOB = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'bob', 'X-Auth-Role': 'member'}
SHELFMARK = [{'key': 'Shelfmark', 'value': 'Rep. 17 & 18'}, {'key': 'Date', 'value': '1781'}]
FOLIO = [{'key': 'Folio', 'value': '1r'}]


@pytest.fixture
def conn(tmp_path, monkeypatch):
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    monkeypatch.setattr('app.config.JOBS_DIR', tmp_path / 'jobs')
    connection = store.connect(tmp_path / 'app.db')
    connection.executescript("""
        INSERT INTO jobs (id, name, owner, status, task) VALUES ('j1', 'Volume', 'alice', 'done', 'text');
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


def put_job(api, metadata, headers=ALICE):
    return api.put('/api/jobs/j1/metadata', json={'metadata': metadata}, headers=headers)


def put_page(api, metadata, headers=ALICE):
    return api.put('/api/pages/1/metadata', json={'metadata': metadata}, headers=headers)


class TestTheDatasets:
    def test_it_is_kept_in_the_order_written_and_shown_in_info(self, api):
        response = put_job(api, SHELFMARK)

        assert (response.status_code, response.json()) == (200, {'metadata': SHELFMARK})
        assert api.get('/api/jobs/j1/info', headers=ALICE).json()['metadata'] == SHELFMARK

    def test_a_new_dataset_has_none(self, api):
        assert api.get('/api/jobs/j1/info', headers=ALICE).json()['metadata'] == []

    def test_fields_are_trimmed_and_empty_rows_dropped(self, api):
        response = put_job(api, [{'key': ' Folio ', 'value': ' 12r '}, {'key': '', 'value': ''}])

        assert response.json() == {'metadata': [{'key': 'Folio', 'value': '12r'}]}

    def test_a_value_without_a_field_name_is_refused(self, api):
        response = put_job(api, [{'key': ' ', 'value': '1781'}])

        assert (response.status_code, response.json()['detail']) == (400, 'every value needs a field name')

    def test_one_field_twice_is_refused(self, api):
        response = put_job(api, [{'key': 'Date', 'value': '1781'}, {'key': 'date', 'value': '1782'}])

        assert (response.status_code, response.json()['detail']) == (400, 'the field "date" is there twice')

    def test_somebody_who_cannot_open_the_dataset_may_not(self, api):
        assert put_job(api, SHELFMARK, headers=BOB).status_code == 404
        assert api.get('/api/jobs/j1/info', headers=ALICE).json()['metadata'] == []

    def test_a_viewer_may_read_it_but_not_change_it(self, api, conn):
        conn.execute("INSERT INTO job_assignees (job_id, username) VALUES ('j1', 'vera')")
        conn.commit()
        vera = {**ALICE, 'X-Auth-User': 'vera', 'X-Auth-Role': 'viewer'}
        put_job(api, SHELFMARK)

        assert put_job(api, FOLIO, headers=vera).status_code == 403
        assert api.get('/api/jobs/j1/info', headers=vera).json()['metadata'] == SHELFMARK


class TestAPages:
    def test_it_is_kept_and_comes_with_the_page(self, api):
        assert put_page(api, FOLIO).json() == {'metadata': FOLIO}

        assert api.get('/api/jobs/j1/pages/1', headers=ALICE).json()['metadata'] == FOLIO

    def test_somebody_who_cannot_open_the_dataset_may_not(self, api):
        assert put_page(api, FOLIO, headers=BOB).status_code == 404


class TestExported:
    def test_the_dataset_heads_the_tei_and_each_page_describes_its_surface(self, api, conn):
        put_job(api, SHELFMARK)
        put_page(api, FOLIO)

        tei = formats.tei(export.collect_job(conn, 'j1'))

        assert ('<publicationStmt><p>Exported from DeepLabel</p></publicationStmt><notesStmt><note type="metadata">'
                '<list type="gloss"><label>Shelfmark</label><item>Rep. 17 &amp; 18</item>'
                '<label>Date</label><item>1781</item></list></note></notesStmt><sourceDesc>') in tei
        assert ('<surface xml:id="f1" ulx="0" uly="0" lrx="400" lry="200"><desc><list type="gloss">'
                '<label>Folio</label><item>1r</item></list></desc><graphic') in tei

    def test_without_metadata_the_tei_has_no_notes(self, conn):
        tei = formats.tei(export.collect_job(conn, 'j1'))

        assert '<notesStmt>' not in tei and '<desc>' not in tei

    def test_each_page_xml_carries_the_datasets_then_its_own(self, api, conn):
        put_job(api, SHELFMARK)
        put_page(api, FOLIO)

        files = export.standard_files(export.collect_job(conn, 'j1'), 'page')

        xml = next(iter(files.values()))
        assert ('<MetadataItem type="other" name="Shelfmark" value="Rep. 17 &amp; 18"/>'
                '<MetadataItem type="other" name="Date" value="1781"/>'
                '<MetadataItem type="other" name="Folio" value="1r"/></Metadata>') in xml


class TestFromElsewhere:
    def test_a_name_given_twice_is_one_field_with_both_values(self):
        assert metadata.merged([('Subject', 'Law'), ('subject', 'Taxes'), ('', 'nameless')]) == \
            [{'key': 'Subject', 'value': 'Law; Taxes'}]

    def test_it_is_held_to_the_limits_an_edit_is(self):
        """A manifest is somebody else's: what it says is cut to size rather than kept whole."""
        fields = metadata.merged([(f'Field {i}', 'x' * 3000) for i in range(150)] + [('k' * 100, 'v')])

        assert len(fields) == metadata.MAX_FIELDS
        assert {len(f['value']) for f in fields} == {metadata.MAX_VALUE}
