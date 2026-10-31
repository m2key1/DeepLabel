"""How a transcript search reads a query: the words it marks in a line, and what it refuses.
The same rules the reader's search box has always had, now run beside the data."""
import pytest

from app import text_search
from app.text_search import PatternTooSlow, matcher, search_form


def words(query: str, mode: str, text: str):
    hit = matcher(query, mode)(text)
    return hit.words if hit else None


class TestMarking:
    def test_every_word_an_exact_phrase_spans(self):
        assert words('Paragraph line 2', 'exact', 'Paragraph line 2') == ['Paragraph', 'line', '2']

    def test_the_words_a_phrase_touches_only_partly_and_none_outside_it(self):
        assert words('raph line', 'exact', 'Paragraph line 2') == ['Paragraph', 'line']

    def test_exact_ignores_case_and_case_does_not(self):
        assert words('PARAGRAPH LINE', 'exact', 'Paragraph line 2') == ['Paragraph', 'line']
        assert words('PARAGRAPH LINE', 'case', 'Paragraph line 2') is None
        assert words('Paragraph line', 'case', 'Paragraph line 2') == ['Paragraph', 'line']

    def test_an_exact_query_is_text_not_a_pattern(self):
        assert words('a.c', 'exact', 'abc a.c') == ['a.c']

    def test_every_word_a_pattern_spans_across(self):
        assert words(r'line \d', 'regex', 'Paragraph line 2') == ['line', '2']

    def test_every_occurrence_not_only_the_first(self):
        assert words('an', 'exact', 'an Anna banner') == ['an', 'Anna', 'banner']

    def test_nothing_in_a_line_the_query_does_not_match(self):
        assert words('line 3', 'exact', 'Paragraph line 2') is None
        assert words(r'line \d{2}', 'regex', 'Paragraph line 2') is None


class TestFuzzy:
    def test_the_misspelt_word_it_found_is_marked_in_its_searched_form(self):
        assert words('Mueller', 'fuzzy', 'Herr Müler zahlt') == ['mueler']

    def test_umlauts_written_out_are_the_same_name(self):
        assert words('Müller', 'fuzzy', 'Herr Mueller zahlt') == ['mueller']

    def test_a_word_containing_the_query_answers_outright(self):
        hit = matcher('schmid', 'fuzzy')('Johann Schmidtbauer')
        assert (hit.score, hit.words) == (1, ['schmidtbauer'])

    def test_one_edit_is_allowed_in_a_short_word_and_two_are_not(self):
        assert words('Gans', 'fuzzy', 'die Gais') == ['gais']
        assert words('Gans', 'fuzzy', 'die Geis') is None

    def test_a_swapped_pair_of_letters_is_one_edit(self):
        assert words('Huber', 'fuzzy', 'Hbuer Franz') == ['hbuer']

    def test_every_term_has_to_be_answered(self):
        assert words('Huber Franz', 'fuzzy', 'Franz Mayer') is None
        assert words('Huber Franz', 'fuzzy', 'Huber Franz') == ['huber', 'franz']

    def test_the_weakest_answer_is_the_score(self):
        hit = matcher('Huber Frantz', 'fuzzy')('Huber Franz')
        assert hit.score == pytest.approx(1 - 1 / 6)

    def test_the_search_form_folds_quotes_dashes_and_space(self):
        assert search_form('Ein „Wort“ –  Zweiß') == 'ein "wort" - zweiss'


class TestRefused:
    def test_an_empty_query_looks_for_nothing(self):
        assert matcher('  ', 'fuzzy') is None

    def test_an_unfinished_pattern_finds_nothing_rather_than_failing(self):
        assert matcher('Hub(er', 'regex') is None

    def test_a_pattern_that_runs_away_is_stopped(self, monkeypatch):
        monkeypatch.setattr(text_search, 'PATTERN_SECONDS', 0.05)
        test = matcher('(a|aa)+$', 'regex')
        with pytest.raises(PatternTooSlow):
            test('a' * 40 + 'b')

    def test_an_unknown_mode_is_refused(self):
        with pytest.raises(ValueError):
            matcher('x', 'soundex')
