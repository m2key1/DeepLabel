import bisect

from app import store

# A pair this close proves itself: the recognition and the transcription say the same
# thing. Below it the score says nothing about the pairing, only about the model, so a
# weaker pair settles only where reading order confirms it.
AUTOCHECK_SIMILARITY = 0.95
ORDERED_SIMILARITY = 0.7

# Ground truth a person put there is a transcription of record. Every other source is some
# machine's reading of the same page - a document's own text layer, or a model asked to
# transcribe it - and checking a machine's guess off would file it in the corpus under a
# human's authority. Text with no recorded source predates provenance and can only have
# come from a sidecar, which is what the schema backfills it to.
TRUSTED_GT_SOURCES = frozenset({'sidecar'})


def gt_is_trusted(gt_source: str | None) -> bool:
    """Whether ground truth from this source may check a line off without being read."""
    return (gt_source or 'sidecar') in TRUSTED_GT_SOURCES


def edit_distance(a, b) -> int:
    if len(a) < len(b):
        a, b = b, a
    previous = list(range(len(b) + 1))
    for i, item_a in enumerate(a, start=1):
        current = [i]
        for j, item_b in enumerate(b):
            current.append(min(previous[j + 1] + 1, current[j] + 1,
                               previous[j] + (item_a != item_b)))
        previous = current
    return previous[-1]


def similarity(a: str, b: str) -> float:
    if not a and not b:
        return 1.0
    longest = max(len(a), len(b))
    return 1.0 - edit_distance(a, b) / longest


def greedy_align(gt_lines: list[str], ocr_lines: list[str],
                 floor: float = 0.5) -> list[tuple[int, int, float]]:
    """Best-first matching of ground-truth lines to OCR lines: the globally
    highest-scoring pair is locked in first and both lines leave their pools,
    so a confident match can never be stolen by a weaker one later. Pairs
    below the floor stay unmatched - forcing them would attach transcriptions
    to lines the segmentation never found."""
    scored = [(similarity(gt, ocr), gi, oi)
              for gi, gt in enumerate(gt_lines)
              for oi, ocr in enumerate(ocr_lines)]
    scored.sort(key=lambda s: (-s[0], s[1], s[2]))
    gt_free = set(range(len(gt_lines)))
    ocr_free = set(range(len(ocr_lines)))
    matches = []
    for score, gi, oi in scored:
        if score < floor:
            break
        if gi in gt_free and oi in ocr_free:
            gt_free.remove(gi)
            ocr_free.remove(oi)
            matches.append((gi, oi, score))
    return matches


def order_confirmed(matches: list[tuple[int, int, float]]) -> list[bool]:
    """Which matches agree with reading order - the longest run of pairs whose
    transcription line and recognized line advance together. Pairs outside that run
    cross over it: one of the two is attached to the wrong line, and which one is
    unknowable from the text alone."""
    confirmed = [False] * len(matches)
    tail_ocr: list[int] = []   # smallest ocr index ending a run of each length
    tail_match: list[int] = []
    previous = [-1] * len(matches)
    for index in sorted(range(len(matches)), key=lambda i: matches[i][0]):
        slot = bisect.bisect_left(tail_ocr, matches[index][1])
        previous[index] = tail_match[slot - 1] if slot else -1
        if slot == len(tail_ocr):
            tail_ocr.append(matches[index][1])
            tail_match.append(index)
        else:
            tail_ocr[slot] = matches[index][1]
            tail_match[slot] = index
    node = tail_match[-1] if tail_match else -1
    while node != -1:
        confirmed[node] = True
        node = previous[node]
    return confirmed


def keeps_correction(checked: bool, corrected_text: str | None, corrected_by: str | None) -> bool:
    """Whether a re-run leaves this line's correction alone and offers the aligned text as
    a reading on it instead of writing it in.

    A checked line is settled, whoever settled it. An unchecked one is a person's when a
    person wrote its correction; a correction with no recorded author predates provenance
    and can only have been typed, so it is theirs too. A machine's correction, or none,
    is written over as before."""
    if checked:
        return True
    if not corrected_text:
        return False
    return corrected_by is None or store.is_person(corrected_by)


def may_autocheck(score: float, in_order: bool) -> bool:
    """Whether a match can check its line off without a person reading it.

    A near-exact score proves the pair on its own. Anything weaker is proof of nothing
    about the pairing - it measures how well the current model reads that hand, so
    gating on it alone keeps only the lines the model already gets right and discards
    every hard one, which is the opposite of what a transcribed corpus is for. On a
    dataset whose transcription lists every line in reading order, agreement with that
    order is the second kind of proof: a pair its neighbours bracket is the right pair."""
    return score >= AUTOCHECK_SIMILARITY or (in_order and score >= ORDERED_SIMILARITY)
