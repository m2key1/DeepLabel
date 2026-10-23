import json
import math
from collections import Counter

from app import layout_templates, reading_order, store

class InvalidGeometry(ValueError):
    """Geometry the caller sent that cannot be used. Raised rather than an
    HTTPException because this module is on the runner's import path, which loads
    inside the model venv where no web stack exists; main.py turns it into a 400."""


def valid_polygon(poly) -> list:
    if not isinstance(poly, list) or len(poly) < 3:
        raise InvalidGeometry('polygon needs at least 3 points')
    out = []
    for pt in poly:
        if not isinstance(pt, list) or len(pt) != 2:
            raise InvalidGeometry('polygon points must be [x, y]')
        x, y = float(pt[0]), float(pt[1])
        if not (0 <= x <= 1 and 0 <= y <= 1):
            raise InvalidGeometry('polygon points must be normalized to [0, 1]')
        out.append([x, y])
    return out


def valid_bbox(bbox) -> list[float]:
    if not isinstance(bbox, list) or len(bbox) != 4:
        raise InvalidGeometry('bbox must be [x0, y0, x1, y1]')
    x0, y0, x1, y1 = (float(v) for v in bbox)
    # Reject rather than clamp: the UI clamps while dragging, so a degenerate
    # box arriving here is a bug worth surfacing.
    if not (0 <= x0 < x1 <= 1 and 0 <= y0 < y1 <= 1):
        raise InvalidGeometry('bbox must be normalized with x0 < x1 and y0 < y1')
    return [x0, y0, x1, y1]


def turn_point(point, degrees: int) -> list[float]:
    """A page point after the scan under it is turned clockwise. Page coordinates are
    normalized to the page's own edges, so a quarter turn is a swap of the two axes and
    needs nothing of the scan's pixel size."""
    x, y = point[0], point[1]
    turn = degrees % 360
    if turn == 90:
        return [1 - y, x]
    if turn == 180:
        return [1 - x, 1 - y]
    if turn == 270:
        return [y, 1 - x]
    return [x, y]


def bbox_ring(bbox: list) -> list:
    """A box as the four-corner outline a polygon-mode element starts from, clockwise
    from the top left like a detected line."""
    x0, y0, x1, y1 = bbox
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]


def ring_bounds(ring: list) -> list[float]:
    xs, ys = [p[0] for p in ring], [p[1] for p in ring]
    return [min(xs), min(ys), max(xs), max(ys)]


def fit_ring(ring: list, old: list, new: list) -> list:
    """An outline carried along when its element's box is moved or resized in box mode,
    so it still fits the box when the dataset goes back to polygons."""
    sx = (new[2] - new[0]) / ((old[2] - old[0]) or 1)
    sy = (new[3] - new[1]) / ((old[3] - old[1]) or 1)
    return [[min(1.0, max(0.0, new[0] + (x - old[0]) * sx)), min(1.0, max(0.0, new[1] + (y - old[1]) * sy))]
            for x, y in ring]


def point_in_ring(x: float, y: float, ring: list) -> bool:
    inside = False
    for (x0, y0), (x1, y1) in zip(ring, ring[1:] + ring[:1]):
        if (y0 > y) != (y1 > y) and x < x0 + (y - y0) * (x1 - x0) / (y1 - y0):
            inside = not inside
    return inside


def clip_ring(ring: list, axis: int, at: float, keep_above: bool) -> list:
    """The part of an outline on one side of a straight cut, x = at (axis 0) or y = at
    (axis 1): what a split leaves each half of a polygon element."""
    def inside(p):
        return p[axis] >= at if keep_above else p[axis] <= at

    def cross(p, q):
        t = (at - p[axis]) / (q[axis] - p[axis])
        return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]

    out = []
    for p, q in zip(ring, ring[1:] + ring[:1]):
        if inside(p):
            out.append(list(p))
            if not inside(q):
                out.append(cross(p, q))
        elif inside(q):
            out.append(cross(p, q))
    return out


def hull(points: list) -> list:
    """The convex outline around several, for a merge of polygon elements."""
    pts = sorted({(p[0], p[1]) for p in points})
    if len(pts) < 3:
        return [list(p) for p in pts]

    def turn(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lower, upper = [], []
    for p in pts:
        while len(lower) >= 2 and turn(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    for p in reversed(pts):
        while len(upper) >= 2 and turn(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    return [list(p) for p in lower[:-1] + upper[:-1]]


def turn_poly(poly: list, degrees: int) -> list:
    return [turn_point(point, degrees) for point in poly]


def turn_bbox(bbox: list, degrees: int) -> list[float]:
    """An axis-aligned box comes out of a quarter turn axis-aligned, with the corners
    that describe it swapped round."""
    (x0, y0), (x1, y1) = turn_point(bbox[:2], degrees), turn_point(bbox[2:], degrees)
    return [min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1)]


def poly_key(poly: list) -> tuple:
    # Same reading-order key the runner sorts by (mean y, then mean x).
    ys = sum(p[1] for p in poly) / len(poly)
    xs = sum(p[0] for p in poly) / len(poly)
    return (ys, xs)


def line_center(poly: list) -> tuple:
    return (sum(p[0] for p in poly) / len(poly), sum(p[1] for p in poly) / len(poly))


SLIVER = 0.003


def split_quad(quad: list, a: list, b: list) -> tuple[list, list]:
    """Cut a [TL, TR, BR, BL] quad along the line through `a` and `b`, extended past both
    points. The line has to cross two opposite sides; both pieces keep the corner order,
    the left (or upper) one first. A tilted line is cut the same way as a level one, so
    a stroke drawn across it lands exactly where it was drawn."""
    if len(quad) != 4:
        raise InvalidGeometry('split only supports 4-point line quads')
    dx, dy = b[0] - a[0], b[1] - a[1]
    crossings = {}
    for i in range(4):
        p, q = quad[i], quad[(i + 1) % 4]
        ex, ey = q[0] - p[0], q[1] - p[1]
        denom = ex * dy - ey * dx
        if abs(denom) < 1e-12:
            continue  # side parallel to the cut, or no cut direction at all
        t = ((a[0] - p[0]) * dy - (a[1] - p[1]) * dx) / denom
        if 0 < t < 1:
            crossings[i] = [p[0] + t * ex, p[1] + t * ey]
    tl, tr, br, bl = quad
    dist = lambda p, q: math.hypot(p[0] - q[0], p[1] - q[1])
    if set(crossings) == {0, 2}:
        top, bottom = crossings[0], crossings[2]
        first, second = [tl, top, bottom, bl], [top, tr, br, bottom]
        thin = min(dist(tl, top), dist(top, tr)) < SLIVER
    elif set(crossings) == {1, 3}:
        right, left = crossings[1], crossings[3]
        first, second = [tl, tr, right, left], [left, right, br, bl]
        thin = min(dist(tl, left), dist(left, bl)) < SLIVER
    else:
        raise InvalidGeometry('cut must cross the line from one side to the other')
    if thin:
        raise InvalidGeometry('split would make a sliver')
    return first, second


def split_polygon(poly: list, a: list, b: list) -> tuple[list, list]:
    """Cut a line polygon of any number of corners along the line through `a` and `b`,
    extended past both points. Where that line crosses the polygon more than once (a
    curved line), the stretch nearest the middle of a-b is cut. The piece holding the
    first corner comes first and still starts there; the other starts where the cut
    enters it - for a cut across a line, the corner that becomes its top left."""
    dx, dy = b[0] - a[0], b[1] - a[1]
    side = [dx * (p[1] - a[1]) - dy * (p[0] - a[0]) for p in poly]
    crossings = []
    for i, p in enumerate(poly):
        j = (i + 1) % len(poly)
        if (side[i] < 0) != (side[j] < 0):
            q, t = poly[j], side[i] / (side[i] - side[j])
            point = [p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]
            crossings.append(((point[0] - a[0]) * dx + (point[1] - a[1]) * dy, i, point))
    crossings.sort()
    middle = (dx * dx + dy * dy) / 2
    # Along the line, every other crossing goes in: consecutive pairs bound the stretches inside.
    stretches = [crossings[k:k + 2] for k in range(0, len(crossings), 2)]
    if not stretches:
        raise InvalidGeometry('cut must cross the line from one side to the other')
    stretch = min(stretches, key=lambda s: max(s[0][0] - middle, middle - s[1][0], 0))
    (_, i, enter), (_, j, leave) = sorted(stretch, key=lambda c: c[1])
    width = math.hypot(enter[0] - leave[0], enter[1] - leave[1])
    if width < 1e-9:
        raise InvalidGeometry('cut must cross the line from one side to the other')
    first = _without_repeats([*poly[:i + 1], enter, leave, *poly[j + 1:]])
    second = _without_repeats([enter, *poly[i + 1:j + 1], leave])
    if min(polygon_area(first), polygon_area(second)) / width < SLIVER:
        raise InvalidGeometry('split would make a sliver')
    return first, second


def _without_repeats(ring: list) -> list:
    """The ring without a corner that repeats the one before it, as a cut through a
    corner leaves."""
    same = lambda p, q: math.isclose(p[0], q[0], abs_tol=1e-12) and math.isclose(p[1], q[1], abs_tol=1e-12)
    out = [p for k, p in enumerate(ring) if k == 0 or not same(p, ring[k - 1])]
    return out[:-1] if len(out) > 1 and same(out[-1], out[0]) else out


def edge_at(a: list, b: list, axis: int, v: float) -> list | None:
    """Point on segment a-b where coordinate `axis` equals v, or None if v is
    outside the segment's span on that axis."""
    if a[axis] == b[axis]:
        return None
    t = (v - a[axis]) / (b[axis] - a[axis])
    if not (0 < t < 1):
        return None
    return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]


def _cross(o, a, b) -> float:
    return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])


def convex_hull(points: list) -> list:
    """Andrew's monotone chain. Duplicate and collinear points are dropped, so the
    result is the corners alone."""
    pts = sorted({(float(x), float(y)) for x, y in points})
    if len(pts) < 3:
        return pts

    def half(seq):
        out: list = []
        for p in seq:
            while len(out) >= 2 and _cross(out[-2], out[-1], p) <= 0:
                out.pop()
            out.append(p)
        return out

    return half(pts)[:-1] + half(list(reversed(pts)))[:-1]


def _orient(quad: list, reading: tuple) -> list:
    """Rotate the corner list so the edge running most nearly the way the text does is
    the top one. The winding is untouched, so [TL, TR, BR, BL] still holds."""
    best_k, best_dot = 0, None
    for k in range(4):
        ax, ay = quad[k]
        bx, by = quad[(k + 1) % 4]
        dot = (bx - ax) * reading[0] + (by - ay) * reading[1]
        if best_dot is None or dot > best_dot:
            best_dot, best_k = dot, k
    return [quad[(best_k + i) % 4] for i in range(4)]


def min_area_quad(points: list, reading: tuple | None = None) -> list:
    """The tightest rectangle covering every point, at whatever angle wraps them best,
    in [TL, TR, BR, BL] order.

    Rotating calipers: a minimum-area rectangle always shares an edge with the convex
    hull, so trying each hull edge as the horizontal is enough. `reading` is the
    direction the text runs, used only to pick which of the rectangle's two sides is its
    top - without it a merged line could come back stood on its end."""
    pts = [(float(x), float(y)) for x, y in points]
    if not pts:
        return [[0.0, 0.0]] * 4
    hull = convex_hull(pts)
    angles = [math.atan2(hull[(i + 1) % len(hull)][1] - hull[i][1],
                         hull[(i + 1) % len(hull)][0] - hull[i][0])
              for i in range(len(hull))] if len(hull) >= 2 else []
    best = None
    for theta in angles or [0.0]:
        cos, sin = math.cos(-theta), math.sin(-theta)
        rot = [(x * cos - y * sin, x * sin + y * cos) for x, y in pts]
        x0 = min(p[0] for p in rot); x1 = max(p[0] for p in rot)
        y0 = min(p[1] for p in rot); y1 = max(p[1] for p in rot)
        area = (x1 - x0) * (y1 - y0)
        if best is None or area < best[0] - 1e-12:
            best = (area, theta, x0, x1, y0, y1)
    _, theta, x0, x1, y0, y1 = best
    cos, sin = math.cos(theta), math.sin(theta)
    quad = [(x * cos - y * sin, x * sin + y * cos)
            for x, y in ((x0, y0), (x1, y0), (x1, y1), (x0, y1))]
    if reading is not None and (reading[0] or reading[1]):
        quad = _orient(quad, reading)
    return [[min(1.0, max(0.0, x)), min(1.0, max(0.0, y))] for x, y in quad]


def orphan_buckets(conn, page_id: int) -> list[int]:
    """The buckets that hold a page's lines outside every layout box."""
    return [r['id'] for r in conn.execute(
        "SELECT id FROM elements WHERE page_id = ? AND deleted = 0 AND kind = 'orphan'", (page_id,))]


def resequence_lines(conn, element_id: int):
    """Put an element's lines back in order. Under a layout box they run straight down
    it; outside every box, where they are read depends on the whole page."""
    row = conn.execute('SELECT page_id, kind FROM elements WHERE id = ?', (element_id,)).fetchone()
    if row is not None and row['kind'] == 'orphan':
        resequence_page(conn, row['page_id'])
        return
    rows = conn.execute(
        'SELECT id, polygon FROM lines WHERE element_id = ? AND deleted = 0', (element_id,)).fetchall()
    polygons = [json.loads(r['polygon']) for r in rows]
    for order_idx, i in enumerate(sorted(range(len(rows)), key=lambda i: poly_key(polygons[i]))):
        conn.execute('UPDATE lines SET order_idx = ? WHERE id = ?', (order_idx, rows[i]['id']))


READING_ORDER_AUTHOR = 'system:reading-order'


def resequence_page(conn, page_id: int) -> set[int]:
    """Work out the order the page is read in and write it: its layout boxes by the
    layout's own rules (reading_order.page_order), its unassigned lines among them.

    Reading order is element order, then line order, so a line can only be read between
    two boxes from a bucket of its own standing between them: each run of unassigned
    lines gets one. A bucket that already holds most of a run keeps it, so a page already
    in order is left exactly as it is, and one a run no longer needs stays on the page
    empty rather than deleted - a line an undo puts back into it then still has somewhere
    to be. Containers are numbered among themselves. Moves and renumbering are logged as
    the system's, like any other write a revert has to be able to take back. Returns the
    elements it changed."""
    elements = conn.execute(
        "SELECT * FROM elements WHERE page_id = ? AND deleted = 0 AND kind != 'orphan' ORDER BY id",
        (page_id,)).fetchall()
    buckets = conn.execute(
        "SELECT * FROM elements WHERE page_id = ? AND deleted = 0 AND kind = 'orphan' "
        'ORDER BY order_idx, id', (page_id,)).fetchall()
    lines = conn.execute(
        'SELECT l.id, l.element_id, l.order_idx, l.polygon FROM lines l JOIN elements e ON l.element_id = e.id '
        "WHERE e.page_id = ? AND e.deleted = 0 AND e.kind = 'orphan' AND l.deleted = 0 "
        'ORDER BY e.order_idx, l.order_idx, l.id', (page_id,)).fetchall()
    polygons = [json.loads(r['polygon']) for r in lines]
    bboxes = [json.loads(e['bbox']) for e in elements]
    read = [_corners(b) for b, e in zip(bboxes, elements) if e['kind'] == 'content']
    job_id = conn.execute('SELECT job_id FROM pages WHERE id = ?', (page_id,)).fetchone()['job_id']
    rules = layout_templates.vocabulary(conn, job_id).reading_rules(layout_templates.reading_template(conn, job_id))
    structure = (1, 1) if rules.pipeline else reading_order.resolve(polygons + read, _page_setting(conn, page_id))
    order = reading_order.page_order(bboxes, [e['class_name'] for e in elements], polygons, *structure, rules=rules)
    holders = _claim_buckets(order.runs, [r['element_id'] for r in lines], [b['id'] for b in buckets])

    sequence = []
    for k, run in enumerate(order.runs):
        if run:
            sequence.append((holders[k], run))
        if k < len(order.content):
            sequence.append((elements[order.content[k]]['id'], None))
    used = {holder for holder, _ in sequence}
    sequence += [(b['id'], None) for b in buckets if b['id'] not in used]

    current = {r['id']: r for r in [*elements, *buckets]}
    changed: set[int] = set()
    for order_idx, (element_id, run) in enumerate(sequence):
        if element_id is None:
            element_id = _new_bucket(conn, page_id, order_idx, _extent([polygons[i] for i in run]))
            changed.add(element_id)
        elif _place(conn, current[element_id], order_idx):
            changed.add(element_id)
        for line_order, i in enumerate(run or []):
            changed |= _file_line(conn, lines[i], element_id, line_order)
    for order_idx, i in enumerate(order.containers):
        if _place(conn, elements[i], order_idx):
            changed.add(elements[i]['id'])
    return changed


def _place(conn, element, order_idx: int) -> bool:
    if element['order_idx'] == order_idx:
        return False
    store.ensure_origin(conn, 'element', element['id'], READING_ORDER_AUTHOR)
    conn.execute('UPDATE elements SET order_idx = ? WHERE id = ?', (order_idx, element['id']))
    store.log_element(conn, element['id'], READING_ORDER_AUTHOR, 'update')
    return True


def _file_line(conn, line, element_id: int, order_idx: int) -> set[int]:
    """Put a line in its bucket at its place. Its place alone is derived and goes
    unlogged, as resequence_lines leaves it; a change of bucket is a write like any
    other."""
    if line['element_id'] != element_id:
        store.ensure_origin(conn, 'line', line['id'], READING_ORDER_AUTHOR)
        conn.execute('UPDATE lines SET element_id = ?, order_idx = ? WHERE id = ?',
                     (element_id, order_idx, line['id']))
        store.log_line(conn, line['id'], READING_ORDER_AUTHOR, 'update')
        return {element_id, line['element_id']}
    if line['order_idx'] != order_idx:
        conn.execute('UPDATE lines SET order_idx = ? WHERE id = ?', (order_idx, line['id']))
        return {element_id}
    return set()


def _page_setting(conn, page_id: int) -> str | None:
    """How the page is laid out, as the page says or as its dataset does."""
    row = conn.execute(
        'SELECT p.reading_order AS page_setting, j.reading_order AS job_setting '
        'FROM pages p JOIN jobs j ON p.job_id = j.id WHERE p.id = ?', (page_id,)).fetchone()
    return row['page_setting'] or row['job_setting']


def _claim_buckets(runs: list, held_by: list, buckets: list) -> list:
    """Which existing bucket each run goes into, None where it needs a new one. Runs are
    matched to the buckets that hold most of their lines first, so as few lines as
    possible change bucket; a run left over takes a bucket nothing else claimed."""
    pairs = [(count, k, bucket) for k, run in enumerate(runs)
             for bucket, count in Counter(held_by[i] for i in run).items()]
    pairs.sort(key=lambda pair: -pair[0])
    holders: list = [None] * len(runs)
    taken = set()
    for _, k, bucket in pairs:
        if holders[k] is None and bucket not in taken:
            holders[k] = bucket
            taken.add(bucket)
    spare = [bucket for bucket in buckets if bucket not in taken]
    for k, run in enumerate(runs):
        if run and holders[k] is None and spare:
            holders[k] = spare.pop(0)
    return holders


def _new_bucket(conn, page_id: int, order_idx: int, bbox: list) -> int:
    cur = conn.execute(
        'INSERT INTO elements (page_id, order_idx, class_name, bbox, conf, kind, lines_bbox) '
        "VALUES (?, ?, 'Unassigned', ?, NULL, 'orphan', ?)", (page_id, order_idx, json.dumps(bbox), json.dumps(bbox)))
    store.log_element(conn, cur.lastrowid, READING_ORDER_AUTHOR, 'create')
    return cur.lastrowid


def _extent(polygons: list) -> list[float]:
    xs = [p[0] for poly in polygons for p in poly]
    ys = [p[1] for poly in polygons for p in poly]
    return [min(xs), min(ys), max(xs), max(ys)]


def _corners(bbox: list) -> list:
    x0, y0, x1, y1 = bbox
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]


def _signed_area(points: list) -> float:
    total = 0.0
    for i, (x0, y0) in enumerate(points):
        x1, y1 = points[(i + 1) % len(points)]
        total += x0 * y1 - x1 * y0
    return total / 2


def polygon_area(points: list) -> float:
    return abs(_signed_area(points)) if len(points) >= 3 else 0.0


def _wound(points: list) -> list:
    """The same ring, always in the same direction, so clipping can call one side inside."""
    return points if _signed_area(points) >= 0 else points[::-1]


def _inside(a: list, b: list, point: list) -> float:
    return (b[0] - a[0]) * (point[1] - a[1]) - (b[1] - a[1]) * (point[0] - a[0])


def _crossing(p: list, q: list, a: list, b: list) -> list:
    """Where segment p-q crosses the infinite line a-b. The side tests that select this
    branch count a point on the line as inside, so p-q can still be parallel to a-b -
    on a contour clipped against itself, every edge is. There is no single crossing
    then, and p already lies on the line to the precision on hand."""
    dx1, dy1 = q[0] - p[0], q[1] - p[1]
    dx2, dy2 = b[0] - a[0], b[1] - a[1]
    denominator = dx1 * dy2 - dy1 * dx2
    if denominator == 0:
        return [p[0], p[1]]
    t = ((a[0] - p[0]) * dy2 - (a[1] - p[1]) * dx2) / denominator
    return [p[0] + t * dx1, p[1] + t * dy1]


def clip_convex(subject: list, clip: list) -> list:
    """Sutherland-Hodgman: the part of `subject` inside the convex polygon `clip`. Line
    quads are convex, which is what makes this exact rather than an approximation."""
    output = _wound(subject)
    clip = _wound(clip)
    for i in range(len(clip)):
        a, b = clip[i], clip[(i + 1) % len(clip)]
        current, output = output, []
        if not current:
            break
        previous = current[-1]
        for point in current:
            if _inside(a, b, point) >= 0:
                if _inside(a, b, previous) < 0:
                    output.append(_crossing(previous, point, a, b))
                output.append(point)
            elif _inside(a, b, previous) >= 0:
                output.append(_crossing(previous, point, a, b))
            previous = point
    return output


_ORIGIN = [0.0, 0.0]


def _shared_area(first: list, second: list) -> float:
    """Area covered by both rings. Each is cut into signed triangles against the origin and
    the pairs are summed with their signs: winding numbers multiply, so this holds for a
    concave ring, where clipping one against the other directly does not - detection emits
    those whenever it traces a contour instead of a quad."""
    terms = []
    for i, a in enumerate(first):
        b = first[(i + 1) % len(first)]
        left = _signed_area([_ORIGIN, a, b])
        if left == 0:
            continue
        for j, c in enumerate(second):
            d = second[(j + 1) % len(second)]
            right = _signed_area([_ORIGIN, c, d])
            if right == 0:
                continue
            shared = polygon_area(clip_convex([_ORIGIN, a, b], [_ORIGIN, c, d]))
            terms.append(shared if (left > 0) == (right > 0) else -shared)
    # Each term is an area of the same order as the rings themselves, so two rings that
    # only graze each other cancel down to a residue rather than to nothing. Below the
    # arithmetic's reach against that scale, the honest answer is no overlap.
    total = abs(math.fsum(terms))
    scale = polygon_area(first) + polygon_area(second)
    return total if total > scale * 1e-12 else 0.0


def _bounds(points: list) -> tuple:
    xs = [x for x, _ in points]
    ys = [y for _, y in points]
    return min(xs), min(ys), max(xs), max(ys)


def iou(first: list, second: list) -> float:
    """Intersection over union of two line regions. Symmetric, unlike coverage: a box that
    grew to swallow another covers it completely but still scores low here, which is what
    keeps a systematically enlarged re-detection from reading as the same line."""
    if len(first) < 3 or len(second) < 3:
        return 0.0
    # Most pairs put to this on a page are nowhere near each other, and the triangle sum
    # below is quadratic in their corners.
    ax0, ay0, ax1, ay1 = _bounds(first)
    bx0, by0, bx1, by1 = _bounds(second)
    if ax0 >= bx1 or bx0 >= ax1 or ay0 >= by1 or by0 >= ay1:
        return 0.0
    own_first, own_second = polygon_area(first), polygon_area(second)
    # Neither ring can share more than it covers; holding that exactly is what makes a
    # ring against its own copy score 1 rather than a hair over.
    overlap = min(_shared_area(first, second), own_first, own_second)
    union = own_first + own_second - overlap
    return overlap / union if union > 0 else 0.0
