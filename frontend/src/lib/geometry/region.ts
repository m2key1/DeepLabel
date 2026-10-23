// The tile editor's geometry: class regions with holes and traced polylines on a map
// tile. Clipping and simplification run in pixel space (x tile w/h) so tolerance and
// area are uniform on non-square tiles, then convert back. No React, no API.
import polygonClipping from 'polygon-clipping'
import { douglasPeucker, pathLengthPx, projectOnSegment, ringAreaPx, segDist } from './core'
import type { Pt, Ring } from './core'

type Rings = Ring[] // outer ring first, holes after - matches [r.points, ...r.holes]

type MultiRings = Rings[]

export interface RegionGeom {
  points: Ring
  holes: Ring[]
}

export const toPoly = (g: RegionGeom): Rings => [g.points, ...g.holes]

// polygon-clipping output rings repeat the first vertex as the last; drop it.
function closeStrip(ring: Ring): Ring {
  if (ring.length > 1) {
    const f = ring[0]
    const l = ring[ring.length - 1]
    if (f[0] === l[0] && f[1] === l[1]) return ring.slice(0, -1)
  }
  return ring
}

function fromMultiRings(mp: MultiRings): RegionGeom[] {
  return mp.map((poly) => ({ points: closeStrip(poly[0]), holes: poly.slice(1).map(closeStrip) }))
}

export const vertexCount = (g: RegionGeom): number =>
  g.points.length + g.holes.reduce((m, h) => m + h.length, 0)

export function countVertices(regions: RegionGeom[]): number {
  return regions.reduce((n, r) => n + vertexCount(r), 0)
}

// Net pixel area (outer minus holes) — used to tell whether a clip actually changed a
// region, since vertex count alone can't (a half-clipped quad is still a quad).
export function regionAreaPx(g: RegionGeom, w: number, h: number): number {
  return ringAreaPx(g.points, w, h) - g.holes.reduce((s, hole) => s + ringAreaPx(hole, w, h), 0)
}

// Simplify one ring in pixel space; may return fewer than 3 points (caller drops it).
function simplifyRing(ring: Ring, tolPx: number, w: number, h: number): Ring {
  if (ring.length <= 3 || tolPx <= 0) return ring
  const px: Pt[] = ring.map(([x, y]) => [x * w, y * h])
  const closed: Pt[] = [...px, px[0]] // close so the seam edge can be simplified too
  const simp = douglasPeucker(closed, tolPx).slice(0, -1) // drop the duplicated closer
  return simp.map(([x, y]) => [x / w, y / h] as Pt)
}

export interface EdgeHit {
  ringIdx: number
  edgeIndex: number // the new vertex goes immediately after ring[edgeIndex]
  distPx: number
  vertexDistPx: number // to the nearest existing vertex, so callers can refuse a duplicate
  point: Pt // closest point *on* the edge, normalized — what snapping lands on
  vertex: Pt // the nearer of the edge's two endpoints, normalized
  vertexIndex: number // that endpoint's index in its ring
}

// The edge of a region nearest a point: which two existing vertices a new one belongs
// between, and how far off the outline the click was. `rings` carries each ring's
// closedness — a traced line's outer ring has no wraparound edge, every other ring does.
export function closestEdge(
  rings: { points: Ring; closed: boolean }[],
  pt: Pt,
  w: number,
  h: number,
): EdgeHit | null {
  const toPx = ([x, y]: Pt): Pt => [x * w, y * h]
  const toNorm = ([x, y]: Pt): Pt => [x / w, y / h]
  const p = toPx(pt)
  let best: EdgeHit | null = null
  rings.forEach((ring, ringIdx) => {
    const n = ring.points.length
    if (n < 2) return
    const edges = ring.closed ? n : n - 1
    for (let i = 0; i < edges; i++) {
      const a = toPx(ring.points[i])
      const b = toPx(ring.points[(i + 1) % n])
      const { point, dist } = projectOnSegment(p, a, b)
      if (best && dist >= best.distPx) continue
      const da = Math.hypot(p[0] - a[0], p[1] - a[1])
      const db = Math.hypot(p[0] - b[0], p[1] - b[1])
      const vertexIndex = da <= db ? i : (i + 1) % n
      best = {
        ringIdx,
        edgeIndex: i,
        distPx: dist,
        vertexDistPx: Math.min(da, db),
        point: toNorm(point),
        vertex: ring.points[vertexIndex],
        vertexIndex,
      }
    }
  })
  return best
}

// Simplify a region's outer ring + holes. Rings that fall below a triangle or 12 px²
// are dropped; if the outer ring dies the whole region should be deleted (returns null).
export function simplifyRegionGeometry(g: RegionGeom, tolPx: number, w: number, h: number): RegionGeom | null {
  const points = simplifyRing(g.points, tolPx, w, h)
  if (points.length < 3 || ringAreaPx(points, w, h) < 12) return null
  const holes = g.holes
    .map((hole) => simplifyRing(hole, tolPx, w, h))
    .filter((hole) => hole.length >= 3 && ringAreaPx(hole, w, h) >= 12)
  return { points, holes }
}

const regionToPx = (g: RegionGeom, w: number, h: number): Rings =>
  toPoly(g).map((ring) => ring.map(([x, y]) => [x * w, y * h] as Pt))

// Clipping output back to normalized regions, dropping parts and holes under 12 px².
function regionsFromClip(result: MultiRings, w: number, h: number): RegionGeom[] {
  const out: RegionGeom[] = []
  for (const part of fromMultiRings(result)) {
    if (part.points.length < 3 || ringAreaPx(part.points, 1, 1) < 12) continue
    const holes = part.holes.filter((hole) => hole.length >= 3 && ringAreaPx(hole, 1, 1) >= 12)
    out.push({
      points: part.points.map(([x, y]) => [x / w, y / h] as Pt),
      holes: holes.map((hole) => hole.map(([x, y]) => [x / w, y / h] as Pt)),
    })
  }
  return out
}

// target minus the union of `winners`; may split into several regions or vanish.
export function subtractRegions(
  target: RegionGeom,
  winners: RegionGeom[],
  w: number,
  h: number,
): RegionGeom[] {
  if (winners.length === 0) return [target]
  const result = polygonClipping.difference(
    regionToPx(target, w, h), ...winners.map((g) => regionToPx(g, w, h))) as MultiRings
  return regionsFromClip(result, w, h)
}

// The union of several polygons. One part when they touch or overlap; several when they
// do not, which callers treat as "nothing to merge".
export function unionRegions(regions: RegionGeom[], w: number, h: number): RegionGeom[] {
  const [first, ...rest] = regions.map((g) => regionToPx(g, w, h))
  const result = polygonClipping.union(first, ...rest) as MultiRings
  return regionsFromClip(result, w, h)
}

// Indices met walking `ring` from `from` to `to`, exclusive of both, forward
// (`step` 1) or backward (-1), wrapping round.
function walk(n: number, from: number, to: number, step: 1 | -1): number[] {
  const out: number[] = []
  for (let i = (from + step + n) % n; i !== to; i = (i + step + n) % n) out.push(i)
  return out
}

// The vertices strictly between `from` and `to`, in the order met walking from `from`. On
// a closed ring that is the shorter of the two ways round; on an open line the only one.
// Snap-to-contour inserts them, so a shape drawn along a neighbour shares its border
// exactly instead of cutting a chord across it.
export function contourBetween(
  ring: Ring, from: number, to: number, closed: boolean, w: number, h: number,
): Ring {
  if (from === to) return []
  if (!closed) {
    const inner = ring.slice(Math.min(from, to) + 1, Math.max(from, to))
    return from < to ? inner : inner.reverse()
  }
  const forward = walk(ring.length, from, to, 1).map((i) => ring[i])
  const backward = walk(ring.length, from, to, -1).map((i) => ring[i])
  const len = (inner: Ring) => pathLengthPx([ring[from], ...inner, ring[to]], w, h)
  return len(forward) <= len(backward) ? forward : backward
}

// Replaces the stretch of `ring` between vertices `start` and `end` with `pts`, which were
// drawn from `start` towards `end`. On a closed ring the shorter way round is the one
// replaced and the longer one is kept; on an open line there is only one way.
export function redrawStretch(
  ring: Ring, start: number, end: number, pts: Ring, closed: boolean, w: number, h: number,
): Ring {
  if (!closed) {
    const [lo, hi] = start < end ? [start, end] : [end, start]
    const between = start < end ? pts : pts.slice().reverse()
    return [...ring.slice(0, lo + 1), ...between, ...ring.slice(hi)]
  }
  const n = ring.length
  const forward = walk(n, start, end, 1)
  const backward = walk(n, start, end, -1)
  const len = (inner: number[]) => pathLengthPx([ring[start], ...inner.map((i) => ring[i]), ring[end]], w, h)
  if (len(forward) <= len(backward)) {
    // Drop the forward way: keep `end` round to `start` and close it with the new points.
    return [ring[end], ...walk(n, end, start, 1).map((i) => ring[i]), ring[start], ...pts]
  }
  return [ring[start], ...forward.map((i) => ring[i]), ring[end], ...pts.slice().reverse()]
}

// A traced line that ends where it began. The repeated point is what says so - there is
// no other mark for it - and it takes a triangle to enclose anything, so two points and
// back is a line drawn over itself rather than a closed one.
export const isClosedRun = (points: Ring): boolean =>
  points.length > 3
  && points[0][0] === points[points.length - 1][0]
  && points[0][1] === points[points.length - 1][1]

// The run brought back to its first point, or left alone if it is already there.
export const closeRun = (points: Ring): Ring => (isClosedRun(points) ? points : [...points, points[0]])

// A traced line with the stretch between two of its corners redrawn. A closed one is a
// ring that stores its seam twice, so it is redrawn as a ring - seam once, short way round -
// and written back closed; walking the stored run would take the long way across the seam.
export function redrawRun(points: Ring, start: number, end: number, pts: Ring, w: number, h: number): Ring {
  if (!isClosedRun(points)) return redrawStretch(points, start, end, pts, false, w, h)
  return closeRun(redrawStretch(points.slice(0, -1), start, end, pts, true, w, h))
}

// An open line grown from one of its ends by `pts`, drawn outwards from that end.
export function extendPolyline(points: Ring, fromEnd: number, pts: Ring): Ring {
  return fromEnd === 0 ? [...pts.slice().reverse(), ...points] : [...points, ...pts]
}

// Two open lines as one, joined at whichever pair of ends lies closest, so the result
// never doubles back on itself. Ends that already meet are not doubled.
export function joinPolylines(a: Ring, b: Ring, w: number, h: number): Ring {
  const gap = (p: Pt, q: Pt) => Math.hypot((p[0] - q[0]) * w, (p[1] - q[1]) * h)
  const rb = b.slice().reverse()
  const last = (r: Ring) => r[r.length - 1]
  const options: { gap: number; pts: Ring }[] = [
    { gap: gap(last(a), b[0]), pts: [...a, ...b] },
    { gap: gap(last(a), last(b)), pts: [...a, ...rb] },
    { gap: gap(last(b), a[0]), pts: [...b, ...a] },
    { gap: gap(b[0], a[0]), pts: [...rb, ...a] },
  ]
  const best = options.reduce((m, o) => (o.gap < m.gap ? o : m))
  return best.pts.filter((p, i) => i === 0 || p[0] !== best.pts[i - 1][0] || p[1] !== best.pts[i - 1][1])
}

// An open line cut at the point on it nearest `at`: two lines meeting there. Null when
// the cut misses the line by more than `reachPx` or would leave a stub under `minPx`.
export function cutPolyline(
  points: Ring, at: Pt, w: number, h: number, reachPx: number, minPx = 2,
): [Ring, Ring] | null {
  const hit = closestEdge([{ points, closed: false }], at, w, h)
  if (!hit || hit.distPx > reachPx) return null
  const first = [...points.slice(0, hit.edgeIndex + 1), hit.point]
  const second = [hit.point, ...points.slice(hit.edgeIndex + 1)]
  if (pathLengthPx(first, w, h) < minPx || pathLengthPx(second, w, h) < minPx) return null
  return [first, second]
}

// Every ring moved by (dx, dy), the delta clamped so the outer ring stays on the tile.
export function translateRegion<T extends RegionGeom>(g: T, dx: number, dy: number): T {
  const xs = g.points.map((p) => p[0])
  const ys = g.points.map((p) => p[1])
  const cdx = Math.min(1 - Math.max(...xs), Math.max(-Math.min(...xs), dx))
  const cdy = Math.min(1 - Math.max(...ys), Math.max(-Math.min(...ys), dy))
  const move = (ring: Ring): Ring => ring.map(([x, y]) => [x + cdx, y + cdy] as Pt)
  return { ...g, points: move(g.points), holes: g.holes.map(move) }
}

/** Copy of `g` with ring `ringIdx` replaced - ring 0 is the outer ring, k>=1 is holes[k-1]. */
export function withRing<T extends RegionGeom>(g: T, ringIdx: number, ring: Ring): T {
  if (ringIdx === 0) return { ...g, points: ring }
  const holes = g.holes.slice()
  holes[ringIdx - 1] = ring
  return { ...g, holes }
}

/** Every vertex of the region within `radiusPx` of the segment a-b is swept away - the
 *  eraser brush's one pass. A ring left below `floor` points (two for a traced line,
 *  three for a polygon) takes the region with it, or the hole if it was one. */
export function eraseFromGeom(
  g: RegionGeom, a: Pt, b: Pt, radiusPx: number, w: number, h: number, floor: 2 | 3,
): { geom: RegionGeom | null; changed: boolean } {
  const aPx: Pt = [a[0] * w, a[1] * h]
  const bPx: Pt = [b[0] * w, b[1] * h]
  const sweep = (ring: Ring) => ring.filter((p) => segDist([p[0] * w, p[1] * h], aPx, bPx) > radiusPx)

  // A closed trace ends on its first point, so erasing the corner it closes at would take
  // both copies and open it. Swept as its corners and closed again, it stays a ring.
  const closed = isClosedRun(g.points)
  const corners = closed ? g.points.slice(0, -1) : g.points
  const kept = sweep(corners)
  let changed = kept.length !== corners.length
  if (changed && kept.length < (closed ? 3 : floor)) return { geom: null, changed: true }
  const points = changed && closed ? closeRun(kept) : changed ? kept : g.points

  const holes: Ring[] = []
  for (const hole of g.holes) {
    const kept = sweep(hole)
    if (kept.length === hole.length) {
      holes.push(hole)
      continue
    }
    changed = true
    if (kept.length >= 3) holes.push(kept)
  }
  return { geom: { points, holes }, changed }
}

// --- picking several vertices at once ----------------------------------------

/** A vertex picked in the select tool: ring 0 is the outer ring, k>=1 is holes[k-1].
 *  `index` counts corners as the editor shows them, so a closed trace's seam - stored at
 *  both ends of its run - is index 0 alone. */
export interface VertexPick {
  ringIdx: number
  index: number
}

const isClosedTraceRing = (ring: Ring, line: boolean, ringIdx: number) =>
  line && ringIdx === 0 && isClosedRun(ring)

/** A ring's corners as the editor shows them: a closed trace shows its seam once. */
export function cornersOf(g: RegionGeom, ringIdx: number, line: boolean): Ring {
  const ring = toPoly(g)[ringIdx] ?? []
  return isClosedTraceRing(ring, line, ringIdx) ? ring.slice(0, -1) : ring
}

/** Every corner of `g` inside the box spanned by `a` and `b`, edges included. */
export function verticesInBox(g: RegionGeom, line: boolean, a: Pt, b: Pt): VertexPick[] {
  const [x0, x1] = [Math.min(a[0], b[0]), Math.max(a[0], b[0])]
  const [y0, y1] = [Math.min(a[1], b[1]), Math.max(a[1], b[1])]
  const out: VertexPick[] = []
  toPoly(g).forEach((_, ringIdx) => {
    cornersOf(g, ringIdx, line).forEach(([x, y], index) => {
      if (x >= x0 && x <= x1 && y >= y0 && y <= y1) out.push({ ringIdx, index })
    })
  })
  return out
}

/** The largest part of the shift (dx, dy) that keeps every point inside the tile, per axis,
 *  so a group pushed against the border stops there whole instead of being squashed flat. */
export function clampShift(pts: Ring, dx: number, dy: number): [number, number] {
  if (!pts.length) return [dx, dy]
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  return [
    Math.min(1 - Math.max(...xs), Math.max(-Math.min(...xs), dx)),
    Math.min(1 - Math.max(...ys), Math.max(-Math.min(...ys), dy)),
  ]
}

/** `g` with the picked corners shifted by (dx, dy). Moving a closed trace's seam moves
 *  both stored copies of it, so the trace stays closed. */
export function moveVertices<T extends RegionGeom>(g: T, line: boolean, picks: VertexPick[], dx: number, dy: number): T {
  const rings = toPoly(g).map((ring, ringIdx) => {
    const mine = picks.filter((p) => p.ringIdx === ringIdx)
    if (!mine.length) return ring
    const closed = isClosedTraceRing(ring, line, ringIdx)
    const next = ring.slice()
    for (const { index } of mine) {
      if (!next[index]) continue
      next[index] = [ring[index][0] + dx, ring[index][1] + dy]
      if (closed && index === 0) next[next.length - 1] = next[0]
    }
    return next
  })
  return { ...g, points: rings[0], holes: rings.slice(1) }
}

/** `g` with the picked corners removed, or null when the outer ring is left too short to
 *  be a shape - the region goes. A ring keeps at least three points, an open traced line
 *  two. A hole left too short goes on its own; removing a closed trace's seam opens it,
 *  the same as removing it one dot at a time does. */
export function deleteVertices<T extends RegionGeom>(g: T, line: boolean, picks: VertexPick[]): T | null {
  const rings: (Ring | null)[] = toPoly(g).map((ring, ringIdx) => {
    const drop = new Set(picks.filter((p) => p.ringIdx === ringIdx).map((p) => p.index))
    if (!drop.size) return ring
    const closed = isClosedTraceRing(ring, line, ringIdx)
    const kept = (closed ? ring.slice(0, -1) : ring).filter((_, i) => !drop.has(i))
    const reclose = closed && !drop.has(0)
    const floor = line && ringIdx === 0 && !reclose ? 2 : 3
    if (kept.length < floor) return null
    return reclose ? closeRun(kept) : kept
  })
  if (rings[0] === null) return null
  return { ...g, points: rings[0], holes: rings.slice(1).filter((h): h is Ring => h !== null) }
}
