"""Cutting a corpus into the reference text a single page is responsible for.

A transcribed corpus arrives as whole documents - a letter, an entry, a chapter - while
the unit of work here is the scanned leaf, and one document spans however many leaves it
was written on. Nothing in the filenames says which leaf carries which part: the only
correspondence is the text itself, read badly by OCR on one side and edited by a human on
the other.

Both sequences are in reading order, so the correspondence is monotonic, and that is the
whole of the method. Recognized lines are anchored to corpus lines wherever the two agree,
anchors that cross each other are dropped, and the cuts fall between what is left. A page
whose anchors all landed is pinned exactly; a page that anchored nothing takes the share
its neighbours leave for it.

The spans this produces are handed to a model that can also see the page, so they are
deliberately generous: a span reaching into its neighbour costs a model that reads the
page nothing, while a short one loses lines that nothing downstream can recover.
"""
import bisect
import re
from dataclasses import dataclass, field
from itertools import pairwise

from app import align

# Below this, two lines are not saying the same thing and an anchor would be noise.
ANCHOR_SIMILARITY = 0.6
# How far from its proportional position a recognized line is looked for, in corpus lines.
# Wide enough that a short corpus is searched end to end, which is the common case.
SEARCH_BAND = 250
# Cheap candidates scored properly per recognized line. The shortlist is what keeps the
# search linear; scoring every pair with edit distance is what it replaces.
SHORTLIST = 5
# Corpus lines added to each side of a span, absorbing the error in a cut the model can
# see past. Never crosses into another document, which a page cannot span.
OVERLAP_LINES = 2

WORD = re.compile(r'\w+', re.UNICODE)


@dataclass(frozen=True)
class Document:
    """One unit of the corpus, in the order it was uploaded."""
    name: str
    text: str


@dataclass
class Span:
    """The corpus text one page is answerable for, and how well it is pinned down."""
    document: str | None = None
    text: str = ''
    first_line: int | None = None
    last_line: int | None = None
    anchors: int = 0
    score: float = 0.0
    lines: list[str] = field(default_factory=list)


def normalize(text: str) -> str:
    """What two transcriptions of the same line have in common: their words, lowercased.
    Punctuation and spacing are exactly what an edition regularizes and what OCR invents,
    so neither is evidence about whether this is the same line."""
    return ' '.join(WORD.findall(text.casefold()))


def trigrams(text: str) -> set[str]:
    padded = f'  {text} '
    return {padded[i:i + 3] for i in range(len(padded) - 2)}


def overlap_ratio(a: set[str], b: set[str]) -> float:
    """Jaccard over character trigrams: a shortlist score, not a verdict. It costs a set
    intersection where similarity costs an edit matrix, which is the only reason every
    recognized line can be compared against a whole band of corpus lines."""
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def split_lines(text: str) -> list[str]:
    return [line.strip() for line in text.splitlines() if line.strip()]


def flatten(documents: list[Document]) -> tuple[list[str], list[int]]:
    """Every document's lines end to end, and the document each line came from."""
    lines: list[str] = []
    owners: list[int] = []
    for index, document in enumerate(documents):
        for line in split_lines(document.text):
            lines.append(line)
            owners.append(index)
    return lines, owners


def _anchor_candidates(page_lines: list[list[str]], corpus: list[str]) -> list[tuple[int, int, float]]:
    """(page index, corpus line, score) for every recognized line that found a partner.

    Each recognized line is looked for near where its position in the whole sequence says
    it should be, so the work stays proportional to the material rather than to its square.
    """
    flat = [(page, line) for page, lines in enumerate(page_lines) for line in lines]
    if not flat or not corpus:
        return []
    corpus_grams = [trigrams(normalize(line)) for line in corpus]
    found = []
    for position, (page, raw) in enumerate(flat):
        line = normalize(raw)
        if not line:
            continue
        centre = round(position * (len(corpus) - 1) / max(len(flat) - 1, 1))
        low = max(0, centre - SEARCH_BAND)
        high = min(len(corpus), centre + SEARCH_BAND + 1)
        grams = trigrams(line)
        # Ties break on nearness to where this line is expected rather than on the lowest
        # index. A corpus repeats itself - a salutation, a dating line, a blank refrain -
        # and every copy scores the same, so picking the first would pile every page's
        # anchors onto one line and leave the pages before it holding nothing.
        shortlist = sorted(range(low, high),
                           key=lambda index: (-overlap_ratio(grams, corpus_grams[index]),
                                              abs(index - centre), index))
        best_index, best_score = -1, 0.0
        for index in shortlist[:SHORTLIST]:
            score = align.similarity(line, normalize(corpus[index]))
            if score > best_score or (score == best_score and best_index >= 0
                                      and abs(index - centre) < abs(best_index - centre)):
                best_index, best_score = index, score
        if best_index >= 0 and best_score >= ANCHOR_SIMILARITY:
            found.append((page, best_index, best_score))
    return found


def monotonic(anchors: list[tuple[int, int, float]]) -> list[tuple[int, int, float]]:
    """The longest run of anchors that advances through the corpus as it advances through
    the pages. Anything crossing it is attached to the wrong line, and the text alone
    cannot say which of the two moved."""
    if not anchors:
        return []
    tails: list[int] = []
    tail_at: list[int] = []
    previous = [-1] * len(anchors)
    for index, (_page, corpus_line, _score) in enumerate(anchors):
        slot = bisect.bisect_right(tails, corpus_line)
        previous[index] = tail_at[slot - 1] if slot else -1
        if slot == len(tails):
            tails.append(corpus_line)
            tail_at.append(index)
        else:
            tails[slot] = corpus_line
            tail_at[slot] = index
    kept = []
    node = tail_at[-1] if tail_at else -1
    while node != -1:
        kept.append(anchors[node])
        node = previous[node]
    return kept[::-1]


def _page_documents(count: int, ranges: dict[int, tuple[int, int]],
                    owners: list[int], documents: int) -> list[int | None]:
    """Which document each page belongs to. A page is assigned by where its anchors
    landed; a page that anchored nothing inherits from the page before it, since a
    document runs over consecutive leaves. Assignments that would go backwards are
    dropped rather than reordered - the pages are in reading order by construction."""
    if documents == 1:
        # Nothing to decide: every leaf belongs to the only document there is, including
        # the ones that anchored nothing, which still need their share of it.
        return [0] * count
    assigned: list[int | None] = [None] * count
    highest = -1
    for page in range(count):
        span = ranges.get(page)
        if span is None:
            continue
        document = owners[(span[0] + span[1]) // 2]
        if document < highest:
            continue
        assigned[page] = highest = document
    last: int | None = None
    for page in range(count):
        if assigned[page] is None:
            assigned[page] = last
        else:
            last = assigned[page]
    following: int | None = None
    for page in reversed(range(count)):
        if assigned[page] is None:
            assigned[page] = following
        else:
            following = assigned[page]
    return assigned


def _interpolate(edges: list[int | None]) -> None:
    """Fills runs of unknown cuts by dividing the gap their known neighbours leave open.
    The ends are always known, so every run is bounded on both sides."""
    index = 1
    while index < len(edges) - 1:
        if edges[index] is not None:
            index += 1
            continue
        start, stop = index - 1, index
        while edges[stop] is None:
            stop += 1
        low, high, steps = edges[start], edges[stop], stop - start
        for offset in range(1, steps):
            edges[start + offset] = low + round(offset * (high - low) / steps)
        index = stop


def _clamp(edges: list[int], low: int, high: int) -> None:
    """Cuts advance or stand still, never retreat: anchors that disagree about where a
    page ends would otherwise hand the same corpus line to two pages."""
    running = low
    for index, edge in enumerate(edges):
        running = min(max(running, edge), high)
        edges[index] = running


def _cut_run(pages: list[int], bounds: tuple[int, int],
             ranges: dict[int, tuple[int, int]]) -> dict[int, tuple[int, int]]:
    """Where one document's lines are cut between the pages carrying it.

    Each cut is placed on whatever evidence reaches it: midway between the page before
    and the page after where both anchored, and hard against the one that anchored where
    only one did. Pages with nothing on either side divide the gap left to them, so a
    whole run that anchored nothing still gets a proportional share rather than nothing.
    """
    first, last = bounds
    if not pages:
        return {}
    edges: list[int | None] = [first]
    for left, right in pairwise(pages):
        before, after = ranges.get(left), ranges.get(right)
        if before is not None and after is not None:
            edges.append((before[1] + after[0] + 1) // 2)
        elif before is not None:
            edges.append(before[1] + 1)
        elif after is not None:
            edges.append(after[0])
        else:
            edges.append(None)
    edges.append(last + 1)
    _interpolate(edges)
    _clamp(edges, first, last + 1)
    return {page: (edges[position], edges[position + 1] - 1)
            for position, page in enumerate(pages)}


def cut(documents: list[Document], page_lines: list[list[str]],
        overlap: int = OVERLAP_LINES) -> list[Span]:
    """The reference span for each page, in page order.

    `page_lines` is what recognition made of each page, in reading order; `documents` is
    the corpus in reading order. Returns one span per page, empty where the page could
    not be placed in any document.
    """
    spans = [Span() for _ in page_lines]
    corpus, owners = flatten(documents)
    if not corpus or not page_lines:
        return spans

    anchors = monotonic(_anchor_candidates(page_lines, corpus))
    ranges: dict[int, tuple[int, int]] = {}
    scores: dict[int, list[float]] = {}
    for page, corpus_line, score in anchors:
        low, high = ranges.get(page, (corpus_line, corpus_line))
        ranges[page] = (min(low, corpus_line), max(high, corpus_line))
        scores.setdefault(page, []).append(score)

    belongs = _page_documents(len(page_lines), ranges, owners, len(documents))
    for index, document in enumerate(documents):
        pages = [page for page, owner in enumerate(belongs) if owner == index]
        lines = [position for position, owner in enumerate(owners) if owner == index]
        if not pages or not lines:
            continue
        bounds = (lines[0], lines[-1])
        for page, (start, stop) in _cut_run(pages, bounds, ranges).items():
            first = max(bounds[0], start - overlap)
            last = min(bounds[1], stop + overlap)
            held = corpus[first:last + 1] if last >= first else []
            spans[page] = Span(document=document.name, text='\n'.join(held),
                               first_line=first if held else None,
                               last_line=last if held else None,
                               anchors=len(scores.get(page, [])),
                               score=round(sum(scores.get(page, [])) / len(scores[page]), 4)
                               if scores.get(page) else 0.0,
                               lines=held)
    return spans
