"""Map routes must enforce the same per-job access rules as the text pipeline.

routes/elements.py and routes/lines.py gate every endpoint with require_*_access, and
e2e/tests/roles.spec.ts pins the 404-not-403 behaviour. These guard the map equivalents:
a member with no ownership, no assignment and no shared group must not reach another
user's tiles, regions, class palette or exported masks.
"""
import pytest
from fastapi.testclient import TestClient

from app import config, store
from app.deps import get_db
from app.main import app

SECRET = 'test-secret'
OWNER = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'alice', 'X-Auth-Role': 'member'}
OUTSIDER = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'mallory', 'X-Auth-Role': 'member'}


@pytest.fixture
def seeded(tmp_path, monkeypatch):
    """Alice owns one map job: one reviewed tile, one region, a two-class palette. The tile
    is cut from a source map, so the fused export has something to fuse."""
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    monkeypatch.setattr('app.config.MASK_EXPORT_DIR', tmp_path / 'masks')
    conn = store.connect(tmp_path / 'app.db')
    conn.execute("INSERT INTO jobs (id, name, owner, task, status, run_tile) "
                 "VALUES ('mapjob', 'alice map', 'alice', 'map_segmentation', 'done', 1)")
    store.seed_job_classes(conn, 'mapjob', [
        {'id': 0, 'name': 'background', 'color': [0, 0, 0], 'priority': 1},
        {'id': 1, 'name': 'buildings', 'color': [255, 0, 195], 'priority': 0},
    ])
    conn.execute(
        'INSERT INTO job_maps (id, job_id, idx, filename, source_file, width, height, status) '
        "VALUES (1, 'mapjob', 0, 'sheet.tif', '/nonexistent/sheet.tif', 1024, 1024, 'done')")
    tile = conn.execute(
        'INSERT INTO pages (job_id, idx, filename, source_file, status, width, height, '
        'layout_checked, source_map, tile_x, tile_y) '
        "VALUES ('mapjob', 0, 't.png', '/nonexistent/t.png', 'done', 512, 512, 1, 1, 0, 0)").lastrowid
    region = conn.execute(
        'INSERT INTO regions (page_id, order_idx, class_id, points, holes, kind, checked) '
        "VALUES (?, 0, 1, '[[0.1,0.1],[0.2,0.1],[0.2,0.2]]', '[]', 'polygon', 1)", (tile,)).lastrowid
    conn.commit()

    app.dependency_overrides[get_db] = lambda: conn
    yield TestClient(app), tile, region
    app.dependency_overrides.clear()
    conn.close()


def ring(a: float) -> list:
    return [[a, a], [a + 0.1, a], [a + 0.1, a + 0.1]]


def endpoints(tile: int, region: int) -> list:
    """(label, method, url, body) for every map endpoint that is not admin-only."""
    return [
        ('region revisions', 'GET', f'/api/regions/{region}/revisions', None),
        ('patch region', 'PATCH', f'/api/regions/{region}', {'class_id': 1}),
        ('delete region', 'DELETE', f'/api/regions/{region}', None),
        ('create region', 'POST', f'/api/pages/{tile}/regions', {'class_id': 1, 'points': ring(0.5)}),
        ('list classes', 'GET', '/api/jobs/mapjob/map-classes', None),
        ('create class', 'POST', '/api/jobs/mapjob/map-classes', {'name': 'roads', 'color': [1, 2, 3]}),
        ('patch class', 'PATCH', '/api/jobs/mapjob/map-classes/1', {'name': 'renamed'}),
        ('reorder classes', 'PUT', '/api/jobs/mapjob/map-classes/order', {'order': [1]}),
        ('delete class', 'DELETE', '/api/jobs/mapjob/map-classes/1?mode=delete', None),
        ('maskset preview', 'GET', '/api/jobs/mapjob/maskset/preview', None),
        ('maskset download', 'GET', '/api/jobs/mapjob/maskset', None),
        ('fused preview', 'GET', '/api/jobs/mapjob/maskset/preview?fused=true', None),
        ('fused download', 'GET', '/api/jobs/mapjob/maskset?fused=true', None),
        ('repredict preview', 'GET', '/api/jobs/mapjob/repredict', None),
    ]


def call(client, headers, method, url, body):
    return client.request(method, url, headers=headers, **({'json': body} if body else {}))


@pytest.mark.parametrize('label', [e[0] for e in endpoints(0, 0)])
def test_an_outsider_cannot_reach_another_members_map_job(seeded, label):
    client, tile, region = seeded
    _, method, url, body = next(e for e in endpoints(tile, region) if e[0] == label)
    res = call(client, OUTSIDER, method, url, body)
    # 404 rather than 403: an unshared dataset must not reveal that it exists.
    assert res.status_code == 404, f'{label} leaked to an outsider ({res.status_code})'


@pytest.mark.parametrize('label', [e[0] for e in endpoints(0, 0)])
def test_the_owner_still_reaches_their_own_map_job(seeded, label):
    """Pairs with the 404 assertions above, so a gate that rejects everyone cannot pass."""
    client, tile, region = seeded
    _, method, url, body = next(e for e in endpoints(tile, region) if e[0] == label)
    res = call(client, OWNER, method, url, body)
    assert res.status_code == 200, f'{label} broke for the owner ({res.status_code}: {res.text})'


def live_regions(client) -> int:
    classes = client.get('/api/jobs/mapjob/map-classes', headers=OWNER).json()['classes']
    return next(c['regions'] for c in classes if c['id'] == 1)


def test_an_outsider_cannot_add_a_region_to_another_members_tile(seeded):
    """State oracle behind the create status code. Kept apart from the delete case: run
    together, an inserted region and a deleted one cancel out and the count still reads 1."""
    client, tile, _ = seeded
    call(client, OUTSIDER, 'POST', f'/api/pages/{tile}/regions', {'class_id': 1, 'points': ring(0.5)})
    assert live_regions(client) == 1, 'outsider inserted a region into alice tile'


def test_an_outsider_cannot_delete_another_members_region(seeded):
    client, _, region = seeded
    call(client, OUTSIDER, 'DELETE', f'/api/regions/{region}', None)
    assert live_regions(client) == 1, 'outsider deleted alice region'


def test_an_outsider_cannot_reclass_another_members_region(seeded):
    client, _, region = seeded
    call(client, OWNER, 'POST', '/api/jobs/mapjob/map-classes', {'name': 'roads', 'color': [1, 2, 3]})
    call(client, OUTSIDER, 'PATCH', f'/api/regions/{region}', {'class_id': 2})
    assert live_regions(client) == 1, 'outsider moved alice region to another class'


def test_admins_still_reach_every_map_job(seeded):
    client, tile, region = seeded
    admin = {**OUTSIDER, 'X-Auth-Role': 'admin'}
    assert client.get('/api/jobs/mapjob/map-classes', headers=admin).status_code == 200
