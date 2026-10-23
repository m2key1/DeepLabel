"""LLM connections are personal: the key is encrypted at rest, never leaves the backend,
and a connection is invisible to everyone but its owner until an admin publishes it.
"""
import pytest
from fastapi.testclient import TestClient

from app import llm, llm_client, store
from app.deps import get_db
from app.main import app

SECRET = 'test-secret'
ADMIN = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'root', 'X-Auth-Role': 'admin'}
ALICE = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'alice', 'X-Auth-Role': 'member'}
BOB = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'bob', 'X-Auth-Role': 'member'}

KEY = 'sk-secret-value-7788'


@pytest.fixture
def conn(tmp_path):
    connection = store.connect(tmp_path / 'app.db')
    yield connection
    connection.close()


@pytest.fixture
def secret(monkeypatch):
    """A configured LLM_SECRET_KEY, with the derived box reset so each test builds its own."""
    monkeypatch.setattr('app.config.LLM_SECRET_KEY', 'passphrase-for-tests')
    monkeypatch.setattr('app.llm._fernet', None)
    yield
    monkeypatch.setattr('app.llm._fernet', None)


@pytest.fixture
def client(conn, monkeypatch, secret):
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    monkeypatch.setattr('app.config.ENABLE_LLM_OCR', True)
    app.dependency_overrides[get_db] = lambda: conn
    yield TestClient(app)
    app.dependency_overrides.clear()


def make_connection(client, headers=ALICE, name='Local vLLM', base_url='http://vllm:8000/v1', api_key=None):
    body = {'name': name, 'base_url': base_url}
    if api_key is not None:
        body['api_key'] = api_key
    response = client.post('/api/llm/connections', json=body, headers=headers)
    assert response.status_code == 201, response.text
    return response.json()


def test_api_key_is_encrypted_at_rest_and_never_returned(client, conn):
    created = make_connection(client, api_key=KEY)

    assert 'api_key' not in created
    assert created['has_key'] is True
    assert created['key_hint'] == '7788'

    stored = conn.execute('SELECT api_key FROM llm_connections WHERE id = ?',
                          (created['id'],)).fetchone()['api_key']
    assert stored != KEY
    assert KEY not in stored
    assert llm.decrypt_key(stored) == KEY

    listed = client.get('/api/llm/connections', headers=ALICE).json()['connections']
    assert [c['key_hint'] for c in listed] == ['7788']
    assert all('api_key' not in c for c in listed)


def test_credentials_hand_the_plaintext_key_to_a_read(client, conn):
    created = make_connection(client, api_key=KEY)
    model = client.post(f"/api/llm/connections/{created['id']}/models",
                        json={'model': 'gpt-4o', 'label': 'GPT-4o'}, headers=ALICE).json()

    resolved_model, connection, key = llm.credentials(conn, model['id'])

    assert resolved_model['model'] == 'gpt-4o'
    assert connection['base_url'] == 'http://vllm:8000/v1'
    assert key == KEY


def test_a_rotated_secret_key_reports_itself_instead_of_failing_at_the_provider(client, conn, monkeypatch):
    created = make_connection(client, api_key=KEY)
    model = client.post(f"/api/llm/connections/{created['id']}/models",
                        json={'model': 'gpt-4o'}, headers=ALICE).json()

    monkeypatch.setattr('app.config.LLM_SECRET_KEY', 'a-different-passphrase')
    monkeypatch.setattr('app.llm._fernet', None)

    with pytest.raises(llm.SecretUnavailable, match='LLM_SECRET_KEY has changed'):
        llm.credentials(conn, model['id'])


def test_a_keyless_endpoint_works_without_a_configured_secret(client, monkeypatch):
    monkeypatch.setattr('app.config.LLM_SECRET_KEY', '')
    monkeypatch.setattr('app.llm._fernet', None)

    keyless = make_connection(client, name='In-house', base_url='http://vllm:8000/v1')
    assert keyless['has_key'] is False

    refused = client.post('/api/llm/connections',
                          json={'name': 'Hosted', 'base_url': 'https://api.example.com/v1',
                                'api_key': KEY}, headers=ALICE)
    assert refused.status_code == 503
    assert 'LLM_SECRET_KEY is not set' in refused.json()['detail']
    assert client.get('/api/llm/connections', headers=ALICE).json()['secret_configured'] is False


def test_a_connection_is_private_until_an_admin_publishes_it(client):
    hers = make_connection(client, headers=ALICE, name='Alice private')

    assert client.get('/api/llm/connections', headers=BOB).json()['connections'] == []
    assert client.get(f"/api/llm/connections/{hers['id']}/probe", headers=BOB).status_code in (404, 405)

    # Alice may own it, but publishing is an admin's call.
    refused = client.patch(f"/api/llm/connections/{hers['id']}", json={'shared': True}, headers=ALICE)
    assert refused.status_code == 403

    published = make_connection(client, headers=ADMIN, name='House endpoint')
    client.patch(f"/api/llm/connections/{published['id']}", json={'shared': True}, headers=ADMIN)

    visible = client.get('/api/llm/connections', headers=BOB).json()['connections']
    assert [(c['name'], c['shared'], c['editable']) for c in visible] == [('House endpoint', True, False)]


def test_only_the_owner_may_change_or_delete_a_published_connection(client):
    published = make_connection(client, headers=ADMIN, name='House endpoint')
    client.patch(f"/api/llm/connections/{published['id']}", json={'shared': True}, headers=ADMIN)

    assert client.patch(f"/api/llm/connections/{published['id']}",
                        json={'name': 'Hijacked'}, headers=BOB).status_code == 403
    assert client.delete(f"/api/llm/connections/{published['id']}", headers=BOB).status_code == 403

    # An admin's private connection is not even visible to another member: 404, not 403.
    hidden = make_connection(client, headers=ADMIN, name='Admin private')
    assert client.patch(f"/api/llm/connections/{hidden['id']}",
                        json={'name': 'Hijacked'}, headers=BOB).status_code == 404


def test_base_urls_are_normalized_and_nonsense_is_refused(client):
    created = make_connection(client, base_url='https://api.example.com/v1/')
    assert created['base_url'] == 'https://api.example.com/v1'

    for bad in ('ftp://api.example.com', 'api.example.com/v1', ''):
        response = client.post('/api/llm/connections',
                               json={'name': f'Bad {bad}', 'base_url': bad}, headers=ALICE)
        assert response.status_code == 400, bad
        assert 'http://' in response.json()['detail']


def test_a_name_is_unique_per_person_not_per_instance(client):
    make_connection(client, headers=ALICE, name='OpenAI')
    assert client.post('/api/llm/connections',
                       json={'name': 'openai', 'base_url': 'https://api.example.com/v1'},
                       headers=ALICE).status_code == 409
    # Bob's own list is his business; the same name there is not a clash.
    assert client.post('/api/llm/connections',
                       json={'name': 'OpenAI', 'base_url': 'https://api.example.com/v1'},
                       headers=BOB).status_code == 201


def test_clearing_a_key_is_distinct_from_leaving_it_alone(client):
    created = make_connection(client, api_key=KEY)

    renamed = client.patch(f"/api/llm/connections/{created['id']}",
                           json={'name': 'Renamed'}, headers=ALICE).json()
    assert renamed['has_key'] is True and renamed['key_hint'] == '7788'

    cleared = client.patch(f"/api/llm/connections/{created['id']}",
                           json={'api_key': None}, headers=ALICE).json()
    assert cleared['has_key'] is False and cleared['key_hint'] == ''


def test_models_hang_off_a_connection_and_go_with_it(client, conn):
    created = make_connection(client, api_key=KEY)
    first = client.post(f"/api/llm/connections/{created['id']}/models",
                        json={'model': 'gpt-4o', 'label': 'GPT-4o'}, headers=ALICE).json()
    client.post(f"/api/llm/connections/{created['id']}/models",
                json={'model': 'gemini-2.5-pro', 'label': 'Gemini'}, headers=ALICE)

    listed = client.get('/api/llm/connections', headers=ALICE).json()['connections']
    assert [m['label'] for m in listed[0]['models']] == ['Gemini', 'GPT-4o']
    # No wording of its own, so it follows whoever runs it - which is what makes editing
    # a personal default reach every model rather than none of them.
    assert first['prompt'] == ''
    assert first['max_image_edge'] == 1600
    assert first['temperature'] == 0.0

    client.delete(f"/api/llm/connections/{created['id']}", headers=ALICE)
    assert conn.execute('SELECT COUNT(*) c FROM llm_models').fetchone()['c'] == 0


def test_usable_models_are_the_enabled_ones_the_caller_can_reach(client):
    hers = make_connection(client, headers=ALICE, name='Hers')
    client.post(f"/api/llm/connections/{hers['id']}/models",
                json={'model': 'gpt-4o', 'label': 'Hers enabled'}, headers=ALICE)
    disabled = client.post(f"/api/llm/connections/{hers['id']}/models",
                           json={'model': 'gpt-4o-mini', 'label': 'Hers disabled'},
                           headers=ALICE).json()
    client.patch(f"/api/llm/models/{disabled['id']}", json={'enabled': False}, headers=ALICE)

    his = make_connection(client, headers=BOB, name='His')
    client.post(f"/api/llm/connections/{his['id']}/models",
                json={'model': 'claude', 'label': 'His private'}, headers=BOB)

    house = make_connection(client, headers=ADMIN, name='House')
    client.patch(f"/api/llm/connections/{house['id']}", json={'shared': True}, headers=ADMIN)
    client.post(f"/api/llm/connections/{house['id']}/models",
                json={'model': 'qwen-vl', 'label': 'House model'}, headers=ADMIN)

    usable = client.get('/api/llm/models', headers=ALICE).json()['models']
    assert [m['label'] for m in usable] == ['Hers enabled', 'House model']


def test_model_fields_are_bounded(client):
    created = make_connection(client)
    too_small = client.post(f"/api/llm/connections/{created['id']}/models",
                            json={'model': 'gpt-4o', 'max_image_edge': 64}, headers=ALICE)
    assert too_small.status_code == 400
    too_big = client.post(f"/api/llm/connections/{created['id']}/models",
                          json={'model': 'gpt-4o', 'max_image_edge': 99_000}, headers=ALICE)
    assert too_big.status_code == 400
    ok = client.post(f"/api/llm/connections/{created['id']}/models",
                     json={'model': 'gpt-4o', 'max_image_edge': 2400}, headers=ALICE)
    assert ok.status_code == 201 and ok.json()['max_image_edge'] == 2400
    # A model with no label of its own is named after the model id.
    assert ok.json()['label'] == 'gpt-4o'


def test_a_deployment_with_the_feature_off_refuses_writes_but_still_explains_itself(client, monkeypatch):
    monkeypatch.setattr('app.config.ENABLE_LLM_OCR', False)

    refused = client.post('/api/llm/connections',
                          json={'name': 'Nope', 'base_url': 'https://api.example.com/v1'}, headers=ALICE)
    assert refused.status_code == 403
    assert 'disabled on this deployment' in refused.json()['detail']

    payload = client.get('/api/llm/connections', headers=ALICE).json()
    assert payload['enabled'] is False and payload['connections'] == []

class TestPersonalDefault:
    def test_a_model_with_no_wording_of_its_own_follows_the_person_running_it(self, client, conn):
        created = make_connection(client)
        model = client.post(f"/api/llm/connections/{created['id']}/models",
                            json={'model': 'gpt-4o'}, headers=ALICE).json()

        assert llm.effective_prompt(conn, model, 'alice').startswith('Transcribe every line')

        client.put('/api/llm/prompt', json={'prompt': 'Kurrent script. Verbatim.'}, headers=ALICE)
        assert llm.effective_prompt(conn, model, 'alice') == 'Kurrent script. Verbatim.'
        # Bob has his own default, and the same shared model reads by his for his runs.
        assert llm.effective_prompt(conn, model, 'bob').startswith('Transcribe every line')

    def test_wording_given_to_a_model_wins_over_the_personal_default(self, client, conn):
        created = make_connection(client)
        model = client.post(f"/api/llm/connections/{created['id']}/models",
                            json={'model': 'gpt-4o', 'prompt': 'This model needs telling twice.'},
                            headers=ALICE).json()
        client.put('/api/llm/prompt', json={'prompt': 'Kurrent script.'}, headers=ALICE)

        assert llm.effective_prompt(conn, model, 'alice') == 'This model needs telling twice.'

    def test_a_dataset_replaces_both(self, client, conn):
        created = make_connection(client)
        model = client.post(f"/api/llm/connections/{created['id']}/models",
                            json={'model': 'gpt-4o', 'prompt': 'Model wording'}, headers=ALICE).json()
        client.put('/api/llm/prompt', json={'prompt': 'Personal wording'}, headers=ALICE)

        assert llm.effective_prompt(conn, model, 'alice', 'Dataset wording') == 'Dataset wording'

    def test_clearing_a_personal_default_restores_the_shipped_one(self, client, conn):
        client.put('/api/llm/prompt', json={'prompt': 'Kurrent script.'}, headers=ALICE)
        body = client.put('/api/llm/prompt', json={'prompt': '   '}, headers=ALICE).json()

        assert body['prompt'] == ''
        assert body['default'].startswith('Transcribe every line')
        assert llm.effective_prompt(conn, {'prompt': ''}, 'alice') == llm.DEFAULT_PROMPT

    def test_a_persons_default_is_their_own(self, client):
        client.put('/api/llm/prompt', json={'prompt': 'Alice writes this'}, headers=ALICE)
        assert client.get('/api/llm/prompt', headers=BOB).json()['prompt'] == ''
        assert client.get('/api/llm/prompt', headers=ALICE).json()['prompt'] == 'Alice writes this'


class TestRequestOptions:
    """A reasoning model answers with its working and no transcription unless told not to,
    and which switch does that is the provider's business, not this client's.
    """

    def test_extra_fields_are_stored_and_handed_to_the_call(self, client, conn):
        created = make_connection(client)
        model = client.post(f"/api/llm/connections/{created['id']}/models",
                            json={'model': 'qwen3.5', 'max_tokens': 4096,
                                  'extra_body': '{"chat_template_kwargs": {"enable_thinking": false}}'},
                            headers=ALICE).json()

        assert model['max_tokens'] == 4096
        assert llm.extra_body(llm.get_model(conn, model['id'])) == {
            'chat_template_kwargs': {'enable_thinking': False}}

    def test_a_model_without_them_sends_nothing_extra(self, client, conn):
        created = make_connection(client)
        model = client.post(f"/api/llm/connections/{created['id']}/models",
                            json={'model': 'gpt-4o'}, headers=ALICE).json()

        assert model['max_tokens'] is None
        assert llm.extra_body(llm.get_model(conn, model['id'])) == {}

    def test_nonsense_is_refused_when_it_is_typed_rather_than_at_the_provider(self, client):
        created = make_connection(client)
        for bad, expected in [('not json at all', 'must be JSON'),
                              ('[1, 2, 3]', 'must be a JSON object'),
                              ('"a string"', 'must be a JSON object')]:
            response = client.post(f"/api/llm/connections/{created['id']}/models",
                                   json={'model': 'gpt-4o', 'extra_body': bad}, headers=ALICE)
            assert response.status_code == 400, bad
            assert expected in response.json()['detail']

    def test_a_token_ceiling_outside_reason_is_refused(self, client):
        created = make_connection(client)
        for bad in (0, -1, 500_000):
            assert client.post(f"/api/llm/connections/{created['id']}/models",
                               json={'model': 'gpt-4o', 'max_tokens': bad},
                               headers=ALICE).status_code == 400

    def test_extra_fields_cannot_displace_what_the_call_is_about(self):
        """A stored switch is the provider's to interpret - the image, the prompt and the
        model it is sent to are not."""
        body = llm_client._merged(
            {'model': 'chosen', 'messages': ['the page'], 'temperature': 0},
            {'model': 'something-else', 'messages': [], 'stream': True, 'top_p': 0.8})

        assert body['model'] == 'chosen'
        assert body['messages'] == ['the page']
        assert 'stream' not in body
        assert body['top_p'] == 0.8

    def test_a_reasoning_only_answer_says_what_to_do_about_it(self):
        with pytest.raises(llm_client.LlmError, match='enable_thinking'):
            llm_client._content({'choices': [{'finish_reason': 'length', 'message': {
                'content': None, 'reasoning': 'Thinking Process: 1.'}}]})

    def test_an_answer_cut_off_before_any_text_says_so(self):
        with pytest.raises(llm_client.LlmError, match='cut off at the token ceiling'):
            llm_client._content({'choices': [{'finish_reason': 'length',
                                              'message': {'content': ''}}]})
