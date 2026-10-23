// The page viewer's geometry: layout boxes and text-line quads on a scan. Normalized page
// coordinates are stretched by the page's aspect ratio, so every rigid edit maps into
// image pixels, works there, and maps back.
import type { Bbox, Line, PageElement } from '../../api'
import { clamp01, pointInRing, polyCenter, polyMaxX, polyMinX } from './core'
import type { Pt, Ring } from './core'

export const MIN_BOX = 0.004

export function orderBbox(x0: number, y0: number, x1: number, y1: number): Bbox {
  return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)]
}

export function resizeBbox(b: Bbox, corner: string, x: number, y: number): Bbox {
  const [x0, y0, x1, y1] = b
  return orderBbox(
    corner.includes('w') ? x : x0,
    corner.includes('n') ? y : y0,
    corner.includes('e') ? x : x1,
    corner.includes('s') ? y : y1,
  )
}

export function moveBbox(origin: Bbox, dx: number, dy: number): Bbox {
  const w = origin[2] - origin[0], h = origin[3] - origin[1]
  const x0 = Math.min(1 - w, Math.max(0, origin[0] + dx))
  const y0 = Math.min(1 - h, Math.max(0, origin[1] + dy))
  return [x0, y0, x0 + w, y0 + h]
}

export const bigEnough = (b: Bbox) => b[2] - b[0] >= MIN_BOX && b[3] - b[1] >= MIN_BOX

// Every box containing the point, innermost first. Layout is nested - a Paragraph
// sits in a Column sits in a Table - so picking only the smallest would leave every
// container unreachable by click. Clicking the same spot again walks outwards.
// With `outlines`, an element that has one is hit inside its outline, not its whole box.
export function containingStack(els: PageElement[], x: number, y: number, outlines = false): PageElement[] {
  const area = (el: PageElement) => (el.bbox[2] - el.bbox[0]) * (el.bbox[3] - el.bbox[1])
  return els
    .filter((el) => el.bbox[0] <= x && x <= el.bbox[2] && el.bbox[1] <= y && y <= el.bbox[3])
    .filter((el) => !outlines || !el.polygon || pointInRing([x, y], el.polygon))
    .sort((a, b) => area(a) - area(b))
}

// Text lines are only a few px tall, so hit-test the polygon's bounding box with a
// little vertical slack rather than the thin polygon itself - otherwise they are
// almost impossible to click. Overlaps cycle by smallest-area, like the box editor.
const LINE_HIT_PAD = 0.004

export function linesAt(lines: Line[], x: number, y: number): Line[] {
  const area = (l: Line) =>
    (polyMaxX(l.polygon) - polyMinX(l.polygon)) *
    (Math.max(...l.polygon.map((p) => p[1])) - Math.min(...l.polygon.map((p) => p[1])))
  const hit = (l: Line) => {
    const ys = l.polygon.map((p) => p[1])
    return (
      polyMinX(l.polygon) <= x && x <= polyMaxX(l.polygon) &&
      Math.min(...ys) - LINE_HIT_PAD <= y && y <= Math.max(...ys) + LINE_HIT_PAD
    )
  }
  return lines.filter(hit).sort((a, b) => area(a) - area(b))
}

// Translates one edge of a quad by the full drag delta, keeping its length and
// orientation. Both endpoints share the clamped delta so a page border never
// deforms the edge.
export function moveEdgeFree(origin: Ring, ei: number, dx: number, dy: number): Ring {
  const a = origin[ei], b = origin[(ei + 1) % origin.length]
  const cdx = Math.min(1 - Math.max(a[0], b[0]), Math.max(-Math.min(a[0], b[0]), dx))
  const cdy = Math.min(1 - Math.max(a[1], b[1]), Math.max(-Math.min(a[1], b[1]), dy))
  return origin.map(([x, y], i) =>
    i === ei || i === (ei + 1) % origin.length ? [x + cdx, y + cdy] : [x, y],
  )
}

/** Slides one edge outwards by walking its two ends down the sides that meet it, so the
 *  shape keeps the angles it was drawn with: a turned box stays a box, a slanted one keeps
 *  its slant, and every other corner stays exactly where it is.
 *
 *  In pixel space, because a direction perpendicular to the edge in the page's [0, 1]
 *  coordinates is not perpendicular on a scan that is not square - which is what turned a
 *  turned box into a parallelogram. Where a side runs along the edge it meets there is no
 *  walking down it, and that end falls back to the edge's own normal. */
export function moveEdge(origin: Ring, ei: number, dx: number, dy: number, aspect = 1): Ring {
  const { px, norm } = isotropic(aspect)
  const P = origin.map(px)
  const n = P.length
  const bi = (ei + 1) % n
  const a = P[ei], b = P[bi]
  const len = Math.hypot(b[0] - a[0], b[1] - a[1])
  if (len === 0) return origin
  const out: Pt = [(b[1] - a[1]) / len, (a[0] - b[0]) / len]

  // The side carrying each end, and how much of the drag it spends going outwards. A side
  // square to the edge spends all of it, which is the old behaviour and the common case.
  const walk = (from: Pt, to: Pt): { dir: Pt; gain: number } => {
    const d = unit(from, to)
    const gain = d[0] * out[0] + d[1] * out[1]
    return Math.abs(gain) < 1e-6 ? { dir: out, gain: 1 } : { dir: d, gain }
  }
  const ends = [
    { at: ei, ...walk(P[(ei + n - 1) % n], a) },
    { at: bi, ...walk(P[(bi + 1) % n], b) },
  ]

  // One distance for both ends, so the edge stays parallel to itself and the page's border
  // never deforms it. Clamped to whichever end runs out of page first.
  let t = (dx * aspect) * out[0] + dy * out[1]
  for (const end of ends) {
    const [x, y] = P[end.at]
    const reach = (p: number, step: number, max: number) => {
      if (Math.abs(step) < 1e-9) return
      const lo = (-p * end.gain) / step, hi = ((max - p) * end.gain) / step
      t = Math.min(Math.max(t, Math.min(lo, hi)), Math.max(lo, hi))
    }
    reach(x, end.dir[0], aspect)
    reach(y, end.dir[1], 1)
  }

  const moved = P.slice()
  for (const end of ends) {
    const k = t / end.gain
    const [x, y] = P[end.at]
    moved[end.at] = [x + k * end.dir[0], y + k * end.dir[1]]
  }
  return moved.map(norm)
}

export function movePoly(origin: Ring, dx: number, dy: number): Ring {
  const minx = polyMinX(origin), maxx = polyMaxX(origin)
  const miny = Math.min(...origin.map((p) => p[1])), maxy = Math.max(...origin.map((p) => p[1]))
  const cdx = Math.min(1 - maxx, Math.max(-minx, dx))
  const cdy = Math.min(1 - maxy, Math.max(-miny, dy))
  return origin.map(([x, y]) => [x + cdx, y + cdy])
}

export const polyBigEnough = (p: Ring) =>
  polyMaxX(p) - polyMinX(p) >= MIN_BOX &&
  Math.max(...p.map((q) => q[1])) - Math.min(...p.map((q) => q[1])) >= MIN_BOX

export const lineBox = (line: Line | null): Bbox | null => {
  if (!line) return null
  const ys = line.polygon.map((p) => p[1])
  return [polyMinX(line.polygon), Math.min(...ys), polyMaxX(line.polygon), Math.max(...ys)]
}

export function pagePoints(line: Line): string {
  return line.polygon.map(([x, y]) => `${x},${y}`).join(' ')
}

// Normalized page coordinates are stretched by the page's aspect ratio, so angles,
// lengths and right angles are only meaningful in image pixels. Every rigid edit maps
// into that isotropic space (x scaled by aspect = width / height), works there, and maps
// back, clamped to the page.
function isotropic(aspect: number) {
  return {
    px: ([x, y]: Pt): Pt => [x * aspect, y],
    norm: ([x, y]: Pt): Pt => [clamp01(x / aspect), clamp01(y)],
  }
}

const unit = (from: Pt, to: Pt): Pt => {
  const len = Math.hypot(to[0] - from[0], to[1] - from[1])
  return len === 0 ? [0, 0] : [(to[0] - from[0]) / len, (to[1] - from[1]) / len]
}

// A rectangle from one side and a point: `a`-`b` is one long side, `c` says how far
// the opposite side sits, measured along that side's normal. The three clicks of the
// Line pen. Returned as [TL, TR, BR, BL] with TL-TR running in reading direction (left
// to right, or down the page for a vertical line), which is the order split and merge
// on the server read a quad in. Null for a zero-length side.
export function angledQuad(a: Pt, b: Pt, c: Pt, aspect: number): Ring | null {
  const { px, norm } = isotropic(aspect)
  let [A, B] = [px(a), px(b)]
  if (A[0] === B[0] && A[1] === B[1]) return null
  if (B[0] < A[0] || (B[0] === A[0] && B[1] < A[1])) [A, B] = [B, A]
  const u = unit(A, B)
  const n: Pt = [-u[1], u[0]]
  const C = px(c)
  const h = (C[0] - A[0]) * n[0] + (C[1] - A[1]) * n[1]
  const across = ([x, y]: Pt): Pt => [x + h * n[0], y + h * n[1]]
  // For left-to-right text the normal points down the page, so a positive height puts
  // the clicked side on top; a negative one means the click landed above the side.
  const quad: Pt[] = h >= 0 ? [A, B, across(B), across(A)] : [across(A), across(B), B, A]
  return quad.map(norm)
}

// Drags corner `i` of a quad while the opposite corner stays put and both sides keep
// their direction: a tilted line stays a tilted rectangle instead of skewing. The
// rebuilt sides never shrink below `minLen` (image px), so the corner cannot be dragged
// through the opposite one and flip the vertex order.
export function resizeQuadCorner(quad: Ring, i: number, to: Pt, aspect: number, minLen = MIN_BOX): Ring {
  const { px, norm } = isotropic(aspect)
  const P = quad.map(px)
  const next = (i + 1) % 4, opposite = (i + 2) % 4, prev = (i + 3) % 4
  const d1 = unit(P[i], P[next]), d2 = unit(P[i], P[prev])
  const det = d1[0] * d2[1] - d1[1] * d2[0]
  if (Math.abs(det) < 1e-6) return quad.map((p, k) => (k === i ? to : p))
  const T = px(to)
  const v: Pt = [P[opposite][0] - T[0], P[opposite][1] - T[1]]
  const l1 = Math.max(minLen, (v[0] * d2[1] - v[1] * d2[0]) / det)
  const l2 = Math.max(minLen, (d1[0] * v[1] - d1[1] * v[0]) / det)
  const out = P.slice()
  out[i] = T
  out[next] = [T[0] + l1 * d1[0], T[1] + l1 * d1[1]]
  out[prev] = [T[0] + l2 * d2[0], T[1] + l2 * d2[1]]
  out[opposite] = [T[0] + l1 * d1[0] + l2 * d2[0], T[1] + l1 * d1[1] + l2 * d2[1]]
  return out.map(norm)
}

/** The convex hull, counter-clockwise in pixel space (Andrew's monotone chain). */
function hull(P: Pt[]): Pt[] {
  const pts = [...P].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  if (pts.length < 3) return pts
  const cross = (o: Pt, a: Pt, b: Pt) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const half = (source: Pt[]) => {
    const out: Pt[] = []
    for (const q of source) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], q) <= 0) out.pop()
      out.push(q)
    }
    out.pop()
    return out
  }
  return [...half(pts), ...half([...pts].reverse())]
}

/** The smallest rotated rectangle that contains the polygon - what a free-form line
 *  becomes when it is turned back into a box. The minimum-area rectangle always shares a
 *  side with the convex hull, so trying each hull side as its axis is exhaustive.
 *
 *  Returned in the [TL, TR, BR, BL] order the rest of the editor and the server read a
 *  quad in, with TL-TR running left to right. */
export function minAreaQuad(poly: Ring, aspect: number): Ring {
  const { px, norm } = isotropic(aspect)
  const H = hull(poly.map(px))
  if (H.length < 3) return poly
  let best: { area: number; quad: Pt[] } | null = null
  for (let i = 0; i < H.length; i++) {
    const a = H[i], b = H[(i + 1) % H.length]
    const len = Math.hypot(b[0] - a[0], b[1] - a[1])
    if (len === 0) continue
    const u: Pt = [(b[0] - a[0]) / len, (b[1] - a[1]) / len]
    const n: Pt = [-u[1], u[0]]
    const along = H.map((q) => (q[0] - a[0]) * u[0] + (q[1] - a[1]) * u[1])
    const across = H.map((q) => (q[0] - a[0]) * n[0] + (q[1] - a[1]) * n[1])
    const [u0, u1] = [Math.min(...along), Math.max(...along)]
    const [n0, n1] = [Math.min(...across), Math.max(...across)]
    const area = (u1 - u0) * (n1 - n0)
    if (best && area >= best.area) continue
    const corner = (s: number, t: number): Pt =>
      [a[0] + s * u[0] + t * n[0], a[1] + s * u[1] + t * n[1]]
    best = { area, quad: [corner(u0, n0), corner(u1, n0), corner(u1, n1), corner(u0, n1)] }
  }
  if (!best) return poly
  // Put the reading direction first: the side running left to right is the top one.
  const q = best.quad
  const top = q[1][0] >= q[0][0] ? q : [q[2], q[3], q[0], q[1]]
  return top.map(norm)
}

/** Splits the polygon's two longest opposite sides at their midpoints, which is what
 *  turns a box into something that can follow a baseline that is not straight. */
// The backend's crop_line rules, mirrored: below ELONG_MIN the polygon is not clearly a
// line, and between SLIGHT_MAX and VERT_MIN the tilt is not confident enough to rotate on -
// in both cases it crops axis-aligned, and the page's own x-axis is then the reading one.
const ELONG_MIN = 1.5

const SLIGHT_MAX = 30

const VERT_MIN = 60

const PAD_FRAC = 0.12

export interface CropPlan {
  /** The region the crop warps from, padded as the backend pads it, in page coordinates. */
  quad: Ring
  /** The two ends of the reading axis, or null where the page's own x-axis is it. */
  axis: [Pt, Pt] | null
  /** False where the tilt or the shape is not confident enough and it crops axis-aligned. */
  deskewed: boolean
  /** Long-axis angle from horizontal, folded to [0, 90] degrees. */
  tilt: number
  /** What the crop comes out as, in source pixels: [width, height] along the reading axis. */
  size: [number, number]
}

/** What `linecrop.crop_line` would do with this polygon, worked out on the page.
 *
 *  Mirrors it rather than asking the server, because the answer is wanted per line while a
 *  page is being read and the geometry is already here. The rules it mirrors: the minimum-area
 *  rectangle, the long side laid horizontal, the direction pinned by the larger component, the
 *  elongation and tilt it insists on before rotating anything, and the padding. */
/** `pageHeight` is the scan's height in pixels: the geometry is worked in page heights, and
 *  only the crop's size is said in pixels, which is what a model's input size is compared to. */
export function cropPlan(poly: Ring, aspect: number, orientation = 0, pageHeight = 1): CropPlan {
  const { px, norm } = isotropic(aspect)
  const pts = poly.map(px)
  const quadPx = minAreaQuad(poly, aspect).map(px)
  const side = (a: number, b: number): Pt => [quadPx[b][0] - quadPx[a][0], quadPx[b][1] - quadPx[a][1]]
  const size = (v: Pt) => Math.hypot(v[0], v[1])
  const [e1, e2] = [side(0, 1), side(0, 3)]
  let long = size(e1) >= size(e2) ? e1 : e2
  let short = size(e1) >= size(e2) ? e2 : e1
  const swung = Math.abs((Math.atan2(long[1], long[0]) * 180) / Math.PI)
  const tilt = Math.min(swung, 180 - swung)
  const deskewed = size(short) > 1e-9
    && size(long) / size(short) >= ELONG_MIN
    && (tilt <= SLIGHT_MAX || tilt >= VERT_MIN)

  let centre: Pt
  if (deskewed) {
    centre = [(quadPx[0][0] + quadPx[2][0]) / 2, (quadPx[0][1] + quadPx[2][1]) / 2]
    const leading = Math.abs(long[0]) > Math.abs(long[1]) ? long[0] : long[1]
    if (leading < 0) {
      long = [-long[0], -long[1]]
      short = [-short[0], -short[1]]
    }
  } else {
    // Not a confident deskew: the crop is the upright box around the polygon.
    const xs = pts.map((p) => p[0])
    const ys = pts.map((p) => p[1])
    centre = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2]
    long = [Math.max(...xs) - Math.min(...xs), 0]
    short = [0, Math.max(...ys) - Math.min(...ys)]
  }

  const half: Pt = [long[0] / 2, long[1] / 2]
  // Padded on the height axis only, so fractions along the reading axis are untouched.
  const grown: Pt = [short[0] * (0.5 + PAD_FRAC), short[1] * (0.5 + PAD_FRAC)]
  const corner = (a: number, b: number): Pt =>
    norm([centre[0] + a * half[0] + b * grown[0], centre[1] + a * half[1] + b * grown[1]])
  const wide = size(long) * pageHeight
  const tall = size(short) * (1 + 2 * PAD_FRAC) * pageHeight
  const quarter = Math.abs(Math.round(orientation / 90)) % 2 === 1
  return {
    quad: [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)],
    axis: deskewed && !quarter
      ? (Math.abs(Math.round(orientation / 90)) % 4 === 2
          ? [norm([centre[0] + half[0], centre[1] + half[1]]),
             norm([centre[0] - half[0], centre[1] - half[1]])]
          : [norm([centre[0] - half[0], centre[1] - half[1]]),
             norm([centre[0] + half[0], centre[1] + half[1]])])
      : null,
    deskewed,
    tilt,
    size: quarter ? [tall, wide] : [wide, tall],
  }
}

/** The two ends of the axis the OCR crop lays this line out along, in page coordinates.
 *
 *  The confidence profile places each character as a fraction of the crop's width, so anything
 *  drawing it back onto the page has to run along this and not the page's own axis: on a tilted
 *  line the two disagree and the colours slide off the characters they belong to. Fractions
 *  along a straight line survive the squash into page coordinates, because an affine map keeps
 *  ratios along a segment, so only the direction has to be carried over.
 *
 *  Null where the page's x-axis is already right, or where this cannot say. */
export function cropAxis(poly: Ring, aspect: number, orientation = 0): [Pt, Pt] | null {
  return cropPlan(poly, aspect, orientation).axis
}

export function splitLongSides(poly: Ring, aspect: number): Ring {
  const { px, norm } = isotropic(aspect)
  const P = poly.map(px)
  const n = P.length
  const sideLength = P.map((a, i) => {
    const b = P[(i + 1) % n]
    return Math.hypot(b[0] - a[0], b[1] - a[1])
  })
  const longest = sideLength.indexOf(Math.max(...sideLength))
  const opposite = (longest + Math.floor(n / 2)) % n
  const out: Pt[] = []
  for (let i = 0; i < n; i++) {
    out.push(P[i])
    if (i === longest || i === opposite) {
      const b = P[(i + 1) % n]
      out.push([(P[i][0] + b[0]) / 2, (P[i][1] + b[1]) / 2])
    }
  }
  return out.map(norm)
}

/** A vertex added at the midpoint of side `ei`, so a polygon can be given detail exactly
 *  where it is needed. */
export function splitSide(poly: Ring, ei: number): Ring {
  const a = poly[ei], b = poly[(ei + 1) % poly.length]
  const mid: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
  return [...poly.slice(0, ei + 1), mid, ...poly.slice(ei + 1)]
}

/** The polygon without vertex `vi`. A triangle is as far down as this goes - the server
 *  refuses anything less, and so does the idea of an area. */
export function dropVertex(poly: Ring, vi: number): Ring {
  if (poly.length <= 3) return poly
  return poly.filter((_, i) => i !== vi)
}

// The angle of a quad's top side (TL to TR), in degrees clockwise from the horizontal
// as seen on screen, folded to (-180, 180].
export function quadAngle(quad: Ring, aspect: number): number {
  const { px } = isotropic(aspect)
  const [a, b] = [px(quad[0]), px(quad[1])]
  return (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI
}

// The angle (degrees, screen-clockwise) from `center` to `p`, for turning a pointer
// position into a rotation.
export function angleAround(center: Pt, p: Pt, aspect: number): number {
  const { px } = isotropic(aspect)
  const [c, q] = [px(center), px(p)]
  return (Math.atan2(q[1] - c[1], q[0] - c[0]) * 180) / Math.PI
}

export function rotatePoly(poly: Ring, center: Pt, degrees: number, aspect: number): Ring {
  const { px, norm } = isotropic(aspect)
  const c = px(center)
  const rad = (degrees * Math.PI) / 180
  const cos = Math.cos(rad), sin = Math.sin(rad)
  return poly.map((p) => {
    const [x, y] = px(p)
    const dx = x - c[0], dy = y - c[1]
    return norm([c[0] + dx * cos - dy * sin, c[1] + dx * sin + dy * cos])
  })
}

// Where the rotate handle sits: outside the top side's midpoint, `offset` image px away
// from the quad's center, so it never overlaps a vertex handle. Returns the midpoint in
// normalized coords plus the outward direction as a unit vector in screen space.
export function rotateHandleAnchor(quad: Ring, aspect: number): { at: Pt; dir: Pt } {
  const { px } = isotropic(aspect)
  const [a, b] = [px(quad[0]), px(quad[1])]
  const mid: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
  const c = px(polyCenter(quad))
  const dir = unit(c, mid)
  return { at: [mid[0] / aspect, mid[1]], dir }
}

// Where the line through `a` and `b` crosses a quad's sides, provided it crosses two
// opposite ones: the two ends of the cut the server will make. Null otherwise.
export function quadCrossing(quad: Ring, a: Pt, b: Pt): [Pt, Pt] | null {
  const dx = b[0] - a[0], dy = b[1] - a[1]
  const crossings = new Map<number, Pt>()
  quad.forEach((p, i) => {
    const q = quad[(i + 1) % quad.length]
    const ex = q[0] - p[0], ey = q[1] - p[1]
    const denom = ex * dy - ey * dx
    if (Math.abs(denom) < 1e-12) return
    const t = ((a[0] - p[0]) * dy - (a[1] - p[1]) * dx) / denom
    if (t > 0 && t < 1) crossings.set(i, [p[0] + t * ex, p[1] + t * ey])
  })
  if (quad.length !== 4) return null
  if (crossings.has(0) && crossings.has(2) && crossings.size === 2) return [crossings.get(0)!, crossings.get(2)!]
  if (crossings.has(1) && crossings.has(3) && crossings.size === 2) return [crossings.get(1)!, crossings.get(3)!]
  return null
}

// The same for a polygon line, mirroring the server's split_polygon: the stretch of the
// line through `a` and `b` that lies inside the polygon, the one nearest the middle of
// `a`-`b` where it crosses more than once. Null where it does not cross at all.
export function polygonCrossing(poly: Ring, a: Pt, b: Pt): [Pt, Pt] | null {
  const dx = b[0] - a[0], dy = b[1] - a[1]
  const side = poly.map((p) => dx * (p[1] - a[1]) - dy * (p[0] - a[0]))
  const crossings: { along: number; at: Pt }[] = []
  poly.forEach((p, i) => {
    const j = (i + 1) % poly.length
    if (side[i] < 0 === side[j] < 0) return
    const q = poly[j], t = side[i] / (side[i] - side[j])
    const at: Pt = [p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]
    crossings.push({ along: (at[0] - a[0]) * dx + (at[1] - a[1]) * dy, at })
  })
  crossings.sort((m, n) => m.along - n.along)
  const middle = (dx * dx + dy * dy) / 2
  let best: [Pt, Pt] | null = null, bestGap = Infinity
  for (let k = 0; k + 1 < crossings.length; k += 2) {
    const [enter, leave] = [crossings[k], crossings[k + 1]]
    const gap = Math.max(enter.along - middle, middle - leave.along, 0)
    if (gap < bestGap) [best, bestGap] = [[enter.at, leave.at], gap]
  }
  return best
}

// A cut straight across a line through `at`: perpendicular to its top side, measured in
// image pixels. Two points on that line, far enough apart to clear any quad.
export function acrossQuad(quad: Ring, at: Pt, aspect: number): [Pt, Pt] {
  const { px, norm } = isotropic(aspect)
  const [a, b] = [px(quad[0]), px(quad[1])]
  const u = unit(a, b)
  const n: Pt = u[0] === 0 && u[1] === 0 ? [0, 1] : [-u[1], u[0]]
  const c = px(at)
  const back = ([x, y]: Pt): Pt => [x / aspect, y]
  void norm
  return [back([c[0] - n[0] * 4, c[1] - n[1] * 4]), back([c[0] + n[0] * 4, c[1] + n[1] * 4])]
}
