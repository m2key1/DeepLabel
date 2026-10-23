"""The evaluation page's figures, computed from the per-line records. Six lines with one
known error each - a digit, a case, an insertion, a punctuation and a space deletion - and
one read exactly, so every total below can be counted by hand."""
from fractions import Fraction

import pytest

from app import eval_metrics

LINES = [
    # line_id, ground truth, prediction, confidence, job
    (10, 'Wels', 'Wels', 0.99, 'j1'),
    (11, 'Wien 1850', 'Wien 1860', 0.95, 'j1'),
    (12, 'Graz', 'graz', 0.85, 'j1'),
    (13, 'ab', 'abc', 0.55, 'j2'),
    (14, 'Linz.', 'Linz', 0.91, 'j2'),
    (15, 'a b', 'ab', None, 'j2'),
]


@pytest.fixture
def rows():
    return [eval_metrics.scored_row({
        **eval_metrics.line_record(line_id, job, 100 + line_id, 'beam', truth, read, conf)})
        for line_id, truth, read, conf, job in LINES]


def close(value, fraction):
    return value == pytest.approx(float(fraction))


class TestOps:
    def test_a_substitution_sits_between_the_runs_it_splits(self):
        assert eval_metrics.char_ops('Wien 1850', 'Wien 1860') == [
            ['=', 'Wien 18', 'Wien 18'], ['s', '5', '6'], ['=', '0', '0']]

    def test_insertions_and_deletions_carry_one_side_only(self):
        assert eval_metrics.char_ops('ab', 'abc') == [['=', 'ab', 'ab'], ['i', '', 'c']]
        assert eval_metrics.char_ops('a b', 'ab') == [['=', 'a', 'a'], ['d', ' ', ''], ['=', 'b', 'b']]

    def test_an_exact_read_is_one_run(self):
        assert eval_metrics.char_ops('Wels', 'Wels') == [['=', 'Wels', 'Wels']]

    def test_nothing_read_is_all_deletion(self):
        assert eval_metrics.char_ops('ab', '') == [['d', 'a', ''], ['d', 'b', '']]


class TestLineRecord:
    def test_the_record_carries_its_own_cer(self):
        record = eval_metrics.line_record(11, 'j1', 111, 'beam', 'Wien 1850', 'Wien 1860', 0.95)
        assert record == {'line_id': 11, 'job_id': 'j1', 'page_id': 111, 'decode': 'beam',
                          'ground_truth': 'Wien 1850', 'prediction': 'Wien 1860',
                          'cer': pytest.approx(1 / 9), 'distance': 1, 'length': 9,
                          'confidence': 0.95,
                          'ops': [['=', 'Wien 18', 'Wien 18'], ['s', '5', '6'], ['=', '0', '0']]}

    def test_an_empty_truth_read_as_nothing_is_no_error(self):
        assert eval_metrics.line_record(1, 'j', 1, 'beam', '', '', None)['cer'] == 0.0


class TestHeadline:
    def test_cer_wer_and_bag_of_words(self, rows):
        head = eval_metrics.headline(rows)
        assert head['lines'] == 6
        assert head['chars'] == 27
        assert close(head['cer'], Fraction(5, 27))
        assert close(head['wer'], Fraction(6, 8))
        assert close(head['bow_wer'], Fraction(6, 8))

    def test_bag_of_words_precision_and_recall_sum_matches_over_the_set(self, rows):
        head = eval_metrics.headline(rows)
        assert close(head['bow_recall'], Fraction(2, 8))
        assert close(head['bow_precision'], Fraction(2, 7))

    def test_bag_of_words_matches_count_repeated_words_once_each(self):
        rows = [eval_metrics.scored_row(eval_metrics.line_record(
            1, 'j', 1, 'beam', 'der der Hof', 'der Hof Hof Weg', None))]
        head = eval_metrics.headline(rows)
        assert close(head['bow_recall'], Fraction(2, 3))
        assert close(head['bow_precision'], Fraction(2, 4))

    def test_bag_of_words_ignores_word_order(self):
        rows = [eval_metrics.scored_row(eval_metrics.line_record(
            1, 'j', 1, 'beam', 'rot weiss', 'weiss rot', None))]
        head = eval_metrics.headline(rows)
        assert head['wer'] == 1.0
        assert head['bow_wer'] == 0.0

    def test_edit_totals_and_shares(self, rows):
        edits = eval_metrics.headline(rows)['edits']
        assert edits == {'substitutions': 2, 'insertions': 1, 'deletions': 2, 'total': 5,
                         'shares': {'substitutions': 0.4, 'insertions': 0.2, 'deletions': 0.4}}

    def test_accuracy_per_character_class(self, rows):
        classes = {c['name']: c for c in eval_metrics.headline(rows)['classes']}
        assert {k: (v['total'], v['correct']) for k, v in classes.items()} == {
            'letters': (20, 19), 'digits': (4, 3), 'punctuation': (1, 0), 'whitespace': (2, 1)}
        assert classes['letters']['accuracy'] == pytest.approx(19 / 20)
        assert classes['digits']['accuracy'] == pytest.approx(3 / 4)

    def test_a_case_error_is_counted_among_the_substitutions(self, rows):
        assert eval_metrics.headline(rows)['case_errors'] == {'count': 1, 'share': 0.5}

    def test_no_lines_is_no_figures(self):
        head = eval_metrics.headline([])
        assert head['lines'] == 0
        assert head['cer'] is None
        assert head['bow_precision'] is None
        assert head['bow_recall'] is None
        assert head['edits']['shares'] == {'substitutions': 0.0, 'insertions': 0.0, 'deletions': 0.0}


class TestConfusions:
    def test_every_kind_is_ranked_with_an_example(self, rows):
        found = eval_metrics.confusions(rows)
        assert [(c['ref'], c['hyp'], c['count']) for c in found['substitutions']] == [
            ('5', '6', 1), ('G', 'g', 1)]
        assert found['substitutions'][0]['example']['line_id'] == 11
        assert [(c['hyp'], c['count'], c['example']['line_id']) for c in found['insertions']] == [
            ('c', 1, 13)]
        assert [(c['ref'], c['example']['line_id']) for c in found['deletions']] == [
            (' ', 15), ('.', 14)]

    def test_the_most_frequent_comes_first(self):
        rows = [eval_metrics.scored_row(eval_metrics.line_record(i, 'j', 1, 'beam', t, p, None))
                for i, (t, p) in enumerate([('ab', 'ob'), ('xe', 'xc'), ('ae', 'oc')], start=1)]
        subs = eval_metrics.confusions(rows)['substitutions']
        assert [(c['ref'], c['hyp'], c['count']) for c in subs] == [('a', 'o', 2), ('e', 'c', 2)]
        assert subs[0]['example']['line_id'] == 1


class TestCharacters:
    def test_each_glyph_has_its_error_rate_and_frequency(self, rows):
        table = {c['char']: c for c in eval_metrics.characters(rows)}
        assert (table['5']['total'], table['5']['errors'], table['5']['rate']) == (1, 1, 1.0)
        assert (table['a']['total'], table['a']['errors'], table['a']['rate']) == (3, 0, 0.0)
        assert (table['G']['total'], table['G']['errors']) == (1, 1)
        assert table['W']['total'] == 2
        assert table['c']['inserted'] == 1

    def test_the_glyphs_with_most_errors_lead_and_the_surest_errors_first(self, rows):
        assert [c['char'] for c in eval_metrics.characters(rows)][:4] == ['.', '5', 'G', ' ']


class TestContext:
    def test_cer_by_line_length(self, rows):
        long_line = eval_metrics.scored_row(eval_metrics.line_record(
            20, 'j1', 120, 'beam', 'Innsbruck am Inn', 'Innsbruck am Inn', 0.97))
        buckets = eval_metrics.by_length(rows + [long_line])
        assert [(b['bucket'], b['lines']) for b in buckets] == [('0-9', 6), ('10-19', 1)]
        assert close(buckets[0]['cer'], Fraction(5, 27))
        assert buckets[1]['cer'] == 0.0

    def test_cer_per_group(self, rows):
        groups = {g['key']: g for g in eval_metrics.grouped(rows, 'job_id')}
        assert groups['j1']['lines'] == 3
        assert close(groups['j1']['cer'], Fraction(2, 17))
        assert close(groups['j2']['cer'], Fraction(3, 10))

    def test_confidence_against_correctness(self, rows):
        bins = {b['bin']: b for b in eval_metrics.calibration(rows)}
        assert sorted(bins) == [0.5, 0.8, 0.9]
        top = bins[0.9]
        assert top['lines'] == 3
        assert top['exact'] == 1
        assert top['exact_share'] == pytest.approx(1 / 3)
        assert top['mean_confidence'] == pytest.approx(0.95)
        assert top['cer'] == pytest.approx(2 / 18)
        assert bins[0.5]['cer'] == pytest.approx(0.5)

    def test_a_confidence_of_one_lands_in_the_top_bin(self):
        rows = [eval_metrics.scored_row(eval_metrics.line_record(1, 'j', 1, 'beam', 'a', 'a', 1.0))]
        assert [b['bin'] for b in eval_metrics.calibration(rows)] == [0.9]


class TestFrequency:
    def test_test_material_against_training_data(self, rows):
        table = {r['char']: r for r in eval_metrics.frequency(rows, {'a': 10, 'b': 5})}
        assert table['a']['test'] == 3
        assert table['a']['test_share'] == pytest.approx(3 / 27)
        assert table['a']['train'] == 10
        assert table['a']['train_share'] == pytest.approx(10 / 15)
        assert table['5']['train'] == 0

    def test_without_training_data_the_train_side_is_unknown(self, rows):
        table = eval_metrics.frequency(rows, None)
        assert table[0]['train'] is None
        assert table[0]['train_share'] is None


def test_a_decomposed_reading_of_composed_ground_truth_is_no_error():
    record = eval_metrics.line_record(1, 'j', 1, 'beam', 'März', 'März', 0.9)

    assert (record['distance'], record['length'], record['cer']) == (0, 4, 0.0)
