"""Line detection scored against checked outlines: one-to-one matches by overlap, and
every checked line that is not matched called missed, merged, split or loose."""
import pytest

from app.line_scores import score_page, totals


def box(x0, y0, x1, y1):
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]


ROW1 = box(0.1, 0.10, 0.9, 0.14)
ROW2 = box(0.1, 0.20, 0.9, 0.24)
LEFT = box(0.1, 0.30, 0.4, 0.34)
RIGHT = box(0.6, 0.30, 0.9, 0.34)


def test_the_same_outlines_are_all_found_and_fit_exactly():
    page = score_page([ROW1, ROW2], [ROW2, ROW1])
    assert page.truth == ['found', 'found']
    assert page.detected == ['found', 'found']
    assert page.ious == pytest.approx([1.0, 1.0])
    assert page.height_ratios == pytest.approx([1.0, 1.0])


def test_a_checked_line_nothing_lies_on_is_missed_and_a_line_on_nothing_is_extra():
    page = score_page([ROW1, ROW2], [ROW1, box(0.1, 0.5, 0.9, 0.54)])
    assert page.truth == ['found', 'missed']
    assert page.detected == ['found', 'extra']


def test_one_line_across_two_columns_merges_both():
    page = score_page([LEFT, RIGHT], [box(0.1, 0.30, 0.9, 0.34)])
    assert page.truth == ['merged', 'merged']
    assert page.detected == ['other']


def test_a_line_cut_in_two_is_split():
    # Each piece overlaps the line by under half, so neither stands for it alone.
    page = score_page([ROW1], [box(0.1, 0.10, 0.48, 0.14), box(0.52, 0.10, 0.9, 0.14)])
    assert page.truth == ['split']
    assert page.detected == ['other', 'other']


def test_an_outline_far_taller_than_its_line_is_loose():
    # Over the line and as much again above and below it: overlap 1 / 3 of the union.
    page = score_page([ROW1], [box(0.1, 0.06, 0.9, 0.18)])
    assert page.truth == ['loose']
    assert page.detected == ['other']


def test_a_slightly_taller_outline_is_still_found_and_its_height_is_measured():
    # Half as tall again: overlap 2 / 3 of the union.
    page = score_page([ROW1], [box(0.1, 0.09, 0.9, 0.15)])
    assert page.truth == ['found']
    assert page.ious == pytest.approx([2 / 3])
    assert page.height_ratios == pytest.approx([1.5])


def test_the_totals_count_every_page_and_f1_weighs_missed_against_extra():
    pages = [score_page([ROW1, ROW2], [ROW1, ROW2]),
             score_page([ROW1, ROW2, LEFT, RIGHT], [ROW1, box(0.1, 0.30, 0.9, 0.34), box(0.1, 0.5, 0.9, 0.54)])]
    summary = totals(pages)
    assert {key: summary[key] for key in ('truth', 'detected', 'found', 'missed', 'merged', 'split', 'loose', 'extra')} == {
        'truth': 6, 'detected': 5, 'found': 3, 'missed': 1, 'merged': 2, 'split': 0, 'loose': 0, 'extra': 1}
    assert summary['precision'] == pytest.approx(3 / 5)
    assert summary['recall'] == pytest.approx(3 / 6)
    assert summary['f1'] == pytest.approx(2 * 3 / (6 + 5))
    assert summary['iou'] == pytest.approx(1.0)
    assert summary['height_ratio'] == pytest.approx(1.0)


def test_nothing_checked_and_nothing_found_scores_nothing():
    assert totals([])['f1'] is None
