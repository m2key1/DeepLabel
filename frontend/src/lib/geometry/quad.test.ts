import { describe, expect, it } from 'vitest'
import type { PageElement } from '../../api'
import {
  containingStack, cropPlan, dropVertex, minAreaQuad, moveBbox, orderBbox, polygonCrossing, quadAngle, resizeBbox, rotatePoly, splitSide,
} from './quad'
import type { Ring } from './core'

const element = (id: number, bbox: [number, number, number, number], className = 'Paragraph'): PageElement =>
  ({ id, order_idx: id, class_name: className, raw_class_name: className, bbox, conf: null,
     kind: 'content', checked: false, polygon: null, lines: [], revision: 0 })

const near = (ring: Ring, digits = 6) => ring.map(([x, y]) => [Number(x.toFixed(digits)), Number(y.toFixed(digits))])

describe('boxes', () => {
  it('orders any two corners into a box', () => {
    expect(orderBbox(1, 1, 0, 0)).toEqual([0, 0, 1, 1])
  })
  it('resizes from the corner that was dragged', () => {
    expect(resizeBbox([0, 0, 1, 1], 'se', 0.5, 0.5)).toEqual([0, 0, 0.5, 0.5])
    expect(resizeBbox([0, 0, 1, 1], 'nw', 0.5, 0.5)).toEqual([0.5, 0.5, 1, 1])
  })
  it('moves without leaving the page', () => {
    expect(moveBbox([0.9, 0, 1, 0.1], 0.5, 0)).toEqual([0.9, 0, 1, 0.1])
    expect(moveBbox([0.1, 0.1, 0.2, 0.2], 0.1, 0.1)).toEqual([0.2, 0.2, 0.30000000000000004, 0.30000000000000004])
  })
  it('lists the boxes under a point innermost first', () => {
    const column = element(1, [0, 0, 1, 1], 'Column')
    const paragraph = element(2, [0.2, 0.2, 0.4, 0.4])
    expect(containingStack([column, paragraph], 0.3, 0.3).map((e) => e.id)).toEqual([2, 1])
    expect(containingStack([column, paragraph], 0.9, 0.9).map((e) => e.id)).toEqual([1])
    // An outline is hit inside itself, and only when outlines are what the dataset draws.
    const corner = { ...element(2, [0.2, 0.2, 0.6, 0.6]), polygon: [[0.2, 0.2], [0.6, 0.2], [0.2, 0.6]] as Ring }
    expect(containingStack([column, corner], 0.25, 0.25, true).map((e) => e.id)).toEqual([2, 1])
    expect(containingStack([column, corner], 0.55, 0.55, true).map((e) => e.id)).toEqual([1])
    expect(containingStack([column, corner], 0.55, 0.55).map((e) => e.id)).toEqual([2, 1])
  })
})

describe('quads', () => {
  const box: Ring = [[0.1, 0.1], [0.5, 0.1], [0.5, 0.3], [0.1, 0.3]]

  it('turns the corners of a level rectangle back into that rectangle, top side first', () => {
    expect(near(minAreaQuad([box[2], box[0], box[3], box[1]], 1))).toEqual(near(box))
    expect(quadAngle(box, 1)).toBe(0)
  })
  it('adds a corner at the midpoint of a side', () => {
    expect(splitSide(box, 0)).toEqual([[0.1, 0.1], [0.3, 0.1], [0.5, 0.1], [0.5, 0.3], [0.1, 0.3]])
  })
  it('drops a corner, but never below a triangle', () => {
    expect(dropVertex([[0, 0], [1, 0], [1, 1], [0, 1], [0.5, 1.5]], 4)).toEqual([[0, 0], [1, 0], [1, 1], [0, 1]])
    const triangle: Ring = [[0, 0], [1, 0], [1, 1]]
    expect(dropVertex(triangle, 0)).toBe(triangle)
  })
  it('turns a square a quarter about its centre', () => {
    const square: Ring = [[0.2, 0.2], [0.4, 0.2], [0.4, 0.4], [0.2, 0.4]]
    expect(near(rotatePoly(square, [0.3, 0.3], 90, 1))).toEqual([[0.4, 0.2], [0.4, 0.4], [0.2, 0.4], [0.2, 0.2]])
  })
})

describe('cutting a polygon line', () => {
  const hexagon: Ring = [[0.1, 0.2], [0.5, 0.2], [0.9, 0.2], [0.9, 0.4], [0.5, 0.4], [0.1, 0.4]]
  const arch: Ring = [[0.1, 0.5], [0.5, 0.1], [0.9, 0.5], [0.9, 0.6], [0.5, 0.2], [0.1, 0.6]]

  it('runs the cut from the side it enters to the side it leaves', () => {
    expect(near(polygonCrossing(hexagon, [0.3, 0], [0.3, 1])!)).toEqual([[0.3, 0.2], [0.3, 0.4]])
  })

  it('takes the stretch at the stroke where the cut crosses twice', () => {
    expect(near(polygonCrossing(arch, [0, 0.45], [0.3, 0.45])!)).toEqual([[0.15, 0.45], [0.25, 0.45]])
    expect(near(polygonCrossing(arch, [0.7, 0.45], [0.9, 0.45])!)).toEqual([[0.75, 0.45], [0.85, 0.45]])
  })

  it('is null for a cut that misses', () => {
    expect(polygonCrossing(hexagon, [0, 0.5], [1, 0.5])).toBeNull()
  })
})

describe('the crop a line is cut as', () => {
  // A level line across 80% of a 2000 x 3000 page, 1% of its height tall: 1600 x 30 px of
  // scan, and 12% padding above and below it.
  const line: Ring = [[0.1, 0.5], [0.9, 0.5], [0.9, 0.51], [0.1, 0.51]]

  it('is sized in the scan\'s pixels, not in fractions of the page', () => {
    const plan = cropPlan(line, 2000 / 3000, 0, 3000)
    expect(plan.size[0]).toBeCloseTo(1600, 6)
    expect(plan.size[1]).toBeCloseTo(30 * 1.24, 6)
  })

  it('swaps its sides when the line is read turned a quarter', () => {
    const [wide, tall] = cropPlan(line, 2000 / 3000, 90, 3000).size
    expect([wide, tall].map((v) => Math.round(v))).toEqual([37, 1600])
  })
})
