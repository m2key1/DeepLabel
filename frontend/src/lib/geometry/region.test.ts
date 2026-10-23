import { describe, expect, it } from 'vitest'
import {
  closeRun, closestEdge, contourBetween, cutPolyline, eraseFromGeom, isClosedRun, joinPolylines,
  redrawRun, redrawStretch, subtractRegions, translateRegion, unionRegions, withRing,
} from './region'
import type { Ring } from './core'

const TILE = 512
const SQUARE: Ring = [[0.2, 0.2], [0.6, 0.2], [0.6, 0.6], [0.2, 0.6]]
const OTHER: Ring = [[0.7, 0.7], [0.9, 0.7], [0.9, 0.9], [0.7, 0.9]]
const OVERLAPPING: Ring = [[0.4, 0.4], [0.8, 0.4], [0.8, 0.8], [0.4, 0.8]]

const sorted = (ring: Ring) => [...ring].map(([x, y]) => [Number(x.toFixed(2)), Number(y.toFixed(2))])
  .sort((a, b) => a[0] - b[0] || a[1] - b[1])

describe('union and subtraction', () => {
  it('joins two overlapping squares into one L-shaped outline', () => {
    const [part, ...rest] = unionRegions([{ points: SQUARE, holes: [] }, { points: OVERLAPPING, holes: [] }], TILE, TILE)
    expect(rest).toEqual([])
    expect(sorted(part.points)).toEqual([
      [0.2, 0.2], [0.2, 0.6], [0.4, 0.6], [0.4, 0.8], [0.6, 0.2], [0.6, 0.4], [0.8, 0.4], [0.8, 0.8],
    ])
    expect(part.holes).toEqual([])
  })
  it('keeps two squares that do not touch apart', () => {
    expect(unionRegions([{ points: SQUARE, holes: [] }, { points: OTHER, holes: [] }], TILE, TILE)).toHaveLength(2)
  })
  it('takes the winner out of the loser', () => {
    const [part] = subtractRegions({ points: SQUARE, holes: [] }, [{ points: OVERLAPPING, holes: [] }], TILE, TILE)
    expect(sorted(part.points)).toEqual([[0.2, 0.2], [0.2, 0.6], [0.4, 0.4], [0.4, 0.6], [0.6, 0.2], [0.6, 0.4]])
  })
})

describe('polylines', () => {
  const line: Ring = [[0.2, 0.3], [0.8, 0.3]]

  it('is cut at the point nearest the click', () => {
    expect(cutPolyline(line, [0.5, 0.3], TILE, TILE, 24)).toEqual([[[0.2, 0.3], [0.5, 0.3]], [[0.5, 0.3], [0.8, 0.3]]])
  })
  it('is not cut by a click too far from it', () => {
    expect(cutPolyline(line, [0.5, 0.5], TILE, TILE, 24)).toBeNull()
  })
  it('joins two lines at their nearest ends without doubling the meeting point', () => {
    expect(joinPolylines([[0, 0], [1, 0]], [[1, 0], [2, 0]], TILE, TILE)).toEqual([[0, 0], [1, 0], [2, 0]])
    expect(joinPolylines([[0, 0], [1, 0]], [[2, 0], [1.01, 0]], TILE, TILE)).toEqual([[0, 0], [1, 0], [1.01, 0], [2, 0]])
  })
})

describe('a closed trace', () => {
  const trace: Ring = [[0.2, 0.2], [0.6, 0.2], [0.6, 0.6]]

  it('is a run of points that ends where it began', () => {
    expect(isClosedRun([...trace, trace[0]])).toBe(true)
    expect(isClosedRun(trace)).toBe(false)
  })

  it('needs an area to enclose, so a line doubled back on itself is still open', () => {
    // Two points and back is a line drawn over itself, not a shape.
    expect(isClosedRun([[0.2, 0.2], [0.6, 0.2], [0.2, 0.2]])).toBe(false)
  })

  it('is closed by repeating its first point, and only once', () => {
    expect(closeRun(trace)).toEqual([...trace, trace[0]])
    expect(closeRun([...trace, trace[0]])).toEqual([...trace, trace[0]])
  })

  it('is redrawn across its seam as a ring, the short way round, and stays closed', () => {
    const stored: Ring = [[0.25, 0.25], [0.65, 0.25], [0.65, 0.65], [0.25, 0.25]]
    expect(redrawRun(stored, 2, 0, [[0.45, 0.75]], TILE, TILE))
      .toEqual([[0.25, 0.25], [0.65, 0.25], [0.65, 0.65], [0.45, 0.75], [0.25, 0.25]])
  })

  it('leaves an open line redrawn between the two dots and nowhere else', () => {
    expect(redrawRun(trace, 2, 0, [[0.4, 0.5]], TILE, TILE)).toEqual([[0.2, 0.2], [0.4, 0.5], [0.6, 0.6]])
  })
})

describe('rings', () => {
  it('finds the nearest edge and which end of it is closer', () => {
    const hit = closestEdge([{ points: SQUARE, closed: true }], [0.3, 0.21], TILE, TILE)!
    expect(hit.ringIdx).toBe(0)
    expect(hit.edgeIndex).toBe(0)
    expect(hit.distPx).toBeCloseTo(0.01 * TILE, 5)
    expect(hit.point[0]).toBeCloseTo(0.3, 10)
    expect(hit.point[1]).toBeCloseTo(0.2, 10)
    expect(hit.vertexIndex).toBe(0)
  })
  it('walks the shorter way round between two vertices', () => {
    expect(contourBetween(SQUARE, 0, 2, true, TILE, TILE)).toEqual([[0.6, 0.2]])
    // Both ways round are as long, so the forward one is taken.
    expect(contourBetween(SQUARE, 2, 0, true, TILE, TILE)).toEqual([[0.2, 0.6]])
    expect(contourBetween(SQUARE, 0, 3, false, TILE, TILE)).toEqual([[0.6, 0.2], [0.6, 0.6]])
  })
  it('replaces the stretch that was redrawn and keeps the rest', () => {
    const drawn: Ring = [[0.3, 0.1], [0.5, 0.1]]
    expect(redrawStretch(SQUARE, 0, 1, drawn, true, TILE, TILE)).toEqual([
      [0.6, 0.2], [0.6, 0.6], [0.2, 0.6], [0.2, 0.2], [0.3, 0.1], [0.5, 0.1],
    ])
  })
  it('swaps one ring of a region', () => {
    const hole: Ring = [[0.3, 0.3], [0.4, 0.3], [0.4, 0.4]]
    const g = { points: SQUARE, holes: [hole] }
    expect(withRing(g, 1, OTHER)).toEqual({ points: SQUARE, holes: [OTHER] })
    expect(withRing(g, 0, OTHER)).toEqual({ points: OTHER, holes: [hole] })
  })
  it('moves a region no further than the tile allows', () => {
    expect(sorted(translateRegion({ points: OTHER, holes: [] }, 0.5, 0).points)).toEqual(
      [[0.8, 0.7], [0.8, 0.9], [1, 0.7], [1, 0.9]])
  })
})

describe('eraseFromGeom', () => {
  const g = { points: SQUARE, holes: [] }
  const radius = 6

  it('sweeps away the vertex under the brush and keeps the rest', () => {
    const res = eraseFromGeom(g, SQUARE[0], SQUARE[0], radius, TILE, TILE, 3)
    expect(res.changed).toBe(true)
    expect(res.geom?.points).toEqual(SQUARE.slice(1))
  })
  it('removes the region once it is below a triangle', () => {
    const res = eraseFromGeom(g, SQUARE[0], SQUARE[1], radius, TILE, TILE, 3)
    expect(res).toEqual({ geom: null, changed: true })
  })
  it('reports nothing changed when the brush touched no vertex', () => {
    expect(eraseFromGeom(g, [0.4, 0.4], [0.41, 0.41], radius, TILE, TILE, 3)).toEqual({ geom: g, changed: false })
  })
  describe('a closed trace', () => {
    // Closed by ending on its first point; a line's floor is 2, as the editor passes it.
    const closed = { points: closeRun(SQUARE), holes: [] }

    it('stays closed when the corner it closes at is erased', () => {
      const res = eraseFromGeom(closed, SQUARE[0], SQUARE[0], radius, TILE, TILE, 2)
      expect(res.geom?.points).toEqual([SQUARE[1], SQUARE[2], SQUARE[3], SQUARE[1]])
      expect(isClosedRun(res.geom!.points)).toBe(true)
    })
    it('stays closed when another corner is erased', () => {
      const res = eraseFromGeom(closed, SQUARE[2], SQUARE[2], radius, TILE, TILE, 2)
      expect(res.geom?.points).toEqual([SQUARE[0], SQUARE[1], SQUARE[3], SQUARE[0]])
    })
    it('is removed once fewer than three corners would close it', () => {
      const res = eraseFromGeom(closed, SQUARE[0], SQUARE[1], radius, TILE, TILE, 2)
      expect(res).toEqual({ geom: null, changed: true })
    })
  })
})
