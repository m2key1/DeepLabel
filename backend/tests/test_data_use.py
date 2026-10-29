"""What a dataset's owner allows its data to be used for, and the backend holding everyone
to it: training, scoring, LLM providers outside the house, and export by others - plus
the record of which models came from a dataset and which admins opened it."""
import io

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app import data_use, llm_gt, llm_ocr, remote_training, store, trainer
from app.deps import get_db
from app.main import app

SECRET = 'test-secret'
ALICE = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'alice', 'X-Auth-Role': 'member', 'X-Auth-Train-Local': '1'}
BOB = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'bob', 'X-Auth-Role': 'member', 'X-Auth-Train-Local': '1'}
ROOT = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'root', 'X-Auth-Role': 'admin'}
ALL_ON = {'training': True, 'test': True, 'external_llm': True, 'export': True}


@pytest.fixture
def conn(tmp_path, monkeypatch):
    monkeypatch.setattr('app.config.TRAININGS_DIR', tmp_path / 'trainings')
    monkeypatch.setattr('app.config.JOBS_DIR', tmp_path / 'jobs')
    monkeypatch.setattr('app.config.LLM_SECRET_KEY', 'passphrase-for-tests')
    monkeypatch.setattr('app.llm._fernet', None)
    connection = store.connect(tmp_path / 'app.db')
    connection.executescript("""
        INSERT INTO models (id, task, name, checkpoint) VALUES (1, 'ocr', 'Base OCR', '/models/base.pt');
        INSERT INTO jobs (id, name, owner, status) VALUES ('j1', 'Council minutes', 'alice', 'done'),
                                                         ('j2', 'Name register', 'alice', 'done');
        INSERT INTO job_assignees (job_id, username) VALUES ('j1', 'bob'), ('j2', 'bob');
        INSERT INTO pages (id, job_id, idx, filename, source_file, content_hash, status, is_test)
            VALUES (1, 'j1', 0, 'p1.png', '/p1.png', 'hash-1', 'done', 1),
                   (2, 'j2', 0, 'p2.png', '/p2.png', 'hash-2', 'done', 1);
        INSERT INTO elements (id, page_id, order_idx, class_name, bbox) VALUES (1, 1, 0, 'Paragraph', '[]'),
                                                                              (2, 2, 0, 'Paragraph', '[]');
        INSERT INTO lines (element_id, order_idx, polygon, text, checked) VALUES (1, 0, '[]', 'x', 1),
                                                                                (2, 0, '[]', 'y', 1);
        INSERT INTO llm_connections (id, owner, name, base_url, shared)
            VALUES (1, 'alice', 'Hosted provider', 'https://api.example/v1', 0),
                   (2, 'root', 'In-house vLLM', 'http://vllm:8000/v1', 1);
        INSERT INTO llm_models (id, connection_id, model, label, enabled)
            VALUES (1, 1, 'big-vl', 'Hosted reader', 1), (2, 2, 'qwen-vl', 'House reader', 1);
    """)
    connection.commit()
    yield connection
    connection.close()


@pytest.fixture
def client(conn, monkeypatch, training_backend):
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    app.dependency_overrides[get_db] = lambda: conn
    yield TestClient(app)
    app.dependency_overrides.clear()


def restrict(conn, job_id='j1', **uses):
    for use, on in uses.items():
        conn.execute(f'UPDATE jobs SET {store.DATA_USE_COLUMNS[use]} = ? WHERE id = ?', (int(on), job_id))
    conn.commit()


def png() -> bytes:
    out = io.BytesIO()
    Image.new('RGB', (20, 20), (255, 255, 255)).save(out, 'PNG')
    return out.getvalue()


class TestTheSwitches:
    def test_a_dataset_allows_everything_until_its_owner_says_otherwise(self, client):
        assert client.get('/api/jobs/j1', headers=ALICE).json()['data_use'] == ALL_ON

    def test_a_new_dataset_can_start_with_uses_switched_off(self, client, conn, monkeypatch):
        response = client.post('/api/jobs', headers=ALICE, data={
            'name': 'Private letters', 'run_layout': 'false', 'run_lines': 'false', 'run_ocr': 'false',
            'data_use': '{"training": false, "export": false}'}, files=[('files', ('a.png', png(), 'image/png'))])
        assert response.status_code == 200, response.text
        job = client.get(f'/api/jobs/{response.json()["job_id"]}', headers=ALICE).json()
        assert job['data_use'] == {**ALL_ON, 'training': False, 'export': False}

    def test_an_unknown_use_is_refused_with_the_ones_there_are(self, client):
        response = client.put('/api/jobs/j1/data-use', headers=ALICE, json={'printing': False})
        assert response.status_code == 400
        assert response.json()['detail'] == ('the data use is a map of training, test, external_llm, export '
                                             'to true or false')

    def test_the_owner_switches_a_use_off_and_the_change_is_logged(self, client, conn):
        response = client.put('/api/jobs/j1/data-use', headers=ALICE, json={'training': False, 'export': True})
        assert response.status_code == 200
        assert response.json()['data_use'] == {**ALL_ON, 'training': False}
        assert [tuple(r) for r in conn.execute('SELECT username, action, detail FROM job_log')] == [
            ('alice', 'data_use', '{"training": false}')]

    def test_someone_it_is_shared_with_cannot_change_or_read_them(self, client):
        assert client.put('/api/jobs/j1/data-use', headers=BOB, json={'training': True}).status_code == 403
        assert client.get('/api/jobs/j1/data-use', headers=BOB).status_code == 403


class TestTraining:
    def start(self, client, **overrides):
        body = {'task': 'ocr', 'name': 'A run', 'dataset_job_ids': ['j1'], **overrides}
        return client.post('/api/trainings', json=body, headers=BOB)

    def test_a_dataset_with_training_off_is_refused_as_training_material(self, client, conn):
        restrict(conn, training=False)
        response = self.start(client)
        assert response.status_code == 403
        assert response.json()['detail'] == ('"Council minutes" may not be used for training or validating a model '
                                             '- its owner has switched that off')

    def test_nor_as_a_validation_set(self, client, conn):
        restrict(conn, 'j2', training=False)
        response = self.start(client, split_strategy='holdout', valid_job_ids=['j2'])
        assert response.status_code == 403
        assert response.json()['detail'].startswith('"Name register" may not be used for training')

    def test_a_dataset_with_scoring_off_is_refused_as_a_test_set(self, client, conn):
        restrict(conn, 'j2', test=False)
        response = self.start(client, test_job_ids=['j2'])
        assert response.status_code == 403
        assert response.json()['detail'] == ('"Name register" may not be used for scoring models '
                                             '- its owner has switched that off')

    def test_a_run_queued_before_training_was_switched_off_stops_before_cutting_anything(self, conn):
        restrict(conn, training=False)
        training = {'id': 7, 'task': 'ocr', 'dataset_job_ids': '["j1"]', 'valid_job_ids': '[]'}
        with pytest.raises(remote_training.CannotTrain, match='"Council minutes" may not be used for training'):
            trainer.prepare_snapshot(conn, training)


class TestScoring:
    def test_an_evaluation_on_a_dataset_with_scoring_off_is_refused(self, client, conn):
        restrict(conn, test=False)
        response = client.post('/api/evaluations', headers=BOB, json={'model_id': 1, 'job_ids': ['j1']})
        assert response.status_code == 403
        assert response.json()['detail'].startswith('"Council minutes" may not be used for scoring models')


class TestLlmProviders:
    def test_a_dataset_kept_in_the_house_is_not_sent_to_an_external_provider(self, client, conn):
        restrict(conn, external_llm=False)
        response = client.post('/api/jobs/j1/llm/read', headers=ALICE, json={'model_ids': [1]})
        assert response.status_code == 403
        assert response.json()['detail'] == ('this dataset is kept from LLM providers outside the house, and '
                                             'Hosted reader is not on a connection an admin has marked self-hosted')
        assert conn.execute('SELECT COUNT(*) FROM llm_reads').fetchone()[0] == 0

    def test_a_self_hosted_connection_may_still_read_it(self, client, conn):
        restrict(conn, external_llm=False)
        conn.execute('UPDATE llm_connections SET self_hosted = 1 WHERE id = 2')
        conn.commit()
        response = client.post('/api/jobs/j1/llm/read', headers=ALICE, json={'model_ids': [2]})
        assert response.status_code == 200, response.text
        assert [tuple(r) for r in conn.execute('SELECT llm_model_id, status FROM llm_reads')] == [(2, 'pending')]

    def test_a_reading_queued_before_the_switch_is_not_sent(self, conn):
        conn.execute("INSERT INTO llm_reads (id, content_hash, llm_model_id, model, label, job_id, requested_by) "
                     "VALUES (1, 'hash-1', 1, 'big-vl', 'Hosted reader', 'j1', 'alice')")
        conn.execute("INSERT INTO gt_reads (id, page_id, job_id, llm_model_id, model, label, status, requested_by) "
                     "VALUES (1, 1, 'j1', 1, 'big-vl', 'Hosted reader', 'pending', 'alice')")
        restrict(conn, external_llm=False)
        for prepare, table in ((llm_ocr._prepare, 'llm_reads'), (llm_gt._prepare, 'gt_reads')):
            read = conn.execute(f'SELECT * FROM {table} WHERE id = 1').fetchone()
            assert prepare(conn, read)['error'].startswith('this dataset is kept from LLM providers outside the house')

    def test_only_an_admin_marks_a_connection_self_hosted_even_one_another_admin_published(self, client, conn):
        refused = client.patch('/api/llm/connections/1', headers=ALICE, json={'self_hosted': True})
        assert refused.json()['detail'] == 'only an admin can mark a connection self-hosted'
        conn.execute("UPDATE llm_connections SET owner = 'another-admin' WHERE id = 2")
        response = client.patch('/api/llm/connections/2', headers=ROOT, json={'self_hosted': True})
        assert response.json()['self_hosted'] is True
        assert conn.execute('SELECT self_hosted FROM llm_connections WHERE id = 2').fetchone()[0] == 1


class TestExport:
    def test_the_owner_may_always_export(self, client, conn):
        restrict(conn, export=False)
        assert client.get('/api/jobs/j1/export?format=txt', headers=ALICE).status_code == 200

    @pytest.mark.parametrize('who', [BOB, ROOT])
    def test_nobody_else_may_while_it_is_off_admins_included(self, client, conn, who):
        assert client.get('/api/jobs/j1/export?format=txt', headers=who).status_code == 200
        restrict(conn, export=False)
        response = client.get('/api/jobs/j1/export?format=txt', headers=who)
        assert response.status_code == 403
        assert response.json()['detail'] == 'the owner of this dataset keeps its exports to themselves'

    def test_viewing_the_dataset_is_not_exporting_it(self, client, conn):
        restrict(conn, export=False)
        assert client.get('/api/jobs/j1', headers=BOB).status_code == 200


class TestAdminVisits:
    def visits(self, conn):
        return [tuple(r) for r in conn.execute("SELECT job_id, username FROM job_log WHERE action = 'admin_visit'")]

    def test_an_admin_opening_a_restricted_dataset_is_recorded_once_per_visit(self, client, conn):
        restrict(conn, training=False)
        client.get('/api/jobs/j1', headers=ROOT)
        client.get('/api/jobs/j1', headers=ROOT)
        assert self.visits(conn) == [('j1', 'root')]
        conn.execute("UPDATE job_log SET created_at = datetime('now', '-31 minutes')")
        client.get('/api/jobs/j1', headers=ROOT)
        assert len(self.visits(conn)) == 2
        listed = client.get('/api/jobs/j1/data-use', headers=ALICE).json()['admin_visits']
        assert [v['username'] for v in listed] == ['root', 'root']

    def test_a_dataset_that_restricts_nothing_records_nothing(self, client, conn):
        client.get('/api/jobs/j2', headers=ROOT)
        restrict(conn, training=False)
        client.get('/api/jobs/j1', headers=ROOT)
        assert self.visits(conn) == [('j1', 'root')]

    def test_an_admin_it_is_shared_with_is_not_a_visitor(self, client, conn):
        restrict(conn, training=False)
        conn.execute("INSERT INTO job_assignees (job_id, username) VALUES ('j1', 'root')")
        client.get('/api/jobs/j1', headers=ROOT)
        client.get('/api/jobs/j1', headers=BOB)
        assert self.visits(conn) == []


class TestModelsMadeFromADataset:
    def test_a_registered_model_records_what_it_was_trained_validated_and_scored_on(self, conn):
        conn.execute("INSERT INTO models (id, task, name, checkpoint) VALUES (5, 'ocr', 'Minutes v2', '/m.pt')")
        training = {'dataset_job_ids': '["j1"]', 'valid_job_ids': '["j2"]', 'test_job_ids': '["j2"]'}
        store.record_model_datasets(conn, 5, training)
        assert [(m['name'], m['roles']) for m in data_use.models_made_from(conn, 'j2')] == [
            ('Minutes v2', ['valid', 'test'])]
        assert [(m['name'], m['roles']) for m in data_use.models_made_from(conn, 'j1')] == [('Minutes v2', ['train'])]

    def test_models_trained_before_the_record_existed_are_filled_in_from_their_trainings(self, tmp_path):
        path = tmp_path / 'old.db'
        conn = store.connect(path)
        conn.executescript("""
            INSERT INTO models (id, task, name, checkpoint) VALUES (5, 'ocr', 'Minutes v2', '/m.pt');
            INSERT INTO trainings (id, task, name, model_id, dataset_job_ids, valid_job_ids, test_job_ids)
                VALUES (3, 'ocr', 'Minutes v2', 5, '["j1"]', '[]', '["j2"]');
            DELETE FROM model_datasets;
            PRAGMA user_version = 5;
        """)
        conn.commit()
        conn.close()
        conn = store.connect(path)
        assert sorted(tuple(r) for r in conn.execute('SELECT model_id, job_id, role FROM model_datasets')) == [
            (5, 'j1', 'train'), (5, 'j2', 'test')]
        conn.close()

    def test_the_owner_sees_them_with_their_training(self, client, conn):
        conn.execute("INSERT INTO models (id, task, name, checkpoint) VALUES (5, 'ocr', 'Minutes v2', '/m.pt')")
        conn.execute("INSERT INTO trainings (id, task, name, model_id, dataset_job_ids) "
                     "VALUES (3, 'ocr', 'Minutes v2', 5, '[\"j1\"]')")
        store.record_model_datasets(conn, 5, conn.execute('SELECT * FROM trainings WHERE id = 3').fetchone())
        conn.commit()
        models = client.get('/api/jobs/j1/data-use', headers=ALICE).json()['models']
        assert [(m['name'], m['training_id'], m['roles']) for m in models] == [('Minutes v2', 3, ['train'])]
