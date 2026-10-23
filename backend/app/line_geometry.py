"""Turning polygonized surfaces into traced boundary lines (map_lines pre-annotation).

Deliberately pure stdlib — no numpy, no cv2, no `inference` — so it imports in the
torch-free app venv and is unit-testable. Both the map runner and a prediction read on a
model backend (app.map_predict) turn surfaces into lines with `as_regions`.

Coordinates are normalized [0, 1]: contours arrive as integer pixel coords divided by the
tile size, so a left/top edge lands exactly on 0.0 while a right/bottom edge lands on
(size - 1) / size — every border test here tolerates both.
"""

# How close to the tile edge counts as "on the cut". This is NOT just the 1px inset of the
# outermost contour pixel: the model routinely leaves a 1-2px sliver of another class along
# the frame, so an edge-hugging contour sits at x=509-511 on a 512 tile rather than exactly
# on 511. Calibrated against a real prediction run (1146 polylines): segments lying within
# 1-2px of an edge reach 450-508px long — unmistakably the cut on a 512 tile — while from
# 3px out the longest drops to ~149px and the population becomes ordinary boundaries that
# merely run near the frame. Widening past 2.5 therefore buys ~2 more artifacts while
# deleting 2-3x as many real short segments. Re-run that length-vs-distance check before
# retuning.
BORDER_TOLERANCE_PX = 2.5
# Shortest surviving fragment worth keeping; below this it is a nub in a tile corner
# between two border stretches, not a boundary anyone wants to review.
MIN_LINE_PX = 3.0


def bounds(width: int, height: int | None = None) -> tuple:
    """(eps, hi, min_len) in normalized units for a tile of this size; eps and hi are
    (x, y) pairs, since a tile need not be square.

    `hi` is where the far edge actually is: contours are integer pixel coords divided by
    the tile size, so the last pixel of a 512 tile normalizes to 511/512, not 1.0. Measuring
    the right/bottom band from 1.0 instead would make it a whole pixel narrower than the
    left/top one — the asymmetry that let edge-hugging contours through."""
    height = height or width
    eps = (BORDER_TOLERANCE_PX / width, BORDER_TOLERANCE_PX / height)
    hi = ((width - 1) / width, (height - 1) / height)
    return eps, hi, MIN_LINE_PX / max(width, height)


def border_edges(pt, eps: tuple, hi: tuple) -> int:
    """Bitmask of the tile edges a point lies on (0 = interior): 1 left, 2 right,
    4 top, 8 bottom. A corner point belongs to two edges."""
    x, y = pt[0], pt[1]
    return ((1 if x <= eps[0] else 0) | (2 if x >= hi[0] - eps[0] else 0)
            | (4 if y <= eps[1] else 0) | (8 if y >= hi[1] - eps[1] else 0))


def length(points) -> float:
    return sum(((points[i + 1][0] - points[i][0]) ** 2 + (points[i + 1][1] - points[i][1]) ** 2) ** 0.5
               for i in range(len(points) - 1))


def split_at_border(ring, eps: tuple, hi: tuple, min_len: float) -> list:
    """Split a closed contour into the open runs that are NOT the tile cut.

    A segment lying along the tile border is an artifact of where the map was cut, not a
    boundary the model detected — training on it would teach the model that tile seams are
    boundaries. A segment is dropped when both endpoints sit on the *same* edge (the
    shared-bit test). What survives is emitted as open polylines in contour order, so one
    ring can yield several lines, or none for a surface that only touches borders. A ring
    that never touches the border stays a single closed loop with its first point repeated.
    """
    n = len(ring)
    if n < 3:
        return []
    edges = [border_edges(p, eps, hi) for p in ring]
    keep = [not (edges[i] & edges[(i + 1) % n]) for i in range(n)]
    if all(keep):
        return [list(ring) + [ring[0]]]
    if not any(keep):
        return []
    # Start walking at a dropped segment so no surviving run wraps past index 0.
    start = keep.index(False)
    runs, run = [], []
    for k in range(n):
        i = (start + k) % n
        if keep[i]:
            if not run:
                run = [ring[i]]
            run.append(ring[(i + 1) % n])
        elif run:
            runs.append(run)
            run = []
    if run:
        runs.append(run)
    return [r for r in runs if len(r) >= 2 and length(r) >= min_len]


def as_regions(poly: dict, region_kind: str, width: int = 512, height: int | None = None) -> list:
    """(points, holes) rows to insert for one polygonized surface.

    Polygon jobs keep the ring + holes as one filled region. Line jobs reduce the surface
    to its outlines: the outer ring and every hole ring each become traced boundaries — a
    hole edge is a real boundary the model found — minus any stretch running along the
    tile cut."""
    if region_kind != 'polyline':
        return [(poly['points'], poly['holes'])]
    eps, hi, min_len = bounds(width, height)
    out = []
    for ring in [poly['points'], *poly['holes']]:
        out.extend((line, []) for line in split_at_border(ring, eps, hi, min_len))
    return out
