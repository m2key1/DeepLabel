"""The request one reading makes. What a provider is sent decides what it can answer, so
the shape is asserted here rather than inferred from what came back: the wording first,
then whatever the model is being shown, and the page it must transcribe last.
"""
import json

import httpx
import pytest

from app import llm_client

PAGE = b'the page as jpeg'
CHART = b'a chart of glyphs'
ALPHABET = b'a specimen alphabet'


class Response:
    def __init__(self, payload, status=200):
        self._payload = payload
        self.status_code = status

    @property
    def text(self):
        return json.dumps(self._payload)

    def raise_for_status(self):
        if self.status_code >= 400:
            raise httpx.HTTPStatusError('refused', request=None, response=self)

    def json(self):
        return self._payload


@pytest.fixture
def sent(monkeypatch):
    """Captures the body of the one call, and answers with a plain transcription."""
    captured = {}

    def post(url, json=None, headers=None, timeout=None):
        captured['url'] = url
        captured['body'] = json
        captured['headers'] = headers
        return Response({'choices': [{'message': {'content': 'A line'}}], 'usage': {}})

    monkeypatch.setattr('app.llm_client.httpx.post', post)
    return captured


def content(sent) -> list:
    return sent['body']['messages'][0]['content']


def kinds(sent) -> list:
    return [part['type'] for part in content(sent)]


def images(sent) -> list:
    return [part['image_url']['url'] for part in content(sent) if part['type'] == 'image_url']


class TestWithNothingToShow:
    def test_the_wording_comes_first_and_the_page_last(self, sent):
        llm_client.transcribe('http://llm/v1', None, 'a-model', 'Transcribe.', PAGE)

        assert kinds(sent) == ['text', 'image_url']
        assert content(sent)[0]['text'] == 'Transcribe.'
        assert images(sent) == ['data:image/jpeg;base64,dGhlIHBhZ2UgYXMganBlZw==']

    def test_it_asks_the_endpoint_for_a_completion(self, sent):
        llm_client.transcribe('http://llm/v1', None, 'a-model', 'Transcribe.', PAGE)

        assert sent['url'] == 'http://llm/v1/chat/completions'
        assert sent['body']['model'] == 'a-model'


class TestWithSomethingToShow:
    """A chart of the glyphs a corpus prints, shown before the page. The prompt can only
    say 'the first image is a reference chart' if that is genuinely where it lands."""

    def test_references_sit_between_the_wording_and_the_page(self, sent):
        llm_client.transcribe('http://llm/v1', None, 'a-model', 'Transcribe.', PAGE,
                              references=[('image/png', CHART)])

        assert kinds(sent) == ['text', 'image_url', 'image_url']
        assert images(sent) == ['data:image/png;base64,YSBjaGFydCBvZiBnbHlwaHM=',
                                'data:image/jpeg;base64,dGhlIHBhZ2UgYXMganBlZw==']

    def test_several_are_sent_in_the_order_given(self, sent):
        llm_client.transcribe('http://llm/v1', None, 'a-model', 'Transcribe.', PAGE,
                              references=[('image/png', CHART), ('image/webp', ALPHABET)])

        assert images(sent)[:2] == ['data:image/png;base64,YSBjaGFydCBvZiBnbHlwaHM=',
                                    'data:image/webp;base64,YSBzcGVjaW1lbiBhbHBoYWJldA==']
        assert len(images(sent)) == 3, 'the page is still the last of them'

    def test_each_keeps_its_own_type(self, sent):
        """A png sent as a jpeg is a picture some providers refuse outright."""
        llm_client.transcribe('http://llm/v1', None, 'a-model', 'Transcribe.', PAGE,
                              references=[('image/webp', ALPHABET)])

        assert images(sent)[0].startswith('data:image/webp;base64,')


class TestTheAnswer:
    def test_the_transcription_comes_back_with_what_it_cost(self, monkeypatch):
        def post(url, json=None, headers=None, timeout=None):
            return Response({'choices': [{'message': {'content': 'A line\nAnother'}}],
                             'usage': {'prompt_tokens': 11, 'completion_tokens': 3}})

        monkeypatch.setattr('app.llm_client.httpx.post', post)

        answer = llm_client.transcribe('http://llm/v1', None, 'a-model', 'Transcribe.', PAGE)

        assert answer['text'] == 'A line\nAnother'
        assert (answer['prompt_tokens'], answer['completion_tokens']) == (11, 3)

    def test_a_provider_that_fails_says_so(self, monkeypatch):
        def post(url, json=None, headers=None, timeout=None):
            raise RuntimeError('connection refused')

        monkeypatch.setattr('app.llm_client.httpx.post', post)

        with pytest.raises(llm_client.LlmError):
            llm_client.transcribe('http://llm/v1', None, 'a-model', 'Transcribe.', PAGE)


class TestReasoning:
    """A reasoning model asked to transcribe a page answers with its working and bills
    every token of it - 4,586 completion tokens for one page, on a provider's own log."""

    def test_it_is_turned_off_without_anyone_asking(self, sent):
        llm_client.transcribe('http://llm/v1', None, 'a-model', 'Transcribe.', PAGE)

        assert sent['body']['reasoning'] == {'enabled': False}
        assert sent['body']['chat_template_kwargs'] == {'enable_thinking': False}

    def test_a_model_can_ask_for_it_back(self, sent):
        llm_client.transcribe('http://llm/v1', None, 'a-model', 'Transcribe.', PAGE,
                              extra={'reasoning': {'enabled': True}})

        assert sent['body']['reasoning'] == {'enabled': True}

    def test_a_null_says_do_not_send_the_field_at_all(self, sent):
        """For an endpoint that refuses what it does not recognise."""
        llm_client.transcribe('http://llm/v1', None, 'a-model', 'Transcribe.', PAGE,
                              extra={'reasoning': None, 'chat_template_kwargs': None})

        assert 'reasoning' not in sent['body']
        assert 'chat_template_kwargs' not in sent['body']


class TestAnEndpointThatRefusesTheSwitch:
    """Not every endpoint may be quietened. OpenRouter answers 400 with "Reasoning is
    mandatory for this endpoint and cannot be disabled" rather than ignoring the field, so
    a saving would otherwise cost the reading."""

    @pytest.fixture
    def refuses(self, monkeypatch):
        """400s anything carrying the switch, and answers whatever comes without it."""
        calls = []

        def post(url, json=None, headers=None, timeout=None):
            calls.append(json)
            if 'reasoning' in json:
                return Response({'error': {'message': 'Reasoning is mandatory for this '
                                                      'endpoint and cannot be disabled.'}},
                                status=400)
            return Response({'choices': [{'message': {'content': 'A line'}}], 'usage': {}})

        monkeypatch.setattr('app.llm_client.httpx.post', post)
        return calls

    def test_it_asks_again_without_it(self, refuses):
        answer = llm_client.transcribe('http://llm/v1', None, 'a-model', 'Transcribe.', PAGE)

        assert answer['text'] == 'A line'
        assert len(refuses) == 2, 'once with the switch, once without'
        assert 'reasoning' not in refuses[1]
        assert 'chat_template_kwargs' not in refuses[1]

    def test_the_second_ask_still_carries_the_models_own_fields(self, refuses):
        llm_client.transcribe('http://llm/v1', None, 'a-model', 'Transcribe.', PAGE,
                              extra={'top_p': 0.9})

        assert refuses[1]['top_p'] == 0.9
        assert refuses[1]['model'] == 'a-model'

    def test_a_400_about_anything_else_is_not_retried(self, monkeypatch):
        """Asking twice would double a cost that the first answer already explained."""
        calls = []

        def post(url, json=None, headers=None, timeout=None):
            calls.append(json)
            return Response({'error': {'message': 'context length exceeded'}}, status=400)

        monkeypatch.setattr('app.llm_client.httpx.post', post)

        with pytest.raises(llm_client.LlmError, match='context length'):
            llm_client.transcribe('http://llm/v1', None, 'a-model', 'Transcribe.', PAGE)
        assert len(calls) == 1


class TestExtraFields:
    def test_a_models_own_fields_are_merged_in(self, sent):
        llm_client.transcribe('http://llm/v1', None, 'a-model', 'Transcribe.', PAGE,
                              extra={'chat_template_kwargs': {'enable_thinking': False}})

        assert sent['body']['chat_template_kwargs'] == {'enable_thinking': False}

    def test_they_cannot_replace_the_page_being_sent(self, sent):
        """Merged fields configure the call; they do not get to decide what is transcribed."""
        llm_client.transcribe('http://llm/v1', None, 'a-model', 'Transcribe.', PAGE,
                              extra={'messages': [], 'model': 'something-else'})

        assert sent['body']['model'] == 'a-model'
        assert images(sent) == ['data:image/jpeg;base64,dGhlIHBhZ2UgYXMganBlZw==']


class TestReadingTheAnswer:
    """What a provider sends back is turned into lines here. A model asked for a JSON array
    often answers with something near it, and near enough is worth accepting - but a guess
    at something unrecognisable would put invented text into a corpus."""

    def test_a_json_array_is_the_contract(self):
        assert llm_client.parse_lines('["First line", "Second line"]') == \
            ['First line', 'Second line']

    def test_a_fenced_array_loses_the_fence_and_its_language_tag(self):
        answer = '```json\n["First line", "Second line"]\n```'

        assert llm_client.parse_lines(answer) == ['First line', 'Second line']

    def test_a_fence_with_no_language_tag_works_too(self):
        assert llm_client.parse_lines('```\n["A line"]\n```') == ['A line']

    def test_an_object_with_a_lines_key_is_accepted(self):
        assert llm_client.parse_lines('{"lines": ["First", "Second"]}') == ['First', 'Second']

    def test_plain_lines_are_accepted_because_models_forget(self):
        assert llm_client.parse_lines('First line\nSecond line\n') == \
            ['First line', 'Second line']

    def test_blank_lines_are_not_lines(self):
        assert llm_client.parse_lines('First\n\n   \nSecond') == ['First', 'Second']

    def test_surrounding_space_is_not_part_of_a_line(self):
        assert llm_client.parse_lines('["  First  "]') == ['First']

    def test_numbers_in_the_array_are_still_read_as_text(self):
        """A page number is a line like any other, and JSON makes it an int."""
        assert llm_client.parse_lines('[385, "K. K. Direktion"]') == ['385', 'K. K. Direktion']

    def test_json_that_is_neither_a_list_nor_a_lines_object_yields_nothing(self):
        assert llm_client.parse_lines('{"text": "the whole page"}') == []

    def test_a_page_whose_only_line_is_a_page_number_is_that_line(self):
        """The prompt asks for plain lines, so '1817' is a page reading 1817 - not a bare
        JSON scalar to be refused. A trailing dot used to be the difference."""
        assert llm_client.parse_lines('1817') == ['1817']
        assert llm_client.parse_lines('1817.') == ['1817.']

    def test_an_empty_answer_yields_nothing(self):
        assert llm_client.parse_lines('') == []
        assert llm_client.parse_lines('   ') == []


class TestAnAnswerThatIsNotATranscription:
    def answer(self, monkeypatch, payload):
        monkeypatch.setattr('app.llm_client.httpx.post',
                            lambda *a, **k: Response(payload))

    def test_a_payload_with_no_message_at_all_says_so(self, monkeypatch):
        self.answer(monkeypatch, {'choices': []})

        with pytest.raises(llm_client.LlmError, match='without a message'):
            llm_client.transcribe('http://llm/v1', None, 'a-model', 'Transcribe.', PAGE)

    def test_a_reasoning_model_still_thinking_is_told_how_to_stop(self, monkeypatch):
        """Empty content with the working in a field of its own - saying so beats storing
        a blank transcription."""
        self.answer(monkeypatch, {'choices': [{'message': {'content': None,
                                                           'reasoning': 'Let me look...'}}]})

        with pytest.raises(llm_client.LlmError, match='enable_thinking'):
            llm_client.transcribe('http://llm/v1', None, 'a-model', 'Transcribe.', PAGE)

    def test_the_other_spelling_of_that_field_is_recognised_too(self, monkeypatch):
        self.answer(monkeypatch, {'choices': [{'message': {'content': '',
                                                           'reasoning_content': 'Hmm'}}]})

        with pytest.raises(llm_client.LlmError, match='reasoning'):
            llm_client.transcribe('http://llm/v1', None, 'a-model', 'Transcribe.', PAGE)

    def test_an_answer_cut_off_at_the_ceiling_says_that_rather_than_empty(self, monkeypatch):
        self.answer(monkeypatch, {'choices': [{'finish_reason': 'length',
                                               'message': {'content': ''}}]})

        with pytest.raises(llm_client.LlmError, match='token ceiling'):
            llm_client.transcribe('http://llm/v1', None, 'a-model', 'Transcribe.', PAGE)

    def test_an_empty_answer_with_no_explanation_is_still_an_error(self, monkeypatch):
        self.answer(monkeypatch, {'choices': [{'message': {'content': ''}}]})

        with pytest.raises(llm_client.LlmError, match='empty transcription'):
            llm_client.transcribe('http://llm/v1', None, 'a-model', 'Transcribe.', PAGE)


class TestWhenTheEndpointMisbehaves:
    """The message is the whole value: these reach a person as the reason their run failed."""

    def test_a_timeout_names_the_thing_that_usually_causes_it(self):
        message = llm_client._describe(httpx.TimeoutException('timed out'))

        assert 'thinking' in message, 'a reasoning model can spend the whole budget on it'
        assert 'LLM_TIMEOUT' in message, 'and the operator can raise the ceiling'

    @pytest.mark.parametrize('status, expected', [
        (401, 'rejected the API key'),
        (403, 'rejected the API key'),
        (404, 'base URL ends at /v1'),
        (429, 'rate limiting'),
    ])
    def test_the_common_refusals_are_explained_rather_than_numbered(self, status, expected):
        error = httpx.HTTPStatusError(
            'x', request=httpx.Request('GET', 'http://llm/v1/models'),
            response=httpx.Response(status, text=''))

        assert expected in llm_client._describe(error)

    def test_a_chat_call_blames_the_model_id_for_a_404_not_the_base_url(self):
        """Four other models answer on the same connection, so the path is fine and the
        model id is not."""
        error = httpx.HTTPStatusError(
            'x', request=httpx.Request('POST', 'http://llm/v1/chat/completions'),
            response=httpx.Response(404, text='{"error":{"message":"No endpoints found for z-ai/glm-5.3"}}'))

        message = llm_client._describe(error, model='z-ai/glm-5.3')

        assert 'z-ai/glm-5.3' in message
        assert 'base URL' not in message
        assert 'No endpoints found' in message

    def test_a_chat_call_blames_the_permission_for_a_403_not_the_key(self):
        error = httpx.HTTPStatusError(
            'x', request=httpx.Request('POST', 'http://llm/v1/chat/completions'),
            response=httpx.Response(403, text='{"error":{"message":"Model requires acceptance of terms"}}'))

        message = llm_client._describe(error, model='meta/muse-spark-1.3-contributor')

        assert 'meta/muse-spark-1.3-contributor' in message
        assert 'API key' not in message
        assert 'acceptance of terms' in message

    def test_an_unusable_key_is_still_the_key_on_a_chat_call(self):
        error = httpx.HTTPStatusError(
            'x', request=httpx.Request('POST', 'http://llm/v1/chat/completions'),
            response=httpx.Response(401, text=''))

        assert 'API key' in llm_client._describe(error, model='a-model')

    def test_a_failed_reading_names_the_model_that_was_refused(self):
        """The message is stored on the failed read, where the model column is the only
        other thing saying which one it was."""
        def refuse(url, **kwargs):
            return httpx.Response(404, text='no such model', request=httpx.Request('POST', url))

        monkeypatch = pytest.MonkeyPatch()
        monkeypatch.setattr(httpx, 'post', refuse)
        try:
            with pytest.raises(llm_client.LlmError, match='z-ai/glm-5.3'):
                llm_client.transcribe('http://llm/v1', None, 'z-ai/glm-5.3', 'Transcribe.', PAGE)
        finally:
            monkeypatch.undo()

    def test_any_other_status_carries_what_the_endpoint_said(self):
        error = httpx.HTTPStatusError(
            'x', request=httpx.Request('POST', 'http://llm/v1/chat/completions'),
            response=httpx.Response(500, text='image input is not supported - provide the mmproj'))

        message = llm_client._describe(error)

        assert '500' in message and 'mmproj' in message

    def test_a_status_with_no_body_still_says_which_it_was(self):
        error = httpx.HTTPStatusError(
            'x', request=httpx.Request('GET', 'http://llm/v1/models'),
            response=httpx.Response(503, text=''))

        assert llm_client._describe(error) == 'the endpoint answered 503'

    def test_anything_else_is_named_by_its_type(self):
        assert llm_client._describe(ValueError('nonsense')) == 'ValueError: nonsense'


class TestAskingWhatItOffers:
    def test_the_model_ids_come_back_sorted_and_deduplicated(self, monkeypatch):
        monkeypatch.setattr('app.llm_client.httpx.get', lambda *a, **k: Response(
            {'data': [{'id': 'qwen-vl'}, {'id': 'gemma'}, {'id': 'qwen-vl'}]}))

        assert llm_client.list_models('http://llm/v1', None) == ['gemma', 'qwen-vl']

    def test_entries_that_are_not_models_are_ignored(self, monkeypatch):
        monkeypatch.setattr('app.llm_client.httpx.get', lambda *a, **k: Response(
            {'data': [{'id': 'qwen-vl'}, 'not an entry', {'no_id': True}, {'id': 7}]}))

        assert llm_client.list_models('http://llm/v1', None) == ['qwen-vl']

    def test_something_that_is_not_a_model_list_is_refused(self, monkeypatch):
        monkeypatch.setattr('app.llm_client.httpx.get',
                            lambda *a, **k: Response({'models': ['qwen-vl']}))

        with pytest.raises(llm_client.LlmError, match='not an OpenAI model list'):
            llm_client.list_models('http://llm/v1', None)

    def test_an_endpoint_that_cannot_be_reached_is_reported_as_such(self, monkeypatch):
        def refuse(*args, **kwargs):
            raise httpx.ConnectError('connection refused')

        monkeypatch.setattr('app.llm_client.httpx.get', refuse)

        with pytest.raises(llm_client.LlmError, match='could not connect'):
            llm_client.list_models('http://llm/v1', None)

    def test_what_the_endpoint_answered_is_never_repeated(self, monkeypatch):
        """Any address may be probed, so an echoed body would read out whatever an internal
        service answers to a GET."""
        monkeypatch.setattr('app.llm_client.httpx.get', lambda url, **k: httpx.Response(
            500, text='internal admin page: db password hunter2', request=httpx.Request('GET', url)))

        with pytest.raises(llm_client.LlmError) as raised:
            llm_client.list_models('http://llm/v1', None)

        assert str(raised.value) == 'the endpoint answered 500 - the server failed'


def status_error(status: int, body: str = 'a body the probe must not repeat') -> httpx.HTTPStatusError:
    request = httpx.Request('GET', 'http://llm/v1/models')
    return httpx.HTTPStatusError('x', request=request,
                                 response=httpx.Response(status, text=body, request=request))


class TestTheProbeFailure:
    """Classified by status and exception alone, so nothing the endpoint said gets through."""

    @pytest.mark.parametrize('exc, expected', [
        (status_error(401), 'the key was refused (401)'),
        (status_error(403), 'the key was refused (403)'),
        (status_error(404), 'the endpoint answered 404 - check the address ends at /v1'),
        (status_error(405), 'the endpoint answered 405 - check the address ends at /v1'),
        (status_error(429), 'the endpoint is rate limiting this key (429)'),
        (status_error(500), 'the endpoint answered 500 - the server failed'),
        (status_error(503), 'the endpoint answered 503 - the server failed'),
        (status_error(302), 'the endpoint answered 302'),
        (httpx.ConnectError('[Errno 111] Connection refused'), 'could not connect - check the address'),
        (httpx.ConnectTimeout('timed out'), 'the endpoint did not answer in time'),
        (httpx.ReadTimeout('timed out'), 'the endpoint did not answer in time'),
        (httpx.RemoteProtocolError('garbage'), 'could not connect - check the address'),
        (httpx.UnsupportedProtocol('ftp'), 'the address is not an http or https URL'),
        (httpx.InvalidURL('bad'), 'the address is not an http or https URL'),
        (json.JSONDecodeError('Expecting value', '<html>secret</html>', 0),
         'the endpoint answered something that is not an OpenAI model list'),
        (RuntimeError('anything at all'), 'the probe failed'),
    ])
    def test_each_failure_has_one_fixed_sentence(self, exc, expected):
        assert llm_client.probe_failure(exc) == expected

    def test_the_key_is_sent_as_a_bearer_token(self, monkeypatch):
        seen = {}

        def get(url, headers=None, timeout=None):
            seen['headers'] = headers
            return Response({'data': []})

        monkeypatch.setattr('app.llm_client.httpx.get', get)

        llm_client.list_models('http://llm/v1', 'sk-secret')

        assert seen['headers']['Authorization'] == 'Bearer sk-secret'

    def test_a_connection_without_a_key_sends_no_authorization(self, monkeypatch):
        seen = {}

        def get(url, headers=None, timeout=None):
            seen['headers'] = headers
            return Response({'data': []})

        monkeypatch.setattr('app.llm_client.httpx.get', get)

        llm_client.list_models('http://llm/v1', None)

        assert 'Authorization' not in seen['headers']
