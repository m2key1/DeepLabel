"""Splitting a text line along a drawn cut, and what a split or merge leaves behind:
the loupe reads a cached crop per line id, so a line whose polygon changed must drop it."""
import json

import pytest
from fastapi.testclient import TestClient

from app import caches, config, store
from app.deps import get_db
from app.main import app

SECRET = 'test-secret'
EDITOR = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'alice', 'X-Auth-Role': 'member'}
TILTED = [[0.255, 0.9], [0.555, 0.6], [0.6, 0.68], [0.3, 0.98]]
LEVEL = [[0.1, 0.2], [0.9, 0.2], [0.9, 0.4], [0.1, 0.4]]


def quad(expected):
    return [pytest.approx(p) for p in expected]


@pytest.fixture
def stack(tmp_path, monkeypatch):
    monkeypatch.setattr('app.config.FRONTEND_SECRET', SECRET)
    monkeypatch.setattr('app.config.DB_PATH', tmp_path / 'app.db')
    monkeypatch.setattr('app.config.JOBS_DIR', tmp_path / 'jobs')
    conn = store.connect(tmp_path / 'app.db')
    conn.execute("INSERT INTO jobs (id, name, owner, status) VALUES ('j', 'Lines', 'alice', 'done')")
    conn.execute("INSERT INTO pages (id, job_id, idx, filename, source_file, status) "
                 "VALUES (1, 'j', 0, 'p1.png', '/nonexistent.png', 'done')")
    conn.execute("INSERT INTO elements (id, page_id, order_idx, class_name, bbox, kind) "
                 "VALUES (1, 1, 0, 'Paragraph', '[0,0,1,1]', 'content')")
    conn.executemany("INSERT INTO lines (id, element_id, order_idx, polygon, text) VALUES (?, ?, ?, ?, ?)", [
        (1, 1, 0, json.dumps(TILTED), 'tilted'),
        (2, 1, 1, json.dumps(LEVEL), 'level'),
    ])
    conn.commit()
    app.dependency_overrides[get_db] = lambda: conn
    yield TestClient(app), conn
    app.dependency_overrides.clear()
    conn.close()


def cached_crop(line_id: int):
    crop = caches.line_crop_path('j', line_id)
    crop.parent.mkdir(parents=True, exist_ok=True)
    crop.write_bytes(b'stale')
    return crop


class TestPolygonLine:
    HEXAGON = [[0.1, 0.5], [0.5, 0.5], [0.9, 0.5], [0.9, 0.7], [0.5, 0.7], [0.1, 0.7]]

    @pytest.fixture
    def polygon_line(self, stack):
        client, conn = stack
        conn.execute("INSERT INTO lines (id, element_id, order_idx, polygon, text) VALUES (3, 1, 2, ?, 'curved')",
                     (json.dumps(self.HEXAGON),))
        conn.commit()
        return client, conn

    def test_a_cut_across_a_polygon_line_splits_it_like_a_box(self, polygon_line):
        client, _ = polygon_line
        res = client.post('/api/lines/3/split', json={'cut_line': [[0.3, 0.4], [0.3, 0.8]]}, headers=EDITOR)
        assert res.status_code == 200, res.text
        first, second = res.json()['lines']
        assert first['id'] == 3
        assert first['polygon'] == quad([[0.1, 0.5], [0.3, 0.5], [0.3, 0.7], [0.1, 0.7]])
        assert second['polygon'] == quad([[0.3, 0.5], [0.5, 0.5], [0.9, 0.5], [0.9, 0.7], [0.5, 0.7], [0.3, 0.7]])
        assert first['text'] is None and second['text'] is None

    def test_an_axis_cut_reaches_a_polygon_line_too(self, polygon_line):
        client, _ = polygon_line
        res = client.post('/api/lines/3/split', json={'cut_y': 0.6}, headers=EDITOR)
        assert res.status_code == 200, res.text
        first, second = res.json()['lines']
        assert first['polygon'] == quad([[0.1, 0.5], [0.5, 0.5], [0.9, 0.5], [0.9, 0.6], [0.1, 0.6]])
        assert second['polygon'] == quad([[0.9, 0.6], [0.9, 0.7], [0.5, 0.7], [0.1, 0.7], [0.1, 0.6]])


class TestDrawnCut:
    def test_a_drawn_cut_splits_a_tilted_line_along_it(self, stack):
        client, _ = stack
        res = client.post('/api/lines/1/split', json={'cut_line': [[0.33, 0.5], [0.33, 1.0]]}, headers=EDITOR)
        assert res.status_code == 200, res.text
        first, second = res.json()['lines']
        assert first['id'] == 1
        assert first['polygon'] == quad([[0.255, 0.9], [0.33, 0.825], [0.33, 0.95], [0.3, 0.98]])
        assert second['polygon'] == quad([[0.33, 0.825], [0.555, 0.6], [0.6, 0.68], [0.33, 0.95]])
        # The text described the whole line, so neither half keeps it.
        assert first['text'] is None and second['text'] is None

    def test_a_cut_that_misses_the_line_is_refused(self, stack):
        client, _ = stack
        res = client.post('/api/lines/2/split', json={'cut_line': [[0.0, 0.9], [1.0, 0.9]]}, headers=EDITOR)
        assert res.status_code == 400
        assert 'cross' in res.json()['detail']

    def test_exactly_one_kind_of_cut_is_accepted(self, stack):
        client, _ = stack
        res = client.post('/api/lines/2/split', json={'cut_x': 0.5, 'cut_line': [[0.5, 0], [0.5, 1]]}, headers=EDITOR)
        assert res.status_code == 400

    def test_the_axis_cut_still_works(self, stack):
        client, _ = stack
        res = client.post('/api/lines/2/split', json={'cut_x': 0.5}, headers=EDITOR)
        assert res.status_code == 200, res.text
        assert [ln['polygon'][1][0] for ln in res.json()['lines']] == pytest.approx([0.5, 0.9])


class TestStaleCrops:
    def test_a_split_drops_the_cached_crop_of_the_line_that_shrank(self, stack):
        client, _ = stack
        crop = cached_crop(1)
        res = client.post('/api/lines/1/split', json={'cut_line': [[0.33, 0.5], [0.33, 1.0]]}, headers=EDITOR)
        assert res.status_code == 200, res.text
        assert not crop.exists()

    def test_a_merge_drops_the_cached_crop_of_the_line_that_grew(self, stack):
        client, _ = stack
        crop = cached_crop(2)
        res = client.post('/api/lines/merge', json={'ids': [1, 2]}, headers=EDITOR)
        assert res.status_code == 200, res.text
        assert res.json()['id'] == 2
        assert not crop.exists()
