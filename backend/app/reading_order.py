"""The order a page is read in: its lines where no layout box decides it, and its boxes
by the layout's own rules inside containers and by the same columns outside them.

Sorting by vertical position alone is right for one column and wrong for every other
page: two columns come out interleaved, line by line, which is unreadable and trains on
nonsense. What a person knows and the geometry does not is how the page is laid out -
one leaf or two, in how many columns - so that is asked at ingest and used here. With
the structure given, the hard half of reading-order recovery (inferring it) disappears
and what is left is arithmetic on the x coordinates.
"""
import functools
from dataclasses import dataclass, field
from typing import NamedTuple

# A line covering this much of the width it sits in runs across the columns rather than
# inside one - a heading, a rule, a signature. The page is cut into bands at each of
# them, and the columns are found again inside every band.
SPANNING = 0.65
# Narrower than this, a gap between two groups of lines is word spacing or a ragged
# margin, not the channel between two columns.
MIN_CHANNEL = 0.035
# Where a gutter is looked for on a double page: the fold is near the middle, and a wide
# channel a third of the way in is a column, not the fold.
GUTTER_BAND = (0.38, 0.62)


# How a dataset says its pages are laid out. 'auto' works it out per page; otherwise
# "<leaves>x<columns>", which is what the New job form offers and what a page may
# override for itself.
AUTO = 'auto'
CHOICES = (AUTO, '1x1', '1x2', '1x3', '2x1', '2x2', '2x3')


def parse(value: str | None) -> tuple[int, int] | None:
    """(leaves, columns), or None for auto - including for anything unrecognised, which
    is the safe reading: work it out rather than order the page by a typo."""
    if not value or value == AUTO or value not in CHOICES:
        return None
    leaves, _, columns = value.partition('x')
    return int(leaves), int(columns)


def resolve(polygons: list, setting: str | None) -> tuple[int, int]:
    """What to order this page by: what the dataset says, or what the page looks like."""
    return parse(setting) or detect(polygons)


def extents(polygon):
    """A line as this module reads it: how far left and right it reaches, and the height
    it sits at. The mean y rather than the top, so a tall initial does not sort above the
    line it belongs to."""
    xs = [p[0] for p in polygon]
    ys = [p[1] for p in polygon]
    return min(xs), max(xs), sum(ys) / len(ys)


def order(polygons: list, pages: int = 1, columns: int = 1) -> list[int]:
    """The indices of `polygons` in reading order. `pages` is 1 or 2 (a scan of an open
    book), `columns` is how many the text is set in on each of them."""
    return _order([extents(p) for p in polygons], pages, columns)


# Mirrors Page.sort_boxes in Schematismus/utils/ordering_utils.py: the containers, in the
# order nesting is worked out - innermost first, so a Column is filled before the Table
# that holds it. The two must change together.
CONTAINER_LEVELS = {'Curly': 0, 'Nested-Column': 1, 'Nested-Table': 2, 'Column': 3, 'Table': 4}
# Inside a Column, a heading this close to a paragraph's height is read before it.
SAME_ROW = 0.01
# Two items level within SAME_ROW stand side by side when they share less than this much of
# the narrower one's width; otherwise one is over the other, however close.
SIDE_BY_SIDE = 0.5
PAGE_NUMBER = 'Pagenumber'


@dataclass(frozen=True)
class Rules:
    """How a dataset's containers read. `levels` are the container classes in the order
    nesting is worked out, innermost first (a tie goes to the smaller box); `reads` is
    each one's direction, 'down' or 'across'. `page_number` is read before everything.
    `schematismus` keeps the Schematismus pipeline's own per-class rules; `pipeline` reads
    the page as that pipeline does, for a template reading top to bottom:
    everything outside the containers top to bottom by its centre, with no guess at leaves
    or columns, and containers of one kind filled in the order they were detected."""
    levels: dict = field(default_factory=dict)
    reads: dict = field(default_factory=dict)
    page_number: str | None = None
    schematismus: bool = False
    pipeline: bool = False


SCHEMATISMUS = Rules(CONTAINER_LEVELS, {}, PAGE_NUMBER, schematismus=True)
PIPELINE = Rules(CONTAINER_LEVELS, {}, PAGE_NUMBER, schematismus=True, pipeline=True)


def schematismus_rules(added: dict, pipeline: bool = False) -> Rules:
    """The Schematismus rules with containers a dataset added to its classes: each nests
    inside the Schematismus ones and reads by its own direction."""
    if not added:
        return PIPELINE if pipeline else SCHEMATISMUS
    return Rules({**CONTAINER_LEVELS, **{name: -1 for name in added}}, dict(added), PAGE_NUMBER,
                 schematismus=True, pipeline=pipeline)


def template_rules(containers: dict, top_to_bottom: bool = False) -> Rules:
    """A template's rules from its containers and the way each reads: every one is one
    level, so which holds which follows from their boxes, the smaller filled first."""
    return Rules({name: 0 for name in containers}, dict(containers), pipeline=top_to_bottom)


class PageOrder(NamedTuple):
    content: list[int]
    runs: list[list[int]]
    containers: list[int]


def page_order(boxes: list, classes: list, lines: list, pages: int = 1, columns: int = 1,
               rules: Rules = SCHEMATISMUS) -> PageOrder:
    """How a page with layout boxes is read. `boxes` are bboxes with their `classes`, in
    the order they were made; `lines` are the polygons no box holds.

    Inside a container the layout pipeline's own rules decide: an item belongs to the
    innermost container its centre falls in, and each kind of container reads its
    children its own way. Everything outside every container - loose boxes, whole
    containers and lines alike - is ordered by the page's bands and columns, a box
    standing at its top edge because that is where reading it begins. The first page
    number is read before everything.

    `content` is the boxes that are not containers, in reading order. `runs` holds the
    lines read before the first of them and then after each one. `containers` is the
    containers walked outside in, numbered among themselves as layout numbers them."""
    centres = [((x0 + x1) / 2, (y0 + y1) / 2) for x0, y0, x1, y1 in boxes]
    centres += [((x0 + x1) / 2, y) for x0, x1, y in (extents(p) for p in lines)]
    widths = [(x0, x1) for x0, _y0, x1, _y1 in boxes] + [(x0, x1) for x0, x1, _y in (extents(p) for p in lines)]
    top, children = _nest(boxes, classes, centres, widths, rules)
    if rules.pipeline:
        sequence = sorted(top, key=lambda i: centres[i][1])
    else:
        spans = [(boxes[i][0], boxes[i][2], boxes[i][1]) if i < len(boxes) else extents(lines[i - len(boxes)])
                 for i in top]
        sequence = [top[k] for k in _order(spans, pages, columns)]
    page_number = next((i for i in sequence if i < len(boxes) and classes[i] == rules.page_number), None)
    if page_number is not None:
        sequence.remove(page_number)
        sequence.insert(0, page_number)

    order = PageOrder([], [[]], [])

    def visit(i):
        if i in children:
            order.containers.append(i)
            for child in children[i]:
                visit(child)
        elif i < len(boxes):
            order.content.append(i)
            order.runs.append([])
        else:
            order.runs[-1].append(i - len(boxes))

    for i in sequence:
        visit(i)
    return order


def _nest(boxes: list, classes: list, centres: list, widths: list, rules: Rules) -> tuple[list[int], dict]:
    """Which container holds what. Containers take what their box holds the centre of,
    innermost kind first, and a filled container is itself something the next one can
    take. Returns what is left outside every container and each container's children
    in reading order. Lines are the items after the boxes."""
    # Of two containers of one kind, the smaller fills first: a Column drawn over half of
    # a wider one takes that half, and the wider one then holds it. The pipeline never
    # overlaps two of a kind, so for its own boxes the order makes no difference.
    # The pipeline itself fills them in the order they were detected.
    levels = rules.levels
    containers = sorted((i for i in range(len(boxes)) if classes[i] in levels),
                        key=lambda i: (levels[classes[i]], 0 if rules.pipeline else _area(boxes[i])))
    loose = [i for i in range(len(centres)) if i >= len(boxes) or classes[i] not in levels]
    by_direction = functools.partial(_arrange_by, rules.reads)

    def arrange(kind, *args):
        # A Schematismus dataset's own containers read by its rules, those added to it by theirs.
        if rules.schematismus and kind not in rules.reads:
            return _arrange(kind, *args, pipeline=rules.pipeline)
        return by_direction(kind, *args)
    children = {}
    for c in containers:
        x0, y0, x1, y1 = boxes[c]
        inside = {i for i in loose if x0 <= centres[i][0] <= x1 and y0 <= centres[i][1] <= y1}
        children[c] = arrange(classes[c], [i for i in loose if i in inside], centres, widths,
                              lambda i: i < len(boxes) and classes[i] not in levels,
                              lambda i: classes[i] if i < len(boxes) else None)
        loose = [i for i in loose if i not in inside] + [c]
    return loose, children


def _side_by_side(a: tuple, b: tuple) -> bool:
    """Whether two items stand beside each other rather than one over the other: they
    share less than half the narrower one's width."""
    shared = min(a[1], b[1]) - max(a[0], b[0])
    return shared < SIDE_BY_SIDE * min(a[1] - a[0], b[1] - b[0])


def _arrange(kind: str, items: list, centres: list, widths: list, is_box, class_of, pipeline: bool = False) -> list:
    x = lambda i: centres[i][0]
    y = lambda i: centres[i][1]
    if kind in ('Table', 'Nested-Table'):
        return sorted(items, key=x)
    if kind == 'Column':
        def compare(a, b):
            if abs(y(a) - y(b)) < SAME_ROW:
                if is_box(a) and is_box(b):
                    if class_of(a) != 'Paragraph' and class_of(b) == 'Paragraph':
                        return -1
                    if class_of(a) == 'Paragraph' and class_of(b) != 'Paragraph':
                        return 1
                # Level and side by side, as two Columns splitting one are: from the left.
                # Stacked one-line entries come closer than a row too, and read downwards.
                # The pipeline itself knows no such case.
                if not pipeline and _side_by_side(widths[a], widths[b]):
                    return (x(a) > x(b)) - (x(a) < x(b))
            return (y(a) > y(b)) - (y(a) < y(b))
        return sorted(sorted(items, key=y), key=functools.cmp_to_key(compare))
    if kind == 'Curly':
        if len(items) < 2:
            return items
        left, right = _two_clusters(items, x)
        return sorted(right, key=y) + sorted(left, key=y)
    return sorted(items, key=y)


def _arrange_by(reads: dict, kind: str, items: list, centres: list, widths: list, is_box, class_of) -> list:
    """A template container's children: side by side from the left when it reads across;
    from the top when it reads down, items level and beside each other from the left."""
    x = lambda i: centres[i][0]
    y = lambda i: centres[i][1]
    if reads.get(kind) == 'across':
        return sorted(items, key=x)

    def compare(a, b):
        if abs(y(a) - y(b)) < SAME_ROW and _side_by_side(widths[a], widths[b]):
            return (x(a) > x(b)) - (x(a) < x(b))
        return (y(a) > y(b)) - (y(a) < y(b))
    return sorted(sorted(items, key=y), key=functools.cmp_to_key(compare))


def _area(bbox: list) -> float:
    return (bbox[2] - bbox[0]) * (bbox[3] - bbox[1])


def _two_clusters(items: list, x) -> tuple[list, list]:
    """The split into a left and a right group that keeps each group tightest - what
    k-means with two clusters settles on along one axis, without its random start. Each
    group keeps the order the items came in."""
    xs = sorted(x(i) for i in items)
    best, cut = None, xs[0]
    for k in range(1, len(xs)):
        spread = sum((v - sum(xs[:k]) / k) ** 2 for v in xs[:k]) + \
            sum((v - sum(xs[k:]) / (len(xs) - k)) ** 2 for v in xs[k:])
        if best is None or spread < best:
            best, cut = spread, xs[k]
    return [i for i in items if x(i) < cut], [i for i in items if x(i) >= cut]


def _order(boxes: list, pages: int, columns: int) -> list[int]:
    if len(boxes) < 2:
        return list(range(len(boxes)))
    ordered: list[int] = []
    for band in _bands(boxes):
        for half in _halves(boxes, band, pages):
            for column in _columns(boxes, half, columns):
                ordered.extend(sorted(column, key=lambda i: (boxes[i][2], boxes[i][0])))
    return ordered


def detect(polygons: list) -> tuple[int, int]:
    """How the page looks to be laid out, for a dataset that would rather not say.

    The channels the lines leave between them are counted. One channel down the middle
    is read as two columns rather than as two leaves, because the two are the same
    picture - a spread of one-column leaves and a two-column page leave exactly the same
    gap in exactly the same place, and nothing in the geometry tells them apart. It costs
    nothing: both orderings read the left group and then the right one. A fold is only
    claimed when each side has channels of its own, which a spread of two-column leaves
    does and a two-column page cannot.
    """
    if len(polygons) < 4:
        return 1, 1
    boxes = [extents(p) for p in polygons]
    inside = [b for b in boxes if b[1] - b[0] < SPANNING]
    if len(inside) < 4:
        return 1, 1
    channels = _channels(inside)
    middle = [c for c in channels if GUTTER_BAND[0] <= (c[0] + c[1]) / 2 <= GUTTER_BAND[1]]
    others = [c for c in channels if c not in middle]
    fold = (middle[0][0] + middle[0][1]) / 2 if middle else None
    if fold is not None and any(c[1] < fold for c in others) and any(c[0] > fold for c in others):
        return 2, min(3, len(others) // 2 + 1)
    return 1, min(3, len(channels) + 1)


def _channels(boxes) -> list:
    """The stretches of the width that no line reaches into, widest first. These are the
    vertical whitespace valleys a projection profile would show, computed from the line
    extents directly because that is all the geometry there is."""
    spans = sorted((b[0], b[1]) for b in boxes)
    found = []
    reach = spans[0][1]
    for x0, x1 in spans[1:]:
        if x0 - reach >= MIN_CHANNEL:
            found.append((reach, x0))
        reach = max(reach, x1)
    return sorted(found, key=lambda c: c[1] - c[0], reverse=True)


def _bands(boxes) -> list:
    """The page cut into horizontal bands at every line that runs across it. A heading
    over two columns belongs to neither, and everything below it is read after it."""
    width = max(b[1] for b in boxes) - min(b[0] for b in boxes)
    by_height = sorted(range(len(boxes)), key=lambda i: (boxes[i][2], boxes[i][0]))
    bands: list[list[int]] = []
    current: list[int] = []
    for i in by_height:
        if boxes[i][1] - boxes[i][0] >= SPANNING * width:
            if current:
                bands.append(current)
                current = []
            bands.append([i])
            continue
        current.append(i)
    if current:
        bands.append(current)
    return bands


def _halves(boxes, band: list, pages: int) -> list:
    """One leaf, or two split at the fold. The fold is the widest channel near the middle
    of what this band covers; a band with no such channel is one leaf however many the
    page has, which is what a heading across the fold needs."""
    if pages < 2 or len(band) < 2:
        return [band]
    inside = [boxes[i] for i in band]
    gutter = [c for c in _channels(inside)
              if GUTTER_BAND[0] <= (c[0] + c[1]) / 2 <= GUTTER_BAND[1]]
    if not gutter:
        return [band]
    cut = (gutter[0][0] + gutter[0][1]) / 2
    left = [i for i in band if (boxes[i][0] + boxes[i][1]) / 2 < cut]
    right = [i for i in band if (boxes[i][0] + boxes[i][1]) / 2 >= cut]
    return [half for half in (left, right) if half]


def _columns(boxes, half: list, columns: int) -> list:
    """`columns` groups, split at the widest channels the lines leave. Asking for more
    columns than the page has channels gives back what there is rather than cutting a
    column down the middle: the number is what somebody said the volume looks like, and
    a page of it can be a half-empty one."""
    if columns < 2 or len(half) < 2:
        return [half]
    cuts = [(c[0] + c[1]) / 2 for c in _channels([boxes[i] for i in half])[:columns - 1]]
    if not cuts:
        return [half]
    groups: list[list[int]] = [[] for _ in range(len(cuts) + 1)]
    for i in half:
        centre = (boxes[i][0] + boxes[i][1]) / 2
        groups[sum(1 for cut in sorted(cuts) if centre >= cut)].append(i)
    return [group for group in groups if group]
