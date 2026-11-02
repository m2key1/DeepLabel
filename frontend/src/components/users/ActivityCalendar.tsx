import { useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'

import { calendarWeeks, monthStarts, shadeByQuantile, WEEKS } from './activityCalendar'
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
  const months = monthStarts(weeks)

  return (
    <div data-testid="activity-calendar" data-total={total}>
      <div className="overflow-x-auto pb-1">
        {/* One grid for the labels and the days: a column per week after the weekday names,
            stretched to the panel, so a day is as wide as the year allows. */}
        <div className="grid min-w-[36rem] gap-[3px] text-[10px] text-ink-subtle"
             style={{ gridTemplateColumns: `auto repeat(${WEEKS}, minmax(0, 1fr))` }}>
          {months.map(({ week, month }) => (
            <span key={week} aria-hidden="true" data-testid="activity-month" data-week={week}
                  style={{ gridRow: 1, gridColumn: week + 2 }} className="overflow-visible whitespace-nowrap leading-4">
              {MONTH.format(new Date(Date.UTC(2000, month, 1)))}
            </span>
          ))}
          {WEEKDAYS.map((label, i) => (
            <span key={i} aria-hidden="true" style={{ gridRow: i + 2, gridColumn: 1 }}
                  className="self-center pr-1 leading-none">{label}</span>
          ))}
          <div ref={grid} role="grid" aria-label="Edits per day over the last year" className="contents"
               onMouseLeave={() => setShown(null)}>
            {weeks.map((week, w) => (
              <div key={w} role="row" className="contents">
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
                    style={{ gridRow: d + 2, gridColumn: w + 2 }}
                    className={`aspect-square rounded-[2px] ${SHADES[shade(day.edits)]} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent`}
                  />
                ) : <span key={d} style={{ gridRow: d + 2, gridColumn: w + 2 }} />)}
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
