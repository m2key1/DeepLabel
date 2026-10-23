import { describe, expect, it } from 'vitest'
import { compactCount, formatRunTime } from './util'

describe('compactCount', () => {
  it.each([
    [9_999, '9999'],
    [10_000, '10k'],
    [999_499, '999k'],
    [999_500, '1M'],
    [999_999, '1M'],
    [1_000_000, '1M'],
    [1_700_000, '1.7M'],
  ])('writes %i as %s', (n, shown) => {
    expect(compactCount(n)).toBe(shown)
  })
})

describe('formatRunTime', () => {
  it('reads like a clock, with hours only once there are any', () => {
    expect(formatRunTime(42)).toBe('0:42')
    expect(formatRunTime(12 * 60 + 3)).toBe('12:03')
    expect(formatRunTime(3 * 3600 + 2 * 60 + 13)).toBe('3:02:13')
    expect(formatRunTime(30 * 3600)).toBe('30:00:00')
  })

  it('counts days past two, and never runs backwards', () => {
    expect(formatRunTime(2 * 86400 + 5 * 3600 + 59)).toBe('2d 5h')
    expect(formatRunTime(-5)).toBe('0:00')
  })
})
