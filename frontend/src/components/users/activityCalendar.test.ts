import { describe, expect, it } from 'vitest'
import { calendarWeeks, shadeByQuantile } from './activityCalendar'

describe('calendarWeeks', () => {
  // 2026-10-13 is a Tuesday.
  const today = new Date(Date.UTC(2026, 9, 13, 15, 0))

  it('lays out 53 Monday-first weeks ending with the week of today, nothing after today', () => {
    const weeks = calendarWeeks(today, [])
    expect(weeks).toHaveLength(53)
    expect(weeks.every((w) => w.length === 7)).toBe(true)
    const last = weeks[52]
    expect(last.map((d) => d?.day ?? null)).toEqual(
      ['2026-10-12', '2026-10-13', null, null, null, null, null])
    expect(weeks[0][0]?.day).toBe('2025-10-13')
  })

  it('puts each day\'s edits on its own cell and counts the rest as none', () => {
    const weeks = calendarWeeks(today, [{ day: '2026-10-12', edits: 4 }, { day: '2025-10-13', edits: 1 }])
    expect(weeks[52][0]).toEqual({ day: '2026-10-12', edits: 4 })
    expect(weeks[0][0]).toEqual({ day: '2025-10-13', edits: 1 })
    expect(weeks[52][1]).toEqual({ day: '2026-10-13', edits: 0 })
  })
})

describe('shadeByQuantile', () => {
  it('splits the days with edits into four quarters by rank, and a day without is band 0', () => {
    const shade = shadeByQuantile([1, 2, 3, 4, 5, 6, 7, 8, 0, 0])
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8].map(shade)).toEqual([0, 1, 1, 2, 2, 3, 3, 4, 4])
  })

  it('gives a single busy day the darkest band, and ties the same band', () => {
    expect(shadeByQuantile([12])(12)).toBe(4)
    const shade = shadeByQuantile([5, 5, 5, 1])
    expect([shade(1), shade(5)]).toEqual([1, 4])
  })
})
