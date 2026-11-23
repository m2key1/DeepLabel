import type { Evaluation, MetricInfo, ProgressPoint, Training } from '../../api'

/** Which material an evaluation scored: its run's validation lines, or the datasets it was
 *  given, as one key. */
export function materialOf(ev: Evaluation): string {
  return ev.source.snapshot !== undefined ? 'valid' : (ev.source.jobs ?? []).join('+')
}

export function duration(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.round((seconds % 3600) / 60)
  return h > 0 ? `${h} h ${m} m` : `${m} m`
}

/** How long a run took, from its own timestamps; while it runs, from its progress points. */
export function runSeconds(run: Training, points: ProgressPoint[]): number | null {
  if (run.started_at && run.finished_at) {
    const at = (stamp: string) => Date.parse(`${stamp.replace(' ', 'T')}Z`)
    return (at(run.finished_at) - at(run.started_at)) / 1000
  }
  const stamps = points.map((p) => p.ts).filter((t): t is number => typeof t === 'number')
  return stamps.length > 1 ? Math.max(...stamps) - Math.min(...stamps) : null
}

export interface RunMetric { key: string; label: string; higherIsBetter: boolean }

const asRunMetric = (metric: MetricInfo): RunMetric =>
  ({ key: metric.key, label: metric.label ?? metric.key, higherIsBetter: metric.better === 'higher' })

/** The metric a run is judged by, as its trainer declares it: CER for one that declares none. */
export function headlineMetric(info: MetricInfo[] | null | undefined): RunMetric {
  const headline = info?.find((m) => m.headline)
  return headline ? asRunMetric(headline) : { key: 'cer', label: 'CER', higherIsBetter: false }
}

/** The metric whose best epoch the trainer keeps: the one it declares as picking the
 *  checkpoint, else its headline. */
export function keptMetric(info: MetricInfo[] | null | undefined): RunMetric {
  const picker = info?.find((m) => m.selects)
  return picker ? asRunMetric(picker) : headlineMetric(info)
}

/** The first epoch with the best value on a metric's curve, and that value. */
export function bestOn(points: ProgressPoint[], metric: RunMetric): { epoch: number; value: number } | null {
  let best: { epoch: number; value: number } | null = null
  for (const point of points) {
    const value = (point as unknown as Record<string, unknown>)[metric.key]
    if (typeof value !== 'number' || point.epoch === undefined) continue
    if (best === null || (metric.higherIsBetter ? value > best.value : value < best.value)) best = { epoch: point.epoch, value }
  }
  return best
}
