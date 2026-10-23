"""Running an action over a selection of datasets.

A group is a project, so what can be asked of one dataset has to be askable of all of
them - and has to refuse for the same reasons, dataset by dataset, rather than refusing
the whole request because one member is busy.
"""
import sqlite3

import pytest
from fastapi.testclient import TestClient

from app import store
from app.deps import get_db
from app.main import app

SECRET = 'test-secret'
ADMIN = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'root', 'X-Auth-Role': 'admin'}
MEMBER_CAPS = 'pipeline.layout pipeline.lines pipeline.ocr train.local'
ALICE = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'alice', 'X-Auth-Role': 'member',
         'X-Auth-Caps': MEMBER_CAPS}
BOB = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'bob', 'X-Auth-Role': 'member'}


@pytest.fixture
def conn(tmp_path, monkeypatch):
    monkeypatch.setattr('app.config.JOBS_DIR', tmp_path / 'jobs')
    monkeypatch.setattr('app.config.BLOBS_DIR', tmp_path / 'blobs')
    connection = store.connect(tmp_path / 'app.db')
    connection.executescript("""
        INSERT INTO models (id, task, name, checkpoint, archived) VALUES
            (1, 'ocr', 'OCR v2', '/models/ocr.pt', 0);
        INSERT INTO groups (id, name, owner) VALUES (1, 'Schematismus', 'alice');
        INSERT INTO jobs (id, name, owner, status, task, group_id, run_ocr) VALUES
            ('j1', 'Volume I',  'alice', 'done',   'text', 1, 1),
            ('j2', 'Volume II', 'alice', 'done',   'text', 1, 1),
            ('j3', 'Volume III','alice', 'running','text', 1, 1),
            ('j9', 'Not hers',  'carol', 'done',   'text', NULL, 1);
        INSERT INTO pages (id, job_id, idx, filename, source_file, status, deleted) VALUES
            (1, 'j1', 0, 'a.png', 'a.png', 'done', 0),
            (2, 'j2', 0, 'b.png', 'b.png', 'done', 0),
            (3, 'j3', 0, 'c.png', 'c.png', 'done', 0);
        INSERT INTO elements (id, page_id, order_idx, class_name, bbox, kind, deleted) VALUES
            (1, 1, 0, 'text', '[]', 'content', 0),
            (2, 2, 0, 'text', '[]', 'content', 0),
            (3, 3, 0, 'text', '[]', 'content', 0);
        INSERT INTO lines (id, element_id, order_idx, polygon, text, checked, deleted) VALUES
            (1, 1, 0, '[]', 'read',   0, 0),
            (2, 1, 1, '[]', 'read',   1, 0),
            (3, 2, 0, '[]', 'read',   0, 0),
            (4, 3, 0, '[]', 'read',   0, 0);
    """)
    connection.commit()
    yield connection
    connection.close()


@pytest.fixture
def client(conn, monkeypatch):
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    app.dependency_overrides[get_db] = lambda: conn
    yield TestClient(app)
    app.dependency_overrides.clear()


def status_of(conn, job_id):
    return conn.execute('SELECT status FROM jobs WHERE id = ?', (job_id,)).fetchone()['status']


def test_a_busy_dataset_is_skipped_and_the_rest_still_run(client, conn):
    r = client.post('/api/bulk/reocr',
                    json={'job_ids': ['j1', 'j2', 'j3'], 'scope': 'unchecked'}, headers=ALICE)

    assert r.status_code == 200
    body = r.json()
    assert [c['id'] for c in body['changed']] == ['j1', 'j2']
    assert body['skipped'] == [
        {'id': 'j3', 'name': 'Volume III', 'reason': 'job is already queued or running'}]
    assert status_of(conn, 'j1') == 'queued'
    assert status_of(conn, 'j2') == 'queued'
    assert status_of(conn, 'j3') == 'running', 'the busy one is left exactly as it was'


def test_a_skipped_dataset_is_rolled_back_not_half_written(client, conn):
    """j3 is running, so its re-read is refused after needs_ocr would have been set."""
    client.post('/api/bulk/reocr',
                json={'job_ids': ['j1', 'j3'], 'scope': 'unchecked'}, headers=ALICE)

    marked = conn.execute(
        'SELECT l.id FROM lines l JOIN elements e ON l.element_id = e.id '
        'WHERE l.needs_ocr = 1 ORDER BY l.id').fetchall()
    assert [row['id'] for row in marked] == [1], 'only j1 line 1; j3 line 4 was rolled back'


def test_nothing_runnable_is_a_refusal_rather_than_an_empty_success(client, conn):
    r = client.post('/api/bulk/reocr', json={'job_ids': ['j3'], 'scope': 'unchecked'},
                    headers=ALICE)

    assert r.status_code == 400
    assert r.json()['detail'] == 'job is already queued or running'
    assert status_of(conn, 'j3') == 'running'


def test_a_dataset_the_caller_cannot_reach_fails_the_whole_request(client, conn):
    r = client.post('/api/bulk/reocr', json={'job_ids': ['j1', 'j9'], 'scope': 'unchecked'},
                    headers=ALICE)

    assert r.status_code == 404
    assert r.json()['detail'] == 'dataset j9 not found'
    assert status_of(conn, 'j1') == 'done', 'a selection that cannot run in full runs not at all'


def test_an_unknown_dataset_fails_the_whole_request(client, conn):
    r = client.post('/api/bulk/reocr', json={'job_ids': ['j1', 'nope'], 'scope': 'unchecked'},
                    headers=ALICE)

    assert r.status_code == 404
    assert r.json()['detail'] == 'dataset nope not found'
    assert status_of(conn, 'j1') == 'done'


def test_a_repeated_id_runs_once(client, conn):
    r = client.post('/api/bulk/reocr', json={'job_ids': ['j1', 'j1'], 'scope': 'unchecked'},
                    headers=ALICE)

    assert [c['id'] for c in r.json()['changed']] == ['j1']


def test_a_selection_asks_for_the_same_permissions_one_dataset_does(client, conn):
    """A member may re-read their own datasets, so they may re-read a selection of them -
    but throwing away what somebody checked is a permission they do not have, and a
    selection is not a way around that."""
    allowed = client.post('/api/bulk/rerun', json={'job_ids': ['j1'], 'from_phase': 'ocr'},
                          headers=ALICE)

    assert allowed.status_code == 200
    assert status_of(conn, 'j1') == 'queued'

    refused = client.post('/api/bulk/rerun',
                          json={'job_ids': ['j2'], 'from_phase': 'ocr', 'keep_checked': False},
                          headers=ALICE)

    assert refused.status_code == 403
    assert refused.json()['detail'] == 'not permitted: pipeline.discard'
    assert status_of(conn, 'j2') == 'done'


def test_an_admin_may_rerun_a_selection(client, conn):
    r = client.post('/api/bulk/rerun', json={'job_ids': ['j1', 'j2'], 'from_phase': 'ocr'},
                    headers=ADMIN)

    assert r.status_code == 200
    assert [c['id'] for c in r.json()['changed']] == ['j1', 'j2']
    assert status_of(conn, 'j1') == 'queued'
    # Re-running from ocr clears the text it is about to replace - except line 2, which
    # somebody checked, and line 4, which belongs to a dataset outside the selection.
    assert [r['id'] for r in conn.execute(
        'SELECT id FROM lines WHERE text IS NOT NULL ORDER BY id')] == [2, 4]
    assert status_of(conn, 'j3') == 'running', 'a dataset outside the selection is untouched'


def test_a_shared_dataset_is_still_its_owner_s_to_re_run(client, conn):
    """Being given a dataset carries re-reading it, not re-running it: one dataset of
    somebody else's refuses the whole selection, so none of it is half re-run."""
    conn.execute("INSERT INTO job_assignees (job_id, username) VALUES ('j9', 'alice')")
    conn.commit()

    refused = client.post('/api/bulk/rerun', json={'job_ids': ['j1', 'j9'], 'from_phase': 'ocr'},
                          headers=ALICE)

    assert refused.status_code == 403
    assert refused.json()['detail'] == 'only the owner or an admin may re-run Not hers'
    assert status_of(conn, 'j1') == 'done'
    assert status_of(conn, 'j9') == 'done'
    assert [r['id'] for r in conn.execute(
        'SELECT id FROM lines WHERE text IS NOT NULL ORDER BY id')] == [1, 2, 3, 4]

    allowed = client.post('/api/bulk/rerun', json={'job_ids': ['j9'], 'from_phase': 'ocr'},
                          headers={**ALICE, 'X-Auth-User': 'carol'})

    assert allowed.status_code == 200
    assert status_of(conn, 'j9') == 'queued'


def test_a_selection_switches_the_phase_back_on_where_it_was_off(client, conn):
    conn.execute("UPDATE jobs SET run_ocr = 0 WHERE id = 'j1'")
    conn.commit()

    r = client.post('/api/bulk/rerun', json={'job_ids': ['j1', 'j2'], 'from_phase': 'ocr'},
                    headers=ADMIN)

    assert r.status_code == 200
    assert {row['id']: row['run_ocr'] for row in conn.execute(
        'SELECT id, run_ocr FROM jobs ORDER BY id')} == {'j1': 1, 'j2': 1, 'j3': 1, 'j9': 1}


def test_a_selection_never_switches_text_phases_on_for_a_map_dataset(client, conn):
    conn.executescript("""
        UPDATE jobs SET run_layout = 0, run_lines = 0, run_ocr = 0 WHERE id = 'j1';
        INSERT INTO jobs (id, name, owner, status, task, run_layout, run_lines, run_ocr) VALUES
            ('m1', 'Cadastre', 'alice', 'done', 'map_segmentation', 0, 0, 0);
        INSERT INTO pages (id, job_id, idx, filename, source_file, status) VALUES
            (9, 'm1', 0, 'tile.png', 'tile.png', 'done');
    """)
    conn.commit()

    r = client.post('/api/bulk/rerun', json={'job_ids': ['j1', 'm1'], 'from_phase': 'lines'},
                    headers=ADMIN)

    assert [c['id'] for c in r.json()['changed']] == ['j1', 'm1']
    assert {row['id']: (row['run_layout'], row['run_lines'], row['run_ocr']) for row in conn.execute(
        "SELECT id, run_layout, run_lines, run_ocr FROM jobs WHERE id IN ('j1', 'm1')")} == {
        'j1': (0, 1, 0), 'm1': (0, 0, 0)}


def test_a_selection_started_over_keeps_each_dataset_s_own_layout_setting(client, conn):
    conn.execute("UPDATE jobs SET run_layout = 0 WHERE id = 'j1'")
    conn.commit()

    r = client.post('/api/bulk/rerun', json={'job_ids': ['j1', 'j2'], 'from_phase': 'start'},
                    headers=ADMIN)

    assert [c['id'] for c in r.json()['changed']] == ['j1', 'j2']
    assert {row['id']: row['run_layout'] for row in conn.execute(
        "SELECT id, run_layout FROM jobs WHERE id IN ('j1', 'j2')")} == {'j1': 0, 'j2': 1}
    assert [row['deleted'] for row in conn.execute(
        'SELECT deleted FROM elements WHERE id IN (1, 2) ORDER BY id')] == [1, 1]


def test_a_selection_can_be_told_to_clear_the_checked_lines_too(client, conn):
    r = client.post('/api/bulk/rerun',
                    json={'job_ids': ['j1', 'j2'], 'from_phase': 'ocr', 'keep_checked': False},
                    headers=ADMIN)

    assert r.status_code == 200
    # Line 2's check goes with the rest; line 4 is in j3 and still untouched.
    assert [r['id'] for r in conn.execute(
        'SELECT id FROM lines WHERE text IS NOT NULL ORDER BY id')] == [4]
    assert conn.execute('SELECT checked FROM lines WHERE id = 2').fetchone()['checked'] == 0


def test_a_bad_phase_is_refused_before_anything_runs(client, conn):
    r = client.post('/api/bulk/rerun', json={'job_ids': ['j1'], 'from_phase': 'nonsense'},
                    headers=ADMIN)

    assert r.status_code == 400
    assert status_of(conn, 'j1') == 'done'


def test_settings_reach_every_dataset_in_the_selection(client, conn):
    r = client.patch('/api/bulk/settings',
                     json={'job_ids': ['j1', 'j2'], 'patch': {'model_ocr_id': 1}}, headers=ALICE)

    assert r.status_code == 200
    assert [c['id'] for c in r.json()['changed']] == ['j1', 'j2']
    picked = conn.execute('SELECT id, model_ocr_id FROM jobs ORDER BY id').fetchall()
    assert {row['id']: row['model_ocr_id'] for row in picked} == {
        'j1': 1, 'j2': 1, 'j3': None, 'j9': None}


def test_a_name_belongs_to_one_dataset_not_a_selection(client, conn):
    r = client.patch('/api/bulk/settings',
                     json={'job_ids': ['j1', 'j2'], 'patch': {'name': 'Same name'}}, headers=ALICE)

    assert r.status_code == 400
    assert r.json()['detail'] == 'name belongs to one dataset, not to a selection'


def test_a_selection_is_filed_under_a_group_at_once(client, conn):
    conn.execute("INSERT INTO groups (id, name, owner) VALUES (2, 'Briefe', 'alice')")
    conn.commit()

    r = client.patch('/api/bulk/group', json={'job_ids': ['j1', 'j2'], 'group_id': 2},
                     headers=ALICE)

    assert r.status_code == 200
    filed = conn.execute("SELECT id, group_id FROM jobs WHERE id IN ('j1','j2','j3') "
                         'ORDER BY id').fetchall()
    assert {row['id']: row['group_id'] for row in filed} == {'j1': 2, 'j2': 2, 'j3': 1}


def test_a_selection_is_filed_out_of_a_group_with_a_null(client, conn):
    r = client.patch('/api/bulk/group', json={'job_ids': ['j1'], 'group_id': None}, headers=ALICE)

    assert r.status_code == 200
    assert conn.execute("SELECT group_id FROM jobs WHERE id = 'j1'").fetchone()['group_id'] is None


def test_the_preview_sums_the_selection_and_names_what_it_cannot_run(client, conn):
    r = client.post('/api/bulk/preview',
                    json={'job_ids': ['j1', 'j2', 'j3'], 'action': 'reocr'}, headers=ALICE)

    assert r.status_code == 200
    body = r.json()
    assert body['action'] == 'reocr'
    assert body['datasets'] == 2, 'j3 is running, so it is not counted in the totals'
    assert body['blocked'] == [
        {'id': 'j3', 'name': 'Volume III', 'reason': 'job is already queued or running'}]
    # j1 has one unchecked and one checked line; j2 has one unchecked. None lack text.
    assert body['totals'] == {'lines': 0, 'unchecked': 2, 'checked': 1}


def test_the_reocr_preview_does_not_count_a_dataset_the_re_read_would_refuse(client, conn):
    conn.execute('UPDATE lines SET checked = 1 WHERE id = 3')
    conn.commit()
    preview = client.post('/api/bulk/preview',
                          json={'job_ids': ['j1', 'j2'], 'action': 'reocr'}, headers=ALICE).json()
    run = client.post('/api/bulk/reocr', json={'job_ids': ['j1', 'j2'], 'scope': 'unchecked'},
                      headers=ALICE).json()

    assert preview['datasets'] == 1
    assert preview['blocked'] == [
        {'id': 'j2', 'name': 'Volume II', 'reason': 'no unchecked lines to re-read'}]
    assert run['skipped'] == preview['blocked']
    # The refused dataset's checked line is left alone as well, so it is still counted.
    assert preview['totals'] == {'lines': 0, 'unchecked': 1, 'checked': 2}


def test_the_redetect_preview_does_not_count_a_dataset_with_nothing_to_redetect(client, conn):
    conn.execute("UPDATE elements SET lines_bbox = '[]' WHERE id = 2")
    conn.commit()
    preview = client.post('/api/bulk/preview',
                          json={'job_ids': ['j1', 'j2'], 'action': 'redetect'}, headers=ADMIN).json()
    run = client.post('/api/bulk/redetect', json={'job_ids': ['j1', 'j2']}, headers=ADMIN).json()

    assert preview['datasets'] == 1
    assert preview['blocked'] == [
        {'id': 'j2', 'name': 'Volume II', 'reason': 'no elements need line re-detection'}]
    assert run['skipped'] == preview['blocked']
    assert preview['totals'] == {'elements': 1, 'pages': 1, 'corrected': 0, 'hand_edited': 0}


def test_the_preview_changes_nothing(client, conn):
    client.post('/api/bulk/preview',
                json={'job_ids': ['j1', 'j2'], 'action': 'rerun', 'from_phase': 'ocr'},
                headers=ALICE)

    assert status_of(conn, 'j1') == 'done'
    assert status_of(conn, 'j2') == 'done'


def test_an_alignment_preview_discards_nothing(client, conn):
    """Alignment re-matches the transcriptions against the text on hand, so a person's
    correction is not among what it costs - the dialog must not say it is lost."""
    conn.execute("UPDATE lines SET corrected_text = 'Wien' WHERE id = 1")
    conn.execute("UPDATE pages SET layout_checked = 1 WHERE id = 2")
    conn.commit()

    align = client.post('/api/bulk/preview', json={
        'job_ids': ['j1', 'j2'], 'action': 'rerun', 'from_phase': 'align'}, headers=ADMIN).json()
    ocr = client.post('/api/bulk/preview', json={
        'job_ids': ['j1', 'j2'], 'action': 'rerun', 'from_phase': 'ocr'}, headers=ADMIN).json()

    assert align['totals'] == {'lines': 3, 'corrected': 0, 'checked': 1,
                               'layout_checked': 0, 'elements_edited': 0}
    assert ocr['totals'] == {'lines': 3, 'corrected': 1, 'checked': 1,
                             'layout_checked': 1, 'elements_edited': 0}


def test_a_layout_preview_names_what_the_re_run_would_refuse_without_force(client, conn):
    conn.execute("UPDATE pages SET layout_checked = 1 WHERE id = 2")
    conn.commit()
    selection = {'job_ids': ['j1', 'j2'], 'from_phase': 'layout'}

    preview = client.post('/api/bulk/preview', json={**selection, 'action': 'rerun'},
                          headers=ADMIN).json()
    forced = client.post('/api/bulk/preview', json={**selection, 'action': 'rerun', 'force': True},
                         headers=ADMIN).json()
    run = client.post('/api/bulk/rerun', json=selection, headers=ADMIN).json()

    assert preview['datasets'] == 1
    assert preview['blocked'] == [{'id': 'j2', 'name': 'Volume II', 'reason':
                                   '1 page(s) are marked layout complete; pass force to re-run anyway'}]
    assert run['skipped'] == preview['blocked']
    assert (forced['datasets'], forced['blocked']) == (2, [])
    assert status_of(conn, 'j2') == 'done'


def test_a_rerun_preview_marks_a_dataset_the_caller_does_not_own_as_blocked(client, conn):
    """The re-run refuses a selection holding somebody else's dataset, so its preview
    names that dataset rather than counting it as runnable."""
    conn.execute("INSERT INTO job_assignees (job_id, username) VALUES ('j9', 'alice')")
    conn.commit()

    preview = client.post('/api/bulk/preview', json={'job_ids': ['j1', 'j9'], 'action': 'rerun',
                                                     'from_phase': 'ocr'}, headers=ALICE).json()

    assert preview['datasets'] == 1
    assert preview['blocked'] == [
        {'id': 'j9', 'name': 'Not hers', 'reason': 'only the owner or an admin may re-run Not hers'}]


def test_a_rerun_preview_needs_the_phase_it_previews(client):
    r = client.post('/api/bulk/preview', json={'job_ids': ['j1'], 'action': 'rerun'},
                    headers=ADMIN)

    assert r.status_code == 400
    assert 'from_phase must be one of' in r.json()['detail']


def test_an_empty_selection_is_refused(client):
    r = client.post('/api/bulk/reocr', json={'job_ids': [], 'scope': 'unchecked'}, headers=ALICE)

    assert r.status_code == 422


def test_the_capability_is_what_decides_on_a_dataset_shared_with_you(client, conn):
    """Sharing a dataset carries re-reading it now, so what settles this is whether the
    person may re-read at all - not whether the dataset is theirs."""
    conn.execute("INSERT INTO job_assignees (job_id, username) VALUES ('j1', 'bob')")
    conn.commit()
    without = {**BOB, 'X-Auth-Caps': 'pipeline.layout pipeline.lines'}

    refused = client.post('/api/bulk/reocr', json={'job_ids': ['j1'], 'scope': 'unchecked'},
                          headers=without)

    assert refused.status_code == 403, 'a permission refusal, as one dataset would answer it'
    assert refused.json()['detail'] == 'not permitted: pipeline.ocr'
    assert status_of(conn, 'j1') == 'done'

    allowed = client.post('/api/bulk/reocr', json={'job_ids': ['j1'], 'scope': 'unchecked'},
                          headers={**BOB, 'X-Auth-Caps': MEMBER_CAPS})

    assert allowed.status_code == 200
    assert status_of(conn, 'j1') == 'queued'


def test_a_selection_is_filed_while_a_running_job_writes_meanwhile(conn, tmp_path):
    # A job's runner commits between the bulk reading a dataset and writing it. Read and
    # write sit in one transaction, so SQLite refused the write at once - "database is
    # locked" - instead of making either side wait for the other.
    from app.routes import bulk

    runner = sqlite3.connect(tmp_path / 'app.db', timeout=0.2)
    conn.execute("INSERT INTO groups (id, name, owner) VALUES (2, 'Briefe', 'alice')")
    conn.commit()

    def file_under_briefe(job):
        conn.execute('SELECT group_id FROM jobs WHERE id = ?', (job['id'],)).fetchone()
        try:
            runner.execute("UPDATE jobs SET name = 'Volume III, read' WHERE id = 'j3'")
            runner.commit()
        except sqlite3.OperationalError as busy:
            assert 'locked' in str(busy)  # the runner waits its turn
        conn.execute('UPDATE jobs SET group_id = 2 WHERE id = ?', (job['id'],))

    done, skipped = bulk.each_isolated(conn, [{'id': 'j1', 'name': 'Volume I'}], file_under_briefe)
    conn.commit()
    runner.close()

    assert ([d['id'] for d in done], skipped) == (['j1'], [])
    assert conn.execute("SELECT group_id FROM jobs WHERE id = 'j1'").fetchone()['group_id'] == 2
