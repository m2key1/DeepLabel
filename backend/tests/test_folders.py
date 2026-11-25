"""Nested folders in a workspace (#133, decision 366): its Managers make, rename, move and delete
them, whoever may move a dataset files it, and a folder never changes who sees a dataset."""
import pytest
from fastapi.testclient import TestClient

from app import page_rows, store
from app.deps import get_db
from app.main import app

SECRET = 'test-secret'


def person(name: str, role: str) -> dict:
    return {'X-Frontend-Secret': SECRET, 'X-Auth-User': name, 'X-Auth-Role': role, 'X-Auth-Caps': ''}


ROOT = person('root', 'admin')
ANNA = person('anna', 'manager')
LENA = person('lena', 'annotator')
MIA = person('mia', 'manager')


@pytest.fixture
def client(tmp_path, monkeypatch):
    """Pfarre Gars has Anna and Lena in it, the Stift Anna and Mia, and the empty Archiv Anna alone.
    In Pfarre Gars Anna made the Taufbuch and the Trauungsbuch and Lena the Sterbebuch; Mia made the
    Urbar in the Stift, and Anna's Sandbox holds her Notizen."""
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    monkeypatch.setattr('app.config.JOBS_DIR', tmp_path / 'jobs')
    page_rows.forget_counts()
    conn = store.connect(tmp_path / 'app.db')
    conn.executescript("""
        INSERT INTO groups (id, name, owner, sandbox_of) VALUES
            (1, 'Pfarre Gars', 'anna', NULL), (2, 'Stift', 'mia', NULL), (3, '', 'anna', 'anna'),
            (4, 'Archiv', 'anna', NULL);
        INSERT INTO group_assignees (group_id, username) VALUES
            (1, 'anna'), (1, 'lena'), (2, 'anna'), (2, 'mia'), (4, 'anna');
        INSERT INTO jobs (id, name, owner, status, group_id) VALUES
            ('j1', 'Taufbuch', 'anna', 'done', 1), ('j2', 'Trauungsbuch', 'anna', 'done', 1),
            ('j3', 'Sterbebuch', 'lena', 'done', 1), ('j4', 'Urbar', 'mia', 'done', 2),
            ('j5', 'Notizen', 'anna', 'done', 3);
    """)
    conn.commit()
    app.dependency_overrides[get_db] = lambda: conn
    yield TestClient(app), conn
    app.dependency_overrides.clear()
    page_rows.forget_counts()
    conn.close()


def make(api, group_id: int, name: str, parent_id: int | None = None, who: dict = ANNA) -> int:
    response = api.post(f'/api/groups/{group_id}/folders', headers=who, json={'name': name, 'parent_id': parent_id})
    assert response.status_code == 200, response.text
    return response.json()['id']


def tree(conn, group_id: int) -> set[tuple[str, str | None]]:
    """Each folder of the workspace by name, with the name of the folder holding it."""
    return {(r[0], r[1]) for r in conn.execute(
        'SELECT f.name, p.name FROM folders f LEFT JOIN folders p ON p.id = f.parent_id WHERE f.group_id = ?',
        (group_id,))}


def filed(conn) -> dict[str, str | None]:
    return {r[0]: r[1] for r in conn.execute(
        'SELECT j.id, f.name FROM jobs j LEFT JOIN folders f ON f.id = j.folder_id ORDER BY j.id')}


def folders_listed(api, group_id: int, who: dict = ANNA) -> list[dict]:
    return next(g for g in api.get('/api/groups', headers=who).json() if g['id'] == group_id)['folders']


class TestMakingFolders:
    def test_a_manager_of_the_workspace_makes_a_folder_and_one_inside_it(self, client):
        api, conn = client

        response = api.post('/api/groups/1/folders', headers=ANNA, json={'name': '  Taufbücher ', 'parent_id': None})
        assert response.status_code == 200, response.text
        taufbuecher = response.json()['id']
        assert response.json() == {'id': taufbuecher, 'name': 'Taufbücher', 'parent_id': None}
        year = make(api, 1, '1891', taufbuecher)

        assert folders_listed(api, 1) == [
            {'id': year, 'name': '1891', 'parent_id': taufbuecher},
            {'id': taufbuecher, 'name': 'Taufbücher', 'parent_id': None},
        ]
        assert folders_listed(api, 1, LENA) == folders_listed(api, 1)
        assert folders_listed(api, 2) == []

    def test_a_sandbox_lists_no_folders_and_takes_none(self, client):
        api, conn = client

        response = api.post('/api/groups/3/folders', headers=ANNA, json={'name': 'Entwürfe', 'parent_id': None})

        assert response.status_code == 409
        assert response.json()['detail'] == 'A Sandbox has no folders'
        assert folders_listed(api, 3) == []

    def test_a_name_is_taken_once_among_its_neighbours_whatever_its_case(self, client):
        api, conn = client
        taufbuecher = make(api, 1, 'Taufbücher')
        make(api, 1, '1891', taufbuecher)

        clash = api.post('/api/groups/1/folders', headers=ANNA, json={'name': 'TAUFBÜCHER', 'parent_id': None})
        nested_clash = api.post('/api/groups/1/folders', headers=ANNA, json={'name': '1891', 'parent_id': taufbuecher})
        make(api, 1, '1891')
        make(api, 4, 'Taufbücher')

        assert (clash.status_code, clash.json()['detail']) == (409, 'A folder named "TAUFBÜCHER" is there already')
        assert nested_clash.status_code == 409
        assert tree(conn, 1) == {('Taufbücher', None), ('1891', 'Taufbücher'), ('1891', None)}

    def test_a_folder_needs_a_name(self, client):
        api, conn = client

        response = api.post('/api/groups/1/folders', headers=ANNA, json={'name': '  ', 'parent_id': None})

        assert (response.status_code, response.json()['detail']) == (400, 'A folder needs a name')
        assert tree(conn, 1) == set()

    def test_only_the_workspaces_managers_and_admins_make_folders(self, client):
        api, conn = client

        annotator = api.post('/api/groups/1/folders', headers=LENA, json={'name': 'Lenas', 'parent_id': None})
        outsider = api.post('/api/groups/1/folders', headers=MIA, json={'name': 'Mias', 'parent_id': None})
        make(api, 1, 'Vom Admin', who=ROOT)

        assert annotator.status_code == 403
        assert outsider.status_code == 404
        assert tree(conn, 1) == {('Vom Admin', None)}

    def test_a_folder_is_made_inside_a_folder_of_the_same_workspace_only(self, client):
        api, conn = client
        stift_folder = make(api, 2, 'Urbare')

        response = api.post('/api/groups/1/folders', headers=ANNA, json={'name': 'Taufbücher', 'parent_id': stift_folder})

        assert response.status_code == 404
        assert tree(conn, 1) == set()


class TestRenamingAndMovingFolders:
    def test_a_manager_renames_a_folder(self, client):
        api, conn = client
        folder = make(api, 1, 'Taufbucher')

        response = api.patch(f'/api/folders/{folder}', headers=ANNA, json={'name': 'Taufbücher'})

        assert response.status_code == 200, response.text
        assert response.json() == {'id': folder, 'name': 'Taufbücher', 'parent_id': None}
        assert tree(conn, 1) == {('Taufbücher', None)}

    def test_a_rename_onto_a_neighbours_name_is_refused(self, client):
        api, conn = client
        make(api, 1, 'Taufbücher')
        folder = make(api, 1, 'Trauungsbücher')

        response = api.patch(f'/api/folders/{folder}', headers=ANNA, json={'name': 'taufbücher'})

        assert response.status_code == 409
        assert tree(conn, 1) == {('Taufbücher', None), ('Trauungsbücher', None)}

    def test_a_folder_moves_into_another_and_back_to_the_top_of_its_workspace(self, client):
        api, conn = client
        matriken = make(api, 1, 'Matriken')
        taufbuecher = make(api, 1, 'Taufbücher')

        into = api.patch(f'/api/folders/{taufbuecher}', headers=ANNA, json={'parent_id': matriken})
        assert into.status_code == 200, into.text
        assert tree(conn, 1) == {('Matriken', None), ('Taufbücher', 'Matriken')}

        out = api.patch(f'/api/folders/{taufbuecher}', headers=ANNA, json={'parent_id': None})
        assert out.status_code == 200, out.text
        assert tree(conn, 1) == {('Matriken', None), ('Taufbücher', None)}

    def test_a_folder_never_goes_inside_itself_or_below_itself(self, client):
        api, conn = client
        matriken = make(api, 1, 'Matriken')
        taufbuecher = make(api, 1, 'Taufbücher', matriken)
        year = make(api, 1, '1891', taufbuecher)

        itself = api.patch(f'/api/folders/{matriken}', headers=ANNA, json={'parent_id': matriken})
        below = api.patch(f'/api/folders/{matriken}', headers=ANNA, json={'parent_id': year})

        assert (itself.status_code, itself.json()['detail']) == (409, 'A folder cannot go inside itself')
        assert (below.status_code, below.json()['detail']) == (409, 'A folder cannot go inside itself')
        assert tree(conn, 1) == {('Matriken', None), ('Taufbücher', 'Matriken'), ('1891', 'Taufbücher')}

    def test_a_folder_stays_in_its_workspace(self, client):
        api, conn = client
        folder = make(api, 1, 'Taufbücher')
        stift_folder = make(api, 2, 'Urbare')

        response = api.patch(f'/api/folders/{folder}', headers=ANNA, json={'parent_id': stift_folder})

        assert (response.status_code, response.json()['detail']) == (409, 'A folder stays in its workspace')
        assert tree(conn, 1) == {('Taufbücher', None)}

    def test_a_move_onto_a_neighbours_name_is_refused(self, client):
        api, conn = client
        matriken = make(api, 1, 'Matriken')
        make(api, 1, '1891', matriken)
        year = make(api, 1, '1891')

        response = api.patch(f'/api/folders/{year}', headers=ANNA, json={'parent_id': matriken})

        assert (response.status_code, response.json()['detail']) == (409, 'A folder named "1891" is there already')
        assert tree(conn, 1) == {('Matriken', None), ('1891', 'Matriken'), ('1891', None)}

    def test_an_annotator_neither_renames_nor_moves_a_folder_and_an_outsider_is_not_told_it_exists(self, client):
        api, conn = client
        matriken = make(api, 1, 'Matriken')
        folder = make(api, 1, 'Taufbücher')

        renamed = api.patch(f'/api/folders/{folder}', headers=LENA, json={'name': 'Lenas'})
        moved = api.patch(f'/api/folders/{folder}', headers=LENA, json={'parent_id': matriken})
        outsider = api.patch(f'/api/folders/{folder}', headers=MIA, json={'name': 'Mias'})

        assert (renamed.status_code, moved.status_code, outsider.status_code) == (403, 403, 404)
        assert tree(conn, 1) == {('Matriken', None), ('Taufbücher', None)}


class TestDeletingFolders:
    def test_what_a_deleted_folder_held_moves_up_to_the_folder_that_held_it(self, client):
        api, conn = client
        matriken = make(api, 1, 'Matriken')
        taufbuecher = make(api, 1, 'Taufbücher', matriken)
        make(api, 1, 'Beilagen', taufbuecher)
        conn.execute('UPDATE jobs SET folder_id = ? WHERE id IN (?, ?)', (taufbuecher, 'j1', 'j2'))
        conn.execute('UPDATE jobs SET folder_id = ? WHERE id = ?', (matriken, 'j3'))
        conn.commit()

        response = api.delete(f'/api/folders/{taufbuecher}', headers=ANNA)

        assert response.status_code == 200, response.text
        assert response.json() == {'datasets': 2, 'folders': 1}
        assert tree(conn, 1) == {('Matriken', None), ('Beilagen', 'Matriken')}
        assert filed(conn) == {'j1': 'Matriken', 'j2': 'Matriken', 'j3': 'Matriken', 'j4': None, 'j5': None}

    def test_what_a_top_folder_held_moves_to_the_top_of_the_workspace(self, client):
        api, conn = client
        matriken = make(api, 1, 'Matriken')
        make(api, 1, 'Taufbücher', matriken)
        conn.execute('UPDATE jobs SET folder_id = ? WHERE id = ?', (matriken, 'j1'))
        conn.commit()

        response = api.delete(f'/api/folders/{matriken}', headers=ANNA)

        assert response.json() == {'datasets': 1, 'folders': 1}
        assert tree(conn, 1) == {('Taufbücher', None)}
        assert filed(conn)['j1'] is None
        assert conn.execute("SELECT group_id FROM jobs WHERE id = 'j1'").fetchone()[0] == 1

    def test_a_folder_whose_name_is_taken_up_there_keeps_the_delete_from_happening(self, client):
        api, conn = client
        matriken = make(api, 1, 'Matriken')
        make(api, 1, 'Taufbücher', matriken)
        make(api, 1, 'Taufbücher')
        conn.execute('UPDATE jobs SET folder_id = ? WHERE id = ?', (matriken, 'j1'))
        conn.commit()

        response = api.delete(f'/api/folders/{matriken}', headers=ANNA)

        assert (response.status_code, response.json()['detail']) == (
            409, 'A folder named "Taufbücher" is there already: rename one of them first')
        assert tree(conn, 1) == {('Matriken', None), ('Taufbücher', 'Matriken'), ('Taufbücher', None)}
        assert filed(conn)['j1'] == 'Matriken'

    def test_an_annotator_does_not_delete_a_folder(self, client):
        api, conn = client
        folder = make(api, 1, 'Taufbücher')

        response = api.delete(f'/api/folders/{folder}', headers=LENA)

        assert response.status_code == 403
        assert tree(conn, 1) == {('Taufbücher', None)}

    def test_deleting_an_empty_workspace_takes_its_folders_along(self, client):
        api, conn = client
        make(api, 4, 'Kisten', make(api, 4, 'Regal'))

        response = api.delete('/api/groups/4', headers=ANNA)

        assert response.status_code == 200, response.text
        assert tree(conn, 4) == set()


class TestFilingDatasets:
    def test_the_datasets_manager_files_it_in_a_folder_and_back_at_the_top(self, client):
        api, conn = client
        folder = make(api, 1, 'Taufbücher')

        response = api.patch('/api/jobs/j1', headers=ANNA, json={'folder_id': folder})
        assert response.status_code == 200, response.text
        assert filed(conn)['j1'] == 'Taufbücher'
        listed = {j['id']: j['folder_id'] for j in api.get('/api/jobs', headers=LENA).json()}
        assert listed == {'j1': folder, 'j2': None, 'j3': None}

        back = api.patch('/api/jobs/j1', headers=ANNA, json={'folder_id': None})
        assert back.status_code == 200, back.text
        assert filed(conn)['j1'] is None

    def test_an_annotator_files_the_dataset_she_made_but_not_anyone_elses(self, client):
        api, conn = client
        folder = make(api, 1, 'Sterbebücher')

        own = api.patch('/api/jobs/j3', headers=LENA, json={'folder_id': folder})
        other = api.patch('/api/jobs/j1', headers=LENA, json={'folder_id': folder})

        assert (own.status_code, other.status_code) == (200, 403)
        assert filed(conn) == {'j1': None, 'j2': None, 'j3': 'Sterbebücher', 'j4': None, 'j5': None}

    def test_a_folder_of_another_workspace_takes_no_dataset_without_the_dataset_moving_there(self, client):
        api, conn = client
        stift_folder = make(api, 2, 'Urbare')

        response = api.patch('/api/jobs/j1', headers=ANNA, json={'folder_id': stift_folder})
        sandbox = api.patch('/api/jobs/j5', headers=ANNA, json={'folder_id': stift_folder})

        assert (response.status_code, response.json()['detail']) == (400, 'That folder is in another workspace')
        assert sandbox.status_code == 400
        assert filed(conn) == {'j1': None, 'j2': None, 'j3': None, 'j4': None, 'j5': None}

    def test_moving_to_another_workspace_leaves_the_folder_unless_one_there_is_named(self, client):
        api, conn = client
        folder = make(api, 1, 'Taufbücher')
        stift_folder = make(api, 2, 'Urbare')
        conn.execute("UPDATE jobs SET folder_id = ? WHERE id IN ('j1', 'j2')", (folder,))
        conn.commit()

        plain = api.patch('/api/jobs/j1', headers=ANNA, json={'group_id': 2})
        into = api.patch('/api/jobs/j2', headers=ANNA, json={'group_id': 2, 'folder_id': stift_folder})

        assert (plain.status_code, into.status_code) == (200, 200)
        assert {r[0]: (r[1], r[2]) for r in conn.execute(
            "SELECT j.id, j.group_id, f.name FROM jobs j LEFT JOIN folders f ON f.id = j.folder_id "
            "WHERE j.id IN ('j1', 'j2')")} == {'j1': (2, None), 'j2': (2, 'Urbare')}

    def test_back_to_the_sandbox_leaves_the_folder(self, client):
        api, conn = client
        folder = make(api, 1, 'Taufbücher')
        conn.execute("UPDATE jobs SET folder_id = ? WHERE id = 'j1'", (folder,))
        conn.commit()

        response = api.patch('/api/jobs/j1', headers=ANNA, json={'group_id': None})

        assert response.status_code == 200, response.text
        assert tuple(conn.execute("SELECT group_id, folder_id FROM jobs WHERE id = 'j1'").fetchone()) == (3, None)

    def test_a_selection_is_filed_in_one_go(self, client):
        api, conn = client
        folder = make(api, 1, 'Matriken')

        response = api.patch('/api/bulk/group', headers=ANNA,
                             json={'job_ids': ['j1', 'j2'], 'group_id': 1, 'folder_id': folder})
        mixed = api.patch('/api/bulk/group', headers=LENA,
                          json={'job_ids': ['j1', 'j3'], 'group_id': 1, 'folder_id': None})

        assert response.status_code == 200, response.text
        assert [d['id'] for d in response.json()['changed']] == ['j1', 'j2']
        assert mixed.status_code == 200, mixed.text
        assert mixed.json()['skipped'] == [{'id': 'j1', 'name': 'Taufbuch',
                                            'reason': 'not permitted: this takes a Manager'}]
        assert filed(conn) == {'j1': 'Matriken', 'j2': 'Matriken', 'j3': None, 'j4': None, 'j5': None}

    def test_a_workspace_wide_setting_never_files_its_datasets(self, client):
        api, conn = client
        folder = make(api, 1, 'Matriken')

        response = api.patch('/api/groups/1/jobs', headers=ANNA, json={'folder_id': folder})

        assert (response.status_code, response.json()['detail']) == (
            400, 'folder_id belongs to one dataset, not to a workspace')
        assert filed(conn)['j1'] is None

    def test_someone_given_a_dataset_alone_learns_neither_its_workspace_nor_its_folder(self, client):
        api, conn = client
        folder = make(api, 1, 'Taufbücher')
        conn.execute("UPDATE jobs SET folder_id = ? WHERE id = 'j1'", (folder,))
        conn.execute("INSERT INTO job_assignees (job_id, username) VALUES ('j1', 'mia')")
        conn.commit()

        alone = api.get('/api/jobs/j1', headers=MIA).json()
        listed = next(j for j in api.get('/api/jobs', headers=MIA).json() if j['id'] == 'j1')
        member = api.get('/api/jobs/j1', headers=LENA).json()

        assert (alone['group_id'], alone['folder_id']) == (None, None)
        assert (listed['group_id'], listed['folder_id']) == (None, None)
        assert (member['group_id'], member['folder_id']) == (1, folder)
