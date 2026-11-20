"""Who may keep what a recognition request reads, and into which dataset: all of it settled
before anything is read. What a kept page holds is the e2e scenario's, against the stub models."""
import io

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app import recognize, store
from app.deps import get_db
from app.main import app

SECRET = 'test-secret'
ALICE = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'alice', 'X-Auth-Role': 'member', 'X-Auth-Caps': 'recognize'}
# Past every keep gate, an empty registry is what stops the request: the control that a
# gate let it through.
NO_MODEL = (503, 'this deployment has no default lines model')


def _png(width: int, height: int) -> bytes:
    out = io.BytesIO()
    Image.new('RGB', (width, height), 'white').save(out, format='PNG')
    return out.getvalue()


@pytest.fixture
def conn(tmp_path, monkeypatch):
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    monkeypatch.setattr('app.config.MODEL_BACKENDS', {})
    monkeypatch.setattr('app.config.JOBS_DIR', tmp_path / 'jobs')
    monkeypatch.setattr('app.config.BLOBS_DIR', tmp_path / 'blobs')
    connection = store.connect(tmp_path / 'app.db')
    for job_id, name, owner, task, status in (('mine', 'Mine', 'alice', 'text', 'done'),
                                              ('theirs', 'Theirs', 'bob', 'text', 'done'),
                                              ('tiles', 'Tiles', 'alice', 'map_segmentation', 'done'),
                                              ('busy', 'Busy', 'alice', 'text', 'running')):
        connection.execute('INSERT INTO jobs (id, name, owner, task, status) VALUES (?,?,?,?,?)',
                           (job_id, name, owner, task, status))
    connection.commit()
    yield connection
    connection.close()


@pytest.fixture
def client(conn):
    app.dependency_overrides[get_db] = lambda: conn
    yield TestClient(app)
    app.dependency_overrides.clear()


def _keep(client, keep: str, headers: dict = ALICE, route: str = 'pages'):
    response = client.post(f'/api/recognize/{route}', headers=headers, data={'keep': keep},
                           files=[('files', ('a.png', _png(8, 8), 'image/png'))])
    return response.status_code, response.json()['detail']


def test_a_name_another_account_holds_is_refused(client):
    assert _keep(client, 'theirs') == (
        409, 'a dataset named "theirs" belongs to another account; keep needs a name of your own')


def test_only_a_text_dataset_keeps_pages(client):
    assert _keep(client, 'Tiles') == (400, '"Tiles" is a map dataset; pages are kept in a text dataset')


def test_a_dataset_that_is_queued_or_running_is_refused(client):
    assert _keep(client, 'Busy') == (409, '"Busy" is queued or running; keep into it once it has finished')


def test_keeping_writes_so_a_viewer_or_a_readonly_token_may_not(client):
    viewer = {**ALICE, 'X-Auth-Role': 'viewer'}
    assert _keep(client, 'Mine', viewer) == (403, 'keeping writes a dataset, which a read-only account may not do')
    readonly = {**ALICE, 'X-Auth-Readonly': '1'}
    assert _keep(client, 'Mine', readonly) == (403, 'keeping writes a dataset, which a read-only token may not do')
    # Without keep, both still recognize: the refusal is the keep, not the request.
    for headers in (viewer, readonly):
        assert _keep(client, '', headers) == NO_MODEL


def test_your_own_dataset_in_any_letter_case_or_a_new_name_passes_every_gate(client):
    assert _keep(client, 'MINE') == NO_MODEL
    assert _keep(client, 'Something new') == NO_MODEL
    # A recognition-only token may keep: the scope limits which routes, not this field.
    assert _keep(client, 'Mine', {**ALICE, 'X-Auth-Scope': 'recognize'}) == NO_MODEL


def test_line_images_have_no_page_to_keep(client):
    assert _keep(client, 'Mine', route='lines') == (400, 'keep works on pages: send them to /api/recognize/pages')


def test_with_no_page_read_nothing_is_created(conn, monkeypatch):
    monkeypatch.setattr(recognize, '_reading', lambda conn, fields: None)
    answer = recognize.pages(conn, 'alice', [recognize.Upload('broken.png', b'not an image')],
                             {'keep': 'Never made', 'lines': '{"broken.png": []}'})
    assert answer['kept'] == {'dataset': None, 'name': 'Never made', 'created': False, 'pages': 0, 'duplicates': []}
    assert conn.execute("SELECT COUNT(*) FROM jobs WHERE name = 'Never made'").fetchone()[0] == 0


def test_a_new_dataset_takes_the_choices_the_request_named(conn, monkeypatch):
    model_id = conn.execute("INSERT INTO models (task, name, checkpoint) VALUES ('ocr', 'Reader', 'r.ckpt')").lastrowid
    reader = recognize.Reading({'id': model_id, 'name': 'Reader'}, None, 'greedy', {'long_s': True})
    monkeypatch.setattr(recognize, '_reading', lambda conn, fields: reader)
    answer = recognize.pages(conn, 'alice', [recognize.Upload('blank.png', _png(40, 30))],
                             {'keep': 'Fresh', 'ocr_model': str(model_id), 'decode': 'greedy', 'convention': 'long_s',
                              'lines': '{"blank.png": []}'})

    job_id = answer['kept']['dataset']
    assert answer['kept'] == {'dataset': job_id, 'name': 'Fresh', 'created': True, 'pages': 1, 'duplicates': []}
    job = store.get_job(conn, job_id)
    assert {key: job[key] for key in ('owner', 'task', 'line_mode', 'run_layout', 'run_lines', 'run_ocr',
                                      'model_lines_id', 'model_ocr_id', 'ocr_decode', 'ocr_convention', 'status')} == {
        'owner': 'alice', 'task': 'text', 'line_mode': 'per_page', 'run_layout': False, 'run_lines': True,
        'run_ocr': True, 'model_lines_id': None, 'model_ocr_id': model_id, 'ocr_decode': 'greedy',
        'ocr_convention': {'long_s': True}, 'status': 'done'}
    page = conn.execute('SELECT filename, status, width, height FROM pages WHERE job_id = ?', (job_id,)).fetchone()
    assert dict(page) == {'filename': 'blank.png', 'status': 'done', 'width': 40, 'height': 30}
    # Made, as any new dataset of hers with no workspace named, in her Sandbox (#131).
    assert job['group_id'] == conn.execute("SELECT id FROM groups WHERE sandbox_of = 'alice'").fetchone()[0]


def test_a_page_is_kept_under_its_own_file_name_whatever_folders_the_request_gave(conn, monkeypatch):
    model_id = conn.execute("INSERT INTO models (task, name, checkpoint) VALUES ('ocr', 'Reader', 'r.ckpt')").lastrowid
    monkeypatch.setattr(recognize, '_reading', lambda conn, fields: recognize.Reading(
        {'id': model_id, 'name': 'Reader'}, None, 'beam', {}))
    answer = recognize.pages(conn, 'alice', [recognize.Upload('../../outside.png', _png(40, 30))],
                             {'keep': 'Mine', 'lines': '{"../../outside.png": []}'})

    assert answer['kept'] == {'dataset': 'mine', 'name': 'Mine', 'created': False, 'pages': 1, 'duplicates': []}
    page = conn.execute("SELECT filename, source_file FROM pages WHERE job_id = 'mine'").fetchone()
    assert page['filename'] == 'outside.png'
    assert page['source_file'] == str(recognize.config.job_dir('mine') / 'uploads' / '00000_outside.png')


def test_a_name_too_long_to_keep_is_refused_before_anything_is_read(client):
    long_name = f'{"x" * 300}.png'
    response = client.post('/api/recognize/pages', headers=ALICE, data={'keep': 'Mine'},
                           files=[('files', (long_name, _png(8, 8), 'image/png'))])
    assert response.status_code == 400
    assert response.json()['detail'] == (f'"{"x" * 40}....png" has a file name of 304 bytes, longer than the 200 '
                                         'a page name may be - shorten it and try again')
