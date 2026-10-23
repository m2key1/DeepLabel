import math

LINE_SHAPES = ('polygon', 'rotated', 'box')
# A run trained here is a DB detector's: it learns a shrunk core of every line, and the
# shrink falls apart on an outline that steps around ascenders and word gaps.
NATIVE_DEFAULT = 'rotated'
# What a backend that declares no shape trains on: the polygons as drawn, as before it could.
BACKEND_DEFAULT = 'polygon'


def shaped(polygon: list, shape: str) -> list:
    """The polygon as a run training on `shape` sees it: as drawn, the smallest rectangle
    round it at any angle, or the upright one."""
    if shape not in LINE_SHAPES:
        raise ValueError(f'line_shape must be one of {", ".join(LINE_SHAPES)}')
    if shape == 'polygon':
        return polygon
    if shape == 'box':
        xs, ys = [p[0] for p in polygon], [p[1] for p in polygon]
        return [[min(xs), min(ys)], [max(xs), min(ys)], [max(xs), max(ys)], [min(xs), max(ys)]]
    return _smallest_rectangle(_hull(polygon))


def _hull(points: list) -> list:
    """Convex hull, by Andrew's monotone chain."""
    ordered = sorted({(float(x), float(y)) for x, y in points})
    if len(ordered) < 3:
        return ordered

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lower, upper = [], []
    for point in ordered:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], point) <= 0:
            lower.pop()
        lower.append(point)
    for point in reversed(ordered):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], point) <= 0:
            upper.pop()
        upper.append(point)
    return lower[:-1] + upper[:-1]


def _smallest_rectangle(hull: list) -> list:
    """The least-area rectangle round a convex hull: one of its sides lies on a hull edge,
    so each edge's direction is tried. Ties keep the first, which is the upright one for an
    upright line."""
    if len(hull) < 3:
        return shaped([list(p) for p in hull] or [[0, 0]], 'box')
    best = None
    for (x0, y0), (x1, y1) in zip(hull, hull[1:] + hull[:1]):
        length = math.hypot(x1 - x0, y1 - y0)
        if not length:
            continue
        ux, uy = (x1 - x0) / length, (y1 - y0) / length
        along = [x * ux + y * uy for x, y in hull]
        across = [-x * uy + y * ux for x, y in hull]
        size = (max(along) - min(along)) * (max(across) - min(across))
        if best is None or size < best[0] - 1e-9:
            best = (size, ux, uy, min(along), max(along), min(across), max(across))
    _, ux, uy, a0, a1, c0, c1 = best
    return [[a * ux - c * uy, a * uy + c * ux] for a, c in ((a0, c0), (a1, c0), (a1, c1), (a0, c1))]
