import { describe, expect, it } from 'vitest'
import { calendarWeeks, monthStarts, shadeByQuantile } from './activityCalendar'

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

describe('monthStarts', () => {
  it('labels the week each month begins in', () => {
    // A year from Monday 2025-10-13: October starts it, November is first seen on 11-03.
    const starts = monthStarts(calendarWeeks(new Date(Date.UTC(2026, 9, 13)), []))
    expect(starts.slice(0, 2)).toEqual([{ week: 0, month: 9 }, { week: 3, month: 10 }])
    expect(starts).toHaveLength(13)
  })

  it('leaves a month without a label when the next one begins right after it', () => {
    // A year from Monday 2025-10-27: October has a single column before November's.
    const starts = monthStarts(calendarWeeks(new Date(Date.UTC(2026, 9, 27)), []))
    expect(starts[0]).toEqual({ week: 1, month: 10 })
    expect(starts.map((s) => s.week).every((week, i, all) => i === 0 || week - all[i - 1] >= 2)).toBe(true)
  })

  it('leaves the last month without a label when the year ends one column into it', () => {
    // Monday 2026-11-02 is the last column: November has no room there.
    const starts = monthStarts(calendarWeeks(new Date(Date.UTC(2026, 10, 2)), []))
    expect(starts.at(-1)).toEqual({ week: 48, month: 9 })
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
