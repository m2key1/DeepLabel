import { describe, expect, it } from 'vitest'
import type { Ring } from './core'
import { allowedShapes, elementShape, reshaped, withinLevel } from './elementShape'

// A page twice as wide as it is high: a square corner in pixels is not one in 0-1 terms.
const ASPECT = 2

function turned(cx: number, cy: number, hw: number, hh: number, degrees: number, aspect = ASPECT): Ring {
  const a = (degrees * Math.PI) / 180
  return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([x, y]) => [
    (cx + x * Math.cos(a) - y * Math.sin(a)) / aspect, cy + x * Math.sin(a) + y * Math.cos(a),
  ])
}

describe('elementShape', () => {
  it('reads no outline and an upright one as a box', () => {
    expect(elementShape(null, ASPECT)).toBe('box')
    expect(elementShape([[0.1, 0.1], [0.5, 0.1], [0.5, 0.3], [0.1, 0.3]], ASPECT)).toBe('box')
  })

  it('reads a turned rectangle as a rotated box by its pixels, not its 0-1 corners', () => {
    const ring = turned(1, 0.5, 0.4, 0.1, 30)
    expect(elementShape(ring, ASPECT)).toBe('rotated')
    expect(elementShape(ring, 1)).toBe('polygon')
  })

  it('reads anything else as a polygon', () => {
    expect(elementShape([[0.1, 0.1], [0.5, 0.1], [0.6, 0.3], [0.1, 0.3]], ASPECT)).toBe('polygon')
    expect(elementShape([[0.1, 0.1], [0.5, 0.1], [0.5, 0.3], [0.3, 0.4], [0.1, 0.3]], ASPECT)).toBe('polygon')
  })
})

describe('levels', () => {
  it('are ceilings', () => {
    expect(allowedShapes('box')).toEqual(['box'])
    expect(allowedShapes('rotated')).toEqual(['box', 'rotated'])
    expect(allowedShapes('polygon')).toEqual(['box', 'rotated', 'polygon'])
    expect(withinLevel('rotated', 'box')).toBe(false)
    expect(withinLevel('box', 'rotated')).toBe(true)
  })
})

describe('reshaped', () => {
  const outline: Ring = [[0.1, 0.1], [0.5, 0.15], [0.55, 0.4], [0.3, 0.5], [0.12, 0.35]]

  it('turns any outline into the box around it', () => {
    expect(reshaped(outline, 'box', ASPECT)).toEqual([[0.1, 0.1], [0.55, 0.1], [0.55, 0.5], [0.1, 0.5]])
  })

  it('turns a polygon into a rotated box, or a box when that fits it best', () => {
    expect(['rotated', 'box']).toContain(elementShape(reshaped(outline, 'rotated', ASPECT), ASPECT))
  })

  it('gives a box corners of its own so it reads as a polygon', () => {
    const box: Ring = [[0.1, 0.1], [0.5, 0.1], [0.5, 0.3], [0.1, 0.3]]
    expect(elementShape(reshaped(box, 'polygon', ASPECT), ASPECT)).toBe('polygon')
  })
})
