"""One set of settings applied to every dataset in a group. Each dataset is patched under
exactly the gates it carries on its own, so a bulk change can never grant what a single one
would refuse - it reports the refusal and changes the rest.
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
            (2, 'ocr', 'OCR v2', '/models/ocr.pt', 0);
        INSERT INTO groups (id, name, owner) VALUES (1, 'Schematismus', 'alice'),
                                                   (2, 'Cadastre', 'bob');
        INSERT INTO jobs (id, name, owner, status, task, group_id, line_mode, run_layout,
                          run_lines, run_ocr) VALUES
            ('j1', 'Volume I',   'alice', 'done',  'text', 1, 'per_crop', 1, 1, 1),
            ('j2', 'Volume II',  'alice', 'done',  'text', 1, 'per_crop', 1, 1, 1),
            ('j3', 'Volume III', 'alice', 'done',  'text', NULL, 'per_crop', 1, 1, 1),
            ('j4', 'Parcels',    'bob',   'done',  'text', 2, 'per_crop', 1, 1, 1);
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


def patch(client, body, headers=ALICE, group_id=1):
    return client.patch(f'/api/groups/{group_id}/jobs', json=body, headers=headers)


def jobs(conn, column: str) -> dict:
    return {r['id']: r[column] for r in conn.execute(f'SELECT id, {column} FROM jobs')}


class TestApplyingSettingsToAWholeGroup:
    def test_every_dataset_in_the_group_takes_the_new_model(self, client, conn):
        response = patch(client, {'model_ocr_id': 2})

        assert response.status_code == 200
        assert jobs(conn, 'model_ocr_id') == {'j1': 2, 'j2': 2, 'j3': None, 'j4': None}

    def test_the_answer_names_the_datasets_it_changed(self, client):
        response = patch(client, {'ocr_decode': 'greedy'})

        assert response.json() == {
            'changed': [{'id': 'j1', 'name': 'Volume I'}, {'id': 'j2', 'name': 'Volume II'}],
            'skipped': []}

    def test_processing_settings_reach_every_dataset_coherently(self, client, conn):
        """run_layout off forces per_page, the same invariant one dataset enforces."""
        response = patch(client, {'run_layout': False})

        assert response.status_code == 200
        assert jobs(conn, 'run_layout') == {'j1': 0, 'j2': 0, 'j3': 1, 'j4': 1}
        assert jobs(conn, 'line_mode') == {'j1': 'per_page', 'j2': 'per_page',
                                           'j3': 'per_crop', 'j4': 'per_crop'}

    def test_the_models_a_group_is_read_with(self, client, conn):
        conn.execute("INSERT INTO llm_connections (id, name, base_url, owner) "
                     "VALUES (1, 'openrouter', 'http://llm/v1', 'alice')")
        conn.execute("INSERT INTO llm_models (id, connection_id, model, label) "
                     "VALUES (5, 1, 'qwen3-vl', 'Qwen')")
        conn.commit()

        assert patch(client, {'llm_model_ids': [5]}).status_code == 200
        assert jobs(conn, 'llm_model_ids') == {'j1': '[5]', 'j2': '[5]', 'j3': '[]', 'j4': '[]'}


class TestWhatItRefuses:
    def test_a_name_belongs_to_one_dataset(self, client, conn):
        response = patch(client, {'name': 'Everything'})

        assert response.status_code == 400
        assert 'name' in response.json()['detail']
        assert jobs(conn, 'name')['j1'] == 'Volume I'

    def test_moving_a_group_into_itself_is_not_a_bulk_setting(self, client):
        assert patch(client, {'group_id': 2}).status_code == 400

    def test_an_empty_change_is_refused_rather_than_reported_as_done(self, client):
        assert patch(client, {}).status_code == 400

    def test_a_group_nobody_can_reach_stays_invisible(self, client):
        assert patch(client, {'ocr_decode': 'greedy'}, headers=STRANGER).status_code == 404

    def test_a_missing_group_is_a_404(self, client):
        assert patch(client, {'ocr_decode': 'greedy'}, group_id=99).status_code == 404


class TestWhenOneDatasetCannotTakeIt:
    def test_a_running_dataset_is_named_and_the_rest_still_change(self, client, conn):
        conn.execute("UPDATE jobs SET status = 'running' WHERE id = 'j1'")
        conn.commit()

        response = patch(client, {'run_ocr': False})

        assert response.status_code == 200
        assert response.json()['changed'] == [{'id': 'j2', 'name': 'Volume II'}]
        assert response.json()['skipped'] == [
            {'id': 'j1', 'name': 'Volume I', 'reason': 'the dataset is already queued or running'}]
        assert jobs(conn, 'run_ocr') == {'j1': 1, 'j2': 0, 'j3': 1, 'j4': 1}

    def test_a_refused_dataset_keeps_the_settings_it_had_before_the_refusal(self, client, conn):
        """checked comes before ocr_decode in the patch; a dataset refusing the second
        must not be left having taken the first."""
        conn.execute("UPDATE jobs SET owner = 'bob' WHERE id = 'j1'")
        conn.execute("INSERT INTO job_assignees (job_id, username) VALUES ('j1', 'alice')")
        conn.commit()

        response = patch(client, {'checked': True, 'ocr_decode': 'greedy'})

        assert response.json()['skipped'] == [
            {'id': 'j1', 'name': 'Volume I', 'reason': 'not permitted'}]
        assert jobs(conn, 'checked')['j1'] == 0
        assert jobs(conn, 'checked')['j2'] == 1

    def test_a_member_may_still_set_what_annotators_set(self, client, conn):
        """bob is assigned to j1 only, so that is the one dataset the group changes for him."""
        response = patch(client, {'line_width': 7}, headers=BOB)

        assert response.json()['changed'] == [{'id': 'j1', 'name': 'Volume I'}]
        assert jobs(conn, 'line_width')['j1'] == 7
        assert jobs(conn, 'line_width')['j2'] != 7

    def test_an_admin_reaches_every_dataset_in_the_group(self, client, conn):
        assert patch(client, {'gt_ordered': True}, headers=ADMIN).status_code == 200
        assert jobs(conn, 'gt_ordered') == {'j1': 1, 'j2': 1, 'j3': 0, 'j4': 0}
