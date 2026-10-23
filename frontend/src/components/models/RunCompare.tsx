import { useEffect, useState } from 'react'

import { trainingProgress } from '../../api'
import type { ProgressPoint, Training } from '../../api'
import { Button } from '../ui/Button'
import { seriesColor } from './MetricChart'
import { CurveGrid, CurveToolbar, effectiveSettings } from './RunMetrics'
import { compareRuns } from './metrics'
import type { XAxis } from './metrics'
import { useCurveSettings } from './curveSettings'

const COMPARE_AXES: XAxis[] = ['epoch', 'time']

/** Two or three runs laid over each other, a chart per metric they reported. Which runs
 *  are worth comparing is a judgement - the same datasets under a different learning
 *  rate, the same settings on a longer schedule - so the page picks them, not a rule. */
export function RunCompare({ runs, onClose }: { runs: Training[]; onClose: () => void }) {
  const [points, setPoints] = useState<Record<number, ProgressPoint[]>>({})
  const [saved, change] = useCurveSettings()
  const settings = effectiveSettings(saved, COMPARE_AXES)
  const [failed, setFailed] = useState<string | null>(null)
  const ids = runs.map((r) => r.id).join(',')

  useEffect(() => {
    let live = true
    Promise.all(runs.map((run) => trainingProgress(run.id).then((r) => [run.id, r.points] as const)))
      .then((pairs) => live && setPoints(Object.fromEntries(pairs)))
      .catch((e: Error) => live && setFailed(e.message))
    return () => { live = false }
    // Keyed by the ids, not by `runs`: that array is rebuilt on every render of a page
    // that polls, and depending on it would refetch the same progress every tick.
  }, [ids])

  const metrics = compareRuns(
    runs.map((run) => ({ id: run.id, label: run.name, points: points[run.id] ?? [] })),
    settings.axis,
  )
  return (
    <div data-testid="run-compare" className="mb-3 rounded border border-line-strong p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">Comparing {runs.length} runs</span>
        {/* The colours are the charts' own, so the legend here is the same mapping. */}
        {runs.map((run, i) => (
          <span key={run.id} className="flex items-center gap-1 text-xs text-ink-muted">
            <span className="h-2 w-2 rounded-full" style={{ background: seriesColor(i) }} />
            {run.name}
          </span>
        ))}
        <Button variant="ghost" size="xs" className="ml-auto" onClick={onClose}>Close</Button>
      </div>
      <div className="mb-2">
        <CurveToolbar settings={settings} axes={COMPARE_AXES} onChange={change} />
      </div>
      {failed && <p className="text-sm text-danger">{failed}</p>}
      {!failed && metrics.length === 0 && (
        <p className="text-sm text-ink-muted">
          Nothing to lay over each other yet - these runs have reported no metrics.
        </p>
      )}
      <CurveGrid metrics={metrics} settings={settings} />
    </div>
  )
}
