"""The dataset info panel: provenance and size of one dataset in a single payload.
Counts describe the dataset as it stands, so deleted pages are reported apart from the
live ones rather than folded into them.
"""
import pytest
from fastapi.testclient import TestClient

from app import caches, store
from app.deps import get_db
from app.main import app

SECRET = 'test-secret'
ADMIN = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'root', 'X-Auth-Role': 'admin'}
ALICE = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'alice', 'X-Auth-Role': 'member'}
BOB = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'bob', 'X-Auth-Role': 'member'}


@pytest.fixture
def db(tmp_path, monkeypatch):
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    monkeypatch.setattr('app.config.JOBS_DIR', tmp_path / 'jobs')
    # The disk walk is cached for a minute against the real data directory.
    monkeypatch.setattr('app.caches._disk_cache', {})
    conn = store.connect(tmp_path / 'app.db')
    conn.executescript("""
        INSERT INTO models (id, task, name, checkpoint) VALUES
            (1, 'layout', 'Layout v3', 'layout.pt'),
            (2, 'ocr', 'Schematismus OCR', 'ocr.pt');
        INSERT INTO groups (id, name, owner) VALUES (1, 'Schematismus', 'alice');
        INSERT INTO jobs (id, name, owner, status, created_at, group_id,
                          model_layout_id, model_ocr_id)
            VALUES ('j1', 'Volume I', 'alice', 'done', '2026-03-01 09:00:00', 1, 1, 2);
        INSERT INTO job_assignees (job_id, username) VALUES ('j1', 'bob');
        INSERT INTO pages (id, job_id, idx, filename, source_file, source_pdf, gt_text, deleted) VALUES
            (1, 'j1', 0, 'v1_p0001.png', '/data/v1_p0001.png', '/data/v1.pdf', 'Wien', 0),
            (2, 'j1', 1, 'v1_p0002.png', '/data/v1_p0002.png', '/data/v1.pdf', NULL, 0),
            (3, 'j1', 2, 'loose.png',    '/data/loose.png',    NULL,           NULL, 0),
            (4, 'j1', 3, 'gone.png',     '/data/gone.png',     NULL,           NULL, 1);
        INSERT INTO elements (id, page_id, order_idx, class_name, bbox, kind, deleted) VALUES
            (1, 1, 0, 'Paragraph', '[0,0,1,1]', 'content', 0),
            (2, 2, 0, 'Paragraph', '[0,0,1,1]', 'content', 0),
            (3, 4, 0, 'Paragraph', '[0,0,1,1]', 'content', 0);
        INSERT INTO lines (id, element_id, order_idx, polygon, text, checked, deleted) VALUES
            (1, 1, 0, '[[0,0],[1,0],[1,1],[0,1]]', 'Wien',    1, 0),
            (2, 1, 1, '[[0,0],[1,0],[1,1],[0,1]]', 'Graz',    0, 0),
            (3, 2, 0, '[[0,0],[1,0],[1,1],[0,1]]', 'Linz',    0, 0),
            (4, 2, 1, '[[0,0],[1,0],[1,1],[0,1]]', 'dropped', 0, 1),
            (5, 3, 0, '[[0,0],[1,0],[1,1],[0,1]]', 'on a deleted page', 1, 0);
        INSERT INTO revisions (target_type, target_id, job_id, author, action, snapshot, created_at) VALUES
            ('line', 1, 'j1', 'alice', 'edit', '{}', '2026-03-02 10:00:00'),
            ('line', 2, 'j1', 'alice', 'edit', '{}', '2026-03-03 11:00:00'),
            ('line', 3, 'j1', 'bob',   'edit', '{}', '2026-03-04 12:00:00'),
            ('line', 3, 'j1', 'model:ocr@best.pt', 'ocr', '{}', '2026-03-01 09:05:00');
    """)
    conn.commit()
    yield conn
    conn.close()


@pytest.fixture
def client(db):
    app.dependency_overrides[get_db] = lambda: db
    yield TestClient(app)
    app.dependency_overrides.clear()


def info(client, headers=ADMIN, job_id='j1'):
    response = client.get(f'/api/jobs/{job_id}/info', headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


def test_it_says_who_uploaded_the_dataset_and_when(client):
    payload = info(client)
    assert (payload['owner'], payload['created_at']) == ('alice', '2026-03-01 09:00:00')


def test_it_counts_what_was_uploaded(client):
    """Two pages come out of one PDF, one was an image of its own."""
    payload = info(client)
    assert (payload['pages'], payload['documents'], payload['images']) == (3, 1, 1)


def test_deleted_pages_are_reported_apart_from_the_live_ones(client):
    payload = info(client)
    assert (payload['pages'], payload['pages_deleted']) == (3, 1)


def test_a_duplicate_upload_is_reported_apart_and_not_counted_as_a_page(client, db):
    db.execute("INSERT INTO pages (id, job_id, idx, filename, source_file, status) "
               "VALUES (5, 'j1', 4, 'loose_again.png', '/data/loose.png', 'duplicate')")
    db.commit()

    payload = info(client)

    assert (payload['pages'], payload['images'], payload['pages_duplicate']) == (3, 1, 1)


def test_annotation_counts_ignore_deleted_rows(client):
    """Line 4 is deleted and line 5 sits on a deleted page: three lines remain, one checked."""
    payload = info(client)
    assert (payload['elements'], payload['lines'], payload['lines_checked']) == (2, 3, 1)


def test_it_counts_the_pages_that_arrived_with_a_transcription(client):
    assert info(client)['transcriptions'] == 1


def test_editors_come_from_the_revision_log_busiest_first(client):
    """The OCR pass logs revisions too, authored `model:...`; those are provenance,
    not contributors, so only the two people are listed."""
    assert info(client)['editors'] == [
        {'author': 'alice', 'edits': 2, 'last_at': '2026-03-03 11:00:00'},
        {'author': 'bob', 'edits': 1, 'last_at': '2026-03-04 12:00:00'},
    ]


PROVENANCE_AUTHORS = ('model:ocr@best.pt', 'align:gt@1.00', 'llm:claude', 'realign:text@0.91',
                      'system:rerun@alice', 'import:eva')


def test_alignment_the_llm_the_system_and_an_import_are_not_editors(client, db):
    """Every machine author writes revisions as it works, and none of them is a person.
    Taking over an export writes its regions and lines the same way: provenance, not an edit."""
    for author in PROVENANCE_AUTHORS:
        store.log_line(db, 2, author, 'update')
    db.commit()

    assert [(e['author'], e['edits']) for e in info(client)['editors']] == [('alice', 2), ('bob', 1)]


def test_is_person_tells_people_from_provenance():
    assert store.is_person('alice')
    for author in PROVENANCE_AUTHORS:
        assert not store.is_person(author), author


def test_a_dataset_nobody_has_edited_yet_has_no_editors(client, db):
    db.execute("INSERT INTO jobs (id, name, owner, status) VALUES ('j2', 'Fresh', 'alice', 'queued')")
    db.commit()
    assert info(client, job_id='j2')['editors'] == []
    assert info(client)['editors'] != []


def test_models_are_named_not_numbered(client):
    assert info(client)['models'] == {'layout': 'Layout v3', 'lines': None, 'ocr': 'Schematismus OCR'}


def test_it_names_the_project_and_the_people_it_is_shared_with(client):
    payload = info(client)
    assert (payload['group'], payload['shared_with']) == ('Schematismus', ['bob'])


def test_the_size_is_broken_down_by_directory(client, tmp_path):
    root = tmp_path / 'jobs' / 'j1'
    (root / 'uploads').mkdir(parents=True)
    (root / 'renditions').mkdir(parents=True)
    (root / 'uploads' / 'v1.pdf').write_bytes(b'x' * 400)
    (root / 'renditions' / '1_full.jpg').write_bytes(b'x' * 60)
    (root / 'runner.log').write_bytes(b'x' * 3)

    payload = info(client)
    assert payload['disk'] == {'uploads': 400, 'renditions': 60, 'other': 3}
    assert payload['disk_bytes'] == 463


def test_a_dataset_with_nothing_on_disk_yet_reports_no_size(client):
    payload = info(client)
    assert (payload['disk'], payload['disk_bytes']) == ({}, 0)


def test_only_this_endpoint_walks_the_disk(client, tmp_path, monkeypatch):
    """Listing the datasets used to size every one of them, which means stat-ing every
    rendition and line crop the caller can see before the page could render at all. The
    size lives here, beside the breakdown that gives it meaning."""
    root = tmp_path / 'jobs' / 'j1'
    (root / 'uploads').mkdir(parents=True)
    (root / 'uploads' / 'v1.pdf').write_bytes(b'x' * 400)
    walks = []
    real = caches.job_disk_usage
    monkeypatch.setattr(caches, 'job_disk_usage',
                        lambda job_id: (walks.append(job_id), real(job_id))[1])

    assert 'disk_bytes' not in client.get('/api/jobs', headers=ALICE).json()[0]
    assert 'disk_bytes' not in client.get('/api/jobs/j1', headers=ALICE).json()
    assert walks == []

    assert info(client)['disk_bytes'] == 400
    assert walks == ['j1']


def test_someone_the_dataset_was_shared_with_may_read_it(client):
    assert info(client, BOB)['owner'] == 'alice'


def test_a_stranger_is_not_told_the_dataset_exists(client):
    stranger = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'mallory', 'X-Auth-Role': 'member'}
    assert client.get('/api/jobs/j1/info', headers=stranger).status_code == 404
    assert client.get('/api/jobs/j1/info', headers=ALICE).status_code == 200


class TestLineCountsWithoutLayout:
    """A dataset that skipped layout keeps every line in one kind='orphan' bucket, which
    the element counters exclude - so its review progress read 0/0 however much was done.
    """

    def seed(self, db, kind='orphan', checked=(1, 0, 0)):
        db.execute("INSERT INTO jobs (id, name, owner, status, run_layout) "
                     "VALUES ('j9', 'No layout', 'alice', 'done', 0)")
        db.execute("INSERT INTO pages (id, job_id, idx, filename, source_file, status) "
                     "VALUES (9, 'j9', 0, 'p.png', '/p.png', 'done')")
        db.execute("INSERT INTO elements (id, page_id, order_idx, class_name, bbox, kind) "
                     "VALUES (9, 9, 0, 'Unassigned', '[0,0,1,1]', ?)", (kind,))
        for i, is_checked in enumerate(checked):
            db.execute('INSERT INTO lines (element_id, order_idx, polygon, text, checked) '
                         "VALUES (9, ?, '[[0,0],[1,0],[1,1],[0,1]]', 'line', ?)", (i, is_checked))
        db.commit()

    def test_lines_are_counted_even_though_no_box_holds_them(self, client, db):
        self.seed(db)

        page = client.get('/api/jobs/j9', headers=ADMIN).json()['pages'][0]

        # The orphan bucket is not a content element, so the old counters stay at zero...
        assert (page['elements_total'], page['elements_checked']) == (0, 0)
        # ...and the line counts are what the page is actually reviewed by.
        assert (page['lines_total'], page['lines_reviewed']) == (3, 1)

    def test_a_page_whose_lines_are_all_checked_counts_as_reviewed(self, client, db):
        self.seed(db, checked=(1, 1, 1))

        job = client.get('/api/jobs/j9', headers=ADMIN).json()

        assert job['pages'][0]['lines_reviewed'] == 3
        assert job['pages_checked'] == 1

    def test_a_page_with_boxes_is_still_counted_by_them(self, client, db):
        """The fallback is for pages with no boxes at all - it must not quietly change
        how a normal dataset is measured."""
        self.seed(db, kind='content', checked=(1, 0, 0))

        job = client.get('/api/jobs/j9', headers=ADMIN).json()

        assert job['pages'][0]['elements_total'] == 1
        assert job['pages_checked'] == 0


def test_the_list_asks_who_each_dataset_is_shared_with_once_for_all_of_them(client, db):
    db.executescript("""
        INSERT INTO jobs (id, name, owner, status) VALUES
            ('j2', 'Volume II', 'alice', 'done'), ('j3', 'Volume III', 'alice', 'done');
        INSERT INTO job_assignees (job_id, username) VALUES
            ('j2', 'dave'), ('j2', 'carol');
    """)
    db.commit()
    seen = []
    db.set_trace_callback(seen.append)
    try:
        listed = client.get('/api/jobs', headers=ALICE).json()
    finally:
        db.set_trace_callback(None)

    assert {job['id']: job['shared_with'] for job in listed} == {
        'j1': ['bob'], 'j2': ['carol', 'dave'], 'j3': []}
    # The list's own filter names job_assignees too, inside its query over jobs.
    lookups = [sql for sql in seen if 'FROM job_assignees' in sql and 'FROM jobs' not in sql]
    assert len(lookups) == 1, lookups
