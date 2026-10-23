"""The shape a line trains as. A DB detector learns a shrunk core of every line, and the
shrink falls apart on an outline that steps around ascenders and word gaps - the synthetic
Schematismus lines are such outlines, 139 points apiece - so it gives up and trains on
nearly the whole line instead, and the boxes the model then reads come out 1.4 times too
tall. A run can therefore train on its lines as drawn, as rotated rectangles, or as boxes.
"""
import math

import pytest

from app import line_shapes

STAIRCASE = [[10, 20], [40, 20], [40, 16], [70, 16], [70, 24], [100, 24], [100, 40],
             [60, 40], [60, 44], [30, 44], [30, 40], [10, 40]]


def area(polygon) -> float:
    return abs(sum(x0 * y1 - x1 * y0 for (x0, y0), (x1, y1) in zip(polygon, polygon[1:] + polygon[:1]))) / 2


def rotated(points, degrees, centre=(200.0, 100.0)):
    a = math.radians(degrees)
    return [[centre[0] + x * math.cos(a) - y * math.sin(a), centre[1] + x * math.sin(a) + y * math.cos(a)]
            for x, y in points]


def test_a_polygon_trains_as_it_was_drawn():
    assert line_shapes.shaped(STAIRCASE, 'polygon') == STAIRCASE


def test_a_box_is_the_upright_rectangle_round_every_point():
    assert line_shapes.shaped(STAIRCASE, 'box') == [[10, 16], [100, 16], [100, 44], [10, 44]]


def test_a_rotated_rectangle_keeps_a_slanted_lines_slant():
    """A line printed at 12 degrees, its outline notched between words: the rotated shape is
    the rectangle it was cut from, which the upright box would inflate by its slant."""
    rectangle = [[-80, -10], [80, -10], [80, 10], [-80, 10]]
    notched = [[-80, -10], [-20, -10], [-20, -4], [20, -4], [20, -10], [80, -10], [80, 10], [-80, 10]]
    shape = line_shapes.shaped(rotated(notched, 12), 'rotated')

    assert len(shape) == 4
    assert area(shape) == pytest.approx(160 * 20, rel=1e-6)
    for corner in rotated(rectangle, 12):
        assert min(math.dist(corner, point) for point in shape) == pytest.approx(0, abs=1e-6)
    assert area(line_shapes.shaped(rotated(notched, 12), 'box')) > 1.5 * 160 * 20


def test_an_upright_lines_rotated_rectangle_is_its_box():
    shape = line_shapes.shaped(STAIRCASE, 'rotated')

    assert area(shape) == pytest.approx(90 * 28)
    assert sorted(map(tuple, shape)) == sorted(map(tuple, line_shapes.shaped(STAIRCASE, 'box')))


def test_a_shape_nobody_offers_is_refused():
    with pytest.raises(ValueError, match='polygon, rotated, box'):
        line_shapes.shaped(STAIRCASE, 'circle')
