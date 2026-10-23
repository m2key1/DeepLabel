"""Group names are project names, so the list is scoped the way the dataset list is:
your own, ones shared with you, and ones holding a dataset you can reach. It used to
return every group in the instance to anyone signed in.
"""
import pytest
from fastapi.testclient import TestClient

from app import store
from app.deps import get_db
from app.main import app

SECRET = 'test-secret'
ADMIN = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'root', 'X-Auth-Role': 'admin'}
ALICE = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'alice', 'X-Auth-Role': 'member'}
BOB = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'bob', 'X-Auth-Role': 'member'}
VIEWER = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'vera', 'X-Auth-Role': 'viewer'}


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    conn = store.connect(tmp_path / 'app.db')
    conn.executescript("""
        INSERT INTO groups (id, name, owner) VALUES
            (1, 'Hers empty', 'alice'),
            (2, 'Shared with her', 'bob'),
            (3, 'Holds her dataset', 'bob'),
            (4, 'Holds one shared with her', 'bob'),
            (5, 'None of her business', 'bob');
        INSERT INTO group_assignees (group_id, username) VALUES (2, 'alice');
        INSERT INTO jobs (id, name, owner, status, group_id) VALUES
            ('j-hers',   'Hers',   'alice', 'done', 3),
            ('j-shared', 'Shared', 'bob',   'done', 4),
            ('j-bobs',   'Bobs',   'bob',   'done', 5);
        INSERT INTO job_assignees (job_id, username) VALUES ('j-shared', 'alice');
    """)
    conn.commit()
    app.dependency_overrides[get_db] = lambda: conn
    yield TestClient(app)
    app.dependency_overrides.clear()
    conn.close()


def names(client, headers):
    response = client.get('/api/groups', headers=headers)
    assert response.status_code == 200, response.text
    return sorted(g['name'] for g in response.json())


def test_an_admin_sees_every_group(client):
    assert names(client, ADMIN) == [
        'Hers empty', 'Holds her dataset', 'Holds one shared with her',
        'None of her business', 'Shared with her']


def test_a_member_sees_only_the_groups_they_can_reach(client):
    """The one holding only Bob's dataset is not among them - that is the leak."""
    assert names(client, ALICE) == [
        'Hers empty', 'Holds her dataset', 'Holds one shared with her', 'Shared with her']


def test_an_empty_group_of_your_own_still_shows(client):
    """It is how the first dataset gets moved into it."""
    assert 'Hers empty' in names(client, ALICE)


def test_a_group_stops_showing_when_her_dataset_leaves_it(client):
    """Reachability is not cached anywhere: it follows wherever the datasets sit now."""
    assert 'Holds her dataset' in names(client, ALICE)
    moved = client.patch('/api/jobs/j-hers', headers=ALICE, json={'group_id': None})
    assert moved.status_code == 200, moved.text
    assert 'Holds her dataset' not in names(client, ALICE)


def test_the_member_list_matches_the_datasets_they_are_offered(client):
    """The two lists back the same picker, so a group heading with nothing under it
    would read as a project they cannot open."""
    jobs = client.get('/api/jobs', headers=ALICE).json()
    reachable = {j['group_id'] for j in jobs if j['group_id'] is not None}
    listed = {g['id'] for g in client.get('/api/groups', headers=ALICE).json()}
    assert reachable <= listed


def group(client, group_id, headers=ALICE):
    return next((g for g in client.get('/api/groups', headers=headers).json()
                 if g['id'] == group_id), None)


class TestFiling:
    """Filing a dataset under a project shares it with that project's people and puts the
    project in the filer's list, so only a project they can already reach takes it."""

    def filed_under(self, client):
        return client.get('/api/jobs/j-hers', headers=ALICE).json()['group_id']

    def test_a_project_she_cannot_reach_answers_as_if_it_did_not_exist(self, client):
        refused = client.patch('/api/jobs/j-hers', headers=ALICE, json={'group_id': 5})

        assert refused.status_code == 404
        assert refused.json()['detail'] == 'group not found'
        assert self.filed_under(client) == 3
        assert 'None of her business' not in names(client, ALICE)

    @pytest.mark.parametrize('group_id', [1, 2, 4])
    def test_a_project_she_can_reach_takes_it(self, client, group_id):
        filed = client.patch('/api/jobs/j-hers', headers=ALICE, json={'group_id': group_id})

        assert filed.status_code == 200, filed.text
        assert self.filed_under(client) == group_id

    def test_an_admin_may_file_under_any_of_them(self, client):
        filed = client.patch('/api/jobs/j-hers', headers=ADMIN, json={'group_id': 5})

        assert filed.status_code == 200, filed.text
        assert self.filed_under(client) == 5

    def test_moving_a_selection_is_held_to_the_same_rule(self, client):
        refused = client.patch('/api/bulk/group', headers=ALICE,
                               json={'job_ids': ['j-hers'], 'group_id': 5})

        assert refused.status_code == 400
        assert refused.json()['detail'] == 'group not found'
        assert self.filed_under(client) == 3


class TestCreating:
    def test_a_member_can_start_a_project_and_owns_it(self, client):
        response = client.post('/api/groups', json={'name': 'Schematismus'}, headers=ALICE)

        assert response.status_code == 200, response.text
        assert response.json()['owner'] == 'alice'
        assert 'Schematismus' in names(client, ALICE)

    def test_the_name_is_trimmed_and_must_say_something(self, client):
        assert client.post('/api/groups', json={'name': '  Padded  '},
                           headers=ALICE).json()['name'] == 'Padded'
        assert client.post('/api/groups', json={'name': '   '}, headers=ALICE).status_code == 400

    def test_two_projects_cannot_share_a_name_whatever_the_case(self, client):
        client.post('/api/groups', json={'name': 'Schematismus'}, headers=ALICE)

        clash = client.post('/api/groups', json={'name': 'schematismus'}, headers=ALICE)

        assert clash.status_code == 409
        assert 'already exists' in clash.json()['detail']

    def test_someone_who_may_only_look_cannot_start_one(self, client):
        assert client.post('/api/groups', json={'name': 'Hers'}, headers=VIEWER).status_code == 403


class TestRenaming:
    def test_the_owner_may_rename_it(self, client):
        response = client.patch('/api/groups/1', json={'name': 'Renamed'}, headers=ALICE)

        assert response.status_code == 200
        assert group(client, 1)['name'] == 'Renamed'

    def test_keeping_its_own_name_is_not_a_clash_with_itself(self, client):
        assert client.patch('/api/groups/1', json={'name': 'Hers empty'},
                            headers=ALICE).status_code == 200

    def test_a_project_cannot_be_renamed_to_nothing(self, client):
        assert client.patch('/api/groups/1', json={'name': '   '},
                            headers=ALICE).status_code == 400

    def test_taking_another_projects_name_is_refused(self, client):
        assert client.patch('/api/groups/1', json={'name': 'Shared with her'},
                            headers=ALICE).status_code == 409

    def test_a_project_shared_with_her_is_not_hers_to_rename(self, client):
        assert client.patch('/api/groups/2', json={'name': 'Mine now'},
                            headers=ALICE).status_code == 403
        assert group(client, 2)['name'] == 'Shared with her'

    def test_a_project_she_cannot_reach_answers_as_if_it_did_not_exist(self, client):
        refused = client.patch('/api/groups/5', json={'name': 'Mine now'}, headers=ALICE)

        assert refused.status_code == 404
        assert group(client, 5, ADMIN)['name'] == 'None of her business'

    def test_an_admin_may_rename_any_of_them(self, client):
        assert client.patch('/api/groups/5', json={'name': 'Tidied'},
                            headers=ADMIN).status_code == 200

    def test_a_project_that_does_not_exist_is_a_404(self, client):
        assert client.patch('/api/groups/99', json={'name': 'Ghost'},
                            headers=ADMIN).status_code == 404


class TestSharing:
    def test_sharing_a_project_names_who_reaches_it(self, client):
        response = client.put('/api/groups/1/share', json={'usernames': ['bob', 'carol']},
                              headers=ALICE)

        assert response.status_code == 200
        assert response.json()['shared_with'] == ['bob', 'carol']
        assert group(client, 1, BOB)['shared_with'] == ['bob', 'carol']

    def test_sharing_replaces_the_list_rather_than_adding_to_it(self, client):
        client.put('/api/groups/1/share', json={'usernames': ['bob']}, headers=ALICE)

        client.put('/api/groups/1/share', json={'usernames': ['carol']}, headers=ALICE)

        assert group(client, 1)['shared_with'] == ['carol']

    def test_blanks_and_duplicates_are_not_people(self, client):
        response = client.put('/api/groups/1/share',
                              json={'usernames': ['bob', ' bob ', '  ', 'carol']}, headers=ALICE)

        assert response.json()['shared_with'] == ['bob', 'carol']

    def test_sharing_reaches_the_datasets_moved_in_later(self, client):
        """The point of sharing a project rather than each dataset."""
        client.put('/api/groups/1/share', json={'usernames': ['bob']}, headers=ALICE)
        client.patch('/api/jobs/j-hers', json={'group_id': 1}, headers=ALICE)

        listed = client.get('/api/jobs', headers=BOB).json()

        assert 'j-hers' in [j['id'] for j in listed]

    def test_a_project_shared_with_her_is_not_hers_to_share(self, client):
        assert client.put('/api/groups/2/share', json={'usernames': ['carol']},
                          headers=ALICE).status_code == 403
        assert group(client, 2)['shared_with'] == ['alice']

    def test_a_project_she_cannot_reach_answers_as_if_it_did_not_exist(self, client):
        refused = client.put('/api/groups/5/share', json={'usernames': ['alice']}, headers=ALICE)

        assert refused.status_code == 404
        assert group(client, 5, ADMIN)['shared_with'] == []


class TestDeleting:
    def test_the_datasets_survive_their_project(self, client):
        assert client.delete('/api/groups/3', headers=BOB).status_code == 200

        assert group(client, 3, ADMIN) is None
        job = client.get('/api/jobs/j-hers', headers=ALICE).json()
        assert job['group_id'] is None

    def test_a_project_shared_with_her_is_not_hers_to_delete(self, client):
        assert client.delete('/api/groups/2', headers=ALICE).status_code == 403
        assert group(client, 2) is not None

    def test_a_project_she_cannot_reach_answers_as_if_it_did_not_exist(self, client):
        assert client.delete('/api/groups/5', headers=ALICE).status_code == 404
        assert group(client, 5, ADMIN) is not None

    def test_an_admin_may_delete_any_of_them(self, client):
        assert client.delete('/api/groups/5', headers=ADMIN).status_code == 200

    def test_a_project_that_does_not_exist_is_a_404(self, client):
        assert client.delete('/api/groups/99', headers=ADMIN).status_code == 404


class TestSettingAWholeProject:
    def test_a_project_she_cannot_reach_answers_as_if_it_did_not_exist(self, client):
        refused = client.patch('/api/groups/5/jobs', json={'checked': True}, headers=ALICE)

        assert refused.status_code == 404
        assert client.get('/api/jobs/j-bobs', headers=ADMIN).json()['checked'] is False

    def test_a_project_she_reaches_through_a_shared_dataset_takes_it(self, client):
        response = client.patch('/api/groups/4/jobs', json={'checked': True}, headers=ALICE)

        assert response.status_code == 200, response.text
        assert response.json() == {'changed': [{'id': 'j-shared', 'name': 'Shared'}], 'skipped': []}
