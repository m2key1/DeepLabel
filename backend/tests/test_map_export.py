import io
import json
import zipfile

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from PIL import Image

from app import map_export, store
from app.deps import get_db
from app.main import app
from app.routes import maps

CLASSES = [
    {'id': 0, 'name': 'background', 'color': [0, 0, 0], 'priority': 2},
    {'id': 1, 'name': 'roads', 'color': [255, 0, 0], 'priority': 1},
    {'id': 2, 'name': 'rivers', 'color': [0, 0, 255], 'priority': 0},
]
RANK = {c['id']: c['priority'] for c in CLASSES}
NAMES = {c['id']: c['name'] for c in CLASSES}


def poly(class_id, points, holes=(), kind='polygon'):
    return {'id': 1, 'class_id': class_id, 'points': points, 'holes': list(holes), 'kind': kind}


def tile(polygons, w=32, h=32):
    return {'page': {'filename': 'x__x0_y0.png'}, 'width': w, 'height': h, 'polygons': polygons}


class TestRasterizePolygons:
    def test_fills_ring_interior(self):
        mask = map_export.rasterize([poly(1, [[4, 4], [12, 4], [12, 12], [4, 12]])], 32, 32, RANK)
        assert mask.getpixel((8, 8)) == 1
        assert mask.getpixel((0, 0)) == 0

    def test_holes_cut_back_to_background(self):
        mask = map_export.rasterize(
            [poly(1, [[2, 2], [30, 2], [30, 30], [2, 30]], [[[10, 10], [20, 10], [20, 20], [10, 20]]])],
            32, 32, RANK)
        assert mask.getpixel((5, 5)) == 1
        assert mask.getpixel((15, 15)) == 0

    def test_higher_priority_class_wins_overlap(self):
        box = [[4, 4], [20, 4], [20, 20], [4, 20]]
        mask = map_export.rasterize([poly(1, box), poly(2, box)], 32, 32, RANK)
        assert mask.getpixel((10, 10)) == 2  # rivers (priority 0) beats roads (1)

    def test_skips_degenerate_ring(self):
        mask = map_export.rasterize([poly(1, [[1, 1], [5, 5]])], 32, 32, RANK)
        assert mask.getpixel((3, 3)) == 0


class TestRasterizePolylines:
    def test_strokes_along_the_line(self):
        mask = map_export.rasterize(
            [poly(1, [[4, 16], [28, 16]], kind='polyline')], 32, 32, RANK, stroke=3)
        assert mask.getpixel((16, 16)) == 1
        assert mask.getpixel((16, 4)) == 0  # away from the line stays background

    def test_stroke_width_widens_the_band(self):
        line = [poly(1, [[4, 16], [28, 16]], kind='polyline')]
        thin = map_export.rasterize(line, 32, 32, RANK, stroke=1)
        thick = map_export.rasterize(line, 32, 32, RANK, stroke=7)
        count = lambda m: sum(1 for p in m.getdata() if p)
        assert count(thick) > count(thin)

    def test_encloses_no_area(self):
        # A polyline that traces three sides of a box must not fill the box.
        mask = map_export.rasterize(
            [poly(1, [[4, 4], [28, 4], [28, 28]], kind='polyline')], 32, 32, RANK, stroke=1)
        assert mask.getpixel((10, 20)) == 0

    def test_a_closed_trace_joins_where_it_meets_itself(self):
        # The corner a trace comes back to is a corner like any other, and must be drawn
        # like one: PIL rounds the joints between segments and leaves an end square, which
        # would notch that corner alone. The oracle is the very same corner traced through
        # rather than closed at.
        def corner(run):
            mask = map_export.rasterize([poly(1, run, kind='polyline')], 32, 32, RANK, stroke=7)
            return sum(1 for x in range(3, 14) for y in range(3, 14) if mask.getpixel((x, y)))

        closed = corner([[8, 8], [24, 8], [24, 24], [8, 24], [8, 8]])
        through = corner([[8, 24], [8, 8], [24, 8], [24, 24]])
        assert closed == through == 74

    def test_two_points_is_enough_but_one_is_not(self):
        assert any(map_export.rasterize(
            [poly(1, [[4, 16], [28, 16]], kind='polyline')], 32, 32, RANK).getdata())
        assert not any(map_export.rasterize(
            [poly(1, [[4, 16]], kind='polyline')], 32, 32, RANK).getdata())

    def test_mixed_kinds_share_the_priority_order(self):
        # The polygon (roads, priority 1) is painted first, the line (rivers, 0) over it.
        mask = map_export.rasterize(
            [poly(1, [[0, 0], [32, 0], [32, 32], [0, 32]]),
             poly(2, [[0, 16], [32, 16]], kind='polyline')],
            32, 32, RANK, stroke=3)
        assert mask.getpixel((16, 16)) == 2
        assert mask.getpixel((16, 4)) == 1


class TestSidecar:
    def test_polygon_only_tile_stays_schema_2(self):
        doc = map_export.sidecar(tile([poly(1, [[1, 1], [5, 1], [5, 5]])]), NAMES)
        assert doc['schema_version'] == 2
        assert 'polylines' not in doc and 'line_width' not in doc
        assert doc['polygons'][0]['class_name'] == 'roads'

    def test_polylines_bump_to_schema_3_with_exact_points(self):
        pts = [[1, 1], [5, 9]]
        doc = map_export.sidecar(tile([poly(2, pts, kind='polyline')]), NAMES, stroke=5)
        assert doc['schema_version'] == 3
        assert doc['line_width'] == 5
        assert doc['polygons'] == []
        assert doc['polylines'] == [{'id': 1, 'class_id': 2, 'class_name': 'rivers', 'points': pts}]

    def test_mixed_tile_splits_by_kind(self):
        doc = map_export.sidecar(
            tile([poly(1, [[1, 1], [5, 1], [5, 5]]), poly(2, [[0, 0], [9, 9]], kind='polyline')]), NAMES)
        assert doc['schema_version'] == 3
        assert len(doc['polygons']) == 1 and len(doc['polylines']) == 1

    def test_unknown_class_id_falls_back_to_the_number(self):
        doc = map_export.sidecar(tile([poly(7, [[0, 0], [9, 9]], kind='polyline')]), NAMES)
        assert doc['polylines'][0]['class_name'] == '7'


class TestCollidingTileNames:
    """Two source maps in one job can share a filename (uploads keep their own name, and a
    server-path scan pulls `sheet.tif` from several folders), so phase_tile's
    '{stem}__x{x}_y{y}.png' repeats. Both tiles must still survive the export."""

    @pytest.fixture
    def conn(self, tmp_path):
        connection = store.connect(tmp_path / 'app.db')
        connection.execute("INSERT INTO jobs (id, name, owner, task, status) "
                           "VALUES ('j', 'maps', 'alice', 'map_segmentation', 'done')")
        for class_id in (1, 2):
            page = connection.execute(
                "INSERT INTO pages (job_id, idx, filename, source_file, status, width, height, layout_checked) "
                "VALUES ('j', ?, 'sheet__x0_y0.png', '/nonexistent.png', 'done', 32, 32, 1)",
                (class_id,)).lastrowid
            # Distinct classes, so a dropped tile shows up as a missing class in the masks.
            connection.execute(
                'INSERT INTO regions (page_id, order_idx, class_id, points, holes, kind) '
                "VALUES (?, 0, ?, '[[0.1,0.1],[0.9,0.1],[0.9,0.9],[0.1,0.9]]', '[]', 'polygon')",
                (page, class_id))
        connection.commit()
        yield connection
        connection.close()

    def test_collect_gives_each_tile_a_distinct_export_name(self, conn):
        tiles, _ = map_export.collect(conn, 'j')
        stems = [map_export._stem(t) for t in tiles]
        assert len(tiles) == 2
        assert len(set(stems)) == 2, f'colliding export names: {stems}'

    def test_zip_keeps_one_mask_and_sidecar_per_tile(self, conn):
        tiles, _ = map_export.collect(conn, 'j')
        names = zipfile.ZipFile(io.BytesIO(map_export.to_zip(tiles, CLASSES))).namelist()
        masks = [n for n in names if n.endswith('.png')]
        sidecars = [n for n in names if n.startswith('annotations/') and n.endswith('.json')]
        assert len(masks) == 2 and len(set(masks)) == 2, f'duplicate mask entries: {masks}'
        assert len(sidecars) == 2 and len(set(sidecars)) == 2

    def test_zip_preserves_both_tiles_geometry(self, conn):
        """Distinct names are not enough - the second tile's class must actually survive."""
        tiles, _ = map_export.collect(conn, 'j')
        zf = zipfile.ZipFile(io.BytesIO(map_export.to_zip(tiles, CLASSES)))
        classes = {json.loads(zf.read(n))['polygons'][0]['class_id']
                   for n in zf.namelist() if n.startswith('annotations/') and n.endswith('.json')}
        assert classes == {1, 2}

    def test_sidecar_tile_name_matches_its_mask(self, conn):
        tiles, _ = map_export.collect(conn, 'j')
        zf = zipfile.ZipFile(io.BytesIO(map_export.to_zip(tiles, CLASSES)))
        for name in [n for n in zf.namelist() if n.startswith('annotations/') and n.endswith('.json')]:
            doc = json.loads(zf.read(name))
            assert f'annotations/{doc["tile_name"]}.png' in zf.namelist()

    def test_disk_export_writes_one_file_per_tile(self, conn, tmp_path):
        tiles, _ = map_export.collect(conn, 'j')
        dest = map_export.write(tiles, tmp_path / 'out', CLASSES)
        assert len(list((dest / 'annotations').glob('*.png'))) == 2


class TestASuffixedNameThatIsTakenToo:
    """The page id that tells two `a.png` tiles apart can spell a third tile's own name."""

    @pytest.fixture
    def conn(self, tmp_path):
        connection = store.connect(tmp_path / 'app.db')
        connection.execute("INSERT INTO jobs (id, name, owner, task, status, run_tile, tile_size) "
                           "VALUES ('j', 'maps', 'alice', 'map_segmentation', 'done', 1, 32)")
        for map_id, filename in ((3, 'a-12.tif'), (7, 'a.tif'), (12, 'a.tif')):
            connection.execute(
                'INSERT INTO job_maps (id, job_id, idx, filename, source_file, width, height, status) '
                "VALUES (?, 'j', ?, ?, '/nonexistent.tif', 32, 32, 'done')", (map_id, map_id, filename))
        for idx, (page_id, filename) in enumerate(((3, 'a-12.png'), (7, 'a.png'), (12, 'a.png'))):
            connection.execute(
                'INSERT INTO pages (id, job_id, idx, filename, source_file, status, width, height, '
                "layout_checked, source_map, tile_x, tile_y) "
                "VALUES (?, 'j', ?, ?, '/nonexistent.png', 'done', 32, 32, 1, ?, 0, 0)",
                (page_id, idx, filename, page_id))
        connection.commit()
        yield connection
        connection.close()

    def test_every_tile_gets_its_own_name(self, conn):
        tiles, _ = map_export.collect(conn, 'j')
        assert [map_export._stem(t) for t in tiles] == ['a-12', 'a', 'a-12-12']

    def test_the_zip_holds_each_tile_once(self, conn):
        tiles, _ = map_export.collect(conn, 'j')
        names = zipfile.ZipFile(io.BytesIO(map_export.to_zip(tiles, CLASSES))).namelist()
        assert sorted(n for n in names if n.endswith('.png')) == [
            'annotations/a-12-12.png', 'annotations/a-12.png', 'annotations/a.png']

    def test_every_map_gets_its_own_name(self, conn):
        entries, _ = map_export.collect_fused(conn, 'j')
        assert [e['export_stem'] for e in entries] == ['a-12', 'a', 'a-12-12']


def at(region, x=0, y=0, tile_w=32, tile_h=32):
    """A tile-local region tagged with its tile's origin, as collect_fused emits it. x/y
    are the DB's tile_x (row offset) / tile_y (column offset) - deliberately in that
    transposed order, so a test that mixes them up fails."""
    return {**region, 'origin': (y, x), 'tile_w': tile_w, 'tile_h': tile_h}


def fused(polygons, w=64, h=64, tiles=(), stem='sheet', filename='sheet.tif'):
    return {'map': {'filename': filename}, 'width': w, 'height': h, 'export_stem': stem,
            'tile_size': 32, 'tiles': list(tiles), 'polygons': polygons}


FULL_TILE = [[0, 0], [31, 0], [31, 31], [0, 31]]


class TestRasterizeFused:
    def test_tile_origin_is_transposed_into_pixel_coordinates(self):
        """tile_x is the row offset and tile_y the column offset. Swapping them puts every
        annotation somewhere else on the map, which no later check would catch."""
        entry = fused([at(poly(1, [[4, 4], [12, 4], [12, 12], [4, 12]]), x=16, y=32)], w=64, h=48)
        mask = map_export.rasterize_fused(entry, RANK)
        assert mask.size == (64, 48)
        assert mask.getpixel((32 + 8, 16 + 8)) == 1
        assert mask.getpixel((16 + 8, 32 + 8)) == 0  # the transposed position stays empty

    def test_higher_priority_class_wins_across_tiles(self):
        """tile_positions snaps the last row/column inside the map, so edge tiles overlap
        their neighbour. Pasting finished tile masks would let whichever tile came last win
        the band; priority has to be decided over every tile's geometry at once."""
        entry = fused([at(poly(2, FULL_TILE), x=0, y=0), at(poly(1, FULL_TILE), x=0, y=16)],
                      w=48, h=32)
        assert map_export.rasterize_fused(entry, RANK).getpixel((20, 8)) == 2

    def test_a_later_tiles_background_does_not_erase_an_earlier_tile(self):
        """The same overlap, the other failure mode: tile B says nothing about the band, so
        tile A's paint must survive it."""
        right_half = [[20, 0], [31, 0], [31, 31], [20, 31]]
        entry = fused([at(poly(2, FULL_TILE), x=0, y=0), at(poly(1, right_half), x=0, y=16)],
                      w=48, h=32)
        mask = map_export.rasterize_fused(entry, RANK)
        assert mask.getpixel((20, 8)) == 2   # inside tile B, painted only by tile A
        assert mask.getpixel((40, 8)) == 1   # tile B's own geometry still lands

    def test_geometry_in_a_small_maps_padding_is_clipped(self):
        """A map smaller than one tile is white-padded to tile size, so an annotator can
        draw past the map's real extent. The paste clips instead of raising."""
        entry = fused([at(poly(1, [[10, 10], [30, 10], [30, 30], [10, 30]]))], w=20, h=20)
        mask = map_export.rasterize_fused(entry, RANK)
        assert mask.size == (20, 20)
        assert mask.getpixel((15, 15)) == 1

    def test_a_stroke_stays_inside_its_own_tile(self):
        """The stencil is tile-sized, so fusing does not let a stroke bleed into a
        neighbouring tile's area - a tile contributes exactly what it contributes alone."""
        entry = fused([at(poly(1, [[16, 16], [31, 16]], kind='polyline'), x=0, y=0)], w=64, h=32)
        mask = map_export.rasterize_fused(entry, RANK, stroke=5)
        assert mask.getpixel((30, 16)) == 1
        assert mask.getpixel((33, 16)) == 0


class TestCollectFused:
    """Grouping reviewed tiles back under the maps they were cut from."""

    @pytest.fixture
    def conn(self, tmp_path):
        connection = store.connect(tmp_path / 'app.db')
        connection.execute(
            "INSERT INTO jobs (id, name, owner, task, status, run_tile, tile_size) "
            "VALUES ('j', 'maps', 'alice', 'map_segmentation', 'done', 1, 32)")
        for map_id, (fn, status) in enumerate(
                [('sheet.tif', 'done'), ('sheet.tif', 'done'), ('gone.tif', 'pending')], start=1):
            connection.execute(
                'INSERT INTO job_maps (id, job_id, idx, filename, source_file, width, height, status) '
                "VALUES (?, 'j', ?, ?, '/nonexistent.tif', 64, 64, ?)",
                (map_id, map_id, fn, status))

        def add_tile(idx, source_map, tile_x, tile_y, reviewed=1, class_id=None):
            page = connection.execute(
                'INSERT INTO pages (job_id, idx, filename, source_file, status, width, height, '
                'layout_checked, source_map, tile_x, tile_y) '
                "VALUES ('j', ?, ?, '/nonexistent.png', 'done', 32, 32, ?, ?, ?, ?)",
                (idx, f'{idx}_t__x{tile_x}_y{tile_y}.png', reviewed, source_map, tile_x, tile_y)
            ).lastrowid
            if class_id is not None:
                connection.execute(
                    'INSERT INTO regions (page_id, order_idx, class_id, points, holes, kind) '
                    "VALUES (?, 0, ?, '[[0.1,0.1],[0.9,0.1],[0.9,0.9],[0.1,0.9]]', '[]', 'polygon')",
                    (page, class_id))
            return page

        add_tile(0, 1, 0, 0, class_id=1)
        add_tile(1, 1, 32, 0)                      # reviewed, no regions
        add_tile(2, 2, 0, 0, reviewed=0, class_id=2)  # its map has nothing reviewed
        add_tile(3, None, None, None, class_id=1)  # no provenance at all
        connection.commit()
        yield connection
        connection.close()

    def test_groups_tiles_under_their_source_map(self, conn):
        entries, manifest = map_export.collect_fused(conn, 'j')
        assert [e['map']['id'] for e in entries] == [1]
        assert manifest['maps'] == 1 and manifest['tiles'] == 2 and manifest['regions'] == 1

    def test_a_map_with_no_reviewed_tile_is_skipped_not_emitted_blank(self, conn):
        _, manifest = map_export.collect_fused(conn, 'j')
        assert manifest['maps_skipped'] == 1

    def test_a_tile_without_provenance_is_counted_not_guessed_at(self, conn):
        _, manifest = map_export.collect_fused(conn, 'j')
        assert manifest['tiles_unattributed'] == 1

    def test_a_reviewed_tile_with_no_regions_still_counts_as_covered(self, conn):
        """'Reviewed and empty' is the only thing distinguishing real background from area
        nobody annotated, so it has to reach the sidecar."""
        entries, _ = map_export.collect_fused(conn, 'j')
        assert sorted(t['x'] for t in entries[0]['tiles']) == [0, 32]

    def test_regions_carry_their_tiles_origin(self, conn):
        entries, _ = map_export.collect_fused(conn, 'j')
        assert entries[0]['polygons'][0]['origin'] == (0, 0)

    def test_export_stem_is_deduplicated_across_maps(self, conn):
        """Two uploads named sheet.tif would otherwise write the same mask twice."""
        conn.execute('UPDATE pages SET layout_checked = 1 WHERE source_map = 2')
        entries, _ = map_export.collect_fused(conn, 'j')
        stems = [e['export_stem'] for e in entries]
        assert len(entries) == 2 and len(set(stems)) == 2, f'colliding map names: {stems}'

    def test_reads_tile_size_from_the_maps_own_tiles(self, conn):
        conn.execute("UPDATE jobs SET tile_size = 1024 WHERE id = 'j'")
        entries, _ = map_export.collect_fused(conn, 'j')
        assert entries[0]['tile_size'] == 32


class TestFusedSidecar:
    def test_points_are_translated_into_map_pixels(self):
        entry = fused([at(poly(1, [[4, 6], [12, 6], [12, 14]]), x=16, y=32)])
        doc = map_export.fused_sidecar(entry, NAMES)
        assert doc['polygons'][0]['points'] == [[36, 22], [44, 22], [44, 30]]

    def test_holes_are_translated_too(self):
        ring = [[0, 0], [31, 0], [31, 31], [0, 31]]
        hole = [[10, 10], [20, 10], [20, 20], [10, 20]]
        entry = fused([at(poly(1, ring, [hole]), x=16, y=32)])
        assert map_export.fused_sidecar(entry, NAMES)['polygons'][0]['holes'][0][0] == [42, 26]

    def test_records_the_tile_a_region_came_from(self, ):
        entry = fused([at(poly(1, [[4, 4], [12, 4], [12, 12]]), x=16, y=32)])
        assert map_export.fused_sidecar(entry, NAMES)['polygons'][0]['tile'] == [16, 32]

    def test_polylines_are_listed_separately_with_the_stroke_width(self):
        entry = fused([at(poly(1, [[4, 4], [12, 12]], kind='polyline'), x=0, y=16)])
        doc = map_export.fused_sidecar(entry, NAMES, stroke=5)
        assert doc['polygons'] == []
        assert doc['polylines'][0]['points'] == [[20, 4], [28, 12]]
        assert doc['line_width'] == 5

    def test_polygon_only_map_omits_the_polyline_keys(self):
        doc = map_export.fused_sidecar(fused([at(poly(1, [[0, 0], [9, 0], [9, 9]]))]), NAMES)
        assert 'polylines' not in doc and 'line_width' not in doc

    def test_carries_its_own_schema_not_the_tile_sidecars(self):
        doc = map_export.fused_sidecar(fused([]), NAMES)
        assert doc['schema'] == 'fused-map' and doc['schema_version'] == 1

    def test_states_what_an_unpainted_pixel_means(self):
        doc = map_export.fused_sidecar(fused([], tiles=[{'x': 0, 'y': 0, 'page_id': 1}]), NAMES)
        assert doc['unreviewed_policy'] == 'background'
        assert doc['tiles'] == [{'x': 0, 'y': 0, 'page_id': 1}]

    def test_names_the_source_file_it_was_fused_from(self):
        doc = map_export.fused_sidecar(fused([], stem='sheet-2', filename='sheet.tif'), NAMES)
        assert doc['map_name'] == 'sheet-2' and doc['source_filename'] == 'sheet.tif'


class TestFusedZip:
    def entries(self):
        return [fused([at(poly(1, [[4, 4], [20, 4], [20, 20], [4, 20]]), x=0, y=32)], w=64, h=48)]

    def test_zip_holds_one_mask_and_sidecar_per_map(self):
        names = zipfile.ZipFile(io.BytesIO(map_export.fused_to_zip(self.entries(), CLASSES))).namelist()
        assert names == ['maps/sheet.png', 'maps/sheet.json', 'class_map.json']

    def test_mask_is_the_size_of_the_original_map(self):
        zf = zipfile.ZipFile(io.BytesIO(map_export.fused_to_zip(self.entries(), CLASSES)))
        with zf.open('maps/sheet.png') as fh:
            assert Image.open(io.BytesIO(fh.read())).size == (64, 48)

    def test_sidecar_map_name_matches_its_mask(self):
        zf = zipfile.ZipFile(io.BytesIO(map_export.fused_to_zip(self.entries(), CLASSES)))
        doc = json.loads(zf.read('maps/sheet.json'))
        assert f'maps/{doc["map_name"]}.png' in zf.namelist()

    def test_disk_export_writes_the_same_layout(self, tmp_path):
        dest = map_export.fused_write(self.entries(), tmp_path / 'out', CLASSES)
        assert (dest / 'maps' / 'sheet.png').exists()
        assert (dest / 'maps' / 'sheet.json').exists()
        assert (dest / 'class_map.json').exists()


class TestFusedEndpoint:
    """What the maskset routes refuse when asked for the fused variant. Each refusal is a
    400 the frontend surfaces in place, not a silent fallback to a different export."""

    SECRET = 'test-secret'
    ADMIN = {'X-Frontend-Secret': SECRET, 'X-Auth-User': 'alice', 'X-Auth-Role': 'admin'}

    @pytest.fixture
    def client(self, tmp_path, monkeypatch):
        monkeypatch.setattr('app.config.FRONTEND_SECRET', self.SECRET)
        monkeypatch.setattr('app.config.MASK_EXPORT_DIR', tmp_path / 'masks')
        conn = store.connect(tmp_path / 'app.db')
        for job_id, run_tile in (('tiled', 1), ('uploaded', 0)):
            conn.execute("INSERT INTO jobs (id, name, owner, task, status, run_tile) "
                         "VALUES (?, ?, 'alice', 'map_segmentation', 'done', ?)",
                         (job_id, f'{job_id} job', run_tile))
            store.seed_job_classes(conn, job_id, CLASSES)
        conn.execute(
            'INSERT INTO job_maps (id, job_id, idx, filename, source_file, width, height, status) '
            "VALUES (1, 'tiled', 0, 'sheet.tif', '/nonexistent.tif', 64, 64, 'done')")
        page = conn.execute(
            'INSERT INTO pages (job_id, idx, filename, source_file, status, width, height, '
            'layout_checked, source_map, tile_x, tile_y) '
            "VALUES ('tiled', 0, 't.png', '/nonexistent.png', 'done', 32, 32, 0, 1, 0, 0)").lastrowid
        conn.execute(
            'INSERT INTO regions (page_id, order_idx, class_id, points, holes, kind) '
            "VALUES (?, 0, 1, '[[0.1,0.1],[0.9,0.1],[0.9,0.9]]', '[]', 'polygon')", (page,))
        conn.commit()
        app.dependency_overrides[get_db] = lambda: conn
        yield TestClient(app), conn
        app.dependency_overrides.clear()
        conn.close()

    def review(self, conn):
        conn.execute('UPDATE pages SET layout_checked = 1')
        conn.commit()

    def test_refuses_a_job_whose_tiles_were_uploaded_directly(self, client):
        c, _ = client
        res = c.get('/api/jobs/uploaded/maskset?fused=true', headers=self.ADMIN)
        assert res.status_code == 400 and 'tiled source maps' in res.json()['detail']

    def test_refuses_include_all_rather_than_ignoring_it(self, client):
        c, conn = client
        self.review(conn)
        res = c.get('/api/jobs/tiled/maskset?fused=true&include_all=true', headers=self.ADMIN)
        assert res.status_code == 400 and 'reviewed-only' in res.json()['detail']

    def test_refuses_when_no_tile_has_been_reviewed(self, client):
        c, _ = client
        res = c.get('/api/jobs/tiled/maskset?fused=true', headers=self.ADMIN)
        assert res.status_code == 400 and 'no reviewed tiles' in res.json()['detail']

    def test_downloads_a_zip_named_for_the_variant(self, client):
        c, conn = client
        self.review(conn)
        res = c.get('/api/jobs/tiled/maskset?fused=true', headers=self.ADMIN)
        assert res.status_code == 200
        assert 'full-maps.zip' in res.headers['content-disposition']
        assert 'maps/sheet.png' in zipfile.ZipFile(io.BytesIO(res.content)).namelist()

    def test_a_name_beyond_latin_1_downloads_under_its_own_name(self, client):
        c, conn = client
        self.review(conn)
        conn.execute("UPDATE jobs SET name = 'Plan – Łódź' WHERE id = 'tiled'")
        conn.commit()
        res = c.get('/api/jobs/tiled/maskset', headers=self.ADMIN)
        assert res.status_code == 200
        assert res.headers['content-disposition'] == (
            'attachment; filename="Plan _ _odz-masks.zip"; '
            "filename*=UTF-8''Plan%20%E2%80%93%20%C5%81%C3%B3d%C5%BA-masks.zip")

    def test_per_tile_download_is_untouched(self, client):
        c, conn = client
        self.review(conn)
        res = c.get('/api/jobs/tiled/maskset', headers=self.ADMIN)
        assert res.status_code == 200 and 'masks.zip' in res.headers['content-disposition']
        assert 'annotations/t.png' in zipfile.ZipFile(io.BytesIO(res.content)).namelist()

    def test_server_export_keeps_the_two_layouts_apart(self, client):
        """One directory holding both a maps/ and an annotations/ tree would leave a trainer
        pointed at it reading the same annotations twice, at two different scales."""
        c, conn = client
        self.review(conn)
        fused_dest = c.post('/api/jobs/tiled/maskset?fused=true', headers=self.ADMIN).json()['dest']
        tile_dest = c.post('/api/jobs/tiled/maskset', headers=self.ADMIN).json()['dest']
        assert fused_dest.endswith('-fused') and fused_dest != tile_dest


class TestGeometryValidation:
    def test_polyline_accepts_two_points(self):
        assert maps._valid_polyline([[0, 0], [1, 1]]) == [[0.0, 0.0], [1.0, 1.0]]

    @pytest.mark.parametrize('points', [
        [[0.5, 0.5]],
        'not a list',
        [[0, 0], [1.5, 0.5]],
        [[0, 0], [0.5]],
    ])
    def test_polyline_rejects_malformed(self, points):
        with pytest.raises(HTTPException) as e:
            maps._valid_polyline(points)
        assert e.value.status_code == 400

    def test_ring_still_needs_three_points(self):
        with pytest.raises(HTTPException) as e:
            maps._valid_ring([[0, 0], [1, 1]])
        assert e.value.status_code == 400

    def test_polyline_geometry_rejects_holes(self):
        with pytest.raises(HTTPException) as e:
            maps._valid_geometry('polyline', [[0, 0], [1, 1]], [[[0, 0], [1, 0], [1, 1]]])
        assert e.value.status_code == 400

    def test_polyline_geometry_returns_empty_holes(self):
        points, holes = maps._valid_geometry('polyline', [[0, 0], [1, 1]], [])
        assert holes == [] and len(points) == 2

    def test_polygon_geometry_keeps_holes(self):
        ring = [[0, 0], [1, 0], [1, 1]]
        points, holes = maps._valid_geometry('polygon', ring, [ring])
        assert len(points) == 3 and len(holes) == 1
