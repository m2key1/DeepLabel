import { useNavigate } from 'react-router-dom'
import type { QueueEntry } from '../../api'
import { clock, spanLabel, tickStep, type Placed } from './timeline'

const W = 900
const LABEL = 92
const PLOT = W - LABEL - 8
const BAR = 34
const GAP = 8
const AXIS = 26
const MIN_LABEL = 48

const KIND_FILL: Record<QueueEntry['kind'], string> = {
  training: 'fill-test-wash',
  dataset: 'fill-accent-wash',
  evaluation: 'fill-note-wash',
}

export const KIND_LABEL: Record<QueueEntry['kind'], string> = {
  dataset: 'dataset',
  training: 'training',
  evaluation: 'evaluation',
}

function caption(placed: Placed): string {
  const { entry, unknown } = placed
  if (entry.status === 'queued') {
    return unknown ? `${entry.owner} · time unknown` : `${entry.owner} · ${spanLabel(placed.end - placed.start).slice(1)}`
  }
  if (entry.kind === 'training' && entry.training?.progress_last?.epoch !== undefined) {
    return `epoch ${entry.training.progress_last.epoch}${entry.training.epochs ? ` of ${entry.training.epochs}` : ''}`
  }
  if (entry.kind === 'training' && entry.training?.snapshot_progress) return 'cutting the snapshot'
  return entry.phase ?? 'running'
}

/** One lane per worker, laid out over time from now: what runs fills as it goes, and
 *  each waiting item is a bar as long as it is expected to take. The viewer's own work is
 *  outlined. A bar opens its dataset, run or evaluation. */
export function QueueTimeline({ lanes, now, user, pageOf }: {
  lanes: { name: string; bars: Placed[] }[]
  now: number
  user: string
  pageOf: (entry: QueueEntry) => string | null
}) {
  const navigate = useNavigate()
  // Scaled to what is queued, with room after the last bar, so the lane is never mostly empty.
  const span = Math.max(120, 1.1 * Math.max(...lanes.flatMap((lane) => lane.bars.map((b) => b.end))))
  const step = tickStep(span)
  const x = (seconds: number) => LABEL + (seconds / span) * PLOT
  let y = AXIS
  const laneTops = lanes.map((lane) => {
    const top = y
    y += (lane.name === 'Local GPU' ? 1 : lane.bars.length) * (BAR + GAP) + 6
    return top
  })
  const height = y + 14

  return (
    <figure data-testid="queue-timeline" className="mb-4 overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${height}`} className="block w-full min-w-[640px]" role="img"
           aria-label={lanes.map((lane) => `${lane.name}: ${lane.bars.map((b) => b.entry.name).join(', ')}`).join('. ')}>
        <defs>
          <pattern id="unknown-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="6" className="stroke-line-strong" strokeWidth="2" />
          </pattern>
          <clipPath id="plot"><rect x={LABEL} y="0" width={PLOT} height={height} /></clipPath>
        </defs>
        <text x={LABEL} y="12" className="fill-ink-subtle text-[10px]">now {clock(0, now)}</text>
        {Array.from({ length: Math.floor(span / step) }, (_, i) => (i + 1) * step).filter((t) => x(t) < W - 30).map((t) => (
          <g key={t}>
            <line x1={x(t)} x2={x(t)} y1={16} y2={height - 12} className="stroke-line" strokeDasharray="2 3" />
            <text x={x(t)} y="12" textAnchor="middle" className="fill-ink-subtle text-[10px]">{spanLabel(t)}</text>
          </g>
        ))}
        {lanes.map((lane, li) => (
          <g key={lane.name}>
            <text x="0" y={laneTops[li] + BAR / 2 + 4} className="fill-ink text-[11px] font-semibold">{lane.name}</text>
            {lane.bars.map((placed, bi) => {
              const top = laneTops[li] + (lane.name === 'Local GPU' ? 0 : bi * (BAR + GAP))
              const left = x(placed.start)
              const width = Math.max(4, x(placed.end) - left - 2)
              const to = pageOf(placed.entry)
              const mine = placed.entry.owner === user
              const clip = `bar-${placed.entry.kind}-${placed.entry.id}`
              return (
                <g key={`${placed.entry.kind}-${placed.entry.id}`} data-testid="queue-bar" data-kind={placed.entry.kind}
                   data-mine={mine || undefined} data-unknown={placed.unknown || undefined}
                   className={to ? 'cursor-pointer' : undefined} clipPath="url(#plot)"
                   onClick={to ? () => navigate(to) : undefined}>
                  <title>{`${placed.entry.name} (${KIND_LABEL[placed.entry.kind]}, ${placed.entry.owner})`
                    + (placed.unknown ? ' - how long it takes is not known yet' : ` - until about ${clock(placed.end, now)}`)}</title>
                  <rect x={left} y={top} width={width} height={BAR} rx="3"
                        className={`${KIND_FILL[placed.entry.kind]} ${mine ? 'stroke-accent' : 'stroke-transparent'}`}
                        strokeWidth={mine ? 2 : 0} />
                  {placed.unknown && <rect x={left} y={top} width={width} height={BAR} rx="3" fill="url(#unknown-hatch)" opacity="0.5" />}
                  {placed.done > 0 && (
                    <rect x={left} y={top} width={width * Math.min(1, placed.done)} height={BAR} rx="3"
                          className="fill-ink" opacity="0.1" />
                  )}
                  {/* A bar too short to read its name leaves it to the title and the list below. */}
                  {width >= MIN_LABEL && (
                    <g clipPath={`url(#${clip})`}>
                      <clipPath id={clip}><rect x={left} y={top} width={width - 4} height={BAR} /></clipPath>
                      <text x={left + 7} y={top + 14} className="fill-ink text-[11px] font-semibold">{placed.entry.name}</text>
                      <text x={left + 7} y={top + 27} className="fill-ink-muted text-[10px]">{caption(placed)}</text>
                    </g>
                  )}
                </g>
              )
            })}
          </g>
        ))}
        <text x={LABEL} y={height - 2} className="fill-ink-subtle text-[10px]">
          Bars are estimates from each item&apos;s own progress, else from how long the same kind of work took recently.
        </text>
      </svg>
    </figure>
  )
}
