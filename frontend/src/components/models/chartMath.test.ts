import { describe, expect, it } from 'vitest'
import {
  bucketize, debiasedEma, logTicks, nearestIndex, niceTicks, quantileRange, panDomain, splitPositive, zoomDomain,
} from './chartMath'

describe('debiasedEma', () => {
  it('is the readings themselves at weight 0', () => {
    expect(debiasedEma([3, 1, 2], 0)).toEqual([3, 1, 2])
  })

  it('debiases the start, so the first value is the first reading rather than pulled to 0', () => {
    const [a, b, c] = debiasedEma([1, 2, 3], 0.5)
    expect(a).toBe(1)
    expect(b).toBeCloseTo(1.6666667, 6)
    expect(c).toBeCloseTo(2.4285714, 6)
  })

  it('matches the stub trainer CER at weight 0.6, the value the e2e readout shows', () => {
    const smoothed = debiasedEma([0.5, 0.3, 0.1], 0.6)
    expect(smoothed[0]).toBeCloseTo(0.5, 9)
    expect(smoothed[1]).toBeCloseTo(0.375, 9)
    expect(smoothed[2]).toBeCloseTo(0.2346939, 6)
  })

  it('carries a non-finite reading through without poisoning what follows', () => {
    const smoothed = debiasedEma([1, Number.NaN, 1], 0.5)
    expect(smoothed[0]).toBe(1)
    expect(Number.isNaN(smoothed[1])).toBe(true)
    expect(smoothed[2]).toBeCloseTo(1, 9)
  })
})

describe('nearestIndex', () => {
  const xs = [1, 2, 4, 8]

  it('snaps to the closest x, the earlier one on a tie', () => {
    expect(nearestIndex(xs, 2.9)).toBe(1)
    expect(nearestIndex(xs, 3)).toBe(1)
    expect(nearestIndex(xs, 3.1)).toBe(2)
  })

  it('clamps beyond either end and says -1 for nothing', () => {
    expect(nearestIndex(xs, -10)).toBe(0)
    expect(nearestIndex(xs, 100)).toBe(3)
    expect(nearestIndex([], 1)).toBe(-1)
  })
})

describe('zoomDomain', () => {
  it('maps a dragged fraction of the axis onto the domain, either drag direction', () => {
    expect(zoomDomain([0, 100], 0.25, 0.5)).toEqual([25, 50])
    expect(zoomDomain([0, 100], 0.5, 0.25)).toEqual([25, 50])
  })

  it('zooms a log axis in log space', () => {
    const [lo, hi] = zoomDomain([1, 1000], 1 / 3, 2 / 3, true)
    expect(lo).toBeCloseTo(10, 9)
    expect(hi).toBeCloseTo(100, 9)
  })
})

describe('panDomain', () => {
  it('slides the domain by a fraction of its span, keeping the span', () => {
    expect(panDomain([10, 30], 0.25)).toEqual([15, 35])
    expect(panDomain([10, 30], -0.5)).toEqual([0, 20])
  })

  it('slides a log axis in log space, so each decade stays as wide', () => {
    const [lo, hi] = panDomain([1, 100], 0.5, true)
    expect(lo).toBeCloseTo(10)
    expect(hi).toBeCloseTo(1000)
  })
})

describe('ticks', () => {
  it('picks round steps inside the range', () => {
    expect(niceTicks(0, 1, 4)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1])
    expect(niceTicks(0.13, 0.52, 4)).toEqual([0.2, 0.3, 0.4, 0.5])
    expect(niceTicks(3, 3, 4)).toEqual([3])
  })

  it('puts log ticks on the powers of ten, and on 2 and 5 when fewer than two fit', () => {
    expect(logTicks(0.001, 10)).toEqual([0.001, 0.01, 0.1, 1, 10])
    expect(logTicks(0.15, 0.6)).toEqual([0.2, 0.5])
    expect(logTicks(-1, 10)).toEqual([])
  })
})

describe('splitPositive', () => {
  it('keeps what a log axis can draw and counts what it cannot', () => {
    const { kept, dropped } = splitPositive([{ x: 1, y: 0 }, { x: 2, y: 0.5 }, { x: 3, y: -1 }])
    expect(kept).toEqual([{ x: 2, y: 0.5 }])
    expect(dropped).toBe(2)
  })
})

describe('quantileRange', () => {
  it('ignores the outliers outside the 5th to 95th percentile', () => {
    const values = [...Array.from({ length: 19 }, (_, i) => i + 1), 1000]
    const [lo, hi] = quantileRange(values, 0.05, 0.95)
    expect(lo).toBeCloseTo(1.95, 9)
    expect(hi).toBeCloseTo(68.05, 9)
  })
})

describe('bucketize', () => {
  it('folds a long series into min, max and last per column inside the domain', () => {
    const samples = [0, 1, 2, 3, 4, 5, 6, 7].map((x) => ({ x, y: x % 2 === 0 ? x : -x }))
    expect(bucketize(samples, [0, 8], 2)).toEqual([
      { x: 3, lo: -3, hi: 2, last: -3 },
      { x: 7, lo: -7, hi: 6, last: -7 },
    ])
  })

  it('leaves out what lies outside the domain', () => {
    const samples = [0, 1, 2, 3].map((x) => ({ x, y: x }))
    expect(bucketize(samples, [1, 2], 1)).toEqual([{ x: 2, lo: 1, hi: 2, last: 2 }])
  })
})
