import re
import time
import unicodedata
from collections.abc import Callable
from dataclasses import dataclass

import regex

MODES = ('fuzzy', 'exact', 'case', 'regex')
# How long one search may spend in a user's pattern, across the whole volume. A pattern
# that backtracks without end would otherwise hold a worker for as long as it likes.
PATTERN_SECONDS = 2.0

UMLAUT = {'ä': 'ae', 'ö': 'oe', 'ü': 'ue', 'ß': 'ss'}
QUOTE = re.compile('[\u2018\u2019\u201a]')
DOUBLE_QUOTE = re.compile('[\u201c\u201d\u201e]')
DASH = re.compile('[\u2010\u2011\u2012\u2013\u2014\u2212]')
SPACE = re.compile(r'\s+')


class PatternTooSlow(Exception):
    """The pattern took longer than PATTERN_SECONDS to run down the volume."""


@dataclass
class Hit:
    # 1 where the line contains the query outright, otherwise how close the nearest spelling
    # came, so exact readings sort above corrected ones.
    score: float
    # The words that answered, so they can be marked in the line they were found in.
    words: list[str]


def fold(text: str) -> str:
    text = unicodedata.normalize('NFC', text)
    text = DASH.sub('-', DOUBLE_QUOTE.sub('"', QUOTE.sub("'", text)))
    return SPACE.sub(' ', text).strip()


def search_form(text: str) -> str:
    """Folded, lowercased, and with the German umlauts written out: a volume spells the same
    name Müller on one page and Mueller on the next, and somebody searching for either
    means both."""
    return re.sub('[äöüß]', lambda m: UMLAUT[m.group()], fold(text).lower())


def distance(a: str, b: str, cap: int) -> int:
    """Damerau-Levenshtein - edits, plus the swapped pair of letters that is half of what a
    person mistypes - abandoned as soon as no finish can come in under `cap`, which is what
    makes it affordable over a whole volume."""
    if abs(len(a) - len(b)) > cap:
        return cap + 1
    before_last: list[int] = []
    last = list(range(len(b) + 1))
    for i in range(1, len(a) + 1):
        row = [i]
        best_in_row = i
        for j in range(1, len(b) + 1):
            cost = 0 if a[i - 1] == b[j - 1] else 1
            step = min(last[j] + 1, row[j - 1] + 1, last[j - 1] + cost)
            if i > 1 and j > 1 and a[i - 1] == b[j - 2] and a[i - 2] == b[j - 1]:
                step = min(step, before_last[j - 2] + 1)
            row.append(step)
            best_in_row = min(best_in_row, step)
        if best_in_row > cap:
            return cap + 1
        before_last, last = last, row
    return last[len(b)]


def allowance(word: str) -> int:
    """How far out a word of this length may be: one edit in four letters is already a
    different word as often as it is a misreading."""
    return 1 if len(word) <= 4 else 2 if len(word) <= 8 else 3


def _pattern_matcher(pattern: regex.Pattern, deadline: float) -> Callable[[str], Hit | None]:
    """Answers with every word a match covers, so a phrase or pattern running across several
    words marks all of them."""
    def test(text: str) -> Hit | None:
        try:
            # An empty match marks nothing, so a pattern that can match nothing finds nothing.
            spans = [m.span() for m in pattern.finditer(text, timeout=max(0.0, deadline - time.monotonic()))
                     if m.end() > m.start()]
        except TimeoutError:
            raise PatternTooSlow from None
        if not spans:
            return None
        return Hit(1, [word.group() for word in re.finditer(r'\S+', text)
                       if any(start < word.end() and end > word.start() for start, end in spans)])
    return test


def matcher(query: str, mode: str = 'fuzzy') -> Callable[[str], Hit | None] | None:
    """A test for one query, built once so the query is folded and measured once rather than
    per line; None where there is nothing to look for, or a pattern not finished yet.

    Every term of a fuzzy query has to be answered somewhere in the line, and the weakest
    answer is the score."""
    if mode not in MODES:
        raise ValueError(f'mode must be one of {", ".join(MODES)}')
    if not query.strip():
        return None
    # One clock for the whole volume, started when the search is.
    deadline = time.monotonic() + PATTERN_SECONDS
    if mode == 'regex':
        try:
            return _pattern_matcher(regex.compile(query), deadline)
        except regex.error:
            return None
    if mode in ('exact', 'case'):
        flags = 0 if mode == 'case' else regex.IGNORECASE
        return _pattern_matcher(regex.compile(regex.escape(query.strip()), flags), deadline)

    terms = search_form(query).split()
    whole = ' '.join(terms)
    caps = [allowance(term) for term in terms]

    def test(text: str) -> Hit | None:
        haystack = search_form(text)
        if not haystack:
            return None
        if whole in haystack:
            return Hit(1, [word for word in haystack.split(' ') if any(term in word for term in terms)])
        found = haystack.split(' ')
        answers = []
        weakest = 1.0
        for term, cap in zip(terms, caps, strict=True):
            best: tuple[float, str] | None = None
            for word in found:
                if term in word:
                    best = (1, word)
                    break
                apart = distance(term, word, cap)
                if apart > cap:
                    continue
                score = 1 - apart / max(len(term), len(word))
                if best is None or score > best[0]:
                    best = (score, word)
            if best is None:
                return None
            answers.append(best[1])
            weakest = min(weakest, best[0])
        return Hit(weakest, answers)
    return test
