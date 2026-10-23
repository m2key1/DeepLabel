import pytest
from app import geometry
from app.geometry import InvalidGeometry


class TestValidPolygon:
    def test_returns_normalized_floats(self):
        assert geometry.valid_polygon([[0, 0], [1, 0], [1, 1]]) == [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0]]

    @pytest.mark.parametrize('poly', [
        'not a list',
        [[0, 0], [1, 1]],
        [[0, 0], [1, 1], [0.5]],
        [[0, 0], [1, 1], [1.5, 0.5]],
        [[0, 0], [1, 1], [-0.1, 0.5]],
    ])
    def test_rejects_malformed(self, poly):
        with pytest.raises(InvalidGeometry) as e:
            geometry.valid_polygon(poly)


class TestValidBbox:
    def test_accepts_ordered_box(self):
        assert geometry.valid_bbox([0.1, 0.2, 0.3, 0.4]) == [0.1, 0.2, 0.3, 0.4]

    @pytest.mark.parametrize('bbox', [
        [0.3, 0.2, 0.1, 0.4],
        [0.1, 0.4, 0.3, 0.2],
        [0.1, 0.2, 0.1, 0.4],
        [-0.1, 0.2, 0.3, 0.4],
        [0.1, 0.2, 1.1, 0.4],
        [0.1, 0.2, 0.3],
    ])
    def test_rejects_degenerate_or_out_of_range(self, bbox):
        with pytest.raises(InvalidGeometry) as e:
            geometry.valid_bbox(bbox)


def test_poly_key_orders_by_row_then_column():
    top_left = [[0.1, 0.1], [0.3, 0.1], [0.3, 0.15], [0.1, 0.15]]
    top_right = [[0.6, 0.1], [0.9, 0.1], [0.9, 0.15], [0.6, 0.15]]
    bottom_left = [[0.1, 0.5], [0.3, 0.5], [0.3, 0.55], [0.1, 0.55]]
    keys = sorted([bottom_left, top_right, top_left], key=geometry.poly_key)
    assert keys == [top_left, top_right, bottom_left]


class TestEdgeAt:
    def test_interpolates_inside_the_segment(self):
        assert geometry.edge_at([0.0, 0.0], [1.0, 1.0], 0, 0.5) == [0.5, 0.5]

    def test_none_outside_the_span_or_parallel(self):
        assert geometry.edge_at([0.0, 0.0], [1.0, 1.0], 0, 1.5) is None
        assert geometry.edge_at([0.0, 0.0], [1.0, 1.0], 0, 0.0) is None
        assert geometry.edge_at([0.5, 0.0], [0.5, 1.0], 0, 0.5) is None


class TestMinAreaQuad:
    """The merged box is fitted to the points at whatever angle wraps them tightest,
    rather than inheriting the angle of whichever fragment happened to be topmost."""

    @staticmethod
    def area(q):
        # Shoelace: the corners are a rectangle, in order.
        return abs(sum(q[i][0] * q[(i + 1) % 4][1] - q[(i + 1) % 4][0] * q[i][1]
                       for i in range(4))) / 2

    def test_an_axis_aligned_rectangle_comes_back_as_itself(self):
        got = geometry.min_area_quad([[0.2, 0.2], [0.6, 0.2], [0.6, 0.4], [0.2, 0.4]])
        assert got == quad([[0.2, 0.2], [0.6, 0.2], [0.6, 0.4], [0.2, 0.4]])

    def test_a_tilted_rectangle_comes_back_as_itself(self):
        import math
        cos, sin = math.cos(0.3), math.sin(0.3)
        box = [(-0.2, -0.05), (0.2, -0.05), (0.2, 0.05), (-0.2, 0.05)]
        tilted = [[0.5 + x * cos - y * sin, 0.5 + x * sin + y * cos] for x, y in box]
        got = geometry.min_area_quad(tilted, reading=(cos, sin))
        assert got == quad(tilted)

    @staticmethod
    def skewed_box(points, theta):
        """What merging used to do: deskew by one fragment's angle, take the box, rotate
        back. Kept here so the improvement is measured against the old behaviour."""
        import math
        cos, sin = math.cos(-theta), math.sin(-theta)
        rot = [(x * cos - y * sin, x * sin + y * cos) for x, y in points]
        x0 = min(p[0] for p in rot); x1 = max(p[0] for p in rot)
        y0 = min(p[1] for p in rot); y1 = max(p[1] for p in rot)
        return (x1 - x0) * (y1 - y0)

    def test_it_wraps_a_mixed_angle_set_tighter_than_the_lead_line_would(self):
        """The topmost fragment is short and steeply skewed; the long one below carries
        the real angle. Deskewing by the lead's angle spreads the box over both."""
        import math

        lead = [[0.20, 0.30], [0.34, 0.36], [0.34, 0.40], [0.20, 0.34]]
        body = [[0.20, 0.36], [0.80, 0.36], [0.80, 0.42], [0.20, 0.42]]
        points = [*lead, *body]
        fitted = geometry.min_area_quad(points, reading=(lead[1][0] - lead[0][0],
                                                         lead[1][1] - lead[0][1]))
        lead_angle = math.atan2(lead[1][1] - lead[0][1], lead[1][0] - lead[0][0])
        assert self.area(fitted) < self.skewed_box(points, lead_angle)

    @staticmethod
    def inside(point, q):
        """A rectangle is convex, so a point is in it when it stays on one side of
        every edge."""
        signs = []
        for i in range(4):
            ax, ay = q[i]
            bx, by = q[(i + 1) % 4]
            signs.append((bx - ax) * (point[1] - ay) - (by - ay) * (point[0] - ax))
        return all(v >= -1e-9 for v in signs) or all(v <= 1e-9 for v in signs)

    def test_it_covers_every_input_point(self):
        points = [[0.2, 0.30], [0.7, 0.35], [0.7, 0.40], [0.2, 0.35], [0.45, 0.32]]
        got = geometry.min_area_quad(points)
        for point in points:
            assert self.inside(point, got), f'{point} fell outside {got}'

    def test_the_top_edge_runs_the_way_the_text_does(self):
        """[TL, TR, BR, BL]: which side is the top is decided by the reading direction,
        so a merged line keeps its baseline rather than being turned on its side."""
        tall = [[0.40, 0.20], [0.50, 0.20], [0.50, 0.70], [0.40, 0.70]]
        rightwards = geometry.min_area_quad(tall, reading=(1.0, 0.0))
        assert rightwards[0] == pytest.approx([0.40, 0.20])
        assert rightwards[1] == pytest.approx([0.50, 0.20])
        downwards = geometry.min_area_quad(tall, reading=(0.0, 1.0))
        assert downwards[0] == pytest.approx([0.50, 0.20])
        assert downwards[1] == pytest.approx([0.50, 0.70])

    def test_it_stays_inside_the_page(self):
        got = geometry.min_area_quad([[0.0, 0.01], [1.0, 0.05], [1.0, 0.1], [0.0, 0.06]])
        for x, y in got:
            assert 0.0 <= x <= 1.0
            assert 0.0 <= y <= 1.0

    def test_degenerate_input_still_yields_a_quad(self):
        assert len(geometry.min_area_quad([[0.5, 0.5], [0.5, 0.5]])) == 4


def quad(expected):
    # pytest.approx does not take nested lists, so compare corner by corner.
    return [pytest.approx(p) for p in expected]


class TestSplitQuad:
    # A line drawn at a slant, in reading order: TL, TR, BR, BL.
    TILTED = [[0.255, 0.9], [0.555, 0.6], [0.6, 0.68], [0.3, 0.98]]
    LEVEL = [[0.1, 0.2], [0.9, 0.2], [0.9, 0.4], [0.1, 0.4]]

    def test_a_cut_crossing_top_and_bottom_splits_left_from_right(self):
        first, second = geometry.split_quad(self.TILTED, [0.33, 0.5], [0.33, 1.0])
        assert first == quad([[0.255, 0.9], [0.33, 0.825], [0.33, 0.95], [0.3, 0.98]])
        assert second == quad([[0.33, 0.825], [0.555, 0.6], [0.6, 0.68], [0.33, 0.95]])

    def test_a_cut_crossing_left_and_right_splits_top_from_bottom(self):
        first, second = geometry.split_quad(self.LEVEL, [0.0, 0.3], [1.0, 0.3])
        assert first == quad([[0.1, 0.2], [0.9, 0.2], [0.9, 0.3], [0.1, 0.3]])
        assert second == quad([[0.1, 0.3], [0.9, 0.3], [0.9, 0.4], [0.1, 0.4]])

    def test_the_drawn_stroke_is_extended_to_a_full_line(self):
        first, _ = geometry.split_quad(self.LEVEL, [0.5, 0.28], [0.5, 0.32])
        assert first == quad([[0.1, 0.2], [0.5, 0.2], [0.5, 0.4], [0.1, 0.4]])

    @pytest.mark.parametrize('a, b', [
        ([0.05, 0.3], [0.25, 0.1]),    # clips a corner: crosses the top and the left side
        ([0.0, 0.5], [1.0, 0.5]),      # misses the quad entirely
        ([0.5, 0.2], [0.5, 0.2]),      # no direction
    ])
    def test_a_cut_that_does_not_cross_side_to_side_is_refused(self, a, b):
        with pytest.raises(InvalidGeometry) as e:
            geometry.split_quad(self.LEVEL, a, b)
        assert 'cross' in str(e.value)

    def test_a_cut_next_to_an_end_is_a_sliver(self):
        with pytest.raises(InvalidGeometry) as e:
            geometry.split_quad(self.LEVEL, [0.101, 0.0], [0.101, 1.0])
        assert 'sliver' in str(e.value)


class TestSplitPolygon:
    # The editor's polygon line: a box given a corner halfway along each long side.
    HEXAGON = [[0.1, 0.2], [0.5, 0.2], [0.9, 0.2], [0.9, 0.4], [0.5, 0.4], [0.1, 0.4]]
    # A thick inverted V, which a level cut crosses twice.
    ARCH = [[0.1, 0.5], [0.5, 0.1], [0.9, 0.5], [0.9, 0.6], [0.5, 0.2], [0.1, 0.6]]

    def test_a_cut_between_corners_keeps_the_first_corner_in_the_first_piece(self):
        first, second = geometry.split_polygon(self.HEXAGON, [0.3, 0.0], [0.3, 1.0])
        assert first == quad([[0.1, 0.2], [0.3, 0.2], [0.3, 0.4], [0.1, 0.4]])
        assert second == quad([[0.3, 0.2], [0.5, 0.2], [0.9, 0.2], [0.9, 0.4], [0.5, 0.4], [0.3, 0.4]])

    def test_a_cut_through_two_corners_does_not_repeat_them(self):
        first, second = geometry.split_polygon(self.HEXAGON, [0.5, 0.0], [0.5, 1.0])
        assert first == quad([[0.1, 0.2], [0.5, 0.2], [0.5, 0.4], [0.1, 0.4]])
        assert second == quad([[0.5, 0.2], [0.9, 0.2], [0.9, 0.4], [0.5, 0.4]])

    def test_where_the_cut_crosses_twice_the_stretch_at_the_stroke_is_cut(self):
        first, second = geometry.split_polygon(self.ARCH, [0.0, 0.45], [0.3, 0.45])
        assert first == quad([[0.1, 0.5], [0.15, 0.45], [0.25, 0.45], [0.1, 0.6]])
        assert second == quad([[0.15, 0.45], [0.5, 0.1], [0.9, 0.5], [0.9, 0.6], [0.5, 0.2], [0.25, 0.45]])

        first, second = geometry.split_polygon(self.ARCH, [0.7, 0.45], [0.9, 0.45])
        assert first == quad([[0.1, 0.5], [0.5, 0.1], [0.85, 0.45], [0.75, 0.45], [0.5, 0.2], [0.1, 0.6]])
        assert second == quad([[0.85, 0.45], [0.9, 0.5], [0.9, 0.6], [0.75, 0.45]])

    @pytest.mark.parametrize('a, b', [
        ([0.0, 0.5], [1.0, 0.5]),      # misses the polygon entirely
        ([0.5, 0.3], [0.5, 0.3]),      # no direction
    ])
    def test_a_cut_that_does_not_cross_is_refused(self, a, b):
        with pytest.raises(InvalidGeometry) as e:
            geometry.split_polygon(self.HEXAGON, a, b)
        assert 'cross' in str(e.value)

    def test_a_cut_next_to_an_end_is_a_sliver(self):
        with pytest.raises(InvalidGeometry) as e:
            geometry.split_polygon(self.HEXAGON, [0.101, 0.0], [0.101, 1.0])
        assert 'sliver' in str(e.value)
