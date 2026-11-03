import type { LayoutShape } from '../../api'
import type { Ring } from './core'
import { minAreaQuad, splitLongSides } from './quad'

/** What a layout element is drawn as. The names are the dataset levels' own, since a level
 *  is the freest shape it allows. */
export type ElementShape = LayoutShape

const ORDER: ElementShape[] = ['box', 'rotated', 'polygon']

// How far from square a corner may be and still count as one, after rounding; the server
// reads shapes with the same allowances.
const SQUARE = 0.02
const UPRIGHT = 0.005

export const allowedShapes = (level: LayoutShape): ElementShape[] => ORDER.slice(0, ORDER.indexOf(level) + 1)

export const withinLevel = (shape: ElementShape, level: LayoutShape) => ORDER.indexOf(shape) <= ORDER.indexOf(level)

/** No outline or an upright rectangle is a box, any other rectangle a rotated box - square
 *  in pixels, which the page's 0-1 coordinates are not - and anything else a polygon. */
export function elementShape(poly: Ring | null | undefined, aspect: number): ElementShape {
  if (!poly) return 'box'
  if (poly.length !== 4) return 'polygon'
  const sides = poly.map(([x, y], i) => {
    const [nx, ny] = poly[(i + 1) % 4]
    return [(nx - x) * aspect, ny - y] as const
  })
  const lengths = sides.map(([dx, dy]) => Math.hypot(dx, dy))
  if (Math.min(...lengths) === 0) return 'polygon'
  const square = sides.every(([ax, ay], i) => {
    const [bx, by] = sides[(i + 1) % 4]
    return Math.abs(ax * bx + ay * by) <= SQUARE * lengths[i] * lengths[(i + 1) % 4]
  })
  if (!square) return 'polygon'
  const upright = sides.every(([dx, dy], i) => Math.min(Math.abs(dx), Math.abs(dy)) <= UPRIGHT * lengths[i])
  return upright ? 'box' : 'rotated'
}

function boundsRing(poly: Ring): Ring {
  const xs = poly.map(([x]) => x)
  const ys = poly.map(([, y]) => y)
  const [x0, y0, x1, y1] = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
}

/** An outline turned into another shape: the box around it, the tightest rotated box
 *  around it, or - from a box - corners added on its long sides so it can bend. */
export function reshaped(poly: Ring, to: ElementShape, aspect: number): Ring {
  if (to === 'box') return boundsRing(poly)
  if (to === 'rotated') return minAreaQuad(poly, aspect)
  return poly.length > 4 ? poly : splitLongSides(poly, aspect)
}
