"""A layout model's boxes scored against the checked ones, the way the COCO evaluation every
layout trainer reports does - so a comparison here reads like the trainer's own numbers."""

# IoU thresholds 0.50, 0.55, ..., 0.95, and the recall points precision is read at.
THRESHOLDS = [0.5 + 0.05 * step for step in range(10)]
RECALL_POINTS = [point / 100 for point in range(101)]


def iou(a: list[float], b: list[float]) -> float:
    """Overlap of two [x0, y0, x1, y1] boxes: their shared area over their joint area."""
    width = min(a[2], b[2]) - max(a[0], b[0])
    height = min(a[3], b[3]) - max(a[1], b[1])
    if width <= 0 or height <= 0:
        return 0.0
    shared = width * height
    joint = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - shared
    return shared / joint if joint > 0 else 0.0


def _average_precision(pages: list[dict], name: str, threshold: float, truth_count: int) -> float:
    """AP of one class at one IoU: its found boxes taken most confident first, each matched
    to the unmatched checked box of its class it overlaps most, if by at least `threshold`;
    precision then read at 101 recall points from its upper envelope (COCO's interpolation)."""
    found = sorted(((box['confidence'] or 0.0, index, box['bbox'])
                    for index, page in enumerate(pages) for box in page['found'] if box['class'] == name),
                   key=lambda entry: -entry[0])
    taken = {index: [False] * len(page['truth']) for index, page in enumerate(pages)}
    hits = 0
    curve = []
    for rank, (_, index, bbox) in enumerate(found, 1):
        best, best_overlap = None, threshold
        for slot, truth in enumerate(pages[index]['truth']):
            if truth['class'] != name or taken[index][slot]:
                continue
            overlap = iou(bbox, truth['bbox'])
            if overlap >= best_overlap:
                best, best_overlap = slot, overlap
        if best is not None:
            taken[index][best] = True
            hits += 1
        curve.append((hits / truth_count, hits / rank))
    envelope, ceiling = [], 0.0
    for recall, precision in reversed(curve):
        ceiling = max(ceiling, precision)
        envelope.append((recall, ceiling))
    envelope.reverse()
    total = 0.0
    for point in RECALL_POINTS:
        total += next((precision for recall, precision in envelope if recall >= point), 0.0)
    return total / len(RECALL_POINTS)


def score(pages: list[dict]) -> dict:
    """mAP at IoU 0.50 and over 0.50-0.95, and both per class, for pages of
    {'truth': [{'class', 'bbox'}], 'found': [{'class', 'bbox', 'confidence'}]}. A class
    nobody checked on these pages has no AP and is left out of the means."""
    truth_counts: dict[str, int] = {}
    found_counts: dict[str, int] = {}
    for page in pages:
        for box in page['truth']:
            truth_counts[box['class']] = truth_counts.get(box['class'], 0) + 1
        for box in page['found']:
            found_counts[box['class']] = found_counts.get(box['class'], 0) + 1
    per_class = {}
    for name in sorted(truth_counts):
        at = [_average_precision(pages, name, threshold, truth_counts[name]) for threshold in THRESHOLDS]
        per_class[name] = {'ap_50': at[0], 'ap_50_95': sum(at) / len(at),
                           'truth': truth_counts[name], 'found': found_counts.get(name, 0)}
    mean = (lambda key: sum(c[key] for c in per_class.values()) / len(per_class)) if per_class else (lambda key: None)
    return {'mAP_50': mean('ap_50'), 'mAP_50_95': mean('ap_50_95'), 'per_class': per_class,
            'pages': len(pages), 'truth': sum(truth_counts.values()), 'found': sum(found_counts.values())}
