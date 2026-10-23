import { useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'

import { calendarWeeks, shadeByQuantile, WEEKS } from './activityCalendar'
import type { CalendarDay } from './activityCalendar'

const SHADES = ['bg-line', 'bg-accent/25', 'bg-accent/50', 'bg-accent/75', 'bg-accent']
const WEEKDAYS = ['Mon', '', 'Wed', '', 'Fri', '', '']
const MONTH = new Intl.DateTimeFormat(undefined, { month: 'short', timeZone: 'UTC' })
const LONG_DAY = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' })

const at = (day: string) => new Date(`${day}T00:00:00Z`)
const describeDay = (d: CalendarDay) =>
  `${d.edits} ${d.edits === 1 ? 'edit' : 'edits'} on ${LONG_DAY.format(at(d.day))}`

/** A year of edits per day, a column per week. One cell is in the tab order and the
 *  arrow keys walk the rest, so the year is one stop for the keyboard, not 371. */
export function ActivityCalendar({ activity }: { activity: CalendarDay[] }) {
  const [today] = useState(() => new Date())
  const weeks = useMemo(() => calendarWeeks(today, activity), [today, activity])
  const shade = useMemo(() => shadeByQuantile(activity.map((a) => a.edits)), [activity])
  const last = weeks[WEEKS - 1].findLastIndex(Boolean)
  const [cursor, setCursor] = useState<[number, number]>([WEEKS - 1, last])
  const [shown, setShown] = useState<CalendarDay | null>(null)
  const grid = useRef<HTMLDivElement>(null)

  const move = (e: KeyboardEvent, week: number, weekday: number) => {
    const step: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
    }
    const delta = step[e.key]
    if (!delta) return
    e.preventDefault()
    const next: [number, number] = [week + delta[0], weekday + delta[1]]
    if (!weeks[next[0]]?.[next[1]]) return
    setCursor(next)
    grid.current?.querySelector<HTMLElement>(`[data-cell="${next[0]}-${next[1]}"]`)?.focus()
  }

  const total = activity.reduce((sum, a) => sum + a.edits, 0)
  const months = weeks.map((week, i) => {
    const first = week[0]
    if (!first) return ''
    const month = at(first.day).getUTCMonth()
    const before = i > 0 ? weeks[i - 1][0] : null
    return !before || at(before.day).getUTCMonth() !== month ? MONTH.format(at(first.day)) : ''
  })

  return (
    <div data-testid="activity-calendar" data-total={total}>
      <div className="overflow-x-auto pb-1">
        <div className="inline-grid grid-cols-[auto_1fr] gap-x-1.5 text-[10px] text-ink-subtle">
          <span />
          <div className="flex gap-[3px]" aria-hidden="true">
            {months.map((label, i) => (
              <span key={i} className="w-2.5 overflow-visible whitespace-nowrap">{label}</span>
            ))}
          </div>
          <div className="flex flex-col gap-[3px]" aria-hidden="true">
            {WEEKDAYS.map((label, i) => <span key={i} className="h-2.5 leading-[10px]">{label}</span>)}
          </div>
          <div ref={grid} role="grid" aria-label="Edits per day over the last year"
               className="flex gap-[3px]" onMouseLeave={() => setShown(null)}>
            {weeks.map((week, w) => (
              <div key={w} role="row" className="flex flex-col gap-[3px]">
                {week.map((day, d) => day ? (
                  <span
                    key={d}
                    role="gridcell"
                    data-testid="activity-day"
                    data-cell={`${w}-${d}`}
                    data-day={day.day}
                    data-edits={day.edits}
                    data-level={shade(day.edits)}
                    aria-label={describeDay(day)}
                    tabIndex={cursor[0] === w && cursor[1] === d ? 0 : -1}
                    onMouseEnter={() => setShown(day)}
                    onFocus={() => {
                      setCursor([w, d])
                      setShown(day)
                    }}
                    onBlur={() => setShown(null)}
                    onKeyDown={(e) => move(e, w, d)}
                    className={`h-2.5 w-2.5 rounded-[2px] ${SHADES[shade(day.edits)]} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent`}
                  />
                ) : <span key={d} className="h-2.5 w-2.5" />)}
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="mt-1 flex flex-wrap items-center justify-between gap-2 text-xs text-ink-subtle">
        <span data-testid="activity-readout" aria-live="polite" className="font-mono tabular-nums">
          {shown ? describeDay(shown) : `${total} ${total === 1 ? 'edit' : 'edits'} in the last year`}
        </span>
        <span className="flex items-center gap-1" data-testid="activity-legend">
          Less
          {SHADES.map((shadeClass, level) => (
            <span key={level} className={`h-2.5 w-2.5 rounded-[2px] ${shadeClass}`} />
          ))}
          More
        </span>
      </div>
    </div>
  )
}
