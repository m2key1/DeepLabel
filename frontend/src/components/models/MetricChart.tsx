import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, MouseEvent, PointerEvent } from 'react'

import {
  bucketize, debiasedEma, logTicks, nearestIndex, niceTicks, panDomain, quantileRange, splitPositive, zoomDomain,
} from './chartMath'
import type { Domain } from './chartMath'
import { formatElapsed, reading } from './metrics'
import type { Metric, Sample, XAxis } from './metrics'
import type { CurveSettings } from './curveSettings'
import { cardChrome } from '../ui/Card'

// One user unit is one CSS pixel, so the labels keep their type size whatever the tile
// does - a fixed viewBox would letterbox itself in a wide card and shrink the text with it.
const MIN_WIDTH = 240
const HEIGHT = { normal: 176, expanded: 360 }
const PAD = { top: 8, right: 12, bottom: 18, left: 46 }
/** Below this many pixels a drag is a click, and that axis keeps its range. */
const DRAG_MIN = 6
/** A series gets one min-max column per this many pixels once it is longer than that. */
const COLUMN_PX = 2

/** Slot 1 is always the first series and never recycled, so a series keeps its colour
 *  when another is hidden. A ninth folds back to the first rather than inventing a hue. */
export function seriesColor(index: number): string {
  return `var(--ui-series-${(index % 8) + 1})`
}

export function axisLabel(axis: XAxis, x: number): string {
  if (axis === 'time') return formatElapsed(x)
  return `${axis} ${Number.isInteger(x) ? x.toLocaleString() : x.toFixed(1)}`
}

interface Row extends Sample {
  smooth: number
}

interface Drawn {
  id: string
  label: string
  color: string
  rows: Row[]
}

interface Zoom {
  x?: Domain
  y?: Domain
}

function linePath(points: { x: number; y: number }[], sx: (v: number) => number, sy: (v: number) => number): string {
  return points.map((p, i) => `${i ? 'L' : 'M'}${sx(p.x).toFixed(1)} ${sy(p.y).toFixed(1)}`).join(' ')
}

function fitY(values: number[], log: boolean, outliers: boolean): Domain {
  const [lo, hi] = outliers && values.length >= 5
    ? quantileRange(values, 0.05, 0.95)
    : [Math.min(...values), Math.max(...values)]
  if (log) return lo === hi ? [lo / 2, hi * 2] : [lo / 1.15, hi * 1.15]
  if (lo === hi) {
    const pad = Math.abs(hi) * 0.05 || 1
    return [lo - pad, hi + pad]
  }
  const pad = (hi - lo) * 0.08
  return [lo - pad, hi + pad]
}

/** One metric's chart, read the way TensorBoard's are: a crosshair that snaps to a step
 *  and follows the other charts, the raw line faint behind the smoothed one, a box to
 *  zoom, and a legend that hides and isolates series. */
export function MetricChart({ metric, settings, cursor, active, onCursor }: {
  metric: Metric
  settings: CurveSettings
  /** The x the crosshair is at on whichever chart the pointer is over. */
  cursor: number | null
  /** Whether this chart holds the pointer or the focus, and so shows the readout. */
  active: boolean
  onCursor: (x: number | null) => void
}) {
  const svg = useRef<SVGSVGElement>(null)
  const clip = useId()
  const [width, setWidth] = useState(MIN_WIDTH * 2)
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const [zoom, setZoom] = useState<Zoom | null>(null)
  const [drag, setDrag] = useState<{ from: [number, number]; to: [number, number] } | null>(null)
  const [pan, setPan] = useState<{ from: [number, number]; x: Domain; y: Domain } | null>(null)
  const [expanded, setExpanded] = useState(false)
  const { axis, scale, smoothing, outliers, tool } = settings
  const log = scale === 'log'

  useEffect(() => {
    const el = svg.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => {
      const next = Math.max(MIN_WIDTH, Math.round(entry.contentRect.width))
      setWidth((old) => (old === next ? old : next))
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  useEffect(() => setZoom(null), [axis, scale])

  const W = width
  const H = expanded ? HEIGHT.expanded : HEIGHT.normal
  const PLOT_W = W - PAD.left - PAD.right
  const PLOT_H = H - PAD.top - PAD.bottom

  const legend = useMemo(() => metric.series.map((s, i) => ({ ...s, color: seriesColor(i) })), [metric.series])

  const geometry = useMemo(() => {
    let dropped = 0
    const drawn: Drawn[] = legend.filter((s) => !hidden.has(s.id)).map((s) => {
      const { kept, dropped: lost } = log ? splitPositive(s.samples) : { kept: s.samples, dropped: 0 }
      dropped += lost
      const smoothed = debiasedEma(kept.map((p) => p.y), smoothing)
      return { id: s.id, label: s.label, color: s.color, rows: kept.map((p, k) => ({ ...p, smooth: smoothed[k] })) }
    })
    const rows = drawn.flatMap((s) => s.rows)
    if (rows.length === 0) return { drawn, dropped, xs: [] as number[], empty: true as const }
    const xs = [...new Set(rows.map((r) => r.x))].sort((a, b) => a - b)
    const xDomain: Domain = zoom?.x ?? (xs[0] === xs[xs.length - 1] ? [xs[0] - 0.5, xs[0] + 0.5] : [xs[0], xs[xs.length - 1]])
    const inView = rows.filter((r) => r.x >= xDomain[0] && r.x <= xDomain[1])
    const yValues = (inView.length ? inView : rows).flatMap((r) => [r.y, r.smooth]).filter(Number.isFinite)
    const yDomain: Domain = zoom?.y ?? fitY(yValues, log, outliers)
    return { drawn, dropped, xs, xDomain, yDomain, empty: false as const }
  }, [legend, hidden, log, smoothing, outliers, zoom])

  const { drawn, dropped, xs } = geometry
  const x0 = geometry.empty ? 0 : geometry.xDomain[0]
  const x1 = geometry.empty ? 1 : geometry.xDomain[1]
  const [y0, y1] = geometry.empty ? [0, 1] : geometry.yDomain
  const ty = (v: number) => (log ? Math.log10(v) : v)
  const sx = (v: number) => PAD.left + ((v - x0) / (x1 - x0 || 1)) * PLOT_W
  const sy = (v: number) => PAD.top + PLOT_H - ((ty(v) - ty(y0)) / (ty(y1) - ty(y0) || 1)) * PLOT_H

  const columns = Math.max(1, Math.floor(PLOT_W / COLUMN_PX))
  const lines = drawn.map((s) => {
    const inView = s.rows.filter((r) => r.x >= x0 && r.x <= x1)
    if (inView.length > columns) {
      const band = bucketize(inView.map((r) => ({ x: r.x, y: r.y })), [x0, x1], columns)
      const trend = bucketize(inView.map((r) => ({ x: r.x, y: r.smooth })), [x0, x1], columns)
      const area = [...band.map((b) => ({ x: b.x, y: b.hi })), ...[...band].reverse().map((b) => ({ x: b.x, y: b.lo }))]
      return { ...s, band: `${linePath(area, sx, sy)} Z`, raw: null, smoothed: linePath(trend.map((b) => ({ x: b.x, y: b.last })), sx, sy) }
    }
    return {
      ...s,
      band: null,
      raw: smoothing > 0 ? linePath(s.rows, sx, sy) : null,
      smoothed: linePath(s.rows.map((r) => ({ x: r.x, y: r.smooth })), sx, sy),
    }
  })

  const yTicks = geometry.empty ? [] : (log ? logTicks(y0, y1) : niceTicks(y0, y1, 4))
  const xTicks = geometry.empty ? [] : niceTicks(x0, x1, Math.max(2, Math.floor(PLOT_W / 90)))
    .filter((t) => axis === 'time' || Number.isInteger(t))

  const at = cursor === null || xs.length === 0 ? null : xs[nearestIndex(xs, cursor)]
  const atRows = at === null ? [] : drawn.map((s) => ({ s, row: s.rows.find((r) => r.x === at) }))
    .filter((r): r is { s: Drawn; row: Row } => r.row !== undefined)
  const where = atRows[0]?.row

  const toUser = (e: { clientX: number; clientY: number }): [number, number] => {
    const box = svg.current!.getBoundingClientRect()
    return [((e.clientX - box.left) / box.width) * W, ((e.clientY - box.top) / box.height) * H]
  }
  const xAt = (px: number) => x0 + ((px - PAD.left) / PLOT_W) * (x1 - x0)
  const snap = (px: number) => xs[nearestIndex(xs, xAt(px))]
  const fraction = (v: number, size: number) => Math.min(1, Math.max(0, v / size))

  const onPointerMove = (e: PointerEvent<SVGSVGElement>) => {
    if (xs.length === 0) return
    const point = toUser(e)
    if (pan) {
      setZoom({
        x: panDomain(pan.x, -(point[0] - pan.from[0]) / PLOT_W),
        y: panDomain(pan.y, (point[1] - pan.from[1]) / PLOT_H, log),
      })
    }
    if (drag) setDrag({ ...drag, to: point })
    onCursor(snap(point[0]))
  }
  const onPointerDown = (e: PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0 || xs.length === 0) return
    const point = toUser(e)
    svg.current?.setPointerCapture?.(e.pointerId)
    if ((tool === 'move' || e.shiftKey) && !geometry.empty) {
      setPan({ from: point, x: geometry.xDomain, y: geometry.yDomain })
      return
    }
    setDrag({ from: point, to: point })
  }
  const onPointerUp = () => {
    if (pan) return setPan(null)
    if (!drag || geometry.empty) return setDrag(null)
    const [[ax, ay], [bx, by]] = [drag.from, drag.to]
    setDrag(null)
    const wide = Math.abs(bx - ax) >= DRAG_MIN
    const tall = Math.abs(by - ay) >= DRAG_MIN
    if (!wide && !tall) return
    setZoom({
      x: wide ? zoomDomain(geometry.xDomain, fraction(ax - PAD.left, PLOT_W), fraction(bx - PAD.left, PLOT_W)) : zoom?.x,
      y: tall ? zoomDomain(geometry.yDomain, fraction(PAD.top + PLOT_H - ay, PLOT_H),
                           fraction(PAD.top + PLOT_H - by, PLOT_H), log) : zoom?.y,
    })
  }
  const onKeyDown = (e: KeyboardEvent<SVGSVGElement>) => {
    if (xs.length === 0) return
    const index = at === null ? xs.length - 1 : xs.indexOf(at)
    const next = { ArrowLeft: index - 1, ArrowRight: index + 1, Home: 0, End: xs.length - 1 }[e.key]
    if (e.key === 'Escape') {
      setZoom(null)
      return
    }
    if (next === undefined) return
    e.preventDefault()
    onCursor(xs[Math.min(xs.length - 1, Math.max(0, next))])
  }
  const toggle = (id: string, e: MouseEvent) => {
    const others = legend.map((s) => s.id).filter((o) => o !== id)
    if (e.altKey) {
      const alone = !hidden.has(id) && others.every((o) => hidden.has(o))
      setHidden(alone ? new Set() : new Set(others))
      return
    }
    const next = new Set(hidden)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setHidden(next)
  }

  const many = legend.length > 1
  const readoutLeft = at !== null && sx(at) < W / 2

  return (
    <figure data-testid="metric-chart" data-metric={metric.key} data-axis={axis} data-scale={scale}
            data-zoomed={zoom ? 'true' : 'false'} data-tool={tool} data-panning={pan ? 'true' : 'false'}
            data-cursor={at ?? undefined}
            className={`${cardChrome} flex min-w-0 flex-col p-2 ${expanded ? 'col-span-full' : ''}`}>
      <figcaption className="mb-1 flex items-start justify-between gap-2">
        <span className="min-w-0 truncate font-ocr text-xs">
          {metric.group && <span className="text-ink-subtle">{metric.group}/</span>}
          <span className="font-semibold text-ink">{metric.leaf}</span>
        </span>
        <span className="flex shrink-0 items-start gap-1">
          {/* Every series is labelled in words as well as in colour - identity is never
              colour alone, and three of the light slots sit under 3:1 on this surface. */}
          <span className="flex flex-col items-end gap-0.5">
            {legend.map((s) => {
              const r = reading(s.samples)
              if (!r) return null
              const better = metric.lowerIsBetter ? r.delta < 0 : r.delta > 0
              const off = hidden.has(s.id)
              return (
                <button key={s.id} type="button" data-testid="legend-item" data-series={s.id} aria-pressed={!off}
                        title={`${off ? 'Show' : 'Hide'} ${s.label}; alt-click shows only it`}
                        onClick={(e) => toggle(s.id, e)}
                        className={`flex items-center justify-end gap-1 rounded px-1 text-[10px] leading-tight hover:bg-raised focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent ${off ? 'opacity-40' : ''}`}>
                  <span aria-hidden className="h-0.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: s.color }} />
                  {many && <span className={`max-w-28 truncate text-ink-subtle ${off ? 'line-through' : ''}`}>{s.label}</span>}
                  <span data-testid="metric-latest" data-series={s.id}
                        className="font-medium font-mono tabular-nums text-ink">{metric.format(r.latest)}</span>
                  {r.delta !== 0 && (
                    <span className={better ? 'text-ok' : 'text-warn'}>
                      {better ? '▾' : '▴'}{metric.format(Math.abs(r.delta))}
                    </span>
                  )}
                </button>
              )
            })}
          </span>
          <button type="button" data-testid="chart-expand" aria-pressed={expanded}
                  aria-label={expanded ? `Shrink ${metric.key}` : `Expand ${metric.key} to full width`}
                  title={expanded ? 'Shrink' : 'Expand to full width'}
                  onClick={() => setExpanded((v) => !v)}
                  className="rounded p-0.5 text-ink-subtle hover:bg-raised hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent">
            <svg aria-hidden viewBox="0 0 12 12" className="h-3 w-3 fill-none stroke-current" strokeWidth="1.5">
              {expanded
                ? <><polyline points="5,1 5,5 1,5" /><polyline points="7,11 7,7 11,7" /></>
                : <><polyline points="1,5 1,1 5,1" /><polyline points="11,7 11,11 7,11" /></>}
            </svg>
          </button>
        </span>
      </figcaption>
      <div className="relative">
        <svg
          ref={svg}
          viewBox={`0 0 ${W} ${H}`}
          style={{ height: H }}
          className={`w-full touch-none select-none ${pan ? 'cursor-grabbing' : tool === 'move' ? 'cursor-grab' : ''} focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent`}
          role="img"
          tabIndex={0}
          aria-label={`${metric.key} by ${axis}; arrow keys move the crosshair, drag to ${tool === 'move' ? 'move' : 'zoom'}, shift-drag to move, double-click to reset`}
          onPointerMove={onPointerMove}
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
          onPointerLeave={() => { if (!drag && !pan) onCursor(null) }}
          onDoubleClick={() => setZoom(null)}
          onKeyDown={onKeyDown}
          onFocus={() => { if (cursor === null && xs.length) onCursor(xs[xs.length - 1]) }}
          onBlur={() => onCursor(null)}
        >
          <defs>
            <clipPath id={clip}>
              <rect x={PAD.left} y={PAD.top} width={PLOT_W} height={PLOT_H} />
            </clipPath>
          </defs>
          {yTicks.map((t) => (
            <g key={`y${t}`}>
              <line x1={PAD.left} x2={W - PAD.right} y1={sy(t)} y2={sy(t)} className="stroke-line" strokeWidth="1" opacity="0.6" />
              <text x={PAD.left - 4} y={sy(t) + 3} textAnchor="end" className="fill-ink-subtle font-mono text-[9px] tabular-nums">
                {metric.format(t)}
              </text>
            </g>
          ))}
          {xTicks.map((t) => (
            <text key={`x${t}`} x={sx(t)} y={H - 4} textAnchor="middle" className="fill-ink-subtle font-mono text-[9px] tabular-nums">
              {axis === 'time' ? formatElapsed(t) : t.toLocaleString()}
            </text>
          ))}
          <line x1={PAD.left} x2={W - PAD.right} y1={PAD.top + PLOT_H} y2={PAD.top + PLOT_H} className="stroke-line-strong" strokeWidth="1" />
          <g clipPath={`url(#${clip})`}>
            {lines.map((s) => (
              <g key={s.id}>
                {s.band && <path d={s.band} data-line="band" style={{ fill: s.color }} opacity="0.2" />}
                {s.raw && <path d={s.raw} data-line="raw" fill="none" strokeWidth="1" opacity="0.3"
                                strokeLinejoin="round" style={{ stroke: s.color }} />}
                <path d={s.smoothed} data-line="smoothed" fill="none" strokeWidth="2"
                      strokeLinejoin="round" strokeLinecap="round" style={{ stroke: s.color }} />
              </g>
            ))}
          </g>
          {at !== null && (
            <>
              <line x1={sx(at)} x2={sx(at)} y1={PAD.top} y2={PAD.top + PLOT_H}
                    className="stroke-ink-subtle" strokeWidth="1" strokeDasharray="2 2" />
              {atRows.map(({ s, row }) => Number.isFinite(row.smooth) && (
                // A 2px ring in the surface colour, so two series crossing stay apart.
                <circle key={s.id} cx={sx(at)} cy={sy(row.smooth)} r="4" strokeWidth="2"
                        className="stroke-surface" style={{ fill: s.color }} />
              ))}
            </>
          )}
          {drag && (
            <rect x={Math.min(drag.from[0], drag.to[0])} y={Math.min(drag.from[1], drag.to[1])}
                  width={Math.abs(drag.to[0] - drag.from[0])} height={Math.abs(drag.to[1] - drag.from[1])}
                  className="fill-accent-wash stroke-accent" opacity="0.5" strokeWidth="1" />
          )}
          {/* On top of every mark, so the pointer always lands on the plot rather than a line. */}
          <rect data-testid="plot-area" x={PAD.left} y={PAD.top} width={PLOT_W} height={PLOT_H} fill="transparent" />
          {geometry.empty && (
            <text x={W / 2} y={H / 2} textAnchor="middle" className="fill-ink-subtle text-[11px]">
              {log && dropped ? 'Nothing above zero to draw on a log scale' : 'Every series is hidden'}
            </text>
          )}
        </svg>
        {active && at !== null && where && (
          <div data-testid="chart-readout"
               className={`pointer-events-none absolute top-1 z-10 min-w-36 rounded border border-line-strong bg-surface px-2 py-1 text-[11px] shadow-sm ${
                 readoutLeft ? '' : '-translate-x-full'}`}
               style={{ left: readoutLeft ? sx(at) / W * 100 + 2 + '%' : sx(at) / W * 100 - 2 + '%' }}>
            <div className="mb-0.5 flex gap-2 font-mono tabular-nums text-ink-subtle">
              {where.step !== null && <span data-testid="readout-step">step {where.step.toLocaleString()}</span>}
              <span data-testid="readout-epoch">epoch {where.epoch}</span>
              {where.time !== null && <span data-testid="readout-time">{formatElapsed(where.time)}</span>}
            </div>
            <table className="w-full">
              <thead className="sr-only">
                <tr><th>series</th><th>smoothed</th><th>value</th></tr>
              </thead>
              <tbody>
                {atRows.map(({ s, row }) => (
                  <tr key={s.id} data-testid="readout-row" data-series={s.id}>
                    <td className="pr-2">
                      <span className="flex items-center gap-1 text-ink-muted">
                        <span aria-hidden className="h-0.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: s.color }} />
                        <span className="max-w-32 truncate">{s.label}</span>
                      </span>
                    </td>
                    <td data-testid="readout-smoothed" className="text-right font-mono font-semibold tabular-nums text-ink">
                      {metric.format(row.smooth)}
                    </td>
                    <td data-testid="readout-raw" className="pl-2 text-right font-mono tabular-nums text-ink-subtle">
                      {metric.format(row.y)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <p data-testid="chart-footer" className="mt-0.5 h-4 truncate text-center font-mono text-[10px] tabular-nums text-ink-subtle">
        {xs.length === 0 ? '' : at === null
          ? `${axisLabel(axis, xs[0])} - ${axisLabel(axis, xs[xs.length - 1])}${zoom ? ' · zoomed, double-click to reset' : ''}`
          : `${axisLabel(axis, at)} · ${atRows.map(({ s, row }) =>
              `${many ? `${s.label} ` : ''}${metric.format(row.smooth)}`).join(' · ')}`}
      </p>
      {dropped > 0 && !geometry.empty && (
        <p data-testid="log-dropped" className="text-center text-[10px] text-ink-subtle">
          {dropped} reading{dropped === 1 ? '' : 's'} at or below zero left out of the log scale
        </p>
      )}
    </figure>
  )
}
