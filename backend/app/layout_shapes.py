import json
import math

from app import geometry, store

# How free a dataset's layout elements may be, lowest first. Each level is a ceiling: it
# allows its own shape and every one below it. The stored names predate the middle level.
LEVELS = ('box', 'rotated', 'polygon')

# How far from square a corner may be and still count as one, after the editor's rounding.
SQUARE = 0.02
UPRIGHT = 0.005


def allowed(level: str) -> list[str]:
    return list(LEVELS[:LEVELS.index(level) + 1])


def outlines(level: str) -> bool:
    """Whether the dataset keeps an outline per element; an Aligned one reads boxes."""
    return level != 'box'


def _pixels(ring: list, size: tuple[int, int]) -> list[tuple[float, float]]:
    return [(x * size[0], y * size[1]) for x, y in ring]


def _corners(ring: list) -> list:
    return ring[:-1] if len(ring) > 1 and ring[0] == ring[-1] else ring


def shape_of(polygon: list | None, size: tuple[int, int]) -> str:
    """What an element is: no outline or an upright rectangle is a box, any other rectangle
    a rotated box - square in pixels, which a page's 0-1 coordinates are not - and anything
    else a polygon."""
    if not polygon:
        return 'box'
    corners = _corners(polygon)
    if len(corners) != 4:
        return 'polygon'
    px = _pixels(corners, size)
    sides = [(px[(i + 1) % 4][0] - px[i][0], px[(i + 1) % 4][1] - px[i][1]) for i in range(4)]
    lengths = [math.hypot(*side) for side in sides]
    if min(lengths) == 0:
        return 'polygon'
    for i in range(4):
        (ax, ay), (bx, by) = sides[i], sides[(i + 1) % 4]
        if abs(ax * bx + ay * by) > SQUARE * lengths[i] * lengths[(i + 1) % 4]:
            return 'polygon'
    upright = all(min(abs(dx), abs(dy)) <= UPRIGHT * length for (dx, dy), length in zip(sides, lengths))
    return 'box' if upright else 'rotated'


def within(level: str, polygon: list | None, size: tuple[int, int]) -> bool:
    return shape_of(polygon, size) in allowed(level)


def _rotated_around(polygon: list, size: tuple[int, int]) -> list:
    """The tightest square-cornered box around an outline, worked out in pixels and given
    back in the page's 0-1 coordinates."""
    scale = max(size)
    scaled = [(x * size[0] / scale, y * size[1] / scale) for x, y in polygon]
    quad = geometry.min_area_quad(scaled, reading=(1, 0))
    return [[x * scale / size[0], y * scale / size[1]] for x, y in quad]


def fitted(polygon: list | None, bbox: list, level: str, size: tuple[int, int]) -> tuple[list, list | None]:
    """An element's box and outline once it keeps to `level`: a shape within it as it is,
    one above it as the tightest allowed shape around it."""
    if within(level, polygon, size):
        return bbox, polygon
    if level == 'box':
        return geometry.ring_bounds(polygon), None
    ring = _rotated_around(polygon, size)
    return geometry.ring_bounds(ring), ring


def covers(ring: list, point: list, size: tuple[int, int], slack: float = 0.5) -> bool:
    """Whether a point lies inside a convex outline, give or take half a pixel."""
    px = _pixels(_corners(ring), size)
    x, y = point[0] * size[0], point[1] * size[1]
    signs = set()
    for i in range(len(px)):
        (ax, ay), (bx, by) = px[i], px[(i + 1) % len(px)]
        cross = (bx - ax) * (y - ay) - (by - ay) * (x - ax)
        if abs(cross) > slack * math.hypot(bx - ax, by - ay):
            signs.add(cross > 0)
    return len(signs) <= 1


def _elements(conn, job_ids: list[str]):
    marks = ','.join('?' * len(job_ids))
    return conn.execute(
        'SELECT e.id, e.bbox, e.polygon, p.width, p.height FROM elements e JOIN pages p ON e.page_id = p.id '
        f'WHERE p.job_id IN ({marks}) AND e.deleted = 0', job_ids).fetchall()


def _size(row) -> tuple[int, int]:
    return (row['width'] or 1, row['height'] or 1)


def changes(conn, job_ids: list[str], level: str) -> dict[str, int]:
    """How many elements lowering to `level` would change, by the shape they have now. An
    Aligned dataset reads every element as its box, so only datasets keeping outlines count."""
    kept = [job_id for job_id in job_ids
            if outlines(conn.execute('SELECT layout_shape FROM jobs WHERE id = ?', (job_id,)).fetchone()[0])]
    counts = {'polygon': 0, 'rotated': 0}
    for row in _elements(conn, kept) if kept else []:
        shape = shape_of(json.loads(row['polygon']) if row['polygon'] else None, _size(row))
        if shape in counts and shape not in allowed(level):
            counts[shape] += 1
    return counts


def apply(conn, job_id: str, level: str, author: str) -> None:
    """Set a dataset's level. Raising from Aligned starts every element from its box, as that
    is what the dataset showed; lowering turns each shape above the level into the tightest
    allowed one around it, logged, so undo and restore bring the old shape back."""
    current = conn.execute('SELECT layout_shape FROM jobs WHERE id = ?', (job_id,)).fetchone()[0]
    conn.execute('UPDATE jobs SET layout_shape = ? WHERE id = ?', (level, job_id))
    rows = _elements(conn, [job_id])
    if not outlines(current) and outlines(level):
        conn.executemany('UPDATE elements SET polygon = ? WHERE id = ?',
                         [(json.dumps(geometry.bbox_ring(json.loads(row['bbox']))), row['id']) for row in rows])
        return
    if not outlines(current):
        return
    for row in rows:
        polygon = json.loads(row['polygon']) if row['polygon'] else None
        bbox, ring = fitted(polygon, json.loads(row['bbox']), level, _size(row))
        ring = ring if outlines(level) else None
        if ring == polygon:
            continue
        conn.execute('UPDATE elements SET bbox = ?, polygon = ? WHERE id = ?',
                     (json.dumps(bbox), json.dumps(ring) if ring else None, row['id']))
        if not within(level, polygon, _size(row)):
            store.log_element(conn, row['id'], author, 'update')
