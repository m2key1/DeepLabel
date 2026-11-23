"""Pictures set in the wording where they stand (#35): a person's prompt may place a reference
image at any point of its text as {{image:<id>}}, and the model receives exactly that order -
text, picture, text - then the pictures in force the wording does not place, then the page.
Wording that places none is sent as it always was."""
import pytest
from fastapi.testclient import TestClient

from app import llm, llm_client, store
from app.deps import get_db
from app.main import app

SECRET = 'test-secret'
ALICE = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'alice', 'X-Auth-Role': 'member'}
CHART = b'\x89PNG\r\n\x1a\n a chart of rings and crosses'
ALPHABET = b'\x89PNG\r\n\x1a\n a specimen alphabet'
PAGE = b'the page as jpeg'


def note(count: int) -> str:
    return llm.REFERENCE_NOTE.format(count=count, plural='' if count == 1 else 's')


@pytest.fixture
def conn(tmp_path):
    connection = store.connect(tmp_path / 'app.db')
    yield connection
    connection.close()


@pytest.fixture
def pictures(conn):
    chart = llm.add_reference(conn, 'alice', None, 'chart.png', 'image/png', CHART)
    alphabet = llm.add_reference(conn, 'alice', None, 'alphabet.png', 'image/png', ALPHABET)
    bobs = llm.add_reference(conn, 'bob', None, 'bobs.png', 'image/png', CHART + b'bob')
    return chart, alphabet, bobs


def parts_for(conn, prompt: str) -> list[dict]:
    shown = llm.references(conn, 'alice')
    return llm.ask_parts(prompt, shown, llm.placeable(conn, 'alice', shown))


class TestTheOrderSent:
    def test_wording_that_places_no_picture_goes_as_it_always_went(self, conn, pictures):
        assert parts_for(conn, 'Transcribe.') == [
            {'text': f'Transcribe.\n\n{note(2)}'},
            {'mime': 'image/png', 'data': CHART}, {'mime': 'image/png', 'data': ALPHABET}]

    def test_a_placed_picture_stands_where_it_is_and_the_others_follow_the_wording(self, conn, pictures):
        chart, *_ = pictures
        assert parts_for(conn, f'The rings mean ae: {{{{image:{chart}}}}} Read the page.') == [
            {'text': 'The rings mean ae: '}, {'mime': 'image/png', 'data': CHART},
            {'text': f' Read the page.\n\n{note(2)}'}, {'mime': 'image/png', 'data': ALPHABET}]

    def test_wording_ending_on_a_picture_says_what_the_pictures_are_after_it(self, conn, pictures):
        chart, alphabet, _ = pictures
        assert parts_for(conn, f'Charts: {{{{image:{chart}}}}}{{{{image:{alphabet}}}}}') == [
            {'text': 'Charts: '}, {'mime': 'image/png', 'data': CHART}, {'mime': 'image/png', 'data': ALPHABET},
            {'text': note(2)}]

    def test_a_picture_gone_since_drops_out_of_the_wording(self, conn, pictures):
        assert parts_for(conn, 'Before {{image:999}}after') == [
            {'text': f'Before after\n\n{note(2)}'},
            {'mime': 'image/png', 'data': CHART}, {'mime': 'image/png', 'data': ALPHABET}]

    def test_the_endpoint_is_sent_them_in_that_order_with_the_page_last(self, monkeypatch):
        sent = {}

        class Answer:
            status_code = 200
            text = ''

            def raise_for_status(self):
                pass

            def json(self):
                return {'choices': [{'message': {'content': 'a line'}}], 'usage': {}}

        def post(url, json=None, headers=None, timeout=None):
            sent['content'] = json['messages'][0]['content']
            return Answer()
        monkeypatch.setattr('app.llm_client.httpx.post', post)
        llm_client.transcribe('http://llm/v1', None, 'm', [
            {'text': 'Rings: '}, {'mime': 'image/png', 'data': CHART}, {'text': ' then read.'}], PAGE)
        assert [part['type'] for part in sent['content']] == ['text', 'image_url', 'text', 'image_url']
        assert [part.get('text') for part in sent['content']] == ['Rings: ', None, ' then read.', None]


class TestWhatAPromptMayPlace:
    @pytest.fixture
    def client(self, conn, monkeypatch):
        monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
        monkeypatch.setattr('app.config.ENABLE_LLM_OCR', True)
        app.dependency_overrides[get_db] = lambda: conn
        yield TestClient(app)
        app.dependency_overrides.clear()

    def test_only_ones_own_pictures_are_kept_in_the_wording(self, client, pictures):
        chart, _, bobs = pictures
        saved = client.put('/api/llm/prompt', headers=ALICE,
                           json={'prompt': f'Mine {{{{image:{chart}}}}}, his {{{{image:{bobs}}}}}.'}).json()
        assert saved['prompt'] == f'Mine {{{{image:{chart}}}}}, his .'

    def test_deleting_a_picture_takes_it_out_of_the_wording(self, client, conn, pictures):
        chart, alphabet, _ = pictures
        client.put('/api/llm/prompt', headers=ALICE,
                   json={'prompt': f'A {{{{image:{chart}}}}} and B {{{{image:{alphabet}}}}}.'})
        assert client.delete(f'/api/llm/references/{chart}', headers=ALICE).status_code == 200
        assert client.get('/api/llm/prompt', headers=ALICE).json()['prompt'] == f'A  and B {{{{image:{alphabet}}}}}.'
