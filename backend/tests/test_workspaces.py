"""Workspaces (#131, decisions 316, 319-322, 324): a dataset sits in exactly one workspace or
one private Sandbox; belonging to a workspace or to a single dataset decides where someone
works, their role what they may do there."""
import pytest
from fastapi.testclient import TestClient

from app import store
from app.deps import get_db
from app.main import app

SECRET = 'test-secret'
PNG = b'\x89PNG\r\n\x1a\n'


def person(name: str, role: str) -> dict:
    return {'X-Frontend-Secret': SECRET, 'X-Auth-User': name, 'X-Auth-Role': role, 'X-Auth-Caps': ''}


ROOT = person('root', 'admin')
ANNA = person('anna', 'manager')
BEN = person('ben', 'reviewer')
LENA = person('lena', 'annotator')
MAX = person('max', 'manager')
RITA = person('rita', 'reviewer')


@pytest.fixture
def client(tmp_path, monkeypatch):
    """Anna's workspace Schematismus, with Ben and Lena in it, holds her Band 1878 and Lena's
    Band 1879; Rita was given Band 1878 alone. Anna and Max each have a dataset in their
    Sandbox."""
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    monkeypatch.setattr('app.config.JOBS_DIR', tmp_path / 'jobs')
    conn = store.connect(tmp_path / 'app.db')
    conn.executescript("""
        INSERT INTO groups (id, name, owner, sandbox_of) VALUES (1, 'Schematismus', 'anna', NULL),
                                                                (2, '', 'anna', 'anna'),
                                                                (3, '', 'max', 'max');
        INSERT INTO group_assignees (group_id, username) VALUES (1, 'anna'), (1, 'ben'), (1, 'lena');
        INSERT INTO jobs (id, name, owner, status, group_id) VALUES
            ('j1', 'Band 1878', 'anna', 'done', 1),
            ('j2', 'Band 1879', 'lena', 'done', 1),
            ('j-anna', 'Anna trying', 'anna', 'done', 2),
            ('j-max', 'Max trying', 'max', 'done', 3);
        INSERT INTO job_assignees (job_id, username) VALUES ('j1', 'rita');
        INSERT INTO pages (id, job_id, idx, filename, source_file, status, width, height)
            VALUES (1, 'j1', 0, 'p1.png', '/nonexistent/p1.png', 'done', 1000, 1400);
        INSERT INTO elements (id, page_id, order_idx, class_name, bbox)
            VALUES (1, 1, 0, 'Paragraph', '[0.05, 0.05, 0.95, 0.5]');
        INSERT INTO lines (id, element_id, order_idx, polygon, text, checked)
            VALUES (1, 1, 0, '[[0.1, 0.1], [0.9, 0.1], [0.9, 0.15], [0.1, 0.15]]', 'Pfarre', 0);
    """)
    conn.commit()
    app.dependency_overrides[get_db] = lambda: conn
    yield TestClient(app), conn
    app.dependency_overrides.clear()
    conn.close()


def dataset_ids(api, headers) -> list[str]:
    response = api.get('/api/jobs', headers=headers)
    assert response.status_code == 200, response.text
    return sorted(j['id'] for j in response.json())


def workspaces(api, headers) -> dict[str, dict]:
    response = api.get('/api/groups', headers=headers)
    assert response.status_code == 200, response.text
    return {g['name']: g for g in response.json()}


def group_of(conn, job_id: str):
    return conn.execute('SELECT group_id FROM jobs WHERE id = ?', (job_id,)).fetchone()[0]


def sandbox_of(conn, username: str):
    row = conn.execute('SELECT id FROM groups WHERE sandbox_of = ?', (username,)).fetchone()
    return row[0] if row else None


def create(api, headers, **form):
    return api.post('/api/jobs', headers=headers, data={'name': 'New volume', **form},
                    files=[('files', ('scan_1.png', PNG, 'image/png'))])


class TestWhoSeesWhat:
    def test_a_workspace_member_sees_its_datasets_and_their_own_sandbox(self, client):
        api, _ = client
        assert dataset_ids(api, LENA) == ['j1', 'j2']
        assert dataset_ids(api, ANNA) == ['j-anna', 'j1', 'j2']

    def test_someone_given_one_dataset_sees_only_that_one(self, client):
        api, _ = client
        assert dataset_ids(api, RITA) == ['j1']

    def test_a_sandbox_is_its_owners_alone(self, client):
        api, _ = client
        assert api.get('/api/jobs/j-anna', headers=LENA).status_code == 404
        assert api.get('/api/jobs/j-anna', headers=MAX).status_code == 404
        assert api.get('/api/jobs/j-anna', headers=ANNA).status_code == 200

    def test_an_admin_opens_every_sandbox(self, client):
        api, _ = client
        assert dataset_ids(api, ROOT) == ['j-anna', 'j-max', 'j1', 'j2']


class TestTheWorkspaceList:
    def test_a_member_sees_their_workspaces_and_their_sandbox(self, client):
        api, _ = client
        listed = workspaces(api, ANNA)
        assert sorted(listed) == ['Sandbox', 'Schematismus']
        assert (listed['Sandbox']['sandbox_of'], listed['Schematismus']['sandbox_of']) == ('anna', None)
        assert listed['Schematismus']['shared_with'] == ['anna', 'ben', 'lena']

    def test_someone_given_one_dataset_sees_no_workspace(self, client):
        api, _ = client
        assert workspaces(api, RITA) == {}

    def test_an_admin_sees_whose_sandbox_each_is(self, client):
        api, _ = client
        listed = workspaces(api, ROOT)
        assert sorted(listed) == ['Schematismus', "anna's Sandbox", "max's Sandbox"]
        assert (listed["anna's Sandbox"]['sandbox_of'], listed["max's Sandbox"]['sandbox_of']) == ('anna', 'max')

    def test_it_says_who_may_manage_each(self, client):
        api, _ = client
        assert {name: g['can_manage'] for name, g in workspaces(api, ANNA).items()} == \
            {'Sandbox': False, 'Schematismus': True}
        assert workspaces(api, BEN)['Schematismus']['can_manage'] is False


class TestWhatSomeoneGivenOneDatasetLearns:
    """Being given one dataset is not being let into the workspace that holds it (decision 334)."""

    def test_the_dataset_names_no_workspace(self, client):
        api, _ = client
        assert [(j['id'], j['group_id']) for j in api.get('/api/jobs', headers=RITA).json()] == [('j1', None)]
        assert api.get('/api/jobs/j1', params={'pages': 'false'}, headers=RITA).json()['group_id'] is None
        assert api.get('/api/jobs/j1/info', headers=RITA).json()['group'] is None

    def test_a_member_still_sees_where_it_is(self, client):
        api, _ = client
        assert api.get('/api/jobs/j1', params={'pages': 'false'}, headers=LENA).json()['group_id'] == 1
        assert api.get('/api/jobs/j1/info', headers=LENA).json()['group'] == 'Schematismus'

    def test_the_workspace_is_not_found_by_its_id(self, client):
        api, _ = client
        assert api.put('/api/groups/1/share', json={'usernames': ['rita']}, headers=RITA).status_code == 404

    def test_a_profile_names_only_workspaces_its_viewer_belongs_to(self, client):
        api, _ = client
        assert api.get('/api/people/anna/profile', headers=ANNA).json()['stats']['groups'] == [
            {'id': 1, 'name': 'Schematismus'}]
        assert api.get('/api/people/anna/profile', headers=RITA).json()['stats']['groups'] == []


class TestWhereANewDatasetStarts:
    """The workspace of someone's newest dataset is where the wizard starts (decision 332)."""

    def last_used(self, api, headers) -> dict[str, bool]:
        return {name: g['last_used'] for name, g in workspaces(api, headers).items()}

    def test_the_workspace_of_their_newest_dataset_is_marked(self, client):
        api, conn = client
        conn.execute("UPDATE jobs SET created_at = '2026-01-01 10:00:00' WHERE id = 'j-anna'")
        conn.execute("UPDATE jobs SET created_at = '2026-02-01 10:00:00' WHERE id = 'j1'")
        assert self.last_used(api, ANNA) == {'Sandbox': False, 'Schematismus': True}
        conn.execute("UPDATE jobs SET created_at = '2026-03-01 10:00:00' WHERE id = 'j-anna'")
        assert self.last_used(api, ANNA) == {'Sandbox': True, 'Schematismus': False}

    def test_not_a_workspace_they_have_left(self, client):
        api, conn = client
        conn.execute("UPDATE jobs SET created_at = '2026-01-01 10:00:00' WHERE id = 'j-anna'")
        conn.execute("UPDATE jobs SET created_at = '2026-02-01 10:00:00' WHERE id = 'j1'")
        conn.execute("DELETE FROM group_assignees WHERE group_id = 1 AND username = 'anna'")
        assert self.last_used(api, ANNA) == {'Sandbox': False}


class TestManagingAWorkspace:
    def test_a_manager_creates_one_and_belongs_to_it(self, client):
        api, _ = client
        response = api.post('/api/groups', json={'name': 'Spanish Letters'}, headers=MAX)
        assert response.status_code == 200, response.text
        assert workspaces(api, MAX)['Spanish Letters']['shared_with'] == ['max']

    def test_a_reviewer_creates_none(self, client):
        api, _ = client
        assert api.post('/api/groups', json={'name': 'Mine'}, headers=BEN).status_code == 403

    def test_its_managers_rename_it_and_add_people(self, client):
        api, conn = client
        assert api.patch('/api/groups/1', json={'name': 'Schematismus Linz'}, headers=ANNA).status_code == 200
        response = api.put('/api/groups/1/share', json={'usernames': ['anna', 'ben', 'lena', 'max']}, headers=ANNA)
        assert response.status_code == 200, response.text
        assert [r[0] for r in conn.execute(
            'SELECT username FROM group_assignees WHERE group_id = 1 ORDER BY username')] == ['anna', 'ben', 'lena', 'max']

    def test_a_reviewer_in_it_may_not_and_someone_outside_does_not_see_it(self, client):
        api, conn = client
        assert api.patch('/api/groups/1', json={'name': 'Renamed'}, headers=BEN).status_code == 403
        assert api.patch('/api/groups/1', json={'name': 'Renamed'}, headers=MAX).status_code == 404
        assert conn.execute('SELECT name FROM groups WHERE id = 1').fetchone()[0] == 'Schematismus'

    def test_only_an_empty_one_is_deleted(self, client):
        api, conn = client
        refused = api.delete('/api/groups/1', headers=ANNA)
        assert refused.status_code == 409
        assert refused.json()['detail'] == 'move or delete its 2 datasets first'
        empty = api.post('/api/groups', json={'name': 'Empty'}, headers=ANNA).json()['id']
        assert api.delete(f'/api/groups/{empty}', headers=ANNA).status_code == 200
        assert conn.execute('SELECT COUNT(*) FROM groups WHERE id IN (1, ?)', (empty,)).fetchone()[0] == 1


class TestTheSandbox:
    def test_nobody_is_added_to_it_or_to_a_dataset_in_it(self, client):
        api, conn = client
        assert api.put('/api/groups/2/share', json={'usernames': ['ben']}, headers=ANNA).status_code == 409
        refused = api.put('/api/jobs/j-anna/share', json={'usernames': ['ben']}, headers=ANNA)
        assert refused.status_code == 409
        assert refused.json()['detail'] == 'a dataset in a Sandbox is shared by moving it into a workspace'
        assert conn.execute("SELECT COUNT(*) FROM job_assignees WHERE job_id = 'j-anna'").fetchone()[0] == 0

    def test_it_is_neither_renamed_nor_deleted(self, client):
        api, _ = client
        assert api.patch('/api/groups/2', json={'name': 'Mine'}, headers=ANNA).status_code == 409
        assert api.delete('/api/groups/2', headers=ROOT).status_code == 409

    def test_a_new_dataset_lands_in_its_creators_sandbox_made_when_first_needed(self, client):
        api, conn = client
        assert sandbox_of(conn, 'lena') is None
        response = create(api, LENA)
        assert response.status_code == 200, response.text
        assert group_of(conn, response.json()['job_id']) == sandbox_of(conn, 'lena') is not None

    def test_a_new_dataset_is_made_in_a_workspace_its_creator_belongs_to(self, client):
        api, conn = client
        response = create(api, LENA, group_id='1')
        assert response.status_code == 200, response.text
        assert group_of(conn, response.json()['job_id']) == 1

    def test_not_in_a_workspace_its_creator_does_not_belong_to(self, client):
        api, conn = client
        assert create(api, MAX, group_id='1').status_code == 404
        assert conn.execute("SELECT COUNT(*) FROM jobs WHERE name = 'New volume'").fetchone()[0] == 0


class TestMovingADataset:
    def test_out_of_a_sandbox_into_a_workspace_its_mover_belongs_to(self, client):
        api, conn = client
        response = api.patch('/api/jobs/j-anna', json={'group_id': 1}, headers=ANNA)
        assert response.status_code == 200, response.text
        assert group_of(conn, 'j-anna') == 1

    def test_not_into_a_workspace_the_mover_does_not_belong_to(self, client):
        api, conn = client
        assert api.patch('/api/jobs/j-max', json={'group_id': 1}, headers=MAX).status_code == 404
        assert group_of(conn, 'j-max') == 3

    def test_out_of_a_workspace_it_goes_back_to_its_creators_sandbox(self, client):
        api, conn = client
        response = api.patch('/api/jobs/j2', json={'group_id': None}, headers=ANNA)
        assert response.status_code == 200, response.text
        assert group_of(conn, 'j2') == sandbox_of(conn, 'lena') is not None

    def test_into_its_creators_sandbox_by_its_id_as_by_none(self, client):
        api, conn = client
        lena_sandbox = store.sandbox_id(conn, 'lena')
        response = api.patch('/api/jobs/j2', json={'group_id': lena_sandbox}, headers=ROOT)
        assert response.status_code == 200, response.text
        assert group_of(conn, 'j2') == lena_sandbox

    def test_a_sandbox_holds_only_its_owners_datasets(self, client):
        api, conn = client
        anna_sandbox = sandbox_of(conn, 'anna')
        response = api.patch('/api/jobs/j2', json={'group_id': anna_sandbox}, headers=ANNA)
        assert (response.status_code, response.json()['detail']) == (
            409, "a Sandbox holds only the datasets of the person it belongs to")
        assert group_of(conn, 'j2') == 1

    def test_into_the_sandbox_it_leaves_the_people_it_was_given_to(self, client):
        api, conn = client
        response = api.patch('/api/jobs/j1', json={'group_id': None}, headers=ANNA)
        assert response.status_code == 200, response.text
        assert group_of(conn, 'j1') == sandbox_of(conn, 'anna')
        assert conn.execute("SELECT COUNT(*) FROM job_assignees WHERE job_id = 'j1'").fetchone()[0] == 0
        assert dataset_ids(api, RITA) == []

    def test_between_workspaces_it_keeps_them(self, client):
        api, conn = client
        conn.execute("INSERT INTO groups (id, name, owner) VALUES (4, 'Briefe', 'anna')")
        conn.execute("INSERT INTO group_assignees (group_id, username) VALUES (4, 'anna')")
        assert api.patch('/api/jobs/j1', json={'group_id': 4}, headers=ANNA).status_code == 200
        assert [r[0] for r in conn.execute("SELECT username FROM job_assignees WHERE job_id = 'j1'")] == ['rita']

    def test_a_reviewer_moves_nothing(self, client):
        api, conn = client
        response = api.patch('/api/jobs/j1', json={'group_id': None}, headers=BEN)
        assert response.status_code == 403
        assert group_of(conn, 'j1') == 1


class TestGivingOneDataset:
    """Adding people, to a whole workspace or to one dataset of it, is its Managers' (decision 320)."""

    def test_a_manager_of_the_workspace_gives_a_dataset_someone_made_there(self, client):
        api, conn = client
        response = api.put('/api/jobs/j2/share', json={'usernames': ['rita']}, headers=ANNA)
        assert response.status_code == 200, response.text
        assert [r[0] for r in conn.execute("SELECT username FROM job_assignees WHERE job_id = 'j2'")] == ['rita']

    def test_the_annotator_who_made_it_does_not(self, client):
        api, conn = client
        response = api.put('/api/jobs/j2/share', json={'usernames': ['rita']}, headers=LENA)
        assert (response.status_code, response.json()['detail']) == (
            403, 'not permitted: this takes a Manager of the workspace')
        assert conn.execute("SELECT COUNT(*) FROM job_assignees WHERE job_id = 'j2'").fetchone()[0] == 0


class TestARoleOnOneDataset:
    def role_on(self, api, job_id, headers) -> str:
        return api.get(f'/api/jobs/{job_id}', params={'pages': 'false'}, headers=headers).json()['my_role']

    def test_an_annotator_is_made_reviewer_on_one_dataset(self, client):
        api, _ = client
        assert self.role_on(api, 'j1', LENA) == 'annotator'
        response = api.put('/api/jobs/j1/share', json={'usernames': ['rita', 'lena'], 'roles': {'lena': 'reviewer'}},
                           headers=ANNA)
        assert response.status_code == 200, response.text
        assert self.role_on(api, 'j1', LENA) == 'reviewer'
        assert api.patch('/api/lines/1', json={'checked': True}, headers=LENA).status_code == 200

    def test_the_list_gives_the_same_role_as_the_dataset(self, client):
        api, _ = client
        api.put('/api/jobs/j1/share', json={'usernames': ['rita', 'lena'], 'roles': {'lena': 'reviewer'}}, headers=ANNA)
        listed = {j['id']: j['my_role'] for j in api.get('/api/jobs', headers=LENA).json()}
        assert listed == {'j1': 'reviewer', 'j2': 'manager'}

    def test_a_reviewer_is_made_annotator_on_one_dataset(self, client):
        api, conn = client
        api.put('/api/jobs/j1/share', json={'usernames': ['rita'], 'roles': {'rita': 'annotator'}}, headers=ANNA)
        assert self.role_on(api, 'j1', RITA) == 'annotator'
        assert api.patch('/api/lines/1', json={'checked': True}, headers=RITA).status_code == 403
        assert conn.execute('SELECT checked FROM lines WHERE id = 1').fetchone()[0] == 0

    def test_a_manager_is_lowered_by_nothing(self, client):
        api, _ = client
        api.put('/api/jobs/j1/share', json={'usernames': ['max'], 'roles': {'max': 'annotator'}}, headers=ANNA)
        assert self.role_on(api, 'j1', MAX) == 'manager'

    def test_only_annotator_and_reviewer_are_swapped(self, client):
        api, _ = client
        response = api.put('/api/jobs/j1/share', json={'usernames': ['rita'], 'roles': {'rita': 'manager'}},
                           headers=ANNA)
        assert response.status_code == 400
        assert response.json()['detail'] == 'on one dataset someone is an Annotator or a Reviewer'


class TestAdminsLeaveNoTrace:
    def test_opening_a_restricted_dataset_records_nothing(self, client):
        api, conn = client
        conn.execute("UPDATE jobs SET use_export = 0 WHERE id = 'j1'")
        conn.commit()
        assert api.get('/api/jobs/j1', headers=ROOT).status_code == 200
        assert api.get('/api/jobs/j1/transcript', headers=ROOT).status_code in (200, 404)
        assert conn.execute("SELECT COUNT(*) FROM job_log WHERE action = 'admin_visit'").fetchone()[0] == 0
        assert 'admin_visits' not in api.get('/api/jobs/j1/data-use', headers=ANNA).json()
