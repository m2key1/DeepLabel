import math

from PIL import Image

# One line-crop, shared by the OCR runner and the /api/lines/{id}/crop endpoint so the
# loupe shows exactly what the model reads. Pure PIL (the app venv has no cv2/numpy).

# Bump whenever the pixels below change. Everything that keeps a crop is keyed on it
# through `caches.line_crop_recipe`, so crops cut by the old rule are never served again.
RECIPE = 'v2'

PAD_FRAC = 0.12
ELONG_MIN = 1.5    # below this the polygon isn't clearly a line, so don't rotate it
SLIGHT_MAX = 30.0  # deg: a near-horizontal line just gets its tilt corrected
VERT_MIN = 60.0    # deg: only a confidently steep/vertical line is rotated to horizontal


def _min_area_rect(poly):
    """The minimum-area rectangle enclosing the polygon, whose long side lies along the
    text baseline regardless of point order. Returns its 4 source-space corners in
    (UL, LL, LR, UR) order plus (width, height). A proper rotation, never mirrored."""
    best = None
    for i in range(len(poly)):
        x0, y0 = poly[i]
        x1, y1 = poly[(i + 1) % len(poly)]
        th = math.atan2(y1 - y0, x1 - x0)
        c, s = math.cos(-th), math.sin(-th)
        rot = [(x * c - y * s, x * s + y * c) for x, y in poly]
        minx = min(p[0] for p in rot)
        maxx = max(p[0] for p in rot)
        miny = min(p[1] for p in rot)
        maxy = max(p[1] for p in rot)
        area = (maxx - minx) * (maxy - miny)
        if best is None or area < best[0]:
            best = (area, th, minx, maxx, miny, maxy)
    _, th, minx, maxx, miny, maxy = best
    c, s = math.cos(th), math.sin(th)

    def back(x, y):
        return (x * c - y * s, x * s + y * c)

    corners = [back(minx, miny), back(minx, maxy), back(maxx, maxy), back(maxx, miny)]
    return corners, (maxx - minx, maxy - miny)


def _frame(poly: list[list[float]], orientation: int = 0):
    """Where a line's crop is taken from and how large it comes out: the four source
    corners, padded and turned, and the output size. None for a degenerate polygon."""
    if len(poly) < 3:
        return None
    xs = [p[0] for p in poly]
    ys = [p[1] for p in poly]
    raw_w, raw_h = max(xs) - min(xs), max(ys) - min(ys)
    if raw_w <= 0 or raw_h <= 0:
        return None

    corners, (w, h) = _min_area_rect(poly)
    if h > w:  # lay the long side horizontal so the tilt below is measured landscape
        corners = corners[1:] + corners[:1]
        w, h = h, w
    # A rectangle is 180°-symmetric, so the minimum-area search returns its long axis
    # pointing either way, decided by the polygon's winding and start vertex alone. Text
    # reads left to right, and a line standing on its side reads top to bottom, so the axis
    # is pinned by whichever component is the larger. Pinning it by x alone compares two
    # numbers that are equal but for noise on a line that is standing up, and a twentieth
    # of a pixel of lean then decides which way up every marginal note lands.
    ax, ay = corners[3][0] - corners[0][0], corners[3][1] - corners[0][1]
    if (ax if abs(ax) > abs(ay) else ay) < 0:
        corners = corners[2:] + corners[:2]
    tilt = abs(math.degrees(math.atan2(corners[3][1] - corners[0][1], corners[3][0] - corners[0][0])))
    tilt = min(tilt, 180 - tilt)  # long-axis angle from horizontal, folded to [0, 90]
    elong = w / max(h, 1e-6)
    deskew = elong >= ELONG_MIN and (tilt <= SLIGHT_MAX or tilt >= VERT_MIN)
    if not deskew:  # not a confident deskew: keep it axis-aligned and upright
        corners = [(min(xs), min(ys)), (min(xs), max(ys)), (max(xs), max(ys)), (max(xs), min(ys))]
        w, h = raw_w, raw_h

    (ulx, uly), (llx, lly) = corners[0], corners[1]  # pad along the height axis (UL->LL)
    hx, hy = llx - ulx, lly - uly
    hlen = math.hypot(hx, hy) or 1.0
    px, py = hx / hlen * PAD_FRAC * h, hy / hlen * PAD_FRAC * h
    corners = [
        (corners[0][0] - px, corners[0][1] - py),
        (corners[1][0] + px, corners[1][1] + py),
        (corners[2][0] + px, corners[2][1] + py),
        (corners[3][0] - px, corners[3][1] - py),
    ]
    h += 2 * PAD_FRAC * h

    q = (int(orientation) // 90) % 4  # quarter-turn: cycle UL->LL->LR->UR
    corners = corners[q:] + corners[:q]
    if q % 2 == 1:
        w, h = h, w

    return corners, (max(1, round(w)), max(1, round(h)))


def crop_size(poly: list[list[float]], orientation: int = 0) -> tuple[int, int] | None:
    """The (width, height) crop_line cuts this polygon to, without touching an image."""
    frame = _frame(poly, orientation)
    return frame[1] if frame else None


def crop_line(img: Image.Image, poly: list[list[float]], orientation: int = 0) -> Image.Image | None:
    """Crop a line, then apply the persisted 0/90/180/270 orientation and warp it out.
    A near-horizontal line only has its slight tilt corrected. The heavy rotation that
    lays a line flat is applied *only* when the line is confidently vertical (clearly
    elongated and steeply tilted) - otherwise the crop stays axis-aligned and upright, so
    normal lines are never spun sideways. `poly` is in `img` pixel coordinates. Returns
    None for a degenerate polygon. (The up/down 180° is left to the manual rotate button.)"""
    frame = _frame(poly, orientation)
    if frame is None:
        return None
    corners, out = frame
    quad = tuple(v for corner in corners for v in corner)
    return img.transform(out, Image.QUAD, quad, resample=Image.BICUBIC)
