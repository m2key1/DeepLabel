// Ring geometry shared by both editors, in normalized page coordinates unless a function
// takes a width and height and works in pixels. No React, no API.

export type Pt = [number, number]
export type Ring = Pt[]

export const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

export const polyMinX = (p: Ring) => Math.min(...p.map((q) => q[0]))

export const polyMaxX = (p: Ring) => Math.max(...p.map((q) => q[0]))

export function polyCenter(poly: Ring): [number, number] {
  if (poly.length === 0) return [0, 0]
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity
  for (const [x, y] of poly) {
    if (x < minx) minx = x
    if (x > maxx) maxx = x
    if (y < miny) miny = y
    if (y > maxy) maxy = y
  }
  return [(minx + maxx) / 2, (miny + maxy) / 2]
}

// Shoelace area in pixels (absolute).
export function ringAreaPx(ring: Ring, w: number, h: number): number {
  let a = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += ring[j][0] * w * (ring[i][1] * h) - ring[i][0] * w * (ring[j][1] * h)
  }
  return Math.abs(a) / 2
}

function perpDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1])
  const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))
}

export function douglasPeucker(pts: Pt[], tol: number): Pt[] {
  if (pts.length < 3) return pts.slice()
  let maxD = 0
  let idx = 0
  const a = pts[0]
  const b = pts[pts.length - 1]
  for (let i = 1; i < pts.length - 1; i++) {
    const d = perpDist(pts[i], a, b)
    if (d > maxD) {
      maxD = d
      idx = i
    }
  }
  if (maxD > tol) {
    const left = douglasPeucker(pts.slice(0, idx + 1), tol)
    const right = douglasPeucker(pts.slice(idx), tol)
    return [...left.slice(0, -1), ...right]
  }
  return [a, b]
}

// Simplify an open traced line. Unlike simplifyRing there is no seam to close and no
// area gate — a polyline encloses nothing, so area would always reject it. Endpoints are
// preserved by Douglas–Peucker itself; below 2 points the caller drops the region.
export function simplifyPolyline(points: Ring, tolPx: number, w: number, h: number): Ring {
  if (points.length <= 2 || tolPx <= 0) return points
  const px: Pt[] = points.map(([x, y]) => [x * w, y * h])
  return douglasPeucker(px, tolPx).map(([x, y]) => [x / w, y / h] as Pt)
}

// Closest point on a *segment* and its distance (perpDist treats a/b as an infinite line,
// so it under-reports past the ends). All in pixel space.
export function projectOnSegment(p: Pt, a: Pt, b: Pt): { point: Pt; dist: number } {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const len2 = dx * dx + dy * dy
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2))
  const point: Pt = [a[0] + t * dx, a[1] + t * dy]
  return { point, dist: Math.hypot(p[0] - point[0], p[1] - point[1]) }
}

export const segDist = (p: Pt, a: Pt, b: Pt): number => projectOnSegment(p, a, b).dist

export function pathLengthPx(points: Ring, w: number, h: number): number {
  let len = 0
  for (let i = 1; i < points.length; i++) {
    len += Math.hypot((points[i][0] - points[i - 1][0]) * w, (points[i][1] - points[i - 1][1]) * h)
  }
  return len
}

export function pointInRing(pt: Pt, ring: Ring): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) {
      inside = !inside
    }
  }
  return inside
}

// One handle per edge. A closed ring has a wraparound edge (last -> first); an open
// polyline does not, so it gets one fewer handle.
export function midpoints(ring: Ring, closed = true): Pt[] {
  const out: Pt[] = []
  for (let i = 0; i < (closed ? ring.length : ring.length - 1); i++) {
    const p = ring[i]
    const q = ring[(i + 1) % ring.length]
    out.push([(p[0] + q[0]) / 2, (p[1] + q[1]) / 2])
  }
  return out
}
