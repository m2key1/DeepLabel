import pytest

from app.align import greedy_align, keeps_correction, may_autocheck, order_confirmed, similarity
from app.store import MACHINE_AUTHORS


def test_similarity_is_normalized_edit_distance():
    assert similarity('Pfarre Wien', 'Pfarre Wien') == 1.0
    assert similarity('Pfarre Wien', 'Pfarre Wein') == 1.0 - 2 / 11
    assert similarity('', '') == 1.0


def test_best_pair_wins_before_weaker_claims():
    """The GT line fits both OCR lines, but the exact match must lock in first
    and push the near-duplicate onto its second-best partner."""
    gt = ['Kaplan Huber', 'Kaplan Hubner']
    ocr = ['Kaplan Hubner', 'Kaplan Huber']
    matches = greedy_align(gt, ocr)
    assert [(gi, oi) for gi, oi, _ in matches] == [(0, 1), (1, 0)]
    assert all(score == 1.0 for _, _, score in matches)


def test_matched_lines_leave_both_pools():
    gt = ['Pfarre Wien', 'Pfarre Wien']
    ocr = ['Pfarre Wien']
    matches = greedy_align(gt, ocr)
    assert len(matches) == 1
    assert matches[0][:2] == (0, 0)


def test_garbage_stays_unmatched_below_the_floor():
    matches = greedy_align(['Oberstjaegermeister'], ['zzzzz'], floor=0.5)
    assert matches == []


def test_empty_pools_align_to_nothing():
    assert greedy_align([], ['a']) == []
    assert greedy_align(['a'], []) == []


def test_order_confirms_the_run_that_advances_together():
    """Both sequences move forward: every pair is bracketed by its neighbours."""
    matches = [(0, 0, 0.7), (1, 1, 0.6), (2, 2, 0.8)]
    assert order_confirmed(matches) == [True, True, True]


def test_a_pair_that_crosses_the_run_stands_alone():
    """The middle pair jumps backwards past the others, so only it is unconfirmed."""
    matches = [(0, 0, 0.7), (1, 5, 0.6), (2, 1, 0.8), (3, 2, 0.9)]
    assert order_confirmed(matches) == [True, False, True, True]


def test_order_holds_when_lines_are_skipped_on_either_side():
    """Undetected lines and unmatched recognitions leave gaps, not crossings."""
    matches = [(0, 1, 0.7), (3, 4, 0.6), (5, 9, 0.8)]
    assert order_confirmed(matches) == [True, True, True]


def test_order_confirmation_reads_matches_in_any_input_order():
    matches = [(2, 2, 0.8), (0, 0, 0.7), (1, 1, 0.6)]
    assert order_confirmed(matches) == [True, True, True]


def test_nothing_to_confirm():
    assert order_confirmed([]) == []


def settles(matches, ordered):
    confirmed = order_confirmed(matches) if ordered else [False] * len(matches)
    return [may_autocheck(score, in_order)
            for (_gi, _oi, score), in_order in zip(matches, confirmed)]


def test_near_exact_matches_settle_without_the_order_prior():
    matches = [(0, 0, 0.97), (1, 1, 0.80)]
    assert settles(matches, ordered=False) == [True, False]


def test_the_order_prior_settles_a_poorly_read_line_its_neighbours_bracket():
    """The transcription is trustworthy and complete, so a pair confirmed by reading
    order is the right pair even where the recognition is too weak to prove it."""
    matches = [(0, 0, 0.97), (1, 1, 0.80), (2, 2, 0.55)]
    assert settles(matches, ordered=True) == [True, True, False]


def test_an_out_of_order_pair_still_needs_a_near_exact_score():
    matches = [(0, 0, 0.97), (1, 9, 0.80), (2, 1, 0.90), (3, 2, 0.90)]
    assert settles(matches, ordered=True) == [True, False, True, True]


def test_a_checked_line_keeps_its_correction_whoever_wrote_it():
    assert keeps_correction(checked=True, corrected_text='Pfarre Wien', corrected_by='align:gt@0.91')
    assert keeps_correction(checked=True, corrected_text=None, corrected_by=None)


def test_a_persons_unchecked_correction_is_kept():
    assert keeps_correction(checked=False, corrected_text='What a person typed', corrected_by='alice')


def test_a_correction_with_no_recorded_author_counts_as_a_persons():
    """Written before corrected_by was kept, so it can only have been typed."""
    assert keeps_correction(checked=False, corrected_text='Pfarre Wien', corrected_by=None)


@pytest.mark.parametrize('author', [f'{prefix}x' for prefix in MACHINE_AUTHORS])
def test_a_machines_unchecked_correction_is_written_over(author):
    assert not keeps_correction(checked=False, corrected_text='Pfarre Wien', corrected_by=author)


def test_an_untouched_line_is_written():
    assert not keeps_correction(checked=False, corrected_text=None, corrected_by=None)
    assert not keeps_correction(checked=False, corrected_text='', corrected_by=None)
