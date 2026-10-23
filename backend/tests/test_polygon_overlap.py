"""Overlap between line quads decides whether a kept correction is the same line as a
newly detected one, so the measure itself is pinned here - especially that it is IoU and
not coverage.
"""
from app import geometry

UNIT = [[0, 0], [1, 0], [1, 1], [0, 1]]


def test_a_quad_fully_overlaps_itself():
    assert geometry.iou(UNIT, UNIT) == 1.0


def test_quads_that_do_not_touch_score_zero():
    far = [[2, 2], [3, 2], [3, 3], [2, 3]]
    assert geometry.iou(UNIT, far) == 0.0
    # Sharing only an edge is not overlapping either.
    touching = [[1, 0], [2, 0], [2, 1], [1, 1]]
    assert geometry.iou(UNIT, touching) == 0.0


def test_half_an_overlap_scores_a_third():
    """Intersection 0.5, union 1.5 - the definition, not an approximation."""
    shifted = [[0.5, 0], [1.5, 0], [1.5, 1], [0.5, 1]]
    assert geometry.iou(UNIT, shifted) == 1 / 3


def test_a_box_that_swallowed_another_is_not_the_same_line():
    """The failure IoU exists to catch: the old box is covered completely, so any
    coverage measure reads 1.0 and would re-stamp every line in a dataset."""
    grown = [[-0.5, -0.5], [1.5, -0.5], [1.5, 1.5], [-0.5, 1.5]]
    covered = geometry.polygon_area(geometry.clip_convex(UNIT, grown)) / geometry.polygon_area(UNIT)
    assert covered == 1.0
    assert geometry.iou(UNIT, grown) == 0.25


def test_a_line_narrowed_at_one_end_stays_the_same_line():
    """A re-detected line that stops 2% short: still the line a person corrected."""
    narrowed = [[0, 0], [0.98, 0], [0.98, 1], [0, 1]]
    assert geometry.iou(UNIT, narrowed) == 0.98


def test_winding_does_not_change_the_answer():
    reversed_ring = UNIT[::-1]
    assert geometry.iou(UNIT, reversed_ring) == 1.0
    shifted = [[0.5, 0], [1.5, 0], [1.5, 1], [0.5, 1]]
    assert geometry.iou(reversed_ring, shifted) == geometry.iou(UNIT, shifted)


def test_tilted_quads_overlap_by_their_real_area_not_their_bounding_boxes():
    """Two thin lines slanting the same way, one above the other: their bounding boxes
    overlap heavily, the lines themselves not at all."""
    upper = [[0, 0], [1, 0.5], [1, 0.6], [0, 0.1]]
    lower = [[0, 0.2], [1, 0.7], [1, 0.8], [0, 0.3]]
    assert geometry.iou(upper, lower) == 0.0


def test_area_is_orientation_independent():
    assert geometry.polygon_area(UNIT) == 1.0
    assert geometry.polygon_area(UNIT[::-1]) == 1.0
    assert geometry.polygon_area([[0, 0], [1, 1]]) == 0.0


# A line contour as detection actually emits one: many points, concave in places, and with
# the last point repeated. Taken from the dataset whose restored lines crashed rematching.
DETECTED = [
    [0.07558787679512699, 0.1953136547955595], [0.11896319850034752, 0.1563405172560786],
    [0.24430512078087457, 0.15006897788190926], [0.2717336330356464, 0.18635431283246043],
    [0.2998000176684362, 0.18545837863615047], [0.4442781112895017, 0.1800827734582911],
    [0.4978593910430094, 0.09989666288855452], [0.49849726342102735, 0.06719506472324295],
    [0.2232553323062822, 0.04345280852103044], [0.12374724133548216, 0.019710552318817933],
    [0.08515596246539622, 0.030013795576381844], [0.07750149392918083, 0.09720886029962479],
    [0.07718255774017185, 0.1482771094892894], [0.07718255774017185, 0.1482771094892894],
]


def test_a_detected_contour_fully_overlaps_itself():
    """The quad case above is convex; a real contour is not, and its own edges can be
    parallel to the clip edge they are tested against. That made the crossing undefined
    and took the whole run down rather than scoring the pair."""
    assert geometry.iou(DETECTED, DETECTED) == 1.0
