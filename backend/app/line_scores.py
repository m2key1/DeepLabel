"""Line detection scored against checked outlines. Found lines are matched one to one to
checked ones by overlap, as a lines training run scores itself; every checked line left
over is then told apart by what lies on it."""
import statistics
from dataclasses import dataclass, field

from app import geometry

FOUND_IOU = 0.5
# A checked line with less than this share under found lines is missed.
COVERED = 0.5
# A found line holds a checked line it covers at least this share of.
HOLDS = 0.5
# A found line is a piece of a checked line it covers at least this share of.
PIECE = 0.2
# A found line lying less than this share of itself on checked lines is extra.
ON_TRUTH = 0.2

TRUTH_KINDS = ('found', 'missed', 'merged', 'split', 'loose')


@dataclass
class PageScore:
    """Each checked line's kind, each found line's ('found', 'extra', or 'other' for one
    that only takes part in a merge, split or loose outline), and the fit of every match."""
    truth: list[str]
    detected: list[str]
    ious: list[float] = field(default_factory=list)
    height_ratios: list[float] = field(default_factory=list)


def _height(ring: list) -> float:
    """Area over length: the height of a line drawn left to right or top to bottom."""
    xs, ys = [x for x, _ in ring], [y for _, y in ring]
    length = max(max(xs) - min(xs), max(ys) - min(ys))
    return geometry.polygon_area(ring) / length if length > 0 else 0.0


def score_page(truth: list[list], detected: list[list]) -> PageScore:
    truth_area = [geometry.polygon_area(t) for t in truth]
    found_area = [geometry.polygon_area(f) for f in detected]
    shared = {(i, j): area for i, t in enumerate(truth) for j, f in enumerate(detected)
              if (area := geometry.overlap_area(t, f)) > 0}
    share_of_truth = {key: area / truth_area[key[0]] for key, area in shared.items() if truth_area[key[0]] > 0}

    def iou(key):
        return shared[key] / (truth_area[key[0]] + found_area[key[1]] - shared[key])

    page = PageScore(truth=[''] * len(truth), detected=[''] * len(detected))
    for i, j in sorted((key for key in shared if iou(key) >= FOUND_IOU), key=iou, reverse=True):
        if page.truth[i] or page.detected[j]:
            continue
        page.truth[i] = page.detected[j] = 'found'
        page.ious.append(iou((i, j)))
        page.height_ratios.append(_height(detected[j]) / _height(truth[i]))

    held_by = {}
    for (i, j), share in share_of_truth.items():
        if share >= HOLDS:
            held_by.setdefault(j, set()).add(i)
    for i in range(len(truth)):
        if page.truth[i]:
            continue
        shares = {j: share for (k, j), share in share_of_truth.items() if k == i}
        if sum(shares.values()) < COVERED:
            page.truth[i] = 'missed'
        elif any(len(held_by.get(j, ())) > 1 for j, share in shares.items() if share >= HOLDS):
            page.truth[i] = 'merged'
        elif sum(1 for share in shares.values() if share >= PIECE) > 1:
            page.truth[i] = 'split'
        else:
            page.truth[i] = 'loose'
    for j in range(len(detected)):
        if page.detected[j]:
            continue
        on_truth = sum(area for (_, k), area in shared.items() if k == j)
        page.detected[j] = 'extra' if found_area[j] == 0 or on_truth / found_area[j] < ON_TRUTH else 'other'
    return page


def totals(pages: list[PageScore]) -> dict:
    """The counts over all pages, precision, recall and F1 of the one-to-one matches, and
    the fit of the matched outlines: their mean overlap and median height against the
    checked ones."""
    counts = {kind: sum(page.truth.count(kind) for page in pages) for kind in TRUTH_KINDS}
    truth = sum(len(page.truth) for page in pages)
    detected = sum(len(page.detected) for page in pages)
    found = counts['found']
    ious = [value for page in pages for value in page.ious]
    ratios = [value for page in pages for value in page.height_ratios]
    return {
        'truth': truth, 'detected': detected, **counts,
        'extra': sum(page.detected.count('extra') for page in pages),
        'precision': found / detected if detected else None,
        'recall': found / truth if truth else None,
        'f1': 2 * found / (truth + detected) if truth + detected else None,
        'iou': statistics.fmean(ious) if ious else None,
        'height_ratio': statistics.median(ratios) if ratios else None,
    }
