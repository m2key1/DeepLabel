import { useCallback, useMemo, useState } from 'react'

import { BoxZoomIcon, HandIcon } from '../icons'
import { Segmented } from '../ui/Segmented'
import { Toggle } from '../ui/Button'
import { MetricChart } from './MetricChart'
import { availableAxes, collectMetrics } from './metrics'
import type { Metric, MetricContext, XAxis } from './metrics'
import { MAX_SMOOTHING, useCurveSettings } from './curveSettings'
import type { CurveSettings } from './curveSettings'
import type { ProgressPoint } from '../../api'

/** The one row of controls every chart below it answers to. */
export function CurveToolbar({ settings, axes, onChange, count }: {
  settings: CurveSettings
  axes: XAxis[]
  onChange: (change: Partial<CurveSettings>) => void
  count?: number
}) {
  return (
    <div data-testid="curve-toolbar" className="flex flex-wrap items-center gap-3">
      <Segmented
        value={settings.axis}
        onChange={(axis) => onChange({ axis })}
        options={axes.map((a) => ({ value: a, label: a, title: a === 'time' ? 'Time since the first point' : undefined }))}
      />
      <Segmented
        value={settings.scale}
        onChange={(scale) => onChange({ scale })}
        options={[{ value: 'linear', label: 'linear' }, { value: 'log', label: 'log' }]}
      />
      <Segmented
        value={settings.tool}
        onChange={(tool) => onChange({ tool })}
        options={[
          { value: 'zoom', label: <span className="flex items-center gap-1"><BoxZoomIcon />zoom</span>,
            title: 'Drag a box to zoom into it' },
          { value: 'move', label: <span className="flex items-center gap-1"><HandIcon />move</span>,
            title: 'Drag to move the view; shift-drag does this with either tool' },
        ]}
      />
      <Toggle on={settings.outliers} onClick={() => onChange({ outliers: !settings.outliers })}
              title="Fit the y range to the 5th-95th percentile of what is in view">
        ignore outliers
      </Toggle>
      <label className="flex items-center gap-2 text-xs text-ink-subtle">
        smoothing
        <input
          type="range"
          min={0}
          max={MAX_SMOOTHING}
          step={0.01}
          value={settings.smoothing}
          data-testid="smoothing"
          onChange={(e) => onChange({ smoothing: Number(e.target.value) })}
          className="w-28 accent-accent"
        />
        <span className="w-8 font-mono tabular-nums">{settings.smoothing === 0 ? 'off' : settings.smoothing.toFixed(2)}</span>
      </label>
      {count !== undefined && (
        <span className="ml-auto text-xs text-ink-subtle">
          {count} metric{count === 1 ? '' : 's'} · drag to zoom or move, shift-drag to move, double-click to reset, alt-click a legend entry to show only it
        </span>
      )}
    </div>
  )
}

/** Charts that share one crosshair: the step under the pointer on one is the step shown on all. */
export function CurveGrid({ metrics, settings, columns = 3 }: {
  metrics: Metric[]
  settings: CurveSettings
  /** At the widest breakpoint; the headline pair reads better two abreast than in a row of three. */
  columns?: 2 | 3
}) {
  const [cursor, setCursor] = useState<{ x: number; source: string } | null>(null)
  const move = useCallback((source: string, x: number | null) => {
    setCursor((old) => (x === null ? (old?.source === source ? null : old) : { x, source }))
  }, [])
  return (
    <div data-testid="curve-grid" className={`grid grid-cols-1 gap-2 sm:grid-cols-2 ${columns === 3 ? 'xl:grid-cols-3' : ''}`}>
      {metrics.map((m) => (
        <MetricChart key={m.key} metric={m} settings={settings}
                     cursor={cursor?.x ?? null} active={cursor?.source === m.key}
                     onCursor={(x) => move(m.key, x)} />
      ))}
    </div>
  )
}

/** The axis asked for when the run can be read on it, otherwise the epoch. */
export function effectiveSettings(settings: CurveSettings, axes: XAxis[]): CurveSettings {
  return axes.includes(settings.axis) ? settings : { ...settings, axis: 'epoch' }
}

/** Every metric a run reported, one chart each, under one set of controls.
 *
 *  Nothing here knows what an OCR run measures. The charts come from the keys in the
 *  points, so a trainer that starts reporting a new number gets a chart for it and this
 *  file does not change - which is the whole reason it is shaped this way. */
export function RunMetrics({ points, datasets, stepsPerEpoch = null, only, context }: {
  points: ProgressPoint[]
  datasets: Record<string, string>
  stepsPerEpoch?: number | null
  /** Just these metrics, in this order - the headline curves on the overview. */
  only?: string[]
  context?: MetricContext
}) {
  const [saved, change] = useCurveSettings()
  const axes = useMemo(() => availableAxes(points, stepsPerEpoch), [points, stepsPerEpoch])
  const settings = effectiveSettings(saved, axes)

  const metrics = useMemo(() => {
    const all = collectMetrics(points, settings.axis, datasets, stepsPerEpoch, context)
    return only ? only.flatMap((key) => all.filter((m) => m.key === key)) : all
  }, [points, settings.axis, datasets, stepsPerEpoch, only, context])
  const main = metrics.filter((m) => !m.detail)
  const detail = metrics.filter((m) => m.detail)

  if (metrics.length === 0) {
    return (
      <p data-testid="no-metrics" className="text-xs text-ink-subtle">
        Nothing reported yet. Charts appear as the trainer writes its first points.
      </p>
    )
  }

  return (
    <div className="space-y-2">
      <CurveToolbar settings={settings} axes={axes} onChange={change} count={only ? undefined : metrics.length} />
      <CurveGrid metrics={main} settings={settings} columns={only ? 2 : 3} />
      {detail.length > 0 && (
        <details data-testid="detail-metrics" className="text-xs text-ink-subtle">
          <summary className="cursor-pointer select-none py-1">
            {detail.length} more the trainer marked as detail
          </summary>
          <CurveGrid metrics={detail} settings={settings} />
        </details>
      )}
    </div>
  )
}
