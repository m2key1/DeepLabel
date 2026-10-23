import { describe, expect, it } from 'vitest'
import {
  clamp01, midpoints, pathLengthPx, pointInRing, polyCenter, polyMaxX, polyMinX, ringAreaPx, segDist,
  simplifyPolyline,
} from './core'
import type { Ring } from './core'

const SQUARE: Ring = [[0, 0], [2, 0], [2, 2], [0, 2]]

describe('clamp01', () => {
  it('keeps a value on the page', () => {
    expect(clamp01(-0.5)).toBe(0)
    expect(clamp01(1.5)).toBe(1)
    expect(clamp01(0.25)).toBe(0.25)
  })
})

describe('segDist', () => {
  it('measures to the segment, not to the line through it', () => {
    expect(segDist([0, 1], [0, 0], [2, 0])).toBe(1)
    expect(segDist([5, 0], [0, 0], [2, 0])).toBe(3)
  })
})

describe('midpoints', () => {
  it('gives a closed ring one per edge, wraparound included', () => {
    expect(midpoints(SQUARE)).toEqual([[1, 0], [2, 1], [1, 2], [0, 1]])
  })
  it('gives an open line one fewer', () => {
    expect(midpoints(SQUARE, false)).toEqual([[1, 0], [2, 1], [1, 2]])
  })
})

describe('pointInRing', () => {
  it('tells inside from outside', () => {
    expect(pointInRing([1, 1], SQUARE)).toBe(true)
    expect(pointInRing([3, 3], SQUARE)).toBe(false)
  })
})

describe('polyCenter and extents', () => {
  it('is the centre of the bounding box', () => {
    expect(polyCenter([[0, 0], [4, 0], [4, 2]])).toEqual([2, 1])
    expect(polyCenter([])).toEqual([0, 0])
    expect(polyMinX(SQUARE)).toBe(0)
    expect(polyMaxX(SQUARE)).toBe(2)
  })
})

describe('ringAreaPx and pathLengthPx', () => {
  it('scale by the tile they are measured on', () => {
    expect(ringAreaPx([[0, 0], [1, 0], [1, 1], [0, 1]], 10, 20)).toBe(200)
    expect(pathLengthPx([[0, 0], [1, 0], [1, 1]], 10, 20)).toBe(30)
  })
})

describe('simplifyPolyline', () => {
  it('drops a point that bends the line by less than the tolerance', () => {
    expect(simplifyPolyline([[0, 0], [0.5, 0.001], [1, 0]], 2, 100, 100)).toEqual([[0, 0], [1, 0]])
  })
  it('keeps one that bends it by more', () => {
    expect(simplifyPolyline([[0, 0], [0.5, 0.1], [1, 0]], 2, 100, 100)).toEqual([[0, 0], [0.5, 0.1], [1, 0]])
  })
  it('leaves a two-point line alone', () => {
    expect(simplifyPolyline([[0, 0], [1, 1]], 5, 100, 100)).toEqual([[0, 0], [1, 1]])
  })
})
