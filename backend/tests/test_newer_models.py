import pytest
from fastapi.testclient import TestClient

from app import store
from app.deps import get_db
from app.main import app

SECRET = 'test-secret'
ADMIN = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'root', 'X-Auth-Role': 'admin'}
OWNER = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'alice', 'X-Auth-Role': 'member',
         'X-Auth-Caps': 'pipeline.layout pipeline.lines pipeline.ocr'}
DISCARDING_OWNER = {**OWNER, 'X-Auth-Caps': 'pipeline.layout pipeline.lines pipeline.ocr pipeline.discard'}
SHARED = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'bob', 'X-Auth-Role': 'member'}

# Three OCR models (v2 the default, v1 its predecessor, a fine-tune of v1), two line
# models and two layout models. Pages 1 and 2 were laid out by layout 10, their lines found
# by lines 20 and read by OCR 1; line 4 is checked.
SEED = """
    INSERT INTO models (id, task, name, source, checkpoint, is_default, trained_from) VALUES
        (1, 'ocr', 'DeepOCR v1', 'backend', 'v1', 0, NULL),
        (2, 'ocr', 'DeepOCR v2', 'backend', 'v2', 1, NULL),
        (3, 'ocr', 'v1 fine-tune', 'trained', 'ft', 0, 1),
        (10, 'layout', 'YOLO-L 4', 'backend', 'l4', 1, NULL),
        (11, 'layout', 'YOLO-L 5', 'backend', 'l5', 0, NULL),
        (20, 'lines', 'LineNet 1', 'backend', 'n1', 1, NULL),
        (21, 'lines', 'LineNet 2', 'backend', 'n2', 0, NULL);
    INSERT INTO jobs (id, name, owner, status) VALUES ('j1', 'Zollbuecher', 'alice', 'done');
    INSERT INTO job_assignees (job_id, username) VALUES ('j1', 'bob');
    INSERT INTO pages (id, job_id, idx, filename, source_file, status, layout_model_id, lines_model_id) VALUES
        (1, 'j1', 0, 'a.png', '/a.png', 'done', 10, 20), (2, 'j1', 1, 'b.png', '/b.png', 'done', 10, 20);
    INSERT INTO elements (id, page_id, order_idx, class_name, bbox) VALUES
        (1, 1, 0, 'Paragraph', '[0,0,1,1]'), (2, 2, 0, 'Paragraph', '[0,0,1,1]');
    INSERT INTO lines (id, element_id, order_idx, polygon, text, ocr_model_id, checked) VALUES
        (1, 1, 0, '[]', 'a', 1, 0), (2, 1, 1, '[]', 'b', 1, 0),
        (3, 2, 0, '[]', 'c', 1, 0), (4, 2, 1, '[]', 'd', 1, 1);
"""


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    monkeypatch.setattr('app.config.JOBS_DIR', tmp_path / 'jobs')
    conn = store.connect(tmp_path / 'app.db')
    conn.executescript(SEED)
    conn.commit()
    app.dependency_overrides[get_db] = lambda: conn
    yield TestClient(app), conn
    app.dependency_overrides.clear()
    conn.close()


def offers(api, headers=OWNER):
    response = api.get('/api/jobs/j1/newer-models', headers=headers)
    assert response.status_code == 200, response.text
    return {o['task']: o for o in response.json()['offers']}


class TestNewVersionOf:
    def test_an_admin_marks_a_model_as_the_new_version_of_another(self, client):
        api, _ = client
        response = api.patch('/api/models/2', json={'supersedes': 1}, headers=ADMIN)

        assert response.status_code == 200, response.text
        assert response.json()['supersedes'] == 1
        listed = {m['id']: m for m in api.get('/api/models', headers=ADMIN).json()['models']}
        assert listed[2]['supersedes'] == 1
        assert api.patch('/api/models/2', json={'supersedes': None}, headers=ADMIN).json()['supersedes'] is None

    @pytest.mark.parametrize('older, why', [(10, 'same task'), (2, 'itself'), (99, 'no model')])
    def test_it_must_name_another_model_of_the_same_task(self, client, older, why):
        api, _ = client
        response = api.patch('/api/models/2', json={'supersedes': older}, headers=ADMIN)
        assert response.status_code == 400, why

    def test_a_chain_cannot_loop(self, client):
        api, _ = client
        api.patch('/api/models/2', json={'supersedes': 1}, headers=ADMIN)
        response = api.patch('/api/models/1', json={'supersedes': 2}, headers=ADMIN)
        assert response.status_code == 400
        assert 'loop' in response.text

    def test_it_is_part_of_managing_the_registry(self, client):
        api, _ = client
        assert api.patch('/api/models/2', json={'supersedes': 1}, headers=OWNER).status_code == 403


class TestOffer:
    def test_a_new_default_is_offered_to_a_dataset_that_follows_the_default(self, client):
        api, _ = client
        ocr = offers(api)['ocr']
        assert (ocr['from']['name'], ocr['to']['name']) == ('DeepOCR v1', 'DeepOCR v2')
        assert (ocr['unchecked'], ocr['checked']) == (3, 1)

    def test_a_dataset_with_its_own_model_is_offered_that_model_s_new_version(self, client):
        api, conn = client
        conn.execute("UPDATE jobs SET model_ocr_id = 1 WHERE id = 'j1'")
        assert 'ocr' not in offers(api)

        api.patch('/api/models/2', json={'supersedes': 1}, headers=ADMIN)

        assert offers(api)['ocr']['to']['name'] == 'DeepOCR v2'

    def test_the_newest_live_version_of_a_chain_is_offered(self, client):
        api, conn = client
        conn.execute("UPDATE jobs SET model_ocr_id = 1 WHERE id = 'j1'")
        conn.execute("INSERT INTO models (id, task, name, source, checkpoint) VALUES (4, 'ocr', 'DeepOCR v3', 'backend', 'v3')")
        conn.execute("INSERT INTO models (id, task, name, source, checkpoint, archived) VALUES (5, 'ocr', 'v4 (pulled)', 'backend', 'v4', 1)")
        for newer, older in ((2, 1), (4, 2), (5, 4)):
            api.patch(f'/api/models/{newer}', json={'supersedes': older}, headers=ADMIN)

        assert offers(api)['ocr']['to']['name'] == 'DeepOCR v3'

    def test_a_fine_tune_is_not_a_new_version(self, client):
        api, conn = client
        conn.execute("UPDATE jobs SET model_ocr_id = 1 WHERE id = 'j1'")
        assert offers(api) == {}

    def test_layout_and_lines_say_what_running_them_replaces(self, client):
        api, conn = client
        conn.execute("UPDATE pages SET layout_checked = 1 WHERE id = 1")
        conn.execute("UPDATE lines SET corrected_text = 'B' WHERE id = 2")
        conn.execute("UPDATE models SET is_default = (id IN (2, 11, 21)) WHERE task IN ('layout', 'lines')")
        found = offers(api)

        assert (found['layout']['from']['name'], found['layout']['to']['name']) == ('YOLO-L 4', 'YOLO-L 5')
        assert (found['layout']['boxes'], found['layout']['lines'], found['layout']['layout_checked']) == (2, 4, 1)
        assert (found['lines']['from']['name'], found['lines']['to']['name']) == ('LineNet 1', 'LineNet 2')
        assert (found['lines']['lines'], found['lines']['corrected']) == (4, 1)

    def test_a_step_the_dataset_does_not_run_is_not_offered(self, client):
        api, conn = client
        conn.execute("UPDATE jobs SET run_ocr = 0 WHERE id = 'j1'")
        assert 'ocr' not in offers(api)

    def test_nothing_is_offered_while_the_dataset_runs(self, client):
        api, conn = client
        conn.execute("UPDATE jobs SET status = 'running' WHERE id = 'j1'")
        assert offers(api) == {}

    def test_only_the_owner_or_an_admin_is_asked(self, client):
        api, _ = client
        assert api.get('/api/jobs/j1/newer-models', headers=SHARED).json()['offers'] == []
        assert 'ocr' in offers(api, ADMIN)


class TestNotNow:
    def test_declining_is_remembered_until_an_even_newer_version(self, client):
        api, conn = client
        response = api.post('/api/jobs/j1/newer-models/dismiss', headers=OWNER)
        assert response.status_code == 200, response.text
        assert offers(api) == {}

        conn.execute("INSERT INTO models (id, task, name, source, checkpoint) VALUES (4, 'ocr', 'DeepOCR v3', 'backend', 'v3')")
        api.patch('/api/models/4', json={'supersedes': 2}, headers=ADMIN)

        assert offers(api)['ocr']['to']['name'] == 'DeepOCR v3'


class TestSwitchAndRun:
    def test_ocr_switches_the_dataset_and_re_reads_the_unchecked_lines(self, client):
        api, conn = client
        conn.execute("UPDATE jobs SET model_ocr_id = 1 WHERE id = 'j1'")
        api.patch('/api/models/2', json={'supersedes': 1}, headers=ADMIN)

        response = api.post('/api/jobs/j1/newer-models', json={'tasks': ['ocr']}, headers=OWNER)

        assert response.status_code == 200, response.text
        job = conn.execute("SELECT model_ocr_id, status FROM jobs WHERE id = 'j1'").fetchone()
        assert tuple(job) == (2, 'queued')
        assert [tuple(r) for r in conn.execute('SELECT id, needs_ocr FROM lines ORDER BY id')] == \
            [(1, 1), (2, 1), (3, 1), (4, 0)]
        assert offers(api) == {}

    def test_a_dataset_following_the_default_keeps_following_it(self, client):
        api, conn = client
        api.post('/api/jobs/j1/newer-models', json={'tasks': ['ocr']}, headers=OWNER)
        assert conn.execute("SELECT model_ocr_id FROM jobs WHERE id = 'j1'").fetchone()[0] is None

    def test_layout_re_runs_from_layout_and_takes_the_sign_off_along(self, client):
        api, conn = client
        conn.execute("UPDATE pages SET layout_checked = 1 WHERE id = 1")
        conn.execute("UPDATE models SET is_default = (id = 11) WHERE task = 'layout'")

        # Retiring a layout sign-off is throwing checked work away, which is its own permission.
        assert api.post('/api/jobs/j1/newer-models', json={'tasks': ['layout']}, headers=OWNER).status_code == 403
        response = api.post('/api/jobs/j1/newer-models', json={'tasks': ['layout']}, headers=DISCARDING_OWNER)

        assert response.status_code == 200, response.text
        assert conn.execute('SELECT COUNT(*) FROM elements WHERE deleted = 0').fetchone()[0] == 0
        assert conn.execute("SELECT status FROM jobs WHERE id = 'j1'").fetchone()[0] == 'queued'

    def test_only_offered_steps_can_be_run(self, client):
        api, _ = client
        response = api.post('/api/jobs/j1/newer-models', json={'tasks': ['lines']}, headers=OWNER)
        assert response.status_code == 400

    def test_the_steps_not_ticked_are_not_asked_about_again(self, client):
        api, conn = client
        conn.execute("UPDATE models SET is_default = (id = 11) WHERE task = 'layout'")
        assert set(offers(api)) == {'layout', 'ocr'}

        api.post('/api/jobs/j1/newer-models', json={'tasks': ['ocr']}, headers=OWNER)
        conn.execute("UPDATE jobs SET status = 'done' WHERE id = 'j1'")

        assert 'layout' not in offers(api)

    def test_someone_who_is_not_the_owner_cannot(self, client):
        api, _ = client
        assert api.post('/api/jobs/j1/newer-models', json={'tasks': ['ocr']}, headers=SHARED).status_code == 403
