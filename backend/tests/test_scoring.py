import pytest

from app.scoring import corpus_scores, edit_distance


class TestEditDistance:
    def test_identical_is_zero(self):
        assert edit_distance(list('abc'), list('abc')) == 0

    def test_counts_substitutions_insertions_deletions(self):
        assert edit_distance(list('kitten'), list('sitting')) == 3

    def test_against_empty(self):
        assert edit_distance(list('abcd'), []) == 4


class TestCorpusScores:
    def test_exact_match_scores_zero(self):
        assert corpus_scores(['hello world'], ['hello world']) == (0.0, 0.0)

    def test_corpus_cer_pools_over_all_lines(self):
        # 1 char error over 10 reference chars total, 1 word error over 4 words.
        cer, wer = corpus_scores(['abcde', 'fghij'], ['abcde', 'fghix'])
        assert cer == pytest.approx(0.1)
        assert wer == pytest.approx(0.5)

    def test_wer_splits_on_whitespace(self):
        cer, wer = corpus_scores(['ein alter Text'], ['ein alter Test'])
        assert wer == pytest.approx(1 / 3)
        assert cer == pytest.approx(1 / 14)

    def test_empty_reference_corpus_scores_zero(self):
        assert corpus_scores([], []) == (0.0, 0.0)


def test_group_breakdown_scores_each_dataset_separately():
    import json
    from app.scoring import group_breakdown
    refs = ['abcd', 'abcd', 'xy']
    hyps = ['abcd', 'abcx', 'xz']
    result = json.loads(group_breakdown(refs, hyps, ['jobA', 'jobA', 'jobB']))
    assert result == {'jobA': {'cer': 0.125, 'wer': 0.5, 'lines': 2},
                      'jobB': {'cer': 0.5, 'wer': 1.0, 'lines': 1}}


def test_group_breakdown_is_omitted_for_a_single_dataset():
    from app.scoring import group_breakdown
    assert group_breakdown(['a'], ['a'], ['jobA']) is None
    assert group_breakdown(['a', 'b'], ['a', 'b'], ['', '']) is None
