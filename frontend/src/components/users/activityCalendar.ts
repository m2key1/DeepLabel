export interface CalendarDay {
  day: string
  edits: number
}

const DAY_MS = 86_400_000
export const WEEKS = 53

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10)

/** A year of days as 53 Monday-first weeks ending with the current one, in UTC like the
 *  days the server counts. Days after today are null, so the last column stops short. */
export function calendarWeeks(today: Date, activity: CalendarDay[]): (CalendarDay | null)[][] {
  const edits = new Map(activity.map((a) => [a.day, a.edits]))
  const todayMs = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
  const sinceMonday = (new Date(todayMs).getUTCDay() + 6) % 7
  const start = todayMs - (sinceMonday + (WEEKS - 1) * 7) * DAY_MS
  return Array.from({ length: WEEKS }, (_, week) => Array.from({ length: 7 }, (_, weekday) => {
    const ms = start + (week * 7 + weekday) * DAY_MS
    if (ms > todayMs) return null
    const day = isoDay(ms)
    return { day, edits: edits.get(day) ?? 0 }
  }))
}

/** Shade 1-4 by which quarter of the active days a count ranks in, 0 for none: a year
 *  with one huge day still shows the ordinary ones apart, which a linear scale would not. */
export function shadeByQuantile(counts: number[]): (edits: number) => number {
  const active = counts.filter((n) => n > 0).sort((a, b) => a - b)
  return (edits) => {
    if (edits <= 0 || active.length === 0) return 0
    let atOrBelow = 0
    while (atOrBelow < active.length && active[atOrBelow] <= edits) atOrBelow++
    return Math.max(1, Math.ceil((4 * atOrBelow) / active.length))
  }
}

// A month's name takes about two columns, so a month that gives way to the next sooner
// goes unnamed rather than printed over its neighbour.
const LABEL_WEEKS = 2

/** The weeks a month's name stands over: where the month is first seen on a Monday, unless
 *  the next month, or the end of the year, comes before there is room for the name. */
export function monthStarts(weeks: (CalendarDay | null)[][]): { week: number; month: number }[] {
  const starts: { week: number; month: number }[] = []
  weeks.forEach((week, i) => {
    const first = week[0]
    if (!first) return
    const month = new Date(`${first.day}T00:00:00Z`).getUTCMonth()
    if (starts.at(-1)?.month !== month) starts.push({ week: i, month })
  })
  const ends = [...starts.slice(1).map((next) => next.week), weeks.length]
  return starts.filter((start, i) => ends[i] - start.week >= LABEL_WEEKS)
}
