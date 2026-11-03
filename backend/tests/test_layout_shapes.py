import math

import pytest

from app import layout_shapes

# A page twice as wide as it is high, so a square corner in pixels is not one in the
# page's own 0-1 coordinates.
SIZE = (400, 200)


def turned(cx, cy, half_w, half_h, degrees, size=SIZE):
    """A rectangle turned on the page, in pixels, as the 0-1 corners an element stores."""
    a = math.radians(degrees)
    corners = [(-half_w, -half_h), (half_w, -half_h), (half_w, half_h), (-half_w, half_h)]
    return [[(cx + x * math.cos(a) - y * math.sin(a)) / size[0], (cy + x * math.sin(a) + y * math.cos(a)) / size[1]]
            for x, y in corners]


def right_angled(ring, size=SIZE):
    px = [(x * size[0], y * size[1]) for x, y in ring]
    for i in range(4):
        (ax, ay), (bx, by), (cx, cy) = px[i - 1], px[i], px[(i + 1) % 4]
        u, v = (ax - bx, ay - by), (cx - bx, cy - by)
        if abs(u[0] * v[0] + u[1] * v[1]) > 1e-6 * math.hypot(*u) * math.hypot(*v):
            return False
    return True


class TestShapeOf:
    def test_no_outline_or_an_upright_one_is_a_box(self):
        assert layout_shapes.shape_of(None, SIZE) == 'box'
        assert layout_shapes.shape_of([[0.1, 0.1], [0.5, 0.1], [0.5, 0.3], [0.1, 0.3]], SIZE) == 'box'

    def test_a_turned_rectangle_is_a_rotated_box_by_its_pixels(self):
        ring = turned(200, 100, 80, 30, 30)
        assert layout_shapes.shape_of(ring, SIZE) == 'rotated'
        # The same corners on a square page are no longer square.
        assert layout_shapes.shape_of(ring, (200, 200)) == 'polygon'

    def test_anything_else_is_a_polygon(self):
        assert layout_shapes.shape_of([[0.1, 0.1], [0.5, 0.1], [0.6, 0.3], [0.1, 0.3]], SIZE) == 'polygon'
        assert layout_shapes.shape_of([[0.1, 0.1], [0.5, 0.1], [0.5, 0.3], [0.3, 0.4], [0.1, 0.3]], SIZE) == 'polygon'


class TestFitted:
    OUTLINE = [[0.1, 0.1], [0.5, 0.15], [0.55, 0.4], [0.3, 0.5], [0.12, 0.35]]

    def test_a_polygon_under_rotated_becomes_the_tightest_square_cornered_box_around_it(self):
        bbox, ring = layout_shapes.fitted(self.OUTLINE, [0.1, 0.1, 0.55, 0.5], 'rotated', SIZE)

        assert len(ring) == 4 and right_angled(ring)
        assert layout_shapes.shape_of(ring, SIZE) in ('rotated', 'box')
        assert bbox == pytest.approx([min(x for x, _ in ring), min(y for _, y in ring),
                                      max(x for x, _ in ring), max(y for _, y in ring)])
        # Every corner of the outline is inside it.
        assert all(layout_shapes.covers(ring, point, SIZE) for point in self.OUTLINE)

    def test_under_aligned_anything_becomes_the_box_around_it(self):
        assert layout_shapes.fitted(self.OUTLINE, [0, 0, 1, 1], 'box', SIZE) == ([0.1, 0.1, 0.55, 0.5], None)
        ring = turned(200, 100, 80, 30, 30)
        bbox, outline = layout_shapes.fitted(ring, [0, 0, 1, 1], 'box', SIZE)
        assert outline is None and bbox == pytest.approx([min(x for x, _ in ring), min(y for _, y in ring),
                                                          max(x for x, _ in ring), max(y for _, y in ring)])

    def test_a_shape_within_the_level_is_left_as_it_is(self):
        ring = turned(200, 100, 80, 30, 30)
        assert layout_shapes.fitted(ring, [0, 0, 1, 1], 'rotated', SIZE) == ([0, 0, 1, 1], ring)
        assert layout_shapes.fitted(self.OUTLINE, [0, 0, 1, 1], 'polygon', SIZE) == ([0, 0, 1, 1], self.OUTLINE)


def test_the_levels_are_ceilings():
    assert layout_shapes.allowed('box') == ['box']
    assert layout_shapes.allowed('rotated') == ['box', 'rotated']
    assert layout_shapes.allowed('polygon') == ['box', 'rotated', 'polygon']
    assert [layout_shapes.outlines(level) for level in layout_shapes.LEVELS] == [False, True, True]


class TestChosenAtCreation:
    SECRET = 'test-secret'
    ADMIN = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'alice', 'X-Auth-Role': 'admin'}
    PNG = b'\x89PNG\r\n\x1a\n'

    @pytest.fixture
    def api(self, tmp_path, monkeypatch):
        from fastapi.testclient import TestClient
        from app import store
        from app.deps import get_db
        from app.main import app
        monkeypatch.setattr('app.config.FRONTEND_SECRET', self.SECRET)
        monkeypatch.setattr('app.config.JOBS_DIR', tmp_path / 'jobs')
        conn = store.connect(tmp_path / 'app.db')
        app.dependency_overrides[get_db] = lambda: conn
        yield TestClient(app), conn
        app.dependency_overrides.clear()
        conn.close()

    def shape(self, conn, response) -> str:
        assert response.status_code == 200, response.text
        return conn.execute('SELECT layout_shape FROM jobs WHERE id = ?', (response.json()['job_id'],)).fetchone()[0]

    def test_an_upload_starts_at_the_level_it_was_given_and_aligned_without_one(self, api):
        client, conn = api
        upload = lambda name, **extra: client.post('/api/jobs', headers=self.ADMIN, data={'name': name, **extra},
                                                   files=[('files', ('a.png', self.PNG, 'image/png'))])

        assert self.shape(conn, upload('Briefe', layout_shape='rotated')) == 'rotated'
        assert self.shape(conn, upload('Akten')) == 'box'
        assert upload('Urkunden', layout_shape='circle').status_code == 400

    def test_a_server_path_does_too(self, api, tmp_path):
        client, conn = api
        (tmp_path / 'scans').mkdir()
        (tmp_path / 'scans' / 'a.png').write_bytes(self.PNG)

        r = client.post('/api/jobs/path', headers=self.ADMIN, json={
            'name': 'Briefe', 'server_path': str(tmp_path / 'scans'), 'layout_shape': 'polygon'})

        assert self.shape(conn, r) == 'polygon'
