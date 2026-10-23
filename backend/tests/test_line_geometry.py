"""Reducing predicted surfaces to traced boundaries, minus the tile cut.

Coordinates below are written in *pixels* on a 512 tile and normalized by `n()`, matching
what inference.polygonize.to_normalized produces: integer contour pixels divided by the
tile size, so the right/bottom edge lands on 511/512, not 1.0.
"""
import pytest

from app import line_geometry as lg

SIZE = 512
EPS, HI, MIN_LEN = lg.bounds(SIZE)
MAX = SIZE - 1  # outermost contour pixel — the far edge is here, not at SIZE


def n(ring):
    return [[x / SIZE, y / SIZE] for x, y in ring]


def px(points):
    return [[round(x * SIZE), round(y * SIZE)] for x, y in points]


def lines(ring, holes=()):
    """The polyline point-lists as_regions emits for one surface, in pixels. `ring` is a
    CLOSED contour as cv2 produces it — the caller must not pass an already-split line."""
    poly = {'points': n(ring), 'holes': [n(h) for h in holes]}
    return [px(points) for points, _ in lg.as_regions(poly, 'polyline', SIZE)]


def has_segment(out, a, b) -> bool:
    """Whether any emitted line still contains the a->b segment. Corner *points* legitimately
    survive as endpoints of neighbouring kept segments, so only the segment can be asserted on."""
    return any(line[i:i + 2] in ([a, b], [b, a]) for line in out for i in range(len(line) - 1))


class TestBorderEdges:
    @pytest.mark.parametrize('pt,expected', [
        ([0.0, 0.5], 1),                 # left
        ([MAX / SIZE, 0.5], 2),          # right — 511/512, not 1.0
        ([0.5, 0.0], 4),                 # top
        ([0.5, MAX / SIZE], 8),          # bottom
        ([0.0, 0.0], 1 | 4),             # top-left corner belongs to two edges
        ([MAX / SIZE, MAX / SIZE], 2 | 8),
        ([0.5, 0.5], 0),                 # interior
        ([10 / SIZE, 0.5], 0),           # 10px in is not the border
    ])
    def test_classifies_edges(self, pt, expected):
        assert lg.border_edges(pt, EPS, HI) == expected


class TestSplitAtBorder:
    def test_full_tile_surface_yields_nothing(self):
        # Every side is the cut; tracing it would teach the model that seams are boundaries.
        assert lines([[0, 0], [0, MAX], [MAX, MAX], [MAX, 0]]) == []

    def test_half_tile_keeps_only_the_real_divide(self):
        assert lines([[0, 0], [0, MAX], [255, MAX], [255, 0]]) == [[[255, MAX], [255, 0]]]

    def test_interior_surface_stays_a_closed_loop(self):
        ring = [[100, 100], [100, 300], [300, 300], [300, 100]]
        out = lines(ring)
        assert len(out) == 1
        assert out[0] == ring + [ring[0]]  # first point repeated = closed

    def test_corner_surface_run_wraps_past_index_zero(self):
        # Segments 3 and 0 are the cut, so the surviving run spans the array seam.
        assert lines([[0, 0], [0, 200], [200, 200], [200, 0]]) == [[[0, 200], [200, 200], [200, 0]]]

    def test_one_ring_can_yield_several_lines(self):
        # A band across the tile: touches left and right, so the top and bottom edges of
        # the band survive as two separate lines.
        out = lines([[0, 100], [0, 200], [MAX, 200], [MAX, 100]])
        assert len(out) == 2
        assert [[0, 200], [MAX, 200]] in out
        assert [[MAX, 100], [0, 100]] in out

    def test_hole_rings_are_traced_too(self):
        out = lines([[10, 10], [10, 400], [400, 400], [400, 10]],
                    [[[100, 100], [100, 200], [200, 200], [200, 100]]])
        assert len(out) == 2  # outer loop + hole loop, both interior → both closed
        assert all(o[0] == o[-1] for o in out)

    def test_border_touching_hole_is_trimmed(self):
        out = lines([[0, 0], [0, MAX], [MAX, MAX], [MAX, 0]],
                    [[[0, 100], [0, 200], [150, 200], [150, 100]]])
        # Outer ring is entirely the cut; only the hole's interior boundary survives.
        assert out == [[[0, 200], [150, 200], [150, 100], [0, 100]]]

    def test_corner_nub_below_min_length_is_dropped(self):
        # A 1px excursion off the top edge is contour noise, not a boundary.
        ring = n([[0, 0], [0, MAX], [MAX, MAX], [MAX, 0], [250, 0]])
        ring.insert(4, [251 / SIZE, 1 / SIZE])
        assert lg.split_at_border(ring, EPS, HI, MIN_LEN) == []

    def test_fragment_above_min_length_survives(self):
        ring = n([[0, 0], [0, MAX], [MAX, MAX], [MAX, 0], [250, 0]])
        ring.insert(4, [251 / SIZE, 40 / SIZE])  # a real 40px excursion inward
        assert len(lg.split_at_border(ring, EPS, HI, MIN_LEN)) == 1

    def test_degenerate_ring_yields_nothing(self):
        assert lg.split_at_border(n([[10, 10], [20, 20]]), EPS, HI, MIN_LEN) == []


class TestEdgeHuggingContours:
    """The model leaves a 1-2px sliver along the frame, so a contour that runs down the
    tile cut lands at 509-511 rather than exactly 511. Coordinates below are taken from
    real predictions on bg_deutschlandsberg_62_tobis tiles."""

    def test_drops_a_run_two_pixels_inside_the_right_edge(self):
        # From __x1536_y5120: a 430px stretch at x=509-511 that was being traced. The
        # contour closes back along the bottom and left, which are also the cut.
        ring = [[MAX, MAX], [509, 81], [296, 81], [285, 84], [158, 325], [28, 449],
                [0, 471], [0, MAX]]
        out = lines(ring)
        assert len(out) == 1
        assert out[0] == [[509, 81], [296, 81], [285, 84], [158, 325], [28, 449], [0, 471]]

    def test_drops_a_run_two_pixels_inside_the_bottom_edge(self):
        # From __x2048_y4096: same artifact against the other far edge.
        ring = [[10, 300], [10, 509], [480, MAX], [480, 300]]
        assert not has_segment(lines(ring), [10, 509], [480, MAX])

    @pytest.mark.parametrize('inset', [0, 1, 2])
    def test_drops_edge_runs_at_any_sliver_depth(self, inset):
        # The model leaves a 0-2px sliver, so the run sits anywhere in that band. The far
        # edge is MAX, so measuring the band from SIZE would miss inset=1 and 2 entirely.
        ring = [[MAX - inset, 20], [MAX - inset, 480], [300, 480], [300, 20]]
        assert not has_segment(lines(ring), [MAX - inset, 20], [MAX - inset, 480])

    def test_band_is_symmetric_between_near_and_far_edges(self):
        near = lines([[2, 20], [2, 480], [300, 480], [300, 20]])
        far = lines([[MAX - 2, 20], [MAX - 2, 480], [300, 480], [300, 20]])
        assert not has_segment(near, [2, 20], [2, 480])
        assert not has_segment(far, [MAX - 2, 20], [MAX - 2, 480])

    def test_keeps_a_boundary_that_drifts_away_from_the_frame(self):
        # A real boundary meeting the frame: 3px in, drifting to 0 over 149px. Unlike a
        # cut its distance to the edge is not constant, so it must survive.
        assert has_segment(lines([[3, 258], [0, 407], [200, 400], [200, 250]]), [3, 258], [0, 407])

    def test_keeps_a_long_boundary_running_just_outside_the_band(self):
        assert has_segment(lines([[4, 20], [4, 480], [300, 480], [300, 20]]), [4, 20], [4, 480])


class TestAsRegions:
    def test_polygon_mode_is_untouched_by_the_border_rule(self):
        # A polygon job must still get the full ring, tile-edge segments and all.
        ring = n([[0, 0], [0, MAX], [MAX, MAX], [MAX, 0]])
        holes = [n([[100, 100], [100, 200], [200, 200]])]
        assert lg.as_regions({'points': ring, 'holes': holes}, 'polygon', SIZE) == [(ring, holes)]

    def test_polyline_mode_never_emits_holes(self):
        out = lg.as_regions({'points': n([[10, 10], [10, 400], [400, 400]]), 'holes': []}, 'polyline', SIZE)
        assert all(holes == [] for _, holes in out)

    def test_scales_the_tolerance_to_the_tile_size(self):
        # The same shape on a 1024 tile: the border test must follow the tile, not assume 512.
        ring = [[0.0, 0.0], [0.0, 1023 / 1024], [1023 / 1024, 1023 / 1024], [1023 / 1024, 0.0]]
        assert lg.as_regions({'points': ring, 'holes': []}, 'polyline', 1024) == []

    def test_each_axis_of_a_non_square_tile_has_its_own_edge(self):
        # A 2048 x 512 tile: the bottom edge is at 511/512. Measured against the width it
        # would sit 0.0002 inside the band and the cut along the bottom would survive.
        w, h = 2048, 512
        ring = [[0.0, 0.0], [0.0, (h - 1) / h], [(w - 1) / w, (h - 1) / h], [(w - 1) / w, 0.0]]
        assert lg.as_regions({'points': ring, 'holes': []}, 'polyline', w, h) == []
