import { afterEach, describe, expect, it } from 'vitest'
import { classHex, classInk, compactCount, formatRunTime, setClassColors } from './util'

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

describe('classInk', () => {
  afterEach(() => setClassColors({}))

  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const contrast = (ink: string, hex: string) => {
    const [a, b] = [ink === 'white' ? 1 : 0, luminance(hex)]
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
  }

  it.each([
    ['Table', 'black'],
    ['Header', 'black'],
    ['Marginalia', 'black'],
    ['Paragraph', 'black'],
    ['Column', 'white'],
    ['Unassigned', 'white'],
  ])('writes on %s in %s', (name, ink) => {
    expect(classInk(name)).toBe(ink)
  })

  it('follows the colour a dataset chose over the one its name gives', () => {
    setClassColors({ Table: '#1e3a8a', Column: '#fde047' })
    expect([classInk('Table'), classInk('Column')]).toEqual(['white', 'black'])
  })

  it('reads at 4.5:1 or better on every hue a name gives', () => {
    const names = Array.from({ length: 3000 }, (_, i) => `class ${i}`)
    expect(new Set(names.map((n) => classHex(n, null))).size).toBeGreaterThanOrEqual(300)
    expect(names.filter((n) => contrast(classInk(n), classHex(n, null)) < 4.5)).toEqual([])
  })

  it('reads at 4.5:1 or better on every colour a dataset may choose', () => {
    const steps = Array.from({ length: 18 }, (_, i) => (i * 15).toString(16).padStart(2, '0'))
    const chosen = steps.flatMap((r) => steps.flatMap((g) => steps.map((b) => `#${r}${g}${b}`)))
    setClassColors(Object.fromEntries(chosen.map((hex) => [hex, hex])))
    expect(chosen.filter((hex) => contrast(classInk(hex), hex) < 4.5)).toEqual([])
  })
})
