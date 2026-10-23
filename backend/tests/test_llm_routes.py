"""The language-model registry over the wire: retuning a model, probing an endpoint, and
the four calls a dataset's reading is driven by.

Money is the theme. A read costs the person who asked for it, so what a preview promises,
what a refresh re-bills and what a cancel does to work already in flight are the things
worth pinning down.
"""
import json

import pytest
from fastapi.testclient import TestClient

from app import candidates, llm, llm_client, store
from app.deps import get_db
from app.main import app

SECRET = 'test-secret'
ADMIN = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'root', 'X-Auth-Role': 'admin'}
ALICE = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'alice', 'X-Auth-Role': 'member'}
BOB = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'bob', 'X-Auth-Role': 'member'}


@pytest.fixture
def secret(monkeypatch):
    monkeypatch.setattr('app.config.LLM_SECRET_KEY', 'passphrase-for-tests')
    monkeypatch.setattr('app.llm._fernet', None)
    yield
    monkeypatch.setattr('app.llm._fernet', None)


@pytest.fixture
def conn(tmp_path, secret):
    connection = store.connect(tmp_path / 'app.db')
    connection.executescript("""
        INSERT INTO jobs (id, name, owner, status) VALUES ('j1', 'Volume', 'alice', 'done');
        INSERT INTO pages (id, job_id, idx, filename, source_file, content_hash, status)
            VALUES (1, 'j1', 0, 'p1.png', '/p1.png', 'hash-of-p1', 'done');
        INSERT INTO llm_connections (id, owner, name, base_url)
            VALUES (1, 'alice', 'Local vLLM', 'http://vllm:8000/v1');
        INSERT INTO llm_models (id, connection_id, model, label, enabled)
            VALUES (1, 1, 'qwen-vl', 'Careful reader', 1);
    """)
    connection.commit()
    yield connection
    connection.close()


@pytest.fixture
def client(conn, monkeypatch):
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    monkeypatch.setattr('app.config.ENABLE_LLM_OCR', True)
    app.dependency_overrides[get_db] = lambda: conn
    yield TestClient(app)
    app.dependency_overrides.clear()


def model(conn, model_id=1):
    return conn.execute('SELECT * FROM llm_models WHERE id = ?', (model_id,)).fetchone()


class TestRetuningAModel:
    def test_its_label_and_provider_id_can_be_changed(self, client, conn):
        response = client.patch('/api/llm/models/1',
                                json={'model': 'qwen-vl-72b', 'label': 'Careful reader v2'},
                                headers=ALICE)

        assert response.status_code == 200, response.text
        assert (model(conn)['model'], model(conn)['label']) == ('qwen-vl-72b', 'Careful reader v2')

    def test_a_provider_id_of_nothing_is_refused(self, client):
        assert client.patch('/api/llm/models/1', json={'model': '  '},
                            headers=ALICE).status_code == 400

    def test_it_can_be_given_wording_of_its_own(self, client, conn):
        client.patch('/api/llm/models/1', json={'prompt': '  Kurrent, 1750s.  '}, headers=ALICE)

        assert model(conn)['prompt'] == 'Kurrent, 1750s.'

    def test_the_image_it_is_sent_can_be_capped(self, client, conn):
        assert client.patch('/api/llm/models/1', json={'max_image_edge': 1200},
                            headers=ALICE).status_code == 200
        assert model(conn)['max_image_edge'] == 1200

    def test_an_image_size_outside_what_is_sensible_is_refused(self, client):
        assert client.patch('/api/llm/models/1', json={'max_image_edge': 10},
                            headers=ALICE).status_code == 400

    def test_a_token_ceiling_can_be_set_and_cleared(self, client, conn):
        client.patch('/api/llm/models/1', json={'max_tokens': 4096}, headers=ALICE)
        assert model(conn)['max_tokens'] == 4096

        client.patch('/api/llm/models/1', json={'max_tokens': None}, headers=ALICE)
        assert model(conn)['max_tokens'] is None, 'the endpoint decides again'

    def test_extra_request_fields_are_stored_as_given(self, client, conn):
        """Kept as the JSON text it was typed as, so what the endpoint receives is what
        the person wrote rather than a re-serialised guess at it."""
        response = client.patch(
            '/api/llm/models/1',
            json={'extra_body': '{"chat_template_kwargs": {"enable_thinking": false}}'},
            headers=ALICE)

        assert response.status_code == 200, response.text
        assert 'enable_thinking' in model(conn)['extra_body']

    def test_extra_fields_are_not_where_the_page_is_protected(self, client, conn):
        """Storing 'messages' is allowed and harmless: the guard is at the point of use,
        where llm_client refuses to let merged fields replace the page being sent."""
        response = client.patch('/api/llm/models/1', json={'extra_body': '{"messages": []}'},
                                headers=ALICE)

        assert response.status_code == 200
        assert 'messages' in model(conn)['extra_body']

    def test_extra_fields_that_are_not_json_are_refused(self, client):
        assert client.patch('/api/llm/models/1', json={'extra_body': 'not json'},
                            headers=ALICE).status_code == 400

    def test_it_can_be_taken_out_of_the_picker_without_deleting_it(self, client, conn):
        client.patch('/api/llm/models/1', json={'enabled': False}, headers=ALICE)

        assert model(conn)['enabled'] == 0

    def test_removing_it_leaves_the_connection(self, client, conn):
        assert client.delete('/api/llm/models/1', headers=ALICE).status_code == 200

        assert model(conn) is None
        assert conn.execute('SELECT COUNT(*) c FROM llm_connections').fetchone()['c'] == 1

    def test_somebody_elses_model_is_not_theirs_to_touch(self, client):
        assert client.patch('/api/llm/models/1', json={'label': 'Mine now'},
                            headers=BOB).status_code == 404
        assert client.delete('/api/llm/models/1', headers=BOB).status_code == 404

    def test_a_model_that_does_not_exist_is_a_404(self, client):
        assert client.patch('/api/llm/models/99', json={'label': 'Ghost'},
                            headers=ALICE).status_code == 404
        assert client.delete('/api/llm/models/99', headers=ALICE).status_code == 404


class TestProbingAnEndpoint:
    def test_a_reachable_endpoint_answers_with_what_it_offers(self, client, monkeypatch):
        monkeypatch.setattr(llm_client, 'list_models', lambda base_url, key: ['qwen-vl', 'gemma'])

        response = client.post('/api/llm/connections/1/probe', headers=ALICE)

        assert response.status_code == 200
        assert response.json()['models'] == ['qwen-vl', 'gemma']

    def test_an_endpoint_that_will_not_answer_is_reported_as_the_endpoints_fault(
            self, client, monkeypatch):
        def refuse(base_url, key):
            raise llm_client.LlmError('connection refused')

        monkeypatch.setattr(llm_client, 'list_models', refuse)

        response = client.post('/api/llm/connections/1/probe', headers=ALICE)

        assert response.status_code == 502
        assert 'connection refused' in response.json()['detail']

    def test_a_key_that_cannot_be_read_back_is_a_deployment_problem(self, client, conn,
                                                                    monkeypatch):
        """No LLM_SECRET_KEY means the stored key cannot be decrypted - the operator's
        problem, not the caller's, and not the endpoint's."""
        conn.execute("UPDATE llm_connections SET api_key = 'gAAAAAB-unreadable' WHERE id = 1")
        conn.commit()
        monkeypatch.setattr('app.config.LLM_SECRET_KEY', '')
        monkeypatch.setattr('app.llm._fernet', None)

        assert client.post('/api/llm/connections/1/probe', headers=ALICE).status_code == 503

    def test_somebody_elses_connection_is_not_theirs_to_probe(self, client):
        assert client.post('/api/llm/connections/1/probe', headers=BOB).status_code == 404


class TestDrivingAReading:
    def test_the_preview_says_what_it_would_cost(self, client):
        response = client.get('/api/jobs/j1/llm/preview', params={'model_ids': [1]},
                              headers=ALICE)

        assert response.status_code == 200
        assert response.json()['calls'] == 1

    def test_the_preview_of_a_dataset_that_does_not_exist_is_a_404(self, client):
        assert client.get('/api/jobs/nope/llm/preview', headers=ADMIN).status_code == 404

    def test_reading_with_no_model_chosen_is_refused(self, client):
        response = client.post('/api/jobs/j1/llm/read', json={'model_ids': []}, headers=ALICE)

        assert response.status_code == 400
        assert 'at least one model' in response.json()['detail']

    def test_reading_with_a_model_they_cannot_use_is_refused(self, client, conn):
        conn.execute("INSERT INTO llm_connections (id, owner, name, base_url) "
                     "VALUES (2, 'bob', 'His own', 'http://his:8000/v1')")
        conn.execute("INSERT INTO llm_models (id, connection_id, model, label) "
                     "VALUES (2, 2, 'his-model', 'His reader')")
        conn.commit()

        response = client.post('/api/jobs/j1/llm/read', json={'model_ids': [2]}, headers=ALICE)

        assert response.status_code == 400
        assert 'available to you' in response.json()['detail']

    def test_queueing_says_how_much_was_queued_and_how_much_was_free(self, client):
        response = client.post('/api/jobs/j1/llm/read', json={'model_ids': [1]}, headers=ALICE)

        assert response.status_code == 200, response.text
        assert response.json()['queued'] == 1

    def test_the_models_a_dataset_reads_with_are_settable_without_reading(self, client, conn):
        """Otherwise starting a run is the only thing that writes them, which is no way to
        say which models a dataset uses - and the page viewer's one-page read needs them
        before it can offer anything."""
        response = client.patch('/api/jobs/j1', json={'llm_model_ids': [1]}, headers=ALICE)

        assert response.status_code == 200, response.text
        assert json.loads(conn.execute("SELECT llm_model_ids FROM jobs WHERE id = 'j1'")
                          .fetchone()['llm_model_ids']) == [1]
        assert conn.execute('SELECT COUNT(*) c FROM llm_reads').fetchone()['c'] == 0, \
            'saying which models is not asking them to read'

    def test_a_model_they_cannot_use_is_not_theirs_to_pin(self, client, conn):
        conn.execute("INSERT INTO llm_connections (id, owner, name, base_url) "
                     "VALUES (2, 'bob', 'His own', 'http://his:8000/v1')")
        conn.execute("INSERT INTO llm_models (id, connection_id, model, label) "
                     "VALUES (2, 2, 'his-model', 'His reader')")
        conn.commit()

        response = client.patch('/api/jobs/j1', json={'llm_model_ids': [2]}, headers=ALICE)

        assert response.status_code == 400
        assert 'not a model you can read with' in response.json()['detail']
        assert json.loads(conn.execute("SELECT llm_model_ids FROM jobs WHERE id = 'j1'")
                          .fetchone()['llm_model_ids'] or '[]') == [], 'a refused pin changes nothing'

    def test_the_list_can_be_emptied(self, client, conn):
        client.patch('/api/jobs/j1', json={'llm_model_ids': [1]}, headers=ALICE)

        client.patch('/api/jobs/j1', json={'llm_model_ids': []}, headers=ALICE)

        assert json.loads(conn.execute("SELECT llm_model_ids FROM jobs WHERE id = 'j1'")
                          .fetchone()['llm_model_ids']) == []

    def test_a_selection_is_priced_and_read_as_a_selection(self, client, conn):
        conn.execute("INSERT INTO pages (id, job_id, idx, filename, source_file, content_hash, "
                     "status) VALUES (2, 'j1', 1, 'p2.png', '/p2.png', 'hash-of-p2', 'done')")
        conn.commit()

        whole = client.get('/api/jobs/j1/llm/preview?model_ids=1', headers=ALICE).json()
        one = client.get('/api/jobs/j1/llm/preview?model_ids=1&page_ids=2', headers=ALICE).json()
        assert (whole['pages'], whole['calls']) == (2, 2)
        assert (one['pages'], one['calls']) == (1, 1)

        response = client.post('/api/jobs/j1/llm/read', json={'model_ids': [1], 'page_ids': [2]},
                               headers=ALICE)

        assert response.status_code == 200, response.text
        assert response.json()['queued'] == 1
        queued = conn.execute('SELECT content_hash FROM llm_reads').fetchall()
        assert [r['content_hash'] for r in queued] == ['hash-of-p2']

    def test_a_page_of_another_dataset_is_refused_rather_than_ignored(self, client, conn):
        conn.execute("INSERT INTO jobs (id, name, owner, status) VALUES ('j2', 'Other', 'alice', 'done')")
        conn.execute("INSERT INTO pages (id, job_id, idx, filename, source_file, content_hash, "
                     "status) VALUES (9, 'j2', 0, 'x.png', '/x.png', 'hash-of-x', 'done')")
        conn.commit()

        response = client.post('/api/jobs/j1/llm/read', json={'model_ids': [1], 'page_ids': [9]},
                               headers=ALICE)

        assert response.status_code == 404
        assert 'no such page in this dataset' in response.json()['detail']
        assert conn.execute('SELECT COUNT(*) c FROM llm_reads').fetchone()['c'] == 0

    def test_a_preview_of_a_page_from_elsewhere_is_refused_too(self, client, conn):
        conn.execute("INSERT INTO jobs (id, name, owner, status) VALUES ('j2', 'Other', 'alice', 'done')")
        conn.execute("INSERT INTO pages (id, job_id, idx, filename, source_file, content_hash, "
                     "status) VALUES (9, 'j2', 0, 'x.png', '/x.png', 'hash-of-x', 'done')")
        conn.commit()

        response = client.get('/api/jobs/j1/llm/preview?model_ids=1&page_ids=9', headers=ALICE)

        assert response.status_code == 404

    def test_the_status_reports_per_model_progress(self, client):
        client.post('/api/jobs/j1/llm/read', json={'model_ids': [1]}, headers=ALICE)

        status = client.get('/api/jobs/j1/llm/status', headers=ALICE).json()

        assert status['pending'] == 1
        assert status['models'][0]['label'] == 'Careful reader'

    def test_the_status_of_one_page_is_about_that_page(self, client, conn):
        """What a view of a single page asks: a run working through the rest of the
        dataset is not this page being read."""
        conn.execute("INSERT INTO pages (id, job_id, idx, filename, source_file, "
                     "content_hash, status) VALUES (2, 'j1', 1, 'p2.png', '/p2.png', "
                     "'hash-of-p2', 'done')")
        conn.commit()
        client.post('/api/jobs/j1/llm/read', json={'model_ids': [1], 'page_ids': [1]},
                    headers=ALICE)

        def counts(query=''):
            body = client.get(f'/api/jobs/j1/llm/status{query}', headers=ALICE).json()
            return body['pages'], body['pending'], body['active']

        assert counts() == (2, 1, True)
        assert counts('?page_ids=1') == (1, 1, True)
        assert counts('?page_ids=2') == (1, 0, False)

    def test_the_status_of_a_page_from_another_dataset_is_refused(self, client, conn):
        conn.execute("INSERT INTO jobs (id, name, owner, status) VALUES ('j2', 'Other', 'alice', 'done')")
        conn.execute("INSERT INTO pages (id, job_id, idx, filename, source_file, content_hash, "
                     "status) VALUES (9, 'j2', 0, 'x.png', '/x.png', 'hash-of-x', 'done')")
        conn.commit()

        assert client.get('/api/jobs/j1/llm/status?page_ids=9', headers=ALICE).status_code == 404

    def test_cancelling_drops_what_has_not_been_sent(self, client, conn):
        client.post('/api/jobs/j1/llm/read', json={'model_ids': [1]}, headers=ALICE)

        response = client.post('/api/jobs/j1/llm/cancel', headers=ALICE)

        assert response.json()['cancelled'] == 1
        assert client.get('/api/jobs/j1/llm/status', headers=ALICE).json()['pending'] == 0

    def test_a_reading_already_in_flight_is_left_to_finish(self, client, conn):
        """It is paid for the moment it is sent, so cancelling it would throw money away."""
        client.post('/api/jobs/j1/llm/read', json={'model_ids': [1]}, headers=ALICE)
        conn.execute("UPDATE llm_reads SET status = 'running'")
        conn.commit()

        assert client.post('/api/jobs/j1/llm/cancel', headers=ALICE).json()['cancelled'] == 0
        assert conn.execute('SELECT status FROM llm_reads').fetchone()[0] == 'running'

    def test_a_pages_chip_drops_its_reading_in_flight_too(self, client, conn):
        client.post('/api/jobs/j1/llm/read', json={'model_ids': [1]}, headers=ALICE)
        conn.execute("UPDATE llm_reads SET status = 'running'")
        conn.commit()

        response = client.post('/api/jobs/j1/llm/cancel', json={'page_ids': [1], 'in_flight': True}, headers=ALICE)

        assert response.json()['cancelled'] == 1
        assert conn.execute('SELECT COUNT(*) FROM llm_reads').fetchone()[0] == 0

    def test_a_dataset_owner_removes_its_readings_and_sees_them_counted_first(self, client, conn):
        conn.execute("INSERT INTO llm_reads (content_hash, llm_model_id, label, status, raw_text, job_id) "
                     "VALUES ('hash-of-p1', 1, 'Careful reader', 'done', '[\"Anno\"]', 'j1')")
        conn.commit()

        listed = client.get('/api/jobs/j1/llm/readings', headers=ALICE).json()['models']
        assert listed == [{'id': 1, 'label': 'Careful reader', 'readings': 1, 'other_datasets': 0}]
        assert client.delete('/api/jobs/j1/llm/readings?model_id=1', headers=ALICE).json() == {'readings': 1}
        assert client.get('/api/jobs/j1/llm/readings', headers=ALICE).json()['models'] == []

    def test_only_a_language_models_reading_can_be_removed_from_a_line(self, client, conn):
        conn.execute("INSERT INTO candidates (id, page_id, source, text) VALUES (5, 1, 'ocr', 'Anno')")
        conn.commit()
        response = client.delete('/api/candidates/5', headers=ALICE)
        assert (response.status_code, response.json()['detail']) == (409, "only a language model's reading can be removed")

    def test_a_stranger_is_not_told_the_dataset_exists(self, client):
        assert client.get('/api/jobs/j1/llm/readings', headers=BOB).status_code == 404
        assert client.delete('/api/jobs/j1/llm/readings', headers=BOB).status_code == 404
        assert client.get('/api/jobs/j1/llm/status', headers=BOB).status_code == 404
        assert client.post('/api/jobs/j1/llm/read', json={'model_ids': [1]},
                           headers=BOB).status_code == 404


class TestADeploymentWithTheFeatureOff:
    @pytest.fixture
    def off(self, client, monkeypatch):
        """After the client fixture, which switches the feature on for everything else."""
        monkeypatch.setattr('app.config.ENABLE_LLM_OCR', False)
        return client

    def test_nothing_can_be_read_or_retuned(self, off, client):
        assert client.post('/api/jobs/j1/llm/read', json={'model_ids': [1]},
                           headers=ALICE).status_code == 403
        assert client.post('/api/jobs/j1/llm/settle', headers=ALICE).status_code == 403
        assert client.patch('/api/llm/models/1', json={'label': 'x'},
                            headers=ALICE).status_code == 403
        assert client.post('/api/llm/connections/1/probe', headers=ALICE).status_code == 403

    def test_but_the_page_can_still_explain_itself(self, off, client):
        assert client.get('/api/llm/connections', headers=ALICE).status_code == 200
        assert client.get('/api/llm/models', headers=ALICE).status_code == 200
        assert client.get('/api/jobs/j1/llm/status', headers=ALICE).status_code == 200


class TestSettlingAgain:
    """Agreement settings save as they are; applying them to lines already read is the
    owner's explicit step, priced in lines first and paid for with no model call."""

    @pytest.fixture
    def readings(self, conn):
        """Two models reading the one line alike, on a dataset that asks for three."""
        conn.executescript("""
            UPDATE jobs SET llm_consensus_min = 3;
            INSERT INTO elements (id, page_id, order_idx, class_name, bbox, kind)
                VALUES (1, 1, 0, 'Paragraph', '[0,0,1,1]', 'content');
            INSERT INTO lines (id, element_id, order_idx, polygon, text)
                VALUES (1, 1, 0, '[[0.1,0.2],[0.9,0.2],[0.9,0.3],[0.1,0.3]]', 'Joh. Bapt. Mayr, Coop.');
        """)
        for model_id, author in ((1, 'llm:Careful reader'), (2, 'llm:Second reader')):
            candidates.add(conn, 1, author, 'Joh. Bapt. Mayr, Cooperator', line_id=1,
                           llm_model_id=model_id)
        conn.commit()

    def line(self, conn):
        return conn.execute('SELECT * FROM lines WHERE id = 1').fetchone()

    def test_the_count_follows_the_settings_and_saving_them_settles_nothing(self, client, conn, readings):
        assert client.get('/api/jobs/j1/llm/settle', headers=ALICE).json() == \
            {'lines': 0, 'fill': 0, 'clear': 0}

        assert client.patch('/api/jobs/j1', json={'llm_consensus_min': 2},
                            headers=ALICE).status_code == 200, 'settings save'
        assert client.get('/api/jobs/j1/llm/settle', headers=ALICE).json() == \
            {'lines': 1, 'fill': 1, 'clear': 0}
        assert self.line(conn)['corrected_text'] is None

    def test_settling_again_fills_from_the_readings_on_file_and_asks_no_model(
            self, client, conn, readings, monkeypatch):
        def no_call(*args, **kwargs):
            raise AssertionError('settling again must not ask a model')
        monkeypatch.setattr(llm_client, '_ask', no_call)
        client.patch('/api/jobs/j1', json={'llm_consensus_min': 2}, headers=ALICE)

        response = client.post('/api/jobs/j1/llm/settle', headers=ALICE)

        assert response.status_code == 200, response.text
        assert response.json() == {'agreed': 1, 'filled': 1, 'cleared': 0, 'checked': 0}
        assert (self.line(conn)['corrected_text'], self.line(conn)['corrected_by']) == \
            ('Joh. Bapt. Mayr, Cooperator', 'llm:consensus@2')
        assert client.get('/api/jobs/j1/llm/status', headers=ALICE).json()['pending'] == 0

    def test_it_is_the_owners_call_like_the_settings_it_applies(self, client, conn, readings):
        conn.execute("INSERT INTO job_assignees (job_id, username) VALUES ('j1', 'bob')")
        conn.commit()

        assert client.get('/api/jobs/j1/llm/settle', headers=BOB).status_code == 403
        assert client.post('/api/jobs/j1/llm/settle', headers=BOB).status_code == 403
        assert client.post('/api/jobs/j1/llm/settle', headers=ADMIN).status_code == 200

    def test_a_stranger_is_not_told_the_dataset_exists(self, client, readings):
        assert client.get('/api/jobs/j1/llm/settle', headers=BOB).status_code == 404
        assert client.post('/api/jobs/j1/llm/settle', headers=BOB).status_code == 404
        assert client.get('/api/jobs/nope/llm/settle', headers=ADMIN).status_code == 404
