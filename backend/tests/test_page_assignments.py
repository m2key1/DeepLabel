"""Assigning pages (#137, decision 356): a Manager hands pages or ranges to the people who reach
the dataset; an annotator's page table and its counts leave out the pages assigned to someone
else, which a link still opens."""
import pytest
from fastapi.testclient import TestClient

from app import page_rows, store
from app.deps import get_db
from app.main import app

SECRET = 'test-secret'


def person(name: str, role: str) -> dict:
    return {'X-Frontend-Secret': SECRET, 'X-Auth-User': name, 'X-Auth-Role': role, 'X-Auth-Caps': ''}


ANNA = person('anna', 'manager')
BEN = person('ben', 'annotator')
LENA = person('lena', 'annotator')
RITA = person('rita', 'reviewer')
MAX = person('max', 'manager')


@pytest.fixture
def client(tmp_path, monkeypatch):
    """Anna's workspace Pfarre Gars, with Ben and Lena in it, holds her five-page Taufbuch;
    Rita was given the Taufbuch alone; Max is in neither. A second dataset holds page 9."""
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    monkeypatch.setattr('app.config.JOBS_DIR', tmp_path / 'jobs')
    page_rows.forget_counts()
    conn = store.connect(tmp_path / 'app.db')
    conn.executescript("""
        INSERT INTO groups (id, name, owner, sandbox_of) VALUES (1, 'Pfarre Gars', 'anna', NULL),
                                                                (2, '', 'max', 'max');
        INSERT INTO group_assignees (group_id, username) VALUES (1, 'anna'), (1, 'ben'), (1, 'lena');
        INSERT INTO jobs (id, name, owner, status, group_id) VALUES ('j1', 'Taufbuch', 'anna', 'done', 1),
                                                                    ('j2', 'Sterbebuch', 'max', 'done', 2);
        INSERT INTO job_assignees (job_id, username) VALUES ('j1', 'rita');
        INSERT INTO pages (id, job_id, idx, filename, source_file, status, width, height) VALUES
            (11, 'j1', 0, 'p1.png', '/nonexistent/p1.png', 'done', 1000, 1400),
            (12, 'j1', 1, 'p2.png', '/nonexistent/p2.png', 'done', 1000, 1400),
            (13, 'j1', 2, 'p3.png', '/nonexistent/p3.png', 'done', 1000, 1400),
            (14, 'j1', 3, 'p4.png', '/nonexistent/p4.png', 'done', 1000, 1400),
            (15, 'j1', 4, 'p5.png', '/nonexistent/p5.png', 'done', 1000, 1400),
            (99, 'j2', 0, 'q1.png', '/nonexistent/q1.png', 'done', 1000, 1400);
    """)
    conn.commit()
    app.dependency_overrides[get_db] = lambda: conn
    yield TestClient(app), conn
    app.dependency_overrides.clear()
    page_rows.forget_counts()
    conn.close()


def assign(api, headers, assignee, **pages):
    return api.put('/api/jobs/j1/assignments', headers=headers, json={'assignee': assignee, **pages})


def assigned(api, headers=ANNA) -> dict:
    response = api.get('/api/jobs/j1/assignments', headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


def table(api, headers, page_filter='all') -> list[int]:
    """The page numbers the page table lists under a filter, as the # column shows them."""
    response = api.get('/api/jobs/j1/page-rows', headers=headers, params={'filter': page_filter})
    assert response.status_code == 200, response.text
    return [row['idx'] + 1 for row in response.json()['rows']]


def counts(api, headers) -> dict[str, int]:
    response = api.get('/api/jobs/j1/page-rows', headers=headers, params={'limit': 1})
    assert response.status_code == 200, response.text
    return response.json()['counts']


class TestHandingOutPages:
    def test_a_manager_assigns_pages_by_number_and_the_rest_stay_unassigned(self, client):
        api, _ = client

        response = assign(api, ANNA, 'lena', numbers=[1, 2, 4])

        assert response.status_code == 200, response.text
        expected = {'people': [{'username': 'anna', 'pages': []}, {'username': 'ben', 'pages': []},
                               {'username': 'lena', 'pages': [1, 2, 4]}, {'username': 'rita', 'pages': []}],
                    'unassigned': [3, 5]}
        assert response.json() == expected
        assert assigned(api) == expected

    def test_a_page_given_to_someone_else_is_theirs_alone(self, client):
        api, _ = client
        assign(api, ANNA, 'lena', numbers=[1, 2])

        assert assign(api, ANNA, 'ben', page_ids=[12]).status_code == 200

        people = {p['username']: p['pages'] for p in assigned(api)['people']}
        assert (people['lena'], people['ben']) == ([1], [2])

    def test_nobody_takes_a_page_back(self, client):
        api, _ = client
        assign(api, ANNA, 'lena', numbers=[1, 2])

        assert assign(api, ANNA, None, numbers=[1]).status_code == 200

        answer = assigned(api)
        assert ({p['username']: p['pages'] for p in answer['people']}['lena'], answer['unassigned']) == \
            ([2], [1, 3, 4, 5])

    def test_the_dataset_creator_can_be_assigned_from_outside_the_workspace(self, client):
        api, conn = client
        conn.execute("DELETE FROM group_assignees WHERE username = 'anna'")
        conn.commit()

        assert assign(api, ANNA, 'anna', numbers=[5]).status_code == 200

        assert {p['username']: p['pages'] for p in assigned(api)['people']}['anna'] == [5]

    @pytest.mark.parametrize('who', [LENA, RITA], ids=['annotator', 'reviewer'])
    def test_only_a_manager_hands_out_pages(self, client, who):
        api, _ = client

        assert assign(api, who, who['X-Auth-User'], numbers=[1]).status_code == 403
        assert api.get('/api/jobs/j1/assignments', headers=who).status_code == 403
        assert assigned(api)['unassigned'] == [1, 2, 3, 4, 5]

    def test_someone_who_cannot_open_the_dataset_is_not_given_pages(self, client):
        api, _ = client

        response = assign(api, ANNA, 'max', numbers=[1])

        assert (response.status_code, response.json()['detail']) == (400, 'max cannot open this dataset')
        assert assigned(api)['unassigned'] == [1, 2, 3, 4, 5]

    @pytest.mark.parametrize('pages, detail', [
        ({'numbers': [5, 6]}, 'There is no page 6 in this dataset'),
        ({'page_ids': [11, 99]}, 'Page 99 is not in this dataset'),
        ({}, 'Name the pages by page_ids or by numbers'),
        ({'numbers': [1], 'page_ids': [11]}, 'Name the pages by page_ids or by numbers'),
    ], ids=['number past the end', 'another dataset page', 'no pages', 'both'])
    def test_pages_the_dataset_lacks_assign_nothing(self, client, pages, detail):
        api, _ = client

        response = assign(api, ANNA, 'lena', **pages)

        assert (response.status_code, response.json()['detail']) == (400, detail)
        assert assigned(api)['unassigned'] == [1, 2, 3, 4, 5]

    def test_a_range_over_a_deleted_page_passes_it_by(self, client):
        api, conn = client
        conn.execute('UPDATE pages SET deleted = 1 WHERE id = 14')
        conn.commit()

        response = assign(api, ANNA, 'lena', numbers=[3, 4, 5])

        assert response.status_code == 200, response.text
        assert ({p['username']: p['pages'] for p in response.json()['people']}['lena'],
                response.json()['unassigned']) == ([3, 5], [1, 2])
        assert conn.execute('SELECT COUNT(*) FROM page_assignees WHERE page_id = 14').fetchone()[0] == 0

    def test_nobody_takes_back_a_page_deleted_since(self, client):
        api, conn = client
        assign(api, ANNA, 'lena', numbers=[4])
        conn.execute('UPDATE pages SET deleted = 1 WHERE id = 14')
        conn.commit()

        assert assign(api, ANNA, None, numbers=[4]).status_code == 200

        assert conn.execute('SELECT COUNT(*) FROM page_assignees WHERE page_id = 14').fetchone()[0] == 0

    def test_a_map_datasets_tiles_are_not_handed_out(self, client):
        api, conn = client
        conn.execute("UPDATE jobs SET task = 'map_segmentation' WHERE id = 'j1'")
        conn.commit()

        response = assign(api, ANNA, 'lena', numbers=[1])

        assert (response.status_code, response.json()['detail']) == (400, "A map dataset's tiles are not handed out")


class TestThePageTable:
    def test_each_row_names_its_assignee(self, client):
        api, _ = client
        assign(api, ANNA, 'lena', numbers=[1, 2, 4])
        assign(api, ANNA, 'ben', numbers=[3])

        rows = api.get('/api/jobs/j1/page-rows', headers=ANNA).json()['rows']

        assert [row['assignee'] for row in rows] == ['lena', 'lena', 'ben', 'lena', None]

    def test_a_manager_filters_on_each_person_on_the_unassigned_and_on_their_own(self, client):
        api, _ = client
        assign(api, ANNA, 'lena', numbers=[1, 2, 4])
        assign(api, ANNA, 'anna', numbers=[3])

        assert (table(api, ANNA, 'assigned:lena'), table(api, ANNA, 'unassigned'), table(api, ANNA, 'mine')) == \
            ([1, 2, 4], [5], [3])
        assert {k: v for k, v in counts(api, ANNA).items() if k in ('all', 'mine', 'unassigned')
                or k.startswith('assigned:')} == \
            {'all': 5, 'mine': 1, 'unassigned': 1, 'assigned:anna': 1, 'assigned:lena': 3}

    def test_sorting_by_assignee_puts_the_unassigned_last(self, client):
        api, _ = client
        assign(api, ANNA, 'lena', numbers=[1])
        assign(api, ANNA, 'ben', numbers=[4])

        rows = api.get('/api/jobs/j1/page-rows', headers=ANNA, params={'sort': 'assignee'}).json()['rows']

        assert [(row['idx'] + 1, row['assignee']) for row in rows] == \
            [(4, 'ben'), (1, 'lena'), (2, None), (3, None), (5, None)]


class TestWhatAnAnnotatorSees:
    def test_their_own_pages_and_the_unassigned_ones(self, client):
        api, _ = client
        assign(api, ANNA, 'lena', numbers=[1, 2, 4])
        assign(api, ANNA, 'ben', numbers=[3])
        # Counted for the manager first: what she was told must not be what Ben is told.
        assert counts(api, ANNA)['all'] == 5

        assert (table(api, BEN), table(api, BEN, 'mine'), table(api, BEN, 'unassigned')) == ([3, 5], [3], [5])
        assert {k: counts(api, BEN)[k] for k in ('all', 'mine', 'unassigned')} == {'all': 2, 'mine': 1, 'unassigned': 1}
        assert 'assigned:lena' not in counts(api, BEN)
        assert counts(api, ANNA)['all'] == 5

    def test_the_dataset_lists_them_alone_with_their_assignees(self, client):
        api, _ = client
        assign(api, ANNA, 'lena', numbers=[1, 2, 4])

        pages = api.get('/api/jobs/j1', headers=BEN).json()['pages']

        assert [(p['idx'] + 1, p['assignee']) for p in pages] == [(3, None), (5, None)]
        assert [(p['idx'] + 1, p['assignee']) for p in api.get('/api/jobs/j1', headers=LENA).json()['pages']] == \
            [(1, 'lena'), (2, 'lena'), (3, None), (4, 'lena'), (5, None)]

    def test_a_page_of_someone_elses_still_opens_from_a_link(self, client):
        api, _ = client
        assign(api, ANNA, 'lena', numbers=[1])

        response = api.get('/api/jobs/j1/pages/11', headers=BEN)

        assert (response.status_code, response.json()['id']) == (200, 11)

    @pytest.mark.parametrize('who', [ANNA, RITA], ids=['manager', 'reviewer'])
    def test_a_manager_and_a_reviewer_see_every_page(self, client, who):
        api, _ = client
        assign(api, ANNA, 'lena', numbers=[1, 2, 4])
        assign(api, ANNA, 'ben', numbers=[3])

        assert table(api, who) == [1, 2, 3, 4, 5]
        assert len(api.get('/api/jobs/j1', headers=who).json()['pages']) == 5

    def test_an_annotator_made_reviewer_on_the_dataset_sees_every_page(self, client):
        api, conn = client
        assign(api, ANNA, 'lena', numbers=[1, 2, 4])
        conn.execute("INSERT INTO job_roles (job_id, username, role) VALUES ('j1', 'ben', 'reviewer')")
        conn.commit()

        assert table(api, BEN) == [1, 2, 3, 4, 5]


    def test_the_lines_to_review_keep_to_their_pages_and_the_unassigned(self, client):
        api, conn = client
        for page_id in (11, 13, 15):
            conn.execute("INSERT INTO elements (id, page_id, order_idx, class_name, bbox) "
                         "VALUES (?, ?, 0, 'Paragraph', '[0.05, 0.05, 0.95, 0.5]')", (page_id, page_id))
            conn.execute("INSERT INTO lines (element_id, order_idx, polygon, text, confidence) "
                         "VALUES (?, 0, '[[0.1, 0.1], [0.9, 0.1], [0.9, 0.15], [0.1, 0.15]]', 'Taufe', 0.5)",
                         (page_id,))
        conn.commit()
        assign(api, ANNA, 'lena', numbers=[1])
        assign(api, ANNA, 'ben', numbers=[3])

        def pages_to_review(headers):
            response = api.get('/api/jobs/j1/review', headers=headers)
            assert response.status_code == 200, response.text
            return [line['page_idx'] + 1 for line in response.json()['lines']]

        assert (pages_to_review(BEN), pages_to_review(ANNA)) == ([3, 5], [1, 3, 5])


class TestAssignmentsLapse:
    def test_when_their_person_leaves_the_workspace(self, client):
        api, _ = client
        assign(api, ANNA, 'lena', numbers=[1, 2])
        assign(api, ANNA, 'ben', numbers=[3])

        response = api.put('/api/groups/1/share', headers=ANNA, json={'usernames': ['anna', 'ben']})

        assert response.status_code == 200, response.text
        answer = assigned(api)
        assert ({p['username']: p['pages'] for p in answer['people']}, answer['unassigned']) == \
            ({'anna': [], 'ben': [3], 'rita': []}, [1, 2, 4, 5])

    def test_when_someone_given_the_dataset_alone_is_taken_off_it(self, client):
        api, _ = client
        assign(api, ANNA, 'rita', numbers=[5])

        response = api.put('/api/jobs/j1/share', headers=ANNA, json={'usernames': []})

        assert response.status_code == 200, response.text
        assert assigned(api)['unassigned'] == [1, 2, 3, 4, 5]
