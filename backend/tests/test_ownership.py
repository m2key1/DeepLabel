"""Inviting into workspaces and handing over ownership (#134, #79, decision 365): an admin adds a
newly invited account to workspaces at once, and a dataset's or a workspace's owner, or an admin,
hands it to someone else."""
import pytest
from fastapi.testclient import TestClient

from app import data_use, page_rows, store
from app.deps import get_db
from app.main import app

SECRET = 'test-secret'


def person(name: str, role: str) -> dict:
    return {'X-Frontend-Secret': SECRET, 'X-Auth-User': name, 'X-Auth-Role': role, 'X-Auth-Caps': ''}


ROOT = person('root', 'admin')
ANNA = person('anna', 'manager')
BEN = person('ben', 'manager')
LENA = person('lena', 'annotator')
MIA = person('mia', 'manager')


@pytest.fixture
def client(tmp_path, monkeypatch):
    """Anna's workspace Pfarre Gars has Anna, Ben and Lena in it, and Mia's Stift has Mia alone.
    In Pfarre Gars Anna made the Taufbuch and the Trauungsbuch, Lena the Sterbebuch and Ben the
    Firmbuch; Anna's Sandbox holds her Notizen."""
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    monkeypatch.setattr('app.config.JOBS_DIR', tmp_path / 'jobs')
    page_rows.forget_counts()
    conn = store.connect(tmp_path / 'app.db')
    conn.executescript("""
        INSERT INTO groups (id, name, owner, sandbox_of) VALUES
            (1, 'Pfarre Gars', 'anna', NULL), (2, 'Stift', 'mia', NULL), (3, '', 'anna', 'anna');
        INSERT INTO group_assignees (group_id, username) VALUES
            (1, 'anna'), (1, 'ben'), (1, 'lena'), (2, 'mia');
        INSERT INTO jobs (id, name, owner, status, group_id) VALUES
            ('j1', 'Taufbuch', 'anna', 'done', 1), ('j2', 'Trauungsbuch', 'anna', 'done', 1),
            ('j3', 'Sterbebuch', 'lena', 'done', 1), ('j4', 'Firmbuch', 'ben', 'done', 1),
            ('j5', 'Notizen', 'anna', 'done', 3);
    """)
    conn.commit()
    app.dependency_overrides[get_db] = lambda: conn
    yield TestClient(app), conn
    app.dependency_overrides.clear()
    page_rows.forget_counts()
    conn.close()


def members(conn, group_id) -> list[str]:
    return [r[0] for r in conn.execute('SELECT username FROM group_assignees WHERE group_id = ? ORDER BY username',
                                       (group_id,))]


def given_alone(conn, job_id) -> list[str]:
    return [r[0] for r in conn.execute('SELECT username FROM job_assignees WHERE job_id = ? ORDER BY username',
                                       (job_id,))]


def owners(conn) -> dict[str, str]:
    return {r[0]: r[1] for r in conn.execute('SELECT id, owner FROM jobs ORDER BY id')}


class TestAddingToWorkspaces:
    def test_an_admin_adds_an_invited_account_to_workspaces_at_once(self, client):
        api, conn = client

        response = api.post('/api/people/julia@example.org/workspaces', headers=ROOT, json={'group_ids': [1, 2]})

        assert response.status_code == 200, response.text
        assert response.json() == {'added': ['Pfarre Gars', 'Stift'], 'missing': []}
        assert members(conn, 1) == ['anna', 'ben', 'julia@example.org', 'lena']
        assert members(conn, 2) == ['julia@example.org', 'mia']

    def test_a_workspace_gone_meanwhile_is_skipped_and_named(self, client):
        api, conn = client

        response = api.post('/api/people/julia@example.org/workspaces', headers=ROOT, json={'group_ids': [2, 99]})

        assert response.json() == {'added': ['Stift'], 'missing': [99]}

    def test_nobody_is_added_to_a_sandbox(self, client):
        api, conn = client

        response = api.post('/api/people/julia@example.org/workspaces', headers=ROOT, json={'group_ids': [3]})

        assert response.json() == {'added': [], 'missing': [3]}
        assert members(conn, 3) == []

    def test_someone_already_in_stays_in_once(self, client):
        api, conn = client

        response = api.post('/api/people/ben/workspaces', headers=ROOT, json={'group_ids': [1]})

        assert response.json() == {'added': ['Pfarre Gars'], 'missing': []}
        assert members(conn, 1) == ['anna', 'ben', 'lena']

    def test_only_an_admin_adds_people_this_way(self, client):
        api, conn = client

        response = api.post('/api/people/julia@example.org/workspaces', headers=ANNA, json={'group_ids': [1]})

        assert response.status_code == 403
        assert members(conn, 1) == ['anna', 'ben', 'lena']


class TestHandingOverADataset:
    def test_the_owner_hands_a_dataset_to_someone_who_opens_it_as_its_owner(self, client):
        api, conn = client

        response = api.post('/api/jobs/j1/transfer', headers=ANNA, json={'to': 'mia'})

        assert response.status_code == 200, response.text
        assert response.json() == {'id': 'j1', 'owner': 'mia'}
        assert owners(conn)['j1'] == 'mia'
        assert given_alone(conn, 'j1') == []
        assert members(conn, 1) == ['anna', 'ben', 'lena']
        assert api.get('/api/jobs/j1', headers=MIA).status_code == 200

    def test_the_previous_owner_keeps_the_access_they_had_and_so_do_the_others(self, client):
        api, conn = client
        conn.execute("INSERT INTO job_assignees (job_id, username) VALUES ('j1', 'mia')")

        api.post('/api/jobs/j1/transfer', headers=ANNA, json={'to': 'ben'})

        assert owners(conn)['j1'] == 'ben'
        assert given_alone(conn, 'j1') == ['mia']
        assert api.get('/api/jobs/j1', headers=ANNA).status_code == 200

    def test_a_previous_owner_who_reached_it_only_as_its_owner_is_given_it_alone(self, client):
        api, conn = client
        conn.execute("DELETE FROM group_assignees WHERE username = 'anna'")

        api.post('/api/jobs/j1/transfer', headers=ROOT, json={'to': 'ben'})

        assert given_alone(conn, 'j1') == ['anna']

    def test_an_annotator_who_hands_over_their_dataset_no_longer_manages_it(self, client):
        api, conn = client

        response = api.post('/api/jobs/j3/transfer', headers=LENA, json={'to': 'ben'})
        delete = api.delete('/api/jobs/j3', headers=LENA)

        assert response.status_code == 200, response.text
        assert delete.status_code == 403
        assert owners(conn)['j3'] == 'ben'

    def test_only_its_owner_or_an_admin_hands_it_over(self, client):
        api, conn = client

        refused = api.post('/api/jobs/j1/transfer', headers=BEN, json={'to': 'ben'})
        by_admin = api.post('/api/jobs/j4/transfer', headers=ROOT, json={'to': 'lena'})

        assert refused.status_code == 403
        assert refused.json()['detail'] == "Only the dataset's owner or an admin hands it over"
        assert by_admin.status_code == 200, by_admin.text
        assert owners(conn) == {'j1': 'anna', 'j2': 'anna', 'j3': 'lena', 'j4': 'lena', 'j5': 'anna'}

    @pytest.mark.parametrize('to, detail', [('anna', 'anna owns it already'), (' ', 'Name the person to hand it to')])
    def test_it_goes_to_someone_else(self, client, to, detail):
        api, conn = client

        response = api.post('/api/jobs/j1/transfer', headers=ANNA, json={'to': to})

        assert response.status_code == 400
        assert response.json()['detail'] == detail
        assert owners(conn)['j1'] == 'anna'

    def test_a_sandbox_dataset_is_not_handed_over(self, client):
        api, conn = client

        response = api.post('/api/jobs/j5/transfer', headers=ANNA, json={'to': 'ben'})

        assert response.status_code == 409
        assert response.json()['detail'] == 'A dataset in a Sandbox is moved into a workspace before it is handed over'
        assert owners(conn)['j5'] == 'anna'

    def test_the_handover_is_written_to_the_datasets_log(self, client):
        api, conn = client

        api.post('/api/jobs/j1/transfer', headers=ANNA, json={'to': 'ben'})

        row = conn.execute("SELECT username, action, detail FROM job_log WHERE job_id = 'j1'").fetchone()
        assert tuple(row) == ('anna', 'transfer', '{"from": "anna", "to": "ben"}')


class TestHandingOverAWorkspace:
    def test_the_owner_hands_over_a_workspace_with_the_datasets_they_made_in_it(self, client):
        api, conn = client

        response = api.post('/api/groups/1/transfer', headers=ANNA, json={'to': 'mia'})

        assert response.status_code == 200, response.text
        assert response.json() == {'id': 1, 'owner': 'mia', 'datasets': 2}
        assert conn.execute('SELECT owner FROM groups WHERE id = 1').fetchone()[0] == 'mia'
        assert members(conn, 1) == ['anna', 'ben', 'lena', 'mia']
        assert owners(conn) == {'j1': 'mia', 'j2': 'mia', 'j3': 'lena', 'j4': 'ben', 'j5': 'anna'}
        assert [r[0] for r in conn.execute("SELECT job_id FROM job_log WHERE action = 'transfer' ORDER BY job_id")] == [
            'j1', 'j2']

    def test_the_datasets_can_stay_with_their_maker(self, client):
        api, conn = client

        response = api.post('/api/groups/1/transfer', headers=ANNA, json={'to': 'mia', 'datasets': False})

        assert response.json() == {'id': 1, 'owner': 'mia', 'datasets': 0}
        assert owners(conn)['j1'] == 'anna'

    def test_only_its_owner_or_an_admin_hands_it_over(self, client):
        api, conn = client

        refused = api.post('/api/groups/1/transfer', headers=BEN, json={'to': 'ben'})
        by_admin = api.post('/api/groups/2/transfer', headers=ROOT, json={'to': 'anna'})

        assert refused.status_code == 403
        assert refused.json()['detail'] == "Only the workspace's owner or an admin hands it over"
        assert by_admin.status_code == 200, by_admin.text
        assert members(conn, 2) == ['anna', 'mia']

    def test_a_sandbox_is_not_handed_over(self, client):
        api, conn = client

        response = api.post('/api/groups/3/transfer', headers=ANNA, json={'to': 'ben'})

        assert response.status_code == 409
        assert response.json()['detail'] == 'A Sandbox stays with the person it belongs to'

    def test_a_handover_failing_halfway_changes_nothing(self, client, monkeypatch):
        """The workspace and its datasets change hands together or not at all (#169)."""
        api, conn = client
        logged = []
        log = data_use.log

        def log_then_fail(*args, **kwargs):
            logged.append(args)
            if len(logged) == 2:
                raise RuntimeError('disk full')
            log(*args, **kwargs)
        monkeypatch.setattr('app.routes.transfers.data_use.log', log_then_fail)

        with pytest.raises(RuntimeError):
            api.post('/api/groups/1/transfer', headers=ANNA, json={'to': 'mia'})
        conn.rollback()

        assert conn.execute('SELECT owner FROM groups WHERE id = 1').fetchone()[0] == 'anna'
        assert owners(conn) == {'j1': 'anna', 'j2': 'anna', 'j3': 'lena', 'j4': 'ben', 'j5': 'anna'}
        assert members(conn, 1) == ['anna', 'ben', 'lena']

    def test_a_workspace_goes_to_someone_else(self, client):
        api, _ = client

        response = api.post('/api/groups/1/transfer', headers=ANNA, json={'to': 'anna'})

        assert response.status_code == 400
        assert response.json()['detail'] == 'anna owns it already'
