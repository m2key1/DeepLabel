"""The corpus a dataset is uploaded with, and the cut of it onto that dataset's pages.

The cut is derived and rewritten on every run, so these tests pin what it may touch as
firmly as what it produces: a transcription of record must survive a re-cut untouched.
"""
import pytest
from fastapi.testclient import TestClient

from app import corpus, llm, store
from app.deps import get_db
from app.main import app

SECRET = 'test-secret'
ADMIN = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'alice', 'X-Auth-Role': 'admin'}

FIRST = ('Mein lieber Freund, ich danke Dir fuer Deinen Brief\n'
         'Das Wetter hier in Wien ist seit Tagen truebe\n'
         'Ich habe gestern lange an dem Bildnis gearbeitet\n'
         'Die Farben wollen noch nicht zusammenstimmen')
SECOND = ('Lieber Elias, nur ein paar Zeilen in grosser Eile\n'
          'Der Zug geht schon um sieben Uhr frueh')
READ = {
    1: ['Mein lieber Freund, ich danke Dir fuer Deinen Bricf',
        'Das Wetter hier in Wien ist seit Tagen truebc'],
    2: ['Ich habe gestern lange an dem Bildnis gearbeitct',
        'Die Farben wollen noch nicht zusammenstimmcn'],
    3: ['Lieber Elias, nur ein paar Zeilen in grosser Eile',
        'Der Zug geht schon um sieben Uhr frueh'],
}


@pytest.fixture
def conn(tmp_path, monkeypatch):
    """Three recognized leaves: two carrying the first letter, one carrying the second."""
    monkeypatch.setattr('app.config.JOBS_DIR', tmp_path / 'jobs')
    connection = store.connect(tmp_path / 'app.db')
    connection.execute(
        "INSERT INTO jobs (id, name, owner, status) VALUES ('j1', 'Letters', 'alice', 'done')")
    for page_id, lines in READ.items():
        connection.execute(
            'INSERT INTO pages (id, job_id, idx, filename, source_file, content_hash, status) '
            "VALUES (?, 'j1', ?, ?, ?, ?, 'done')",
            (page_id, page_id - 1, f'leaf_{page_id}.png', f'/nonexistent/leaf_{page_id}.png',
             f'hash-{page_id}'))
        connection.execute(
            'INSERT INTO elements (id, page_id, order_idx, class_name, bbox, kind) '
            "VALUES (?, ?, 0, 'Paragraph', '[0,0,1,1]', 'content')", (page_id, page_id))
        for order, text in enumerate(lines):
            connection.execute(
                'INSERT INTO lines (element_id, order_idx, polygon, text) '
                "VALUES (?, ?, '[[0,0],[1,0],[1,1],[0,1]]', ?)", (page_id, order, text))
    connection.commit()
    yield connection
    connection.close()


def spans(conn):
    return {row['id']: (row['reference_document'], row['reference_text'])
            for row in conn.execute(
                'SELECT id, reference_document, reference_text FROM pages ORDER BY idx')}


class TestKeepingTheCorpus:
    def test_documents_are_held_in_name_order(self, conn):
        corpus.store_documents(conn, 'j1', {'letter-02': SECOND, 'letter-01': FIRST})
        assert [document.name for document in corpus.documents(conn, 'j1')] == [
            'letter-01', 'letter-02']

    def test_uploading_a_document_again_replaces_its_text(self, conn):
        corpus.store_documents(conn, 'j1', {'letter-01': FIRST})
        corpus.store_documents(conn, 'j1', {'letter-01': SECOND})
        held = corpus.documents(conn, 'j1')
        assert len(held) == 1
        assert held[0].text == SECOND

    def test_an_empty_document_is_not_kept(self, conn):
        assert corpus.store_documents(conn, 'j1', {'blank': '   \n  '}) == 0
        assert corpus.document_count(conn, 'j1') == 0

    def test_a_nameless_document_is_not_kept(self, conn):
        """A file called '.txt' has an empty stem. Held under an empty name it could not
        be listed, fetched or deleted by the routes that key on the name."""
        assert corpus.store_documents(conn, 'j1', {'': FIRST, '   ': FIRST}) == 0
        assert corpus.document_count(conn, 'j1') == 0

    def test_removing_a_document_closes_the_gap_in_reading_order(self, conn):
        corpus.store_documents(conn, 'j1', {'a': FIRST, 'b': SECOND, 'c': FIRST})
        assert corpus.remove_document(conn, 'j1', 'b') is True
        assert [row['idx'] for row in conn.execute(
            "SELECT idx FROM job_documents WHERE job_id = 'j1' ORDER BY idx")] == [0, 1]
        assert corpus.remove_document(conn, 'j1', 'b') is False


class TestWhatEachPageReads:
    def test_pages_come_back_in_reading_order_with_their_lines(self, conn):
        order, lines = corpus.page_reads(conn, 'j1')
        assert order == [1, 2, 3]
        assert lines == [READ[1], READ[2], READ[3]]

    def test_a_page_with_no_lines_still_holds_its_place(self, conn):
        conn.execute('DELETE FROM lines WHERE element_id = 2')
        conn.commit()
        order, lines = corpus.page_reads(conn, 'j1')
        assert order == [1, 2, 3]
        assert lines[1] == []

    def test_a_human_correction_is_preferred_over_what_the_model_read(self, conn):
        conn.execute("UPDATE lines SET corrected_text = 'Das Wetter hier in Wien ist truebe' "
                     'WHERE element_id = 1 AND order_idx = 1')
        conn.commit()
        _order, lines = corpus.page_reads(conn, 'j1')
        assert lines[0][1] == 'Das Wetter hier in Wien ist truebe'


class TestCuttingItOntoThePages:
    def test_each_leaf_is_answerable_for_its_own_letter(self, conn):
        corpus.store_documents(conn, 'j1', {'letter-01': FIRST, 'letter-02': SECOND})
        result = corpus.apply_cut(conn, 'j1', overlap=0)
        assert result == {'documents': 2, 'pages': 3, 'placed': 3, 'unanchored': 0}
        assert spans(conn) == {
            1: ('letter-01', ('Mein lieber Freund, ich danke Dir fuer Deinen Brief\n'
                              'Das Wetter hier in Wien ist seit Tagen truebe')),
            2: ('letter-01', ('Ich habe gestern lange an dem Bildnis gearbeitet\n'
                              'Die Farben wollen noch nicht zusammenstimmen')),
            3: ('letter-02', SECOND),
        }

    def test_the_anchors_behind_a_cut_are_recorded_with_it(self, conn):
        corpus.store_documents(conn, 'j1', {'letter-01': FIRST, 'letter-02': SECOND})
        corpus.apply_cut(conn, 'j1', overlap=0)
        rows = {row['id']: (row['reference_anchors'], row['reference_score'])
                for row in conn.execute('SELECT id, reference_anchors, reference_score FROM pages')}
        assert [anchors for anchors, _score in rows.values()] == [2, 2, 2]
        assert all(score >= 0.9 for _anchors, score in rows.values())

    def test_overlap_reaches_into_the_neighbouring_leaf_only(self, conn):
        corpus.store_documents(conn, 'j1', {'letter-01': FIRST, 'letter-02': SECOND})
        corpus.apply_cut(conn, 'j1', overlap=1)
        first, second = spans(conn)[1][1], spans(conn)[3][1]
        assert first.endswith('Ich habe gestern lange an dem Bildnis gearbeitet')
        assert spans(conn)[3][0] == 'letter-02'
        assert 'Bildnis' not in second

    def test_counters_report_what_a_person_has_to_judge(self, conn):
        corpus.store_documents(conn, 'j1', {'letter-01': FIRST, 'letter-02': SECOND})
        corpus.apply_cut(conn, 'j1', overlap=0)
        counters = store.get_job(conn, 'j1')['counters']
        assert counters['reference_documents'] == 2
        assert counters['reference_placed'] == 3
        assert counters['reference_unanchored'] == 0

    def test_a_cut_with_no_corpus_leaves_no_span_behind(self, conn):
        corpus.store_documents(conn, 'j1', {'letter-01': FIRST})
        corpus.apply_cut(conn, 'j1', overlap=0)
        conn.execute("DELETE FROM job_documents WHERE job_id = 'j1'")
        conn.commit()
        assert corpus.apply_cut(conn, 'j1') == {
            'documents': 0, 'pages': 3, 'placed': 0, 'unanchored': 0}
        assert {document for document, _text in spans(conn).values()} == {None}

    def test_a_cut_with_no_corpus_zeroes_the_counters(self, conn):
        corpus.store_documents(conn, 'j1', {'letter-01': FIRST})
        corpus.apply_cut(conn, 'j1', overlap=0)
        conn.execute("DELETE FROM job_documents WHERE job_id = 'j1'")
        corpus.apply_cut(conn, 'j1')
        counters = store.get_job(conn, 'j1')['counters']
        assert (counters['reference_documents'], counters['reference_placed'],
                counters['reference_unanchored']) == (0, 0, 0)

    def test_a_run_cuts_while_a_corpus_or_a_span_from_one_is_left(self, conn):
        """The pipeline's cut is what takes back the spans of a deleted corpus, so a run
        has to make it until nothing is left to take back."""
        assert not corpus.needs_cut(conn, 'j1')
        corpus.store_documents(conn, 'j1', {'letter-01': FIRST})
        assert corpus.needs_cut(conn, 'j1')
        corpus.apply_cut(conn, 'j1', overlap=0)
        conn.execute("DELETE FROM job_documents WHERE job_id = 'j1'")
        assert corpus.needs_cut(conn, 'j1')
        corpus.apply_cut(conn, 'j1')
        assert not corpus.needs_cut(conn, 'j1')

    def test_recutting_never_touches_a_transcription_of_record(self, conn):
        """The cut owns the reference columns and nothing else. A person's ground truth
        and a checked line have to survive it, or improving recognition would cost the
        corrections made since the last run."""
        conn.execute("UPDATE pages SET gt_text = 'written by hand', gt_source = 'sidecar' "
                     'WHERE id = 1')
        conn.execute('UPDATE lines SET corrected_text = ?, checked = 1 WHERE element_id = 1',
                     ('checked by hand',))
        conn.commit()
        corpus.store_documents(conn, 'j1', {'letter-01': FIRST, 'letter-02': SECOND})
        corpus.apply_cut(conn, 'j1', overlap=0)
        page = conn.execute('SELECT gt_text, gt_source FROM pages WHERE id = 1').fetchone()
        assert page['gt_text'] == 'written by hand'
        assert page['gt_source'] == 'sidecar'
        assert conn.execute(
            'SELECT COUNT(*) c FROM lines WHERE checked = 1').fetchone()['c'] == 2


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    monkeypatch.setattr('app.config.JOBS_DIR', tmp_path / 'jobs')
    connection = store.connect(tmp_path / 'app.db')
    connection.execute(
        "INSERT INTO jobs (id, name, owner, status) VALUES ('j1', 'Letters', 'alice', 'done')")
    connection.execute(
        'INSERT INTO pages (id, job_id, idx, filename, source_file, status) '
        "VALUES (1, 'j1', 0, 'leaf_1.png', '/nonexistent/leaf_1.png', 'done')")
    connection.commit()
    app.dependency_overrides[get_db] = lambda: connection
    yield TestClient(app), connection
    app.dependency_overrides.clear()
    connection.close()


class TestWhichTextFilesAreWhich:
    """A .txt named after an image is that page's transcription, as it always was. One
    named after nothing in the upload is a document of the corpus - which is what lets a
    corpus and a bag of scans share an upload without sharing a naming scheme."""

    def test_a_matching_name_is_still_a_page_transcription(self, client):
        api, conn = client
        response = api.post('/api/jobs/j1/pages/upload', headers=ADMIN, files=[
            ('files', ('leaf_2.png', b'\x89PNG\r\n\x1a\n', 'image/png')),
            ('files', ('leaf_2.txt', b'Pfarre Wien\nKaplan Huber', 'text/plain')),
        ])
        assert response.status_code == 200
        assert response.json() == {'ok': True, 'added': 1, 'documents': 0}
        row = conn.execute("SELECT gt_text, gt_source FROM pages WHERE filename = 'leaf_2.png'"
                           ).fetchone()
        assert row['gt_text'] == 'Pfarre Wien\nKaplan Huber'
        assert row['gt_source'] == 'sidecar'

    def test_a_name_matching_nothing_becomes_a_corpus_document(self, client):
        api, conn = client
        response = api.post('/api/jobs/j1/pages/upload', headers=ADMIN, files=[
            ('files', ('leaf_2.png', b'\x89PNG\r\n\x1a\n', 'image/png')),
            ('files', ('brief-1941-03-02.txt', FIRST.encode(), 'text/plain')),
        ])
        assert response.status_code == 200
        assert response.json() == {'ok': True, 'added': 1, 'documents': 1}
        assert [d.name for d in corpus.documents(conn, 'j1')] == ['brief-1941-03-02']
        assert conn.execute(
            "SELECT gt_text FROM pages WHERE filename = 'leaf_2.png'").fetchone()['gt_text'] is None


    def test_a_transcription_pairs_whatever_the_case_of_its_name(self, client):
        api, conn = client
        response = api.post('/api/jobs/j1/pages/upload', headers=ADMIN, files=[
            ('files', ('leaf_2.png', b'\x89PNG\r\n\x1a\n', 'image/png')),
            ('files', ('LEAF_2.TXT', b'Pfarre Wien', 'text/plain')),
        ])
        assert response.json() == {'ok': True, 'added': 1, 'documents': 0}
        assert conn.execute("SELECT gt_text FROM pages WHERE filename = 'leaf_2.png'"
                            ).fetchone()['gt_text'] == 'Pfarre Wien'

    def test_a_byte_order_mark_is_not_part_of_the_text(self, client):
        api, conn = client
        api.post('/api/jobs/j1/pages/upload', headers=ADMIN, files=[
            ('files', ('leaf_2.png', b'\x89PNG\r\n\x1a\n', 'image/png')),
            ('files', ('leaf_2.txt', '\ufeffM\u00fcnchen'.encode(), 'text/plain')),
            ('files', ('brief.txt', 'M\u00fcnchen'.encode('utf-16'), 'text/plain')),
        ])
        assert conn.execute("SELECT gt_text FROM pages WHERE filename = 'leaf_2.png'"
                            ).fetchone()['gt_text'] == 'M\u00fcnchen'
        assert [(d.name, d.text) for d in corpus.documents(conn, 'j1')] == [('brief', 'M\u00fcnchen')]

    def test_a_transcription_that_is_not_utf8_is_refused_and_named(self, client):
        api, conn = client
        response = api.post('/api/jobs/j1/pages/upload', headers=ADMIN, files=[
            ('files', ('leaf_2.png', b'\x89PNG\r\n\x1a\n', 'image/png')),
            ('files', ('leaf_2.txt', 'M\u00fcnchen'.encode('cp1252'), 'text/plain')),
        ])
        assert response.status_code == 400
        assert response.json()['detail'] == (
            'leaf_2.txt is not UTF-8 text - save it as UTF-8 and add it again')
        assert [row['filename'] for row in conn.execute('SELECT filename FROM pages')] == ['leaf_1.png']


class TestTheDocumentRoutes:
    def test_documents_are_listed_with_what_they_cover(self, client):
        api, conn = client
        corpus.store_documents(conn, 'j1', {'letter-01': FIRST})
        conn.commit()
        body = api.get('/api/jobs/j1/documents', headers=ADMIN).json()
        assert body == {'documents': [
            {'name': 'letter-01', 'idx': 0, 'characters': len(FIRST), 'lines': 4, 'pages': 0}]}

    def test_a_document_can_be_read_back_whole(self, client):
        api, conn = client
        corpus.store_documents(conn, 'j1', {'letter-01': FIRST})
        conn.commit()
        assert api.get('/api/jobs/j1/documents/letter-01', headers=ADMIN).json() == {
            'name': 'letter-01', 'text': FIRST}
        assert api.get('/api/jobs/j1/documents/nope', headers=ADMIN).status_code == 404

    def test_uploading_a_document_stores_it_without_recutting(self, client):
        api, conn = client
        response = api.post('/api/jobs/j1/documents', headers=ADMIN, files=[
            ('files', ('letter-01.txt', FIRST.encode(), 'text/plain'))])
        assert response.status_code == 200
        assert response.json() == {'stored': 1, 'skipped': [], 'documents': 1}
        assert conn.execute(
            'SELECT reference_text FROM pages WHERE id = 1').fetchone()['reference_text'] is None

    def test_a_file_that_is_not_text_is_refused_and_named(self, client):
        api, _conn = client
        response = api.post('/api/jobs/j1/documents', headers=ADMIN, files=[
            ('files', ('scan.png', b'\x89PNG\r\n\x1a\n', 'image/png'))])
        assert response.status_code == 400
        assert 'scan.png' in response.json()['detail']

    def test_a_document_named_by_its_folder_is_read_and_deleted_by_that_name(self, client):
        api, conn = client
        corpus.store_documents(conn, 'j1', {'vol1/letter': FIRST, 'letter': SECOND})
        conn.commit()
        assert api.get('/api/jobs/j1/documents/vol1%2Fletter', headers=ADMIN).json() == {
            'name': 'vol1/letter', 'text': FIRST}
        assert api.delete('/api/jobs/j1/documents/vol1%2Fletter', headers=ADMIN).json() == {
            'documents': 1}
        assert [d.name for d in corpus.documents(conn, 'j1')] == ['letter']

    def test_a_document_that_is_not_utf8_is_refused_and_named(self, client):
        api, conn = client
        response = api.post('/api/jobs/j1/documents', headers=ADMIN, files=[
            ('files', ('letter-01.txt', 'M\u00fcnchen'.encode('cp1252'), 'text/plain'))])
        assert response.status_code == 400
        assert response.json()['detail'] == (
            'letter-01.txt is not UTF-8 text - save it as UTF-8 and add it again')
        assert corpus.documents(conn, 'j1') == []

    def test_a_document_can_be_deleted(self, client):
        api, conn = client
        corpus.store_documents(conn, 'j1', {'letter-01': FIRST})
        conn.commit()
        assert api.delete('/api/jobs/j1/documents/letter-01', headers=ADMIN).json() == {
            'documents': 0}
        assert api.delete('/api/jobs/j1/documents/letter-01', headers=ADMIN).status_code == 404

    def test_cutting_needs_a_corpus_to_cut(self, client):
        api, _conn = client
        response = api.post('/api/jobs/j1/reference/cut', headers=ADMIN)
        assert response.status_code == 400
        assert 'no corpus documents' in response.json()['detail']

    def test_cutting_after_the_last_document_is_gone_clears_every_span(self, client):
        """Deleting a document leaves its spans until the next cut, so that cut has to
        run even with nothing left to cut, or the spans could never be taken back."""
        api, conn = client
        corpus.store_documents(conn, 'j1', {'letter-01': FIRST})
        conn.execute("UPDATE pages SET reference_text = 'stale', reference_document = 'letter-01', "
                     'reference_anchors = 2, reference_score = 0.9 WHERE id = 1')
        conn.commit()
        api.delete('/api/jobs/j1/documents/letter-01', headers=ADMIN)

        response = api.post('/api/jobs/j1/reference/cut', headers=ADMIN)
        assert response.status_code == 200
        assert response.json() == {'documents': 0, 'pages': 1, 'placed': 0, 'unanchored': 0}
        page = api.get('/api/jobs/j1/reference', headers=ADMIN).json()['pages'][0]
        assert (page['document'], page['text'], page['anchors']) == (None, '', 0)

    def test_a_running_dataset_is_not_recut_underneath_itself(self, client):
        api, conn = client
        corpus.store_documents(conn, 'j1', {'letter-01': FIRST})
        conn.execute("UPDATE jobs SET status = 'running' WHERE id = 'j1'")
        conn.commit()
        assert api.post('/api/jobs/j1/reference/cut', headers=ADMIN).status_code == 409


class TestWhatTheEditorNeedsToShow:
    """Two things the interface cannot draw honestly without the API saying them."""

    def test_the_shipped_wording_is_served_beside_the_datasets_own(self, client):
        api, _conn = client
        body = api.get('/api/jobs/j1/groundtruth/prompt', headers=ADMIN).json()
        assert body['prompt'] == ''
        assert body['default'] == llm.DEFAULT_GT_PROMPT
        assert body['in_force'] == llm.DEFAULT_GT_PROMPT
        assert body['variables'] == ['reference']

    def test_a_datasets_own_wording_is_what_is_in_force(self, client):
        api, conn = client
        conn.execute("UPDATE jobs SET gt_prompt = 'Read it: {{reference}}' WHERE id = 'j1'")
        conn.commit()
        body = api.get('/api/jobs/j1/groundtruth/prompt', headers=ADMIN).json()
        assert body['prompt'] == 'Read it: {{reference}}'
        assert body['in_force'] == 'Read it: {{reference}}'
        assert body['default'] == llm.DEFAULT_GT_PROMPT

    def test_a_page_says_whether_it_carries_ground_truth_at_all(self, client):
        """Text written before provenance was tracked has a null source, so a null must
        not be read as 'this page has none' - the two need telling apart."""
        api, conn = client
        conn.execute("UPDATE pages SET gt_text = 'written long ago', gt_source = NULL "
                     'WHERE id = 1')
        conn.commit()
        page = api.get('/api/jobs/j1/reference', headers=ADMIN).json()['pages'][0]
        assert page['has_gt'] is True
        assert page['gt_source'] is None

    def test_a_page_with_no_ground_truth_says_so(self, client):
        api, _conn = client
        page = api.get('/api/jobs/j1/reference', headers=ADMIN).json()['pages'][0]
        assert page['has_gt'] is False
        assert page['gt_source'] is None


class TestTheSpanReview:
    def test_a_duplicate_scan_is_not_listed_as_a_page_the_cut_missed(self, client):
        """The cut skips a duplicate, so listing one would show a page with no span that
        the cut never meant to place, and a count that disagrees with the cut's own."""
        api, conn = client
        conn.execute(
            'INSERT INTO pages (id, job_id, idx, filename, source_file, status) '
            "VALUES (2, 'j1', 1, 'leaf_1_again.png', '/nonexistent/leaf_1_again.png', 'duplicate')")
        corpus.store_documents(conn, 'j1', {'letter-01': FIRST})
        conn.commit()
        cut = api.post('/api/jobs/j1/reference/cut', headers=ADMIN).json()
        listed = api.get('/api/jobs/j1/reference', headers=ADMIN).json()
        assert cut['pages'] == 1
        assert listed['total'] == 1
        assert [page['page_id'] for page in listed['pages']] == [1]
