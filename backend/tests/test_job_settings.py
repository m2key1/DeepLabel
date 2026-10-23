"""A dataset's settings, and who may change which. The split is deliberate: the review
flags are worked on by whoever is annotating, while renaming, moving, choosing models and
anything that puts lines into the training corpus stay with the owner.
"""
import pytest
from fastapi.testclient import TestClient

from app import store
from app.deps import get_db
from app.main import app

SECRET = 'test-secret'
ADMIN = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'root', 'X-Auth-Role': 'admin'}
ALICE = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'alice', 'X-Auth-Role': 'member'}
BOB = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'bob', 'X-Auth-Role': 'member'}
STRANGER = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'mallory', 'X-Auth-Role': 'member'}


@pytest.fixture
def conn(tmp_path, monkeypatch):
    monkeypatch.setattr('app.config.JOBS_DIR', tmp_path / 'jobs')
    monkeypatch.setattr('app.config.BLOBS_DIR', tmp_path / 'blobs')
    connection = store.connect(tmp_path / 'app.db')
    connection.executescript("""
        INSERT INTO models (id, task, name, checkpoint, archived) VALUES
            (1, 'layout', 'Layout v3', '/models/layout.pt', 0),
            (2, 'ocr', 'OCR v2', '/models/ocr.pt', 0),
            (3, 'ocr', 'Retired OCR', '/models/old.pt', 1);
        INSERT INTO groups (id, name, owner) VALUES (1, 'Schematismus', 'alice');
        INSERT INTO jobs (id, name, owner, status, task) VALUES
            ('j1', 'Volume I', 'alice', 'done', 'text'),
            ('j2', 'Volume II', 'alice', 'done', 'text');
        INSERT INTO job_assignees (job_id, username) VALUES ('j1', 'bob');
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


def patch(client, body, headers=ALICE, job_id='j1'):
    return client.patch(f'/api/jobs/{job_id}', json=body, headers=headers)


def job(conn, job_id='j1'):
    return conn.execute('SELECT * FROM jobs WHERE id = ?', (job_id,)).fetchone()


class TestWhatAnyoneWorkingOnItMaySet:
    def test_marking_the_dataset_reviewed(self, client, conn):
        assert patch(client, {'checked': True}, headers=BOB).status_code == 200
        assert job(conn)['checked'] == 1

    def test_turning_automatic_re_detection_off(self, client, conn):
        assert patch(client, {'auto_redetect': False}, headers=BOB).status_code == 200
        assert job(conn)['auto_redetect'] == 0

    def test_the_line_width_a_mask_export_draws_with(self, client, conn):
        """Tuned by whoever is looking at the mask, since it only changes the next export."""
        assert patch(client, {'line_width': 7}, headers=BOB).status_code == 200
        assert job(conn)['line_width'] == 7

    def test_a_line_width_outside_what_a_mask_can_use_is_refused(self, client):
        assert patch(client, {'line_width': 0}, headers=BOB).status_code == 400
        assert patch(client, {'line_width': 999}, headers=BOB).status_code == 400


class TestWhatOnlyTheOwnerMaySet:
    @pytest.mark.parametrize('body', [
        {'name': 'Renamed'},
        {'group_id': 1},
        {'model_ocr_id': 2},
        {'gt_autocheck': True},
        {'gt_ordered': True},
        {'llm_autocheck': True},
        {'ocr_decode': 'greedy'},
        {'line_mode': 'per_page'},
        {'run_layout': False},
        {'llm_consensus_with_ocr': True},
        {'llm_consensus_min': 3},
    ])
    def test_an_assignee_is_refused(self, client, body):
        assert patch(client, body, headers=BOB).status_code == 403

    @pytest.mark.parametrize('body', [
        {'name': 'Renamed'},
        {'group_id': 1},
        {'model_ocr_id': 2},
        {'gt_autocheck': True},
        {'gt_ordered': True},
        {'llm_autocheck': True},
        {'ocr_decode': 'greedy'},
        {'line_mode': 'per_page'},
        {'run_layout': False},
        {'llm_consensus_with_ocr': True},
        {'llm_consensus_min': 3},
        {'gt_prompt': 'Read the page. Here is what it says: {{reference}}'},
    ])
    def test_the_owner_is_not(self, client, body):
        assert patch(client, body).status_code == 200

    def test_an_admin_may_set_them_on_anybodys(self, client):
        assert patch(client, {'name': 'Tidied by an admin'}, headers=ADMIN).status_code == 200


class TestNaming:
    def test_a_rename_sticks_and_is_trimmed(self, client, conn):
        patch(client, {'name': '  Volume the First  '})

        assert job(conn)['name'] == 'Volume the First'

    def test_a_name_of_nothing_is_refused(self, client):
        assert patch(client, {'name': '   '}).status_code == 400

    def test_taking_another_datasets_name_is_refused(self, client):
        response = patch(client, {'name': 'Volume II'})

        assert response.status_code == 409

    def test_keeping_its_own_name_is_not_a_clash_with_itself(self, client):
        assert patch(client, {'name': 'Volume I'}).status_code == 200


class TestMovingItIntoAProject:
    def test_it_can_be_moved_in_and_back_out(self, client, conn):
        assert patch(client, {'group_id': 1}).status_code == 200
        assert job(conn)['group_id'] == 1

        assert patch(client, {'group_id': None}).status_code == 200
        assert job(conn)['group_id'] is None

    def test_a_project_that_does_not_exist_is_refused(self, client):
        response = patch(client, {'group_id': 99})

        assert response.status_code == 404
        assert 'group not found' in response.json()['detail']


class TestChoosingModels:
    def test_a_model_for_the_right_task_is_accepted(self, client, conn):
        assert patch(client, {'model_ocr_id': 2}).status_code == 200
        assert job(conn)['model_ocr_id'] == 2

    def test_a_model_for_another_task_is_refused(self, client):
        assert patch(client, {'model_ocr_id': 1}).status_code == 400

    def test_an_archived_model_is_refused(self, client):
        assert patch(client, {'model_ocr_id': 3}).status_code == 409

    def test_keeping_a_model_archived_since_it_was_picked_is_not_choosing_it(self, client, conn):
        """The picker sends every setting back, so a dataset pinned before the archive
        could otherwise never have its decoding changed without losing its model."""
        conn.execute("UPDATE jobs SET model_ocr_id = 3 WHERE id = 'j1'")
        conn.commit()

        assert patch(client, {'model_ocr_id': 3, 'ocr_decode': 'greedy'}).status_code == 200
        assert (job(conn)['model_ocr_id'], job(conn)['ocr_decode']) == (3, 'greedy')
        assert patch(client, {'model_ocr_id': 3}, job_id='j2').status_code == 409

    def test_clearing_the_choice_falls_back_to_the_default(self, client, conn):
        patch(client, {'model_ocr_id': 2})

        assert patch(client, {'model_ocr_id': None}).status_code == 200
        assert job(conn)['model_ocr_id'] is None

    def test_a_decode_mode_nobody_offers_is_refused(self, client):
        assert patch(client, {'ocr_decode': 'telepathy'}).status_code == 400


class TestTheLanguageModelSettings:
    def test_how_many_must_agree_is_settable(self, client, conn):
        assert patch(client, {'llm_consensus_min': 3}).status_code == 200
        assert job(conn)['llm_consensus_min'] == 3

    def test_an_assignee_leaves_the_threshold_as_it_was(self, client, conn):
        """How many must agree decides what settles, like autocheck and who counts as a
        reader, so an assignee's attempt changes nothing."""
        assert patch(client, {'llm_consensus_min': 1}, headers=BOB).status_code == 403
        assert job(conn)['llm_consensus_min'] == 2

    @pytest.mark.parametrize('value', [0, 11])
    def test_a_threshold_outside_the_range_is_refused(self, client, value):
        response = patch(client, {'llm_consensus_min': value})

        assert response.status_code == 400
        assert 'between 1 and 10' in response.json()['detail']

    def test_the_datasets_own_prompt_is_stored_trimmed(self, client, conn):
        patch(client, {'llm_prompt': '  Kurrent script, 1750s.  '})

        assert job(conn)['llm_prompt'] == 'Kurrent script, 1750s.'

    def test_a_prompt_longer_than_the_limit_is_refused(self, client):
        from app import llm

        response = patch(client, {'llm_prompt': 'x' * (llm.MAX_PROMPT_LENGTH + 1)})

        assert response.status_code == 400
        assert 'at most' in response.json()['detail']


class TestHowATranscriptionIsMatched:
    """Re-running Alignment is how a transcription is matched under changed settings, so
    both have to be changeable after the dataset exists."""

    @pytest.mark.parametrize('field', ['gt_autocheck', 'gt_ordered'])
    def test_each_can_be_switched_on_and_back_off(self, client, conn, field):
        response = patch(client, {field: True})
        assert response.status_code == 200
        assert response.json()[field] is True
        assert job(conn)[field] == 1

        assert patch(client, {field: False}).json()[field] is False
        assert job(conn)[field] == 0

    def test_one_leaves_the_other_alone(self, client, conn):
        patch(client, {'gt_ordered': True})
        patch(client, {'gt_autocheck': True})

        assert (job(conn)['gt_autocheck'], job(conn)['gt_ordered']) == (1, 1)

    def test_the_dataset_reports_them_as_flags(self, client):
        patch(client, {'gt_autocheck': True})

        shown = client.get('/api/jobs/j1?pages=false', headers=ALICE).json()
        assert (shown['gt_autocheck'], shown['gt_ordered']) == (True, False)


class TestSharing:
    def test_the_list_replaces_rather_than_adds(self, client, conn):
        client.put('/api/jobs/j1/share', json={'usernames': ['bob', 'carol']}, headers=ALICE)

        response = client.put('/api/jobs/j1/share', json={'usernames': ['dave']}, headers=ALICE)

        assert response.json()['shared_with'] == ['dave']
        assert [r['username'] for r in conn.execute(
            "SELECT username FROM job_assignees WHERE job_id = 'j1'")] == ['dave']

    def test_blanks_and_duplicates_are_not_people(self, client):
        response = client.put('/api/jobs/j1/share',
                              json={'usernames': ['bob', ' bob ', '  ', 'carol']}, headers=ALICE)

        assert response.json()['shared_with'] == ['bob', 'carol']

    def test_an_assignee_cannot_re_share_it(self, client):
        assert client.put('/api/jobs/j1/share', json={'usernames': ['mallory']},
                          headers=BOB).status_code == 403


# Deleting is a capability a member does not have by default; these two were given it.
ALICE_MAY_DELETE = {**ALICE, 'X-Auth-Caps': 'dataset.delete'}
BOB_MAY_DELETE = {**BOB, 'X-Auth-Caps': 'dataset.delete'}


class TestDeleting:
    def test_the_dataset_and_its_directory_go(self, client, conn, tmp_path):
        directory = tmp_path / 'jobs' / 'j1'
        directory.mkdir(parents=True)
        (directory / 'runner.log').write_text('log')

        assert client.delete('/api/jobs/j1', headers=ALICE_MAY_DELETE).status_code == 200

        assert job(conn) is None
        assert not directory.exists()

    def test_its_history_goes_with_it(self, client, conn):
        """The one place the append-only log is broken on purpose: the scans go too, so
        an audit trail for images that no longer exist is unbounded noise."""
        store.log_revision(conn, 'page', 1, 'j1', 'alice', 'update', {'id': 1})
        conn.commit()

        client.delete('/api/jobs/j1', headers=ALICE_MAY_DELETE)

        assert conn.execute(
            "SELECT COUNT(*) c FROM revisions WHERE job_id = 'j1'").fetchone()['c'] == 0

    def test_owning_it_is_not_enough_without_the_capability(self, client, conn):
        response = client.delete('/api/jobs/j1', headers=ALICE)

        assert response.status_code == 403
        assert response.json()['detail'] == 'not permitted: dataset.delete'
        assert job(conn)['name'] == 'Volume I'

    def test_an_assignee_cannot_delete_it_even_with_the_capability(self, client, conn):
        response = client.delete('/api/jobs/j1', headers=BOB_MAY_DELETE)

        assert response.status_code == 403
        assert response.json()['detail'] == 'not permitted'
        assert job(conn) is not None

    def test_a_dataset_that_does_not_exist_is_a_404(self, client):
        assert client.delete('/api/jobs/nope', headers=ADMIN).status_code == 404


class TestCancelling:
    def test_a_queued_dataset_can_be_stopped(self, client, conn):
        conn.execute("UPDATE jobs SET status = 'queued' WHERE id = 'j1'")
        conn.commit()

        assert client.post('/api/jobs/j1/cancel', headers=ALICE).status_code == 200
        assert job(conn)['status'] == 'cancelled'

    def test_an_assignee_cannot_stop_it(self, client):
        assert client.post('/api/jobs/j1/cancel', headers=BOB).status_code == 403

    def test_a_dataset_that_does_not_exist_is_a_404(self, client):
        assert client.post('/api/jobs/nope/cancel', headers=ADMIN).status_code == 404

    def test_a_finished_dataset_is_refused_and_left_finished(self, client, conn):
        response = client.post('/api/jobs/j1/cancel', headers=ALICE)

        assert response.status_code == 409
        assert response.json()['detail'] == (
            'this dataset is already done - only a queued or running one can be cancelled')
        assert job(conn)['status'] == 'done'


class TestWhoSeesIt:
    def test_a_stranger_is_not_told_it_exists(self, client):
        assert patch(client, {'checked': True}, headers=STRANGER).status_code == 404
        assert client.delete('/api/jobs/j1', headers=STRANGER).status_code == 404


class TestTheQueue:
    def test_a_queued_dataset_is_listed_in_the_order_it_will_run(self, client, conn):
        conn.execute("UPDATE jobs SET status = 'queued' WHERE id = 'j1'")
        conn.commit()

        gpu = client.get('/api/queue', headers=ALICE).json()['gpu']

        assert [e['id'] for e in gpu['queued']] == ['j1']
        assert gpu['running'] is None

    def test_a_running_one_is_shown_apart_from_what_is_waiting(self, client, conn):
        conn.execute("UPDATE jobs SET status = 'running' WHERE id = 'j1'")
        conn.commit()

        gpu = client.get('/api/queue', headers=ALICE).json()['gpu']

        assert gpu['running']['id'] == 'j1'
        assert gpu['queued'] == []

    def test_an_idle_instance_says_so_rather_than_failing(self, client):
        body = client.get('/api/queue', headers=ALICE).json()

        assert body == {'gpu': {'running': None, 'queued': []}, 'cluster': [],
                        'pending_reocr': None}

    def test_the_queue_is_global_but_names_are_not(self, client, conn):
        """One GPU, so everybody sees how busy it is - without being told what other
        people's datasets are called."""
        conn.execute("UPDATE jobs SET status = 'queued' WHERE id = 'j1'")
        conn.commit()

        entry = client.get('/api/queue', headers=STRANGER).json()['gpu']['queued'][0]

        assert entry['name'] == 'another dataset'
        assert entry['accessible'] is False

    def test_lines_waiting_to_be_re_read_are_counted_for_the_next_sweep(self, client, conn):
        conn.executescript("""
            UPDATE jobs SET run_ocr = 1 WHERE id = 'j1';
            INSERT INTO pages (id, job_id, idx, filename, source_file, status)
                VALUES (1, 'j1', 0, 'p1.png', '/p1.png', 'done');
            INSERT INTO elements (id, page_id, order_idx, class_name, bbox, kind)
                VALUES (1, 1, 0, 'Paragraph', '[0,0,1,1]', 'content');
            INSERT INTO lines (id, element_id, order_idx, polygon, needs_ocr)
                VALUES (1, 1, 0, '[[0,0],[1,0],[1,1],[0,1]]', 1);
        """)
        conn.commit()

        pending = client.get('/api/queue', headers=ALICE).json()['pending_reocr']

        assert pending['lines'] == 1
        assert pending['datasets'][0]['name'] == 'Volume I' 


class TestHowItIsProcessed:
    """Which text phases a dataset runs, and whether lines are looked for inside the layout
    boxes or across the whole page. Both were written once at creation, so a dataset could
    never be moved between the two afterwards. It applies from the next run onwards."""

    def test_the_line_mode_can_be_changed_after_the_dataset_exists(self, client, conn):
        body = patch(client, {'line_mode': 'per_page'}).json()

        assert body['line_mode'] == 'per_page'
        assert job(conn)['line_mode'] == 'per_page'

    def test_the_phases_can_be_switched_off_and_on(self, client, conn):
        patch(client, {'run_layout': False, 'run_lines': True, 'run_ocr': True})
        assert (job(conn)['run_layout'], job(conn)['run_lines'], job(conn)['run_ocr']) == (0, 1, 1)

        body = patch(client, {'run_layout': True}).json()

        assert (body['run_layout'], body['run_lines'], body['run_ocr']) == (True, True, True)

    def test_turning_line_detection_off_takes_ocr_with_it(self, client, conn):
        """OCR reads line crops, so a dataset asked for OCR without lines would queue a
        phase with nothing to read."""
        body = patch(client, {'run_lines': False}).json()

        assert (body['run_lines'], body['run_ocr']) == (False, False)
        assert job(conn)['run_ocr'] == 0

    def test_turning_layout_off_moves_line_detection_to_the_whole_page(self, client, conn):
        """Per-crop detection segments inside the layout boxes, and there will not be any."""
        body = patch(client, {'run_layout': False}).json()

        assert body['line_mode'] == 'per_page'
        assert job(conn)['line_mode'] == 'per_page'

    def test_per_crop_is_refused_while_layout_is_off_rather_than_stored(self, client, conn):
        patch(client, {'run_layout': False})

        assert patch(client, {'line_mode': 'per_crop'}).json()['line_mode'] == 'per_page'
        assert job(conn)['line_mode'] == 'per_page'

    def test_a_line_mode_that_is_not_one_is_refused(self, client, conn):
        response = patch(client, {'line_mode': 'per_column'})

        assert response.status_code == 400
        assert response.json()['detail'] == "line_mode must be one of ['per_crop', 'per_page']"
        assert job(conn)['line_mode'] == 'per_crop'

    def test_a_running_dataset_is_refused_so_the_phases_cannot_change_under_it(self, client, conn):
        conn.execute("UPDATE jobs SET status = 'running' WHERE id = 'j1'")
        conn.commit()

        response = patch(client, {'run_ocr': False})

        assert response.status_code == 409
        assert job(conn)['run_ocr'] == 1

    def test_a_tile_dataset_has_no_text_phases_to_set(self, client, conn):
        conn.execute("UPDATE jobs SET task = 'map_segmentation' WHERE id = 'j1'")
        conn.commit()

        response = patch(client, {'run_layout': True})

        assert response.status_code == 400
        assert response.json()['detail'] == 'a tile dataset runs no text phases'

    def test_leaving_them_alone_changes_nothing(self, client, conn):
        before = dict(job(conn))

        patch(client, {'checked': True})

        after = job(conn)
        assert (after['line_mode'], after['run_layout'], after['run_lines'], after['run_ocr']) == (
            before['line_mode'], before['run_layout'], before['run_lines'], before['run_ocr'])


class TestLettingTheRecognitionVote:
    """Who counts as a reader decides what settles, and so what a training run can be
    handed. Off by default - see app.consensus for why."""

    def test_it_starts_off(self, client, conn):
        assert job(conn)['llm_consensus_with_ocr'] == 0

    def test_the_owner_can_turn_it_on_and_off_again(self, client, conn):
        assert patch(client, {'llm_consensus_with_ocr': True}).json()['llm_consensus_with_ocr'] is True
        assert job(conn)['llm_consensus_with_ocr'] == 1

        assert patch(client, {'llm_consensus_with_ocr': False}).json()['llm_consensus_with_ocr'] is False
        assert job(conn)['llm_consensus_with_ocr'] == 0


class TestTheDiplomaticWording:
    """The wording a paid-for reading is asked with, and the slack its reference span is
    given. Both are working tools, so anyone the dataset is shared with sets them."""

    def test_the_owner_sets_the_wording_and_it_comes_back(self, client, conn):
        wording = 'Transcribe the leaf. An edited text of it: {{reference}}'
        assert patch(client, {'gt_prompt': wording}).json()['gt_prompt'] == wording
        assert conn.execute(
            "SELECT gt_prompt FROM jobs WHERE id = 'j1'").fetchone()['gt_prompt'] == wording

    def test_wording_asking_for_something_nothing_supplies_is_refused_by_name(self, client, conn):
        """A misspelled placeholder would otherwise reach the model as literal braces, on
        every page, and only be noticed once the answers came back wrong."""
        response = patch(client, {'gt_prompt': 'Read {{reference}} in the {{weather}}'})
        assert response.status_code == 400
        assert 'weather' in response.json()['detail']
        assert conn.execute(
            "SELECT gt_prompt FROM jobs WHERE id = 'j1'").fetchone()['gt_prompt'] == ''

    def test_wording_with_no_placeholder_at_all_is_allowed(self, client):
        """Nothing forces a dataset to use the span - a corpus can be uploaded for the
        cut alone, and read without it."""
        assert patch(client, {'gt_prompt': 'Just transcribe the page.'}).status_code == 200

    def test_wording_longer_than_the_ceiling_is_refused(self, client):
        assert patch(client, {'gt_prompt': 'x' * 8001}).status_code == 400

    @pytest.mark.parametrize('column', ['gt_prompt', 'llm_prompt'])
    def test_an_assignee_sets_either_wording(self, client, conn, column):
        response = patch(client, {column: 'Read {{reference}} as written'}, headers=BOB)

        assert response.status_code == 200, response.text
        assert job(conn)[column] == 'Read {{reference}} as written'

    @pytest.mark.parametrize('column', ['gt_prompt', 'llm_prompt'])
    def test_someone_it_is_not_shared_with_cannot_reach_either(self, client, conn, column):
        assert patch(client, {column: 'Read {{reference}}'}, headers=STRANGER).status_code == 404
        assert job(conn)[column] == ''

    def test_the_overlap_is_settable_across_its_whole_range(self, client, conn):
        assert patch(client, {'reference_overlap': 0}).json()['reference_overlap'] == 0
        assert patch(client, {'reference_overlap': 20}).json()['reference_overlap'] == 20
        assert conn.execute(
            "SELECT reference_overlap FROM jobs WHERE id = 'j1'").fetchone()[0] == 20

    def test_an_overlap_outside_that_range_is_refused(self, client, conn):
        assert patch(client, {'reference_overlap': -1}).status_code == 400
        assert patch(client, {'reference_overlap': 21}).status_code == 400
        assert conn.execute(
            "SELECT reference_overlap FROM jobs WHERE id = 'j1'").fetchone()[0] == 2

    def test_a_fresh_dataset_reports_the_shipped_defaults(self, client):
        settings = patch(client, {'checked': False}).json()
        assert settings['gt_prompt'] == ''
        assert settings['reference_overlap'] == 2


class TestTheTranscriptionConvention:
    def test_a_new_dataset_reads_normalized(self, client):
        assert client.get('/api/jobs/j1', headers=ALICE).json()['ocr_convention'] == {}

    def test_the_owner_sets_the_flags(self, client, conn):
        response = patch(client, {'ocr_convention': {'long_s': True, 'oblique_hyphen': False}})

        assert response.status_code == 200
        assert response.json()['ocr_convention'] == {'long_s': True, 'oblique_hyphen': False}
        assert client.get('/api/jobs/j1', headers=ALICE).json()['ocr_convention'] == {
            'long_s': True, 'oblique_hyphen': False}

    def test_an_assignee_leaves_the_convention_as_it_was(self, client, conn):
        """It decides what every unchecked line will read as, like the model choice."""
        assert patch(client, {'ocr_convention': {'long_s': True}}, headers=BOB).status_code == 403
        assert job(conn)['ocr_convention'] == '{}'

    @pytest.mark.parametrize('name', ['Long S', '', 'long-s'])
    def test_a_flag_name_no_model_could_have_is_refused(self, client, name):
        assert patch(client, {'ocr_convention': {name: True}}).status_code == 400

    def test_the_flags_honoured_by_the_last_read_are_reported(self, client, conn):
        store.note_convention_read(conn, 'j1', ['long_s'])

        assert client.get('/api/jobs/j1', headers=ALICE).json()['ocr_convention_read'] == ['long_s']
        assert client.get('/api/jobs/j2', headers=ALICE).json()['ocr_convention_read'] is None
