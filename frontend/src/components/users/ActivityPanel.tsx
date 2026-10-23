import { Link } from 'react-router-dom'
import type { ContributorActivity, EditCounts } from '../../api'
import { formatDate, formatRelative } from '../../util'

// One bar per day, oldest left. Days without edits are drawn as a baseline tick so
// gaps read as gaps rather than as a shorter chart.
function DailyBars({ daily, days }: { daily: ContributorActivity['daily']; days: number }) {
  const counts = new Map(daily.map((d) => [d.day, d.revisions]))
  const today = new Date()
  const series = Array.from({ length: days }, (_, i) => {
    const date = new Date(today)
    date.setUTCDate(today.getUTCDate() - (days - 1 - i))
    const day = date.toISOString().slice(0, 10)
    return { day, revisions: counts.get(day) ?? 0 }
  })
  const peak = Math.max(1, ...series.map((s) => s.revisions))
  const width = 4
  const gap = 2
  const height = 32
  return (
    <svg
      role="img"
      aria-label={`edits per day over the last ${days} days`}
      width={series.length * (width + gap)}
      height={height}
      className="block"
    >
      {series.map((s, i) => {
        const barHeight = s.revisions === 0 ? 1 : Math.max(2, Math.round((s.revisions / peak) * (height - 2)))
        return (
          <rect
            key={s.day}
            x={i * (width + gap)}
            y={height - barHeight}
            width={width}
            height={barHeight}
            rx={1}
            className={s.revisions === 0 ? 'fill-raised' : 'fill-accent'}
          >
            <title>{`${s.day}: ${s.revisions} edit${s.revisions === 1 ? '' : 's'}`}</title>
          </rect>
        )
      })}
    </svg>
  )
}

function countsLabel(counts: EditCounts): string {
  const parts = [
    counts.lines ? `${counts.lines} line${counts.lines === 1 ? '' : 's'}` : '',
    counts.elements ? `${counts.elements} element${counts.elements === 1 ? '' : 's'}` : '',
    counts.regions ? `${counts.regions} region${counts.regions === 1 ? '' : 's'}` : '',
  ].filter(Boolean)
  return parts.length ? parts.join(' · ') : 'nothing yet'
}

export function ActivityPanel({ activity }: { activity: ContributorActivity }) {
  const { totals, daily, days, datasets } = activity
  return (
    <div data-testid="user-activity" className="space-y-3 text-sm">
      <div>
        <div data-testid="activity-totals" className="font-medium">{countsLabel(totals)}</div>
        <div className="text-xs text-ink-muted">
          {totals.revisions === 0
            ? 'No edits recorded.'
            : `${totals.revisions} edits since ${formatDate(totals.first_at!).slice(0, 10)}, last ${formatRelative(totals.last_at!)}.`}
        </div>
      </div>
      <div>
        <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-subtle">
          Last {days} days
        </h4>
        <DailyBars daily={daily} days={days} />
      </div>
      {datasets.length > 0 && (
        <div>
          <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-subtle">
            Per dataset
          </h4>
          <ul className="space-y-0.5">
            {datasets.map((d) => (
              <li key={d.id} className="flex items-baseline justify-between gap-3">
                {d.name === null ? (
                  <span className="truncate italic text-ink-subtle">deleted dataset</span>
                ) : (
                  <Link to={`/jobs/${d.id}`} className="truncate hover:text-accent-ink hover:underline">
                    {d.name}
                  </Link>
                )}
                <span className="shrink-0 text-xs text-ink-muted" title={`last edit ${formatDate(d.last_at)}`}>
                  {countsLabel(d)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
