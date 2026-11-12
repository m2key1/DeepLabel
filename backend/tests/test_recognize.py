"""The parts of the recognition API that need no model: what a request may carry, and the
documents a page comes back with."""
import io

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app import recognize, store
from app.deps import get_db
from app.main import app

SECRET = 'test-secret'
MAY_RECOGNIZE = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'alice', 'X-Auth-Role': 'member',
                 'X-Auth-Caps': 'recognize'}


def _png(width: int, height: int) -> bytes:
    out = io.BytesIO()
    Image.new('RGB', (width, height), 'white').save(out, format='PNG')
    return out.getvalue()


@pytest.mark.parametrize('fmt, absent', [('page', '<TextLine'), ('alto', '<TextLine'), ('hocr', "class='ocr_line'")])
def test_a_page_without_lines_still_gets_its_document(fmt, absent):
    document = recognize._document(fmt, 0, 'blank.png', 100, 50, [])
    assert 'blank.png' in document
    assert absent not in document


def test_a_page_without_lines_reads_as_no_text():
    assert recognize._document('txt', 0, 'blank.png', 100, 50, []) == ''


def test_own_lines_have_to_name_a_file_of_the_request():
    with pytest.raises(recognize.Refused) as refused:
        recognize._own_lines('{"other.png": []}', ['scan.png'])
    assert (refused.value.status, refused.value.message) == (400, 'lines names other.png, which is not a file of this request')


@pytest.mark.parametrize('outlines', ['[[[0, 0], [1, 0]]]', '[[[0, 0], [1, 0], [1, "a"]]]', '[[[0, 0, 0], [1, 0], [1, 1]]]',
                                      '[[[0, 0], [1, 0], [true, 1]]]', '{"a": 1}'])
def test_own_lines_have_to_be_outlines_of_three_points_or_more(outlines):
    with pytest.raises(recognize.Refused) as refused:
        recognize._own_lines(f'{{"scan.png": {outlines}}}', ['scan.png'])
    assert refused.value.message == 'the lines of scan.png must be outlines of at least three [x, y] points'


def test_own_lines_that_are_not_an_object_are_refused():
    with pytest.raises(recognize.Refused) as refused:
        recognize._own_lines('[1, 2]', ['scan.png'])
    assert refused.value.message == 'lines must be a JSON object: {"<file name>": [<outline>, ...]}'


def test_own_lines_count_against_the_line_limit(monkeypatch):
    monkeypatch.setattr('app.config.RECOGNIZE_MAX_LINES', 2)
    outline = [[0, 0], [5, 0], [5, 2]]
    assert recognize._own_lines(f'{{"a.png": [{outline}, {outline}]}}'.replace("'", '"'), ['a.png']) == {
        'a.png': [outline, outline]}
    with pytest.raises(recognize.Refused) as refused:
        recognize._own_lines(f'{{"a.png": [{outline}], "b.png": [{outline}, {outline}]}}', ['a.png', 'b.png'])
    assert (refused.value.status, refused.value.message) == (413, 'at most 2 lines per request, this one has 3')


def test_an_image_over_the_pixel_limit_fails_alone(monkeypatch):
    monkeypatch.setattr('app.config.MAX_IMAGE_PIXELS', 100)
    assert recognize._decoded(recognize.Upload('big.png', _png(20, 10))) == 'the image is over 100 pixels'
    image, sent = recognize._decoded(recognize.Upload('small.png', _png(10, 10)))
    assert image.size == (10, 10)
    # Already upright RGB in a format the model contract takes: sent as the file itself.
    assert sent.mime == 'image/png'


def test_an_unreadable_image_says_so():
    assert recognize._decoded(recognize.Upload('x.png', b'not an image')) == 'the image could not be read'


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    monkeypatch.setattr('app.config.MODEL_BACKENDS', {})
    conn = store.connect(tmp_path / 'app.db')
    app.dependency_overrides[get_db] = lambda: conn
    yield TestClient(app)
    app.dependency_overrides.clear()
    conn.close()


def test_a_request_over_the_size_limit_is_refused_before_it_is_read(client, monkeypatch):
    monkeypatch.setattr('app.config.RECOGNIZE_MAX_MB', 1)
    files = [('files', (f'p{i}.png', b'x' * 600_000, 'image/png')) for i in range(2)]
    refused = client.post('/api/recognize/pages', headers=MAY_RECOGNIZE, files=files)
    assert refused.status_code == 413
    assert refused.json()['detail'] == 'at most 1 MB per request'


def test_two_files_of_one_name_are_refused(client):
    files = [('files', ('same.png', _png(4, 4), 'image/png')) for _ in range(2)]
    refused = client.post('/api/recognize/lines', headers=MAY_RECOGNIZE, files=files)
    assert refused.status_code == 400
    assert refused.json()['detail'] == 'each file needs a name of its own; same.png comes more than once'


def test_an_unknown_format_is_refused(client):
    refused = client.post('/api/recognize/pages', headers=MAY_RECOGNIZE,
                          files=[('files', ('a.png', _png(4, 4), 'image/png'))], data={'format': 'docx'})
    assert refused.status_code == 400
    assert refused.json()['detail'] == 'format must be one of json, page, alto, hocr, txt'
