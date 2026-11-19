"""Account roles (#131, decisions 317-319): Annotator, Reviewer, Manager, Admin and Viewer
decide what someone may do with a dataset they can open, and whoever created a dataset
manages it whatever their role. Deleting, discarding and re-running are the role's, not
a capability an admin grants."""
import pytest
from fastapi.testclient import TestClient

from app import store
from app.deps import get_db
from app.main import app

SECRET = 'test-secret'


def person(name: str, role: str) -> dict:
    return {'X-Frontend-Secret': SECRET, 'X-Auth-User': name, 'X-Auth-Role': role, 'X-Auth-Caps': ''}


ROOT = person('root', 'admin')
BOB = person('bob', 'manager')
MAX = person('max', 'manager')
RITA = person('rita', 'reviewer')
ANN = person('ann', 'annotator')
MIA = person('mia', 'member')
PNG = b'\x89PNG\r\n\x1a\n'


@pytest.fixture
def client(tmp_path, monkeypatch):
    """Bob's group holds his dataset and is shared with Max, Rita, Ann and Mia; Ann also
    created a dataset of her own."""
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    monkeypatch.setattr('app.config.JOBS_DIR', tmp_path / 'jobs')
    conn = store.connect(tmp_path / 'app.db')
    conn.executescript("""
        INSERT INTO groups (id, name, owner) VALUES (1, 'Schematismus', 'bob');
        INSERT INTO group_assignees (group_id, username) VALUES (1, 'max'), (1, 'rita'), (1, 'ann'), (1, 'mia');
        INSERT INTO jobs (id, name, owner, status, group_id) VALUES ('j-bob', 'Band 1878', 'bob', 'done', 1),
                                                                    ('j-ann', 'Band 1879', 'ann', 'done', NULL);
        INSERT INTO pages (id, job_id, idx, filename, source_file, status, width, height)
            VALUES (1, 'j-bob', 0, 'p1.png', '/nonexistent/p1.png', 'done', 1000, 1400),
                   (2, 'j-ann', 0, 'p2.png', '/nonexistent/p2.png', 'done', 1000, 1400);
        INSERT INTO elements (id, page_id, order_idx, class_name, bbox)
            VALUES (1, 1, 0, 'Paragraph', '[0.05, 0.05, 0.95, 0.5]'), (2, 2, 0, 'Paragraph', '[0.05, 0.05, 0.95, 0.5]');
        INSERT INTO lines (id, element_id, order_idx, polygon, text, checked)
            VALUES (1, 1, 0, '[[0.1, 0.1], [0.9, 0.1], [0.9, 0.15], [0.1, 0.15]]', 'Pfarre', 0),
                   (2, 2, 0, '[[0.1, 0.1], [0.9, 0.1], [0.9, 0.15], [0.1, 0.15]]', 'Dechant', 0);
    """)
    conn.commit()
    app.dependency_overrides[get_db] = lambda: conn
    yield TestClient(app), conn
    app.dependency_overrides.clear()
    conn.close()


def role_on(api, job_id: str, headers: dict) -> str:
    response = api.get(f'/api/jobs/{job_id}', params={'pages': 'false'}, headers=headers)
    assert response.status_code == 200, response.text
    return response.json()['my_role']


def line(conn, line_id: int) -> dict:
    return dict(conn.execute('SELECT corrected_text, checked FROM lines WHERE id = ?', (line_id,)).fetchone())


def test_a_dataset_says_which_role_its_caller_acts_with(client):
    api, _ = client
    assert {name: role_on(api, 'j-bob', headers) for name, headers in
            [('root', ROOT), ('bob', BOB), ('max', MAX), ('rita', RITA), ('ann', ANN), ('mia', MIA)]} == {
        'root': 'admin', 'bob': 'manager', 'max': 'manager', 'rita': 'reviewer', 'ann': 'annotator',
        # An account the auth service has not moved off the old role yet acts as a Manager.
        'mia': 'manager'}


def test_whoever_created_a_dataset_manages_it_whatever_their_role(client):
    api, _ = client
    assert role_on(api, 'j-ann', ANN) == 'manager'


def test_an_annotator_corrects_a_line_but_cannot_check_it(client):
    api, conn = client
    corrected = api.patch('/api/lines/1', json={'corrected_text': 'Pfarrei'}, headers=ANN)
    assert corrected.status_code == 200, corrected.text
    assert line(conn, 1) == {'corrected_text': 'Pfarrei', 'checked': 0}

    checked = api.patch('/api/lines/1', json={'checked': True}, headers=ANN)
    assert checked.status_code == 403
    assert line(conn, 1) == {'corrected_text': 'Pfarrei', 'checked': 0}

    checked_with_text = api.patch('/api/lines/1', json={'corrected_text': 'Pfarre', 'checked': True}, headers=ANN)
    assert checked_with_text.status_code == 403
    assert line(conn, 1) == {'corrected_text': 'Pfarrei', 'checked': 0}


def test_a_reviewer_checks_a_line(client):
    api, conn = client
    response = api.patch('/api/lines/1', json={'checked': True}, headers=RITA)
    assert response.status_code == 200, response.text
    assert line(conn, 1) == {'corrected_text': None, 'checked': 1}


def test_marking_a_page_reviewed_needs_a_reviewer(client):
    api, conn = client
    lines_checked = lambda: conn.execute('SELECT lines_checked FROM pages WHERE id = 1').fetchone()[0]
    assert api.patch('/api/pages/1', json={'lines_checked': True}, headers=ANN).status_code == 403
    assert lines_checked() == 0
    response = api.patch('/api/pages/1', json={'lines_checked': True}, headers=RITA)
    assert response.status_code == 200, response.text
    assert lines_checked() == 1


def test_an_annotator_adds_pages_to_a_dataset_of_the_workspace(client):
    api, conn = client
    response = api.post('/api/jobs/j-bob/pages/upload', headers=ANN,
                        files=[('files', ('p3.png', PNG, 'image/png'))])
    assert response.status_code == 200, response.text
    assert [r[0] for r in conn.execute("SELECT filename FROM pages WHERE job_id = 'j-bob' ORDER BY idx")] == \
        ['p1.png', 'p3.png']


def test_marking_test_pages_is_a_managers(client):
    api, conn = client
    is_test = lambda: conn.execute('SELECT is_test FROM pages WHERE id = 1').fetchone()[0]
    assert api.post('/api/jobs/j-bob/test-pages', json={'page_ids': [1], 'test': True},
                    headers=RITA).status_code == 403
    assert is_test() == 0
    response = api.post('/api/jobs/j-bob/test-pages', json={'page_ids': [1], 'test': True}, headers=MAX)
    assert response.status_code == 200, response.text
    assert is_test() == 1


def test_data_use_is_set_by_a_manager_or_the_creator(client):
    api, conn = client
    export_allowed = lambda job_id: conn.execute(
        'SELECT use_export FROM jobs WHERE id = ?', (job_id,)).fetchone()[0]
    assert api.put('/api/jobs/j-bob/data-use', json={'export': False}, headers=ANN).status_code == 403
    assert export_allowed('j-bob') == 1
    response = api.put('/api/jobs/j-ann/data-use', json={'export': False}, headers=ANN)
    assert response.status_code == 200, response.text
    assert export_allowed('j-ann') == 0


def test_export_is_a_managers(client):
    api, _ = client
    assert api.get('/api/jobs/j-bob/export', headers=RITA).status_code == 403
    assert api.get('/api/jobs/j-bob/export', headers=MAX).status_code == 200


def test_deleting_a_dataset_takes_a_manager_and_no_granted_capability(client):
    api, conn = client
    exists = lambda: conn.execute("SELECT COUNT(*) FROM jobs WHERE id = 'j-bob'").fetchone()[0]
    assert api.delete('/api/jobs/j-bob', headers=ANN).status_code == 403
    assert api.delete('/api/jobs/j-bob', headers=RITA).status_code == 403
    assert exists() == 1
    response = api.delete('/api/jobs/j-bob', headers=MAX)
    assert response.status_code == 200, response.text
    assert exists() == 0


def test_an_annotator_deletes_the_dataset_they_created(client):
    api, conn = client
    response = api.delete('/api/jobs/j-ann', headers=ANN)
    assert response.status_code == 200, response.text
    assert conn.execute("SELECT COUNT(*) FROM jobs WHERE id = 'j-ann'").fetchone()[0] == 0


def test_a_box_an_annotator_draws_waits_for_a_reviewer(client):
    api, conn = client
    drawn = {}
    for name, headers in [('ann', ANN), ('rita', RITA)]:
        response = api.post('/api/pages/1/elements', json={'class_name': 'Paragraph', 'bbox': [0.1, 0.1, 0.5, 0.3]},
                            headers=headers)
        assert response.status_code == 200, response.text
        drawn[name] = conn.execute('SELECT checked FROM elements WHERE id = ?', (response.json()['id'],)).fetchone()[0]
    assert drawn == {'ann': 0, 'rita': 1}
