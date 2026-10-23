"""A map dataset's palette is what its exported masks mean: every pixel value must be a
class class_map.json lists, and two classes must never share a pixel value."""
import pytest
from fastapi.testclient import TestClient

from app import map_export, store
from app.deps import get_db
from app.main import app

SECRET = 'test-secret'
ALICE = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'alice', 'X-Auth-Role': 'member'}
SQUARE = [[0.2, 0.2], [0.6, 0.2], [0.6, 0.6], [0.2, 0.6]]


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    conn = store.connect(tmp_path / 'app.db')
    conn.execute("INSERT INTO jobs (id, name, owner, task, status) "
                 "VALUES ('mapjob', 'alice map', 'alice', 'map_segmentation', 'done')")
    store.seed_job_classes(conn, 'mapjob', [
        {'id': 0, 'name': 'background', 'color': [0, 0, 0], 'priority': 2},
        {'id': 1, 'name': 'buildings', 'color': [255, 0, 195], 'priority': 0},
        {'id': 2, 'name': 'roads', 'color': [0, 255, 255], 'priority': 1},
    ])
    conn.execute("INSERT INTO pages (id, job_id, idx, filename, source_file, status, width, height) "
                 "VALUES (1, 'mapjob', 0, 't.png', '/nonexistent/t.png', 'done', 512, 512)")
    conn.commit()
    app.dependency_overrides[get_db] = lambda: conn
    yield TestClient(app), conn
    app.dependency_overrides.clear()
    conn.close()


def deleted_region_of_class(c, class_id: int) -> int:
    region = c.post('/api/pages/1/regions', json={'class_id': class_id, 'points': SQUARE}, headers=ALICE).json()
    c.delete(f"/api/regions/{region['id']}", headers=ALICE)
    return region['id']


def region_row(conn, region_id: int):
    return conn.execute('SELECT class_id, deleted FROM regions WHERE id = ?', (region_id,)).fetchone()


class TestRestoringARegion:
    def test_a_region_whose_class_still_exists_comes_back(self, client):
        c, conn = client
        region_id = deleted_region_of_class(c, 2)

        res = c.patch(f'/api/regions/{region_id}', json={'deleted': False}, headers=ALICE)

        assert res.status_code == 200
        assert tuple(region_row(conn, region_id)) == (2, 0)

    def test_a_region_whose_class_was_deleted_stays_deleted(self, client):
        c, conn = client
        region_id = deleted_region_of_class(c, 2)
        c.delete('/api/jobs/mapjob/map-classes/2?mode=delete', headers=ALICE)

        res = c.patch(f'/api/regions/{region_id}', json={'deleted': False}, headers=ALICE)

        assert res.status_code == 409
        assert res.json()['detail']['message'] == 'class 2 no longer exists in this dataset'
        assert tuple(region_row(conn, region_id)) == (2, 1)

    def test_it_can_come_back_into_a_class_that_exists(self, client):
        c, conn = client
        region_id = deleted_region_of_class(c, 2)
        c.delete('/api/jobs/mapjob/map-classes/2?mode=delete', headers=ALICE)

        res = c.patch(f'/api/regions/{region_id}', json={'deleted': False, 'class_id': 1}, headers=ALICE)

        assert res.status_code == 200
        assert tuple(region_row(conn, region_id)) == (1, 0)


class TestPaletteSize:
    def fill_to(self, conn, highest: int):
        store.seed_job_classes(conn, 'mapjob', [
            {'id': cid, 'name': f'class {cid}', 'color': [1, 2, 3], 'priority': cid}
            for cid in range(3, highest + 1)])
        conn.commit()

    def add(self, c, name: str):
        return c.post('/api/jobs/mapjob/map-classes', json={'name': name, 'color': [40, 120, 200]},
                      headers=ALICE)

    def test_the_last_id_a_mask_can_hold_is_given_out(self, client):
        c, conn = client
        self.fill_to(conn, map_export.MAX_CLASS_ID - 1)

        res = self.add(c, 'last')

        assert res.status_code == 200 and res.json()['id'] == 255

    def test_no_id_past_it_is_given_out(self, client):
        c, conn = client
        self.fill_to(conn, map_export.MAX_CLASS_ID)

        res = self.add(c, 'one too many')

        assert res.status_code == 400
        assert res.json()['detail'] == ('no class id left: masks are 8-bit images, so class ids '
                                        'stop at 255 and every one up to it has been used')
        assert max(c['id'] for c in store.job_classes(conn, 'mapjob')) == 255


class TestRetiredClassIds:
    def add(self, c, name: str):
        return c.post('/api/jobs/mapjob/map-classes', json={'name': name, 'color': [40, 120, 200]},
                      headers=ALICE)

    def test_the_id_of_a_deleted_empty_class_is_not_given_out_again(self, client):
        c, _ = client
        assert c.delete('/api/jobs/mapjob/map-classes/2?mode=delete', headers=ALICE).status_code == 200

        res = self.add(c, 'fields')

        assert res.status_code == 200 and res.json()['id'] == 3

    def test_it_survives_a_reopen_of_the_database(self, client, tmp_path):
        c, conn = client
        c.delete('/api/jobs/mapjob/map-classes/2?mode=delete', headers=ALICE)
        reopened = store.connect(tmp_path / 'app.db')
        app.dependency_overrides[get_db] = lambda: reopened

        res = self.add(c, 'fields')

        assert res.status_code == 200 and res.json()['id'] == 3
        reopened.close()

    def test_deleting_a_lower_class_does_not_lower_the_mark(self, client):
        c, _ = client
        c.delete('/api/jobs/mapjob/map-classes/2?mode=delete', headers=ALICE)
        c.delete('/api/jobs/mapjob/map-classes/1?mode=delete', headers=ALICE)

        res = self.add(c, 'fields')

        assert res.status_code == 200 and res.json()['id'] == 3


class TestReorderingPriority:
    def reorder(self, c, order):
        return c.put('/api/jobs/mapjob/map-classes/order', json={'order': order}, headers=ALICE)

    def ranks(self, conn) -> dict:
        return {c['id']: c['priority'] for c in store.job_classes(conn, 'mapjob')}

    def test_the_new_order_is_stored_as_ranks_with_the_ids_untouched(self, client):
        c, conn = client
        assert self.ranks(conn) == {0: 2, 1: 0, 2: 1}

        res = self.reorder(c, [2, 1])

        assert res.status_code == 200
        assert [(k['id'], k['name'], k['priority']) for k in res.json()['classes']] == [
            (0, 'background', 2), (1, 'buildings', 1), (2, 'roads', 0)]
        assert self.ranks(conn) == {0: 2, 1: 1, 2: 0}

    def test_the_ranks_stay_a_permutation_after_gaps_and_ties(self, client):
        c, conn = client
        store.seed_job_classes(conn, 'mapjob', [{'id': 7, 'name': 'rivers', 'color': [0, 0, 255], 'priority': 0}])
        conn.commit()

        assert self.reorder(c, [7, 2, 1]).status_code == 200

        assert self.ranks(conn) == {7: 0, 2: 1, 1: 2, 0: 3}

    @pytest.mark.parametrize('order', [[1], [1, 2, 2], [1, 2, 9], [0, 1, 2], []])
    def test_an_order_that_is_not_every_drawable_class_once_is_refused(self, client, order):
        c, conn = client

        res = self.reorder(c, order)

        assert res.status_code == 400
        assert res.json()['detail'] == 'order must list every class except background exactly once: [1, 2]'
        assert self.ranks(conn) == {0: 2, 1: 0, 2: 1}
