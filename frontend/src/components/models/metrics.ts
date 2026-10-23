import type { MetricInfo, ProgressPoint } from '../../api'

export type { MetricInfo }

/** What a trainer reports, discovered rather than declared.
 *
 *  The backend merges every line of progress.jsonl per epoch and passes the keys through
 *  untouched, so a trainer that starts emitting `grad_norm` gets a chart for it without
 *  anything here changing. Only `epoch` and `ts` are spoken for - they are the two axes -
 *  and `cer_by_dataset` is the one shape that is read rather than plotted flat, because
 *  it carries one line per dataset instead of one number.
 */

export interface Sample {
  x: number
  y: number
  epoch: number
  /** Seconds since the run's first point, where the trainer stamped one. */
  time: number | null
  step: number | null
}

export interface Series {
  /** Stable across renders and filters, so a series keeps its colour. */
  id: string
  label: string
  samples: Sample[]
}

export interface Metric {
  key: string
  /** `group/leaf` splits into a muted group and a bold leaf, as the trainer named it. */
  group: string
  leaf: string
  series: Series[]
  format: (value: number) => string
  /** Lower is better, which decides which way the delta reads. */
  lowerIsBetter: boolean
  /** What the run is read by, as its backend declared it: charted first. */
  headline: boolean
  /** Declared as detail - one value per decoder layer, an EMA copy - and folded away. */
  detail: boolean
}

export interface MetricContext {
  /** The run's declared metrics; a run trained in-process has none. */
  info?: MetricInfo[] | null
  /** Items in the training split, so an epoch's time also reads as items per second. */
  trainItems?: number
}

export type XAxis = 'step' | 'epoch' | 'time'

const AXES = new Set(['epoch', 'ts', 'step'])

/** The two the app has always known, so they keep their units and their sort order.
 *  Anything else is a number on a chart, which is the point. */
const KNOWN: Record<string, { format: (v: number) => string; lowerIsBetter: boolean; rank: number }> = {
  cer: { format: (v) => `${(v * 100).toFixed(2)}%`, lowerIsBetter: true, rank: 0 },
  best_cer: { format: (v) => `${(v * 100).toFixed(2)}%`, lowerIsBetter: true, rank: 1 },
  loss: { format: (v) => trim(v.toFixed(4)), lowerIsBetter: true, rank: 2 },
}

const UNIT_FORMAT: Record<NonNullable<MetricInfo['unit']>, (v: number) => string> = {
  fraction: (v) => `${(v * 100).toFixed(2)}%`,
  number: (v) => formatUnknown(v),
  gb: (v) => `${trim(v.toFixed(1))} GB`,
  seconds: (v) => formatElapsed(v),
  per_second: (v) => `${formatUnknown(v)}/s`,
}

/** The timing every stamped run gets, worked out here from the stamps and the split. */
const TIMING: MetricInfo[] = [
  { key: 'time/epoch_seconds', label: 'time per epoch', unit: 'seconds', better: 'lower' },
  { key: 'time/items_per_s', label: 'throughput', unit: 'per_second', better: 'higher' },
]

function keyPattern(key: string): RegExp {
  const body = key.replace(/[.+?^${}()|\\]/g, '\\$&').replace(/\*/g, '(.*)')
  return new RegExp(`^${body}$`)
}

/** The declaration a key falls under, the exact one before any pattern, and what its `*`
 *  matched. */
export function describeMetric(key: string, info: MetricInfo[]): { info: MetricInfo | null; matched: string } {
  const exact = info.find((m) => m.key === key)
  if (exact) return { info: exact, matched: '' }
  for (const m of info) {
    if (!m.key.includes('*')) continue
    const found = keyPattern(m.key).exec(key)
    if (found) return { info: m, matched: found[1] ?? '' }
  }
  return { info: null, matched: '' }
}

/** Seconds per epoch and items per second between stamped epochs: what a run costs, which
 *  a trainer need not report for it to be shown. */
function timing(points: ProgressPoint[], trainItems: number): Record<string, Omit<Sample, 'x'>[]> {
  const stamped = points.filter((p) => typeof p.ts === 'number' && typeof p.epoch === 'number')
  const out: Record<string, Omit<Sample, 'x'>[]> = { 'time/epoch_seconds': [], 'time/items_per_s': [] }
  for (let i = 1; i < stamped.length; i++) {
    const epochs = stamped[i].epoch! - stamped[i - 1].epoch!
    const seconds = stamped[i].ts! - stamped[i - 1].ts!
    if (epochs <= 0 || seconds <= 0) continue
    const at = { epoch: stamped[i].epoch!, time: stamped[i].ts! - stamped[0].ts!, step: null }
    out['time/epoch_seconds'].push({ ...at, y: seconds / epochs })
    if (trainItems > 0) out['time/items_per_s'].push({ ...at, y: (trainItems * epochs) / seconds })
  }
  return out
}

function trim(s: string): string {
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s
}

/** Enough digits to tell two readings apart, without pretending to more. */
export function formatUnknown(v: number): string {
  const size = Math.abs(v)
  if (size === 0) return '0'
  if (size >= 1000) return Math.round(v).toLocaleString()
  if (size >= 1) return trim(v.toFixed(2))
  if (size >= 0.001) return trim(v.toFixed(4))
  return v.toExponential(1)
}

function stepOf(point: ProgressPoint, epoch: number, stepsPerEpoch: number | null): number | null {
  if (typeof point.step === 'number') return point.step
  return stepsPerEpoch ? epoch * stepsPerEpoch : null
}

function xOf(at: Omit<Sample, 'x' | 'y'>, axis: XAxis): number {
  if (axis === 'time' && at.time !== null) return at.time
  if (axis === 'step' && at.step !== null) return at.step
  return at.epoch
}

/** The x axes a run can be read on: step only where the trainer reported one or the
 *  pre-flight says how many an epoch takes, time only where the points are stamped -
 *  otherwise the epoch numbers would be drawn and labelled as something they are not. */
export function availableAxes(points: ProgressPoint[], stepsPerEpoch: number | null = null): XAxis[] {
  const axes: XAxis[] = []
  if (stepsPerEpoch || points.some((p) => typeof p.step === 'number')) axes.push('step')
  axes.push('epoch')
  if (points.some((p) => typeof p.ts === 'number')) axes.push('time')
  return axes
}

/** Every metric a run has reported, in a stable order: the ones the app has always
 *  charted first, then whatever else the trainer sent, alphabetically. */
export function collectMetrics(
  points: ProgressPoint[],
  axis: XAxis,
  datasetNames: Record<string, string> = {},
  stepsPerEpoch: number | null = null,
  context: MetricContext = {},
): Metric[] {
  const declared = [...(context.info ?? []), ...TIMING]
  const stamps = points.map((p) => p.ts).filter((t): t is number => typeof t === 'number')
  const start = stamps.length ? Math.min(...stamps) : null

  const flat = new Map<string, Sample[]>()
  const byDataset = new Map<string, Sample[]>()
  points.forEach((point, i) => {
    const epoch = point.epoch ?? i + 1
    const at = {
      epoch,
      time: typeof point.ts === 'number' && start !== null ? point.ts - start : null,
      step: stepOf(point, epoch, stepsPerEpoch),
    }
    const x = xOf(at, axis)
    for (const [key, value] of Object.entries(point)) {
      if (AXES.has(key) || typeof value !== 'number' || !Number.isFinite(value)) continue
      if (!flat.has(key)) flat.set(key, [])
      flat.get(key)!.push({ ...at, x, y: value })
    }
    for (const [jobId, value] of Object.entries(point.cer_by_dataset ?? {})) {
      if (typeof value !== 'number' || !Number.isFinite(value)) continue
      if (!byDataset.has(jobId)) byDataset.set(jobId, [])
      byDataset.get(jobId)!.push({ ...at, x, y: value })
    }
  })

  if (stamps.length > 1 && !flat.has('time/epoch_seconds')) {
    for (const [key, samples] of Object.entries(timing(points, context.trainItems ?? 0))) {
      if (samples.length) flat.set(key, samples.map((at) => ({ ...at, x: xOf(at, axis) })))
    }
  }

  const metrics: Metric[] = [...flat.entries()].map(([key, samples]) => {
    const known = KNOWN[key]
    const { info, matched } = describeMetric(key, declared)
    const name = info?.label ? info.label.replace('{}', matched) : key
    const slash = name.indexOf('/')
    return {
      key,
      group: slash > 0 ? name.slice(0, slash) : '',
      leaf: slash > 0 ? name.slice(slash + 1) : name,
      series: [{ id: key, label: name, samples }],
      format: info?.unit ? UNIT_FORMAT[info.unit] : known?.format ?? formatUnknown,
      lowerIsBetter: info?.better ? info.better === 'lower' : known?.lowerIsBetter ?? false,
      headline: Boolean(info?.headline),
      detail: Boolean(info?.detail),
    }
  })

  if (byDataset.size > 1) {
    metrics.push({
      key: 'cer_by_dataset',
      group: 'cer',
      leaf: 'by dataset',
      series: [...byDataset.entries()].map(([jobId, samples]) => ({
        id: jobId,
        label: datasetNames[jobId] ?? jobId,
        samples,
      })),
      format: KNOWN.cer.format,
      lowerIsBetter: true,
      headline: false,
      detail: false,
    })
  }

  return metrics.sort((a, b) => rank(a) - rank(b) || a.key.localeCompare(b.key))
}

/** Headline first, then the two the app has always known, then the rest; detail last. */
function rank(m: Metric): number {
  if (m.headline) return -1
  return (KNOWN[m.key]?.rank ?? 50) + (m.detail ? 100 : 0)
}

/** The curves a run is read by: its declared headline and its loss, else CER and loss. */
export function headlineKeys(info: MetricInfo[] | null | undefined): string[] {
  const headline = info?.find((m) => m.headline)?.key
  if (!headline) return ['cer', 'loss']
  const loss = info?.find((m) => !m.detail && /(^|\/)loss$/.test(m.key))?.key
  return loss ? [headline, loss] : [headline]
}

/** The same metrics across several runs: one chart per key, one line per run.
 *
 *  A run that never reported a key simply has no line on that chart, rather than a gap -
 *  two runs of different trainers are worth laying over each other for the keys they
 *  share. `cer_by_dataset` is left out: it is already one line per dataset, and stacking
 *  runs on top of that is a chart nobody can read. */
export function compareRuns(
  runs: { id: number; label: string; points: ProgressPoint[] }[],
  axis: XAxis,
): Metric[] {
  const keys = new Map<string, Metric>()
  for (const run of runs) {
    for (const metric of collectMetrics(run.points, axis)) {
      if (metric.key === 'cer_by_dataset') continue
      const merged = keys.get(metric.key) ?? { ...metric, series: [] }
      merged.series = [...merged.series, {
        id: `${run.id}:${metric.key}`,
        label: run.label,
        samples: metric.series[0].samples,
      }]
      keys.set(metric.key, merged)
    }
  }
  return [...keys.values()].sort((a, b) => rank(a) - rank(b) || a.key.localeCompare(b.key))
}

export interface Reading {
  latest: number
  delta: number
}

/** The last reading and how far it has come, which is what a run is read for. */
export function reading(samples: Sample[]): Reading | null {
  if (samples.length === 0) return null
  const latest = samples[samples.length - 1].y
  return { latest, delta: latest - samples[0].y }
}

/** Seconds as a human would say them, for the time axis. */
export function formatElapsed(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)}s`
  if (seconds < 5400) return `${Math.round(seconds / 60)}m`
  const hours = seconds / 3600
  return hours < 48 ? `${trim(hours.toFixed(1))}h` : `${Math.round(hours / 24)}d`
}

export interface ReportedValue {
  key: string
  label: string
  value: string
  headline: boolean
}

export interface ReportedGroup {
  title: string
  values: ReportedValue[]
}

const SCORE_NAME = /(^|[/_])(m?AP|mAR|AR|F1|precision|recall|hmean|accuracy|iou)(?![a-z])/i
const GROUP_TITLES: Record<string, string> = { val: 'Validation', final: 'Final evaluation', train: 'Training' }
export const DETAIL_GROUP = 'Detail'
const GROUP_ORDER = ['Validation', 'Final evaluation', 'Training']

function groupRank(title: string): number {
  if (title === DETAIL_GROUP) return 100
  if (title === 'Settings') return 99
  return GROUP_ORDER.includes(title) ? GROUP_ORDER.indexOf(title) : 10
}

function reportedFormat(key: string, value: number, info: MetricInfo | null): (v: number) => string {
  if (info?.unit) return UNIT_FORMAT[info.unit]
  if (KNOWN[key]) return KNOWN[key].format
  return value >= 0 && value <= 1 && SCORE_NAME.test(key) ? UNIT_FORMAT.fraction : formatUnknown
}

/** A run's closing report, as its model page lists it: scores grouped by what they were
 *  measured on (a bare key is a validation score), one group per declared `{}` family (AP per class), the whole numbers a
 *  trainer echoes back - resolution, query counts - apart as settings, and what its backend
 *  declared as detail (EMA copies, per-layer losses) last. `val_metric` only repeats a
 *  score the run reports under its own key, so it shows only when it is the sole score. */
export function groupReported(metrics: Record<string, unknown>, info: MetricInfo[] | null | undefined): ReportedGroup[] {
  const declared = info ?? []
  const numbers = Object.entries(metrics).filter((e): e is [string, number] => typeof e[1] === 'number' && Number.isFinite(e[1]))
  const named = typeof metrics.val_metric_name === 'string' ? metrics.val_metric_name : 'metric'
  const groups = new Map<string, ReportedValue[]>()
  for (const [key, raw] of numbers) {
    const { info: found, matched } = describeMetric(key, declared)
    const prefix = key.includes('/') ? key.slice(0, key.indexOf('/')) : ''
    const leaf = key.slice(key.lastIndexOf('/') + 1).replaceAll('_', ' ')
    const perClass = found?.label?.includes('{}') ? found.label.replace('{}', '').trim() : null
    let title: string
    let label = found?.label ?? leaf
    let format = reportedFormat(key, raw, found)
    if (key === 'val_metric') {
      if (numbers.length > 1) continue
      title = 'Validation'
      label = `validation ${named}`
      format = reportedFormat(named, raw, null)
    } else if (found?.detail) title = DETAIL_GROUP
    else if (perClass) [title, label] = [`${perClass} per class`, matched]
    else if (prefix) title = GROUP_TITLES[prefix] ?? prefix
    else title = Number.isInteger(raw) && !KNOWN[key] ? 'Settings' : 'Validation'
    if (!groups.has(title)) groups.set(title, [])
    groups.get(title)!.push({ key, label, value: format(raw), headline: Boolean(found?.headline) })
  }
  return [...groups.entries()]
    .sort(([a], [b]) => groupRank(a) - groupRank(b) || a.localeCompare(b))
    .map(([title, values]) => ({
      title,
      values: values.sort((a, b) => Number(b.headline) - Number(a.headline) || a.label.localeCompare(b.label)),
    }))
}
