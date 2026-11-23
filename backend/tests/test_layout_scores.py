"""Scoring a layout model's boxes against the checked ones (#150), the way the COCO
evaluation every layout trainer reports does: average precision per class at IoU 0.50 and
over 0.50 to 0.95, a found box matching at most one checked box of its class."""
import pytest

from app import layout_scores


def page(truth=(), found=()):
    return {'truth': [{'class': c, 'bbox': b} for c, b in truth],
            'found': [{'class': c, 'bbox': b, 'confidence': s} for c, b, s in found]}


BOX = [0.1, 0.1, 0.5, 0.3]
ELSEWHERE = [0.6, 0.6, 0.9, 0.9]


class TestBoxes:
    def test_overlap_is_shared_area_over_joint_area(self):
        assert layout_scores.iou([0, 0, 2, 2], [1, 0, 3, 2]) == pytest.approx(2 / 6)
        assert layout_scores.iou(BOX, ELSEWHERE) == 0


class TestScores:
    def test_every_box_found_exactly_scores_one(self):
        scores = layout_scores.score([page(truth=[('text', BOX), ('node', ELSEWHERE)],
                                           found=[('text', BOX, 0.9), ('node', ELSEWHERE, 0.8)])])
        assert (scores['mAP_50'], scores['mAP_50_95']) == (1.0, 1.0)
        assert scores['per_class'] == {
            'node': {'ap_50': 1.0, 'ap_50_95': 1.0, 'truth': 1, 'found': 1},
            'text': {'ap_50': 1.0, 'ap_50_95': 1.0, 'truth': 1, 'found': 1}}
        assert (scores['pages'], scores['truth'], scores['found']) == (1, 2, 2)

    def test_a_box_under_the_wrong_class_finds_nothing(self):
        scores = layout_scores.score([page(truth=[('text', BOX)], found=[('node', BOX, 0.9)])])
        assert scores['per_class']['text'] == {'ap_50': 0.0, 'ap_50_95': 0.0, 'truth': 1, 'found': 0}
        assert scores['mAP_50'] == 0.0
        # A class nobody checked has no AP to average in: a false alarm costs the classes it
        # was confused with, not an extra zero.
        assert 'node' not in scores['per_class']

    def test_a_loose_box_counts_at_half_overlap_and_not_at_the_strict_thresholds(self):
        # Overlap 0.58: a match at IoU 0.50 and 0.55, a miss from 0.60 on - 2 of the 10 steps.
        loose = [0.1, 0.1, 0.5, 0.1 + 0.08 / 0.58 / 0.4]
        assert layout_scores.iou(BOX, loose) == pytest.approx(0.58)
        scores = layout_scores.score([page(truth=[('text', BOX)], found=[('text', loose, 0.9)])])
        assert scores['per_class']['text']['ap_50'] == 1.0
        assert scores['per_class']['text']['ap_50_95'] == pytest.approx(0.2)

    def test_a_confident_false_alarm_costs_precision_before_the_true_box(self):
        # Ranked first, the false alarm makes the curve start at precision 0; the true box
        # then reaches recall 1 at precision 1/2. COCO's 101-point interpolation reads 0.5.
        scores = layout_scores.score([page(truth=[('text', BOX)],
                                           found=[('text', ELSEWHERE, 0.95), ('text', BOX, 0.5)])])
        assert scores['per_class']['text']['ap_50'] == pytest.approx(0.5)

    def test_one_found_box_matches_one_checked_box(self):
        # Two checked boxes in one place, one found: recall 1/2 at most.
        scores = layout_scores.score([page(truth=[('text', BOX), ('text', BOX)], found=[('text', BOX, 0.9)])])
        assert scores['per_class']['text']['ap_50'] == pytest.approx(51 / 101)

    def test_pages_without_any_box_score_nothing(self):
        assert layout_scores.score([page()]) == {
            'mAP_50': None, 'mAP_50_95': None, 'per_class': {}, 'pages': 1, 'truth': 0, 'found': 0}
