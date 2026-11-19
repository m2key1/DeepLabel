import type { PreflightResult, ProgressPoint, Training } from '../../api'

export interface Check {
  id: 'error' | 'best-early' | 'stalled' | 'memory' | 'restarts' | 'preflight' | 'likely-errors'
  tone: 'danger' | 'warn' | 'info'
  text: string
  /** The tab that shows it, and the lines filter where that is the Lines tab. */
  show?: { tab: 'training' | 'data' | 'lines'; label: string }
  /** The best epoch of a running run, which it can still be stopped at and keep. */
  keep?: number
}

// A running run whose validation has not improved for this many epochs is past its best: the
// patience early stopping uses by default (decision 313).
export const STALLED_AFTER = 10

// A run whose best epoch came this early and that ended this much worse kept training long
// after it had learned what it could.
const WORSE_BY = 0.1

/** The headline curve: CER for an OCR run, else the metric its trainer marked headline. */
function headlineCurve(run: Training, points: ProgressPoint[]): { epoch: number; value: number }[] {
  const metric = run.task === 'ocr' ? { key: 'cer', lower: true }
    : (() => {
      const headline = run.metric_info?.find((m) => m.headline)
      return headline ? { key: headline.key, lower: headline.better === 'lower' } : null
    })()
  if (!metric) return []
  return points.flatMap((p) => {
    const value = (p as unknown as Record<string, unknown>)[metric.key]
    if (typeof value !== 'number' || p.epoch === undefined) return []
    return [{ epoch: p.epoch, value: metric.lower ? value : -value }]
  })
}

/** What a reader should know about how a run went, only where something happened. */
export function runChecks({ run, points, preflight, likelyErrors }: {
  run: Training
  points: ProgressPoint[]
  preflight: PreflightResult | null
  /** Lines on the material shown that read nothing like their truth, with how many it has. */
  likelyErrors: { count: number; of: number; material: string } | null
}): Check[] {
  const checks: Check[] = []
  if (run.status === 'error') {
    checks.push({ id: 'error', tone: 'danger', text: run.error ? `Failed: ${run.error}` : 'Failed' })
  }

  const curve = headlineCurve(run, points)
  if (curve.length > 1) {
    const best = curve.reduce((b, p) => (p.value < b.value ? p : b))
    const last = curve[curve.length - 1]
    if (run.status === 'running' && last.epoch - best.epoch >= STALLED_AFTER) {
      checks.push({ id: 'stalled', tone: 'warn', text: `Validation has not improved since epoch ${best.epoch}`,
                    show: { tab: 'training', label: 'See the curve' }, keep: best.epoch })
    } else if (best.epoch <= last.epoch / 2 && last.value - best.value > WORSE_BY * Math.abs(best.value)) {
      checks.push({ id: 'best-early', tone: 'warn', text: `Best after epoch ${best.epoch} of ${last.epoch}, worse after`,
                    show: { tab: 'training', label: 'See the curve' } })
    }
  }

  if (run.batch_fallback) {
    const { asked, trained } = run.batch_fallback
    checks.push({ id: 'memory', tone: 'warn',
                  text: `Ran out of GPU memory at batch ${asked.batch_size}; trained at ${trained.batch_size} × ${trained.grad_accum_steps}` })
  }
  if (run.resumes > 0) {
    checks.push({ id: 'restarts', tone: 'info',
                  text: `Resumed ${run.resumes === 1 ? 'once' : `${run.resumes} times`} after the cluster's time limit` })
  }

  const warnings = preflight?.findings.filter((f) => f.level === 'warn').length ?? 0
  if (warnings > 0) {
    checks.push({ id: 'preflight', tone: 'warn',
                  text: `${warnings} pre-flight warning${warnings === 1 ? '' : 's'} about the material`,
                  show: { tab: 'data', label: 'See the pre-flight' } })
  }

  if (likelyErrors && likelyErrors.count > 0) {
    const share = likelyErrors.of ? ` (${((likelyErrors.count / likelyErrors.of) * 100).toFixed(1)} %)` : ''
    checks.push({ id: 'likely-errors', tone: 'warn',
                  text: `${likelyErrors.count.toLocaleString()} lines${share} of the ${likelyErrors.material} read nothing like their truth: likely transcription errors`,
                  show: { tab: 'lines', label: 'Show them' } })
  }
  return checks
}
