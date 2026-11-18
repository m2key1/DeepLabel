import { useMemo } from 'react'
import { lineShapeLabel } from '../../api'
import type { FinalEvaluation, ProgressPoint, TestEvaluation, Training } from '../../api'
import { trainedAugmentationLabel } from '../augment/pipeline'
import { cardChrome } from '../ui/Card'
import { EmptyState } from '../ui/EmptyState'
import { Section } from '../ui/Section'
import { FinalEvaluationTable, TestEvaluationTable } from './FinalEvaluation'
import { PreflightPanel } from './PreflightReport'
import { RunMetrics } from './RunMetrics'
import { languageModelLabel } from './runStatus'
import type { ShownPreflight } from './usePreflight'

/** Every setting the run trained with, by the name the training form gives it. */
function RunSettings({ run }: { run: Training }) {
  const settings: (readonly [string, string | number])[] = [
    ['epochs', run.epochs ?? (run.default_epochs ? `${run.default_epochs} (default)` : 'default')],
    ['batch size', run.batch_size ?? 'default'],
    ...(run.grad_accum_steps ? [['gradient accumulation', run.grad_accum_steps] as const] : []),
    ...(run.lr_scale ? [['learning rates', `x ${run.lr_scale}`] as const] : []),
    ...(run.batch_fallback ? [['out of memory at', `batch ${run.batch_fallback.asked.batch_size}, `
      + `trained at ${run.batch_fallback.trained.batch_size} x ${run.batch_fallback.trained.grad_accum_steps}`] as const]
      : []),
    ...(run.resumes ? [['resumed after the time limit', `${run.resumes}x`] as const] : []),
    ['validation', `${Math.round(run.val_fraction * 100)}% · ${run.split_strategy}`],
    ['augmentation', trainedAugmentationLabel(run)],
    ...(run.line_shape ? [['line shape', lineShapeLabel(run.line_shape)] as const] : []),
    ...(run.task === 'ocr' ? [
      ['human-checked only', run.human_checked_only ? 'yes' : 'no'] as const,
      ['language model', languageModelLabel(run)] as const,
    ] : []),
    ...Object.entries(run.hyperparams).map(([k, v]) =>
      [k.replace(/_/g, ' '), typeof v === 'boolean' ? (v ? 'on' : 'off') : String(v)] as const),
  ]
  return (
    <dl data-testid="run-settings" className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-4">
      {settings.map(([label, value]) => (
        <div key={label} data-setting={label}>
          <dt className="text-ink-subtle">{label}</dt>
          <dd className="font-mono tabular-nums text-ink">{String(value)}</dd>
        </div>
      ))}
    </dl>
  )
}

/** How the run trained: every curve it reported, every setting and the tail of its log. */
export function TrainingPanel({ run, points, datasets, preflight, log }: {
  run: Training
  points: ProgressPoint[]
  datasets: Record<string, string>
  preflight: ShownPreflight | null
  log: string
}) {
  const metricInfo = run.metric_info
  const trainItems = run.snapshot_counts?.train ?? 0
  const context = useMemo(() => ({ info: metricInfo, trainItems }), [metricInfo, trainItems])
  const stepsPerEpoch = preflight?.status === 'done' ? preflight.result?.settings.steps_per_epoch ?? null : null
  const finalEvaluation = (run.metrics?.evaluation ?? null) as FinalEvaluation | null
  const testEvaluation = run.task === 'ocr' ? null : (run.metrics?.test_evaluation ?? null) as TestEvaluation | null
  return (
    <div className="space-y-2">
      <Section title="Curves" description="Everything this run reported, as it reported it.">
        <RunMetrics points={points} datasets={datasets} stepsPerEpoch={stepsPerEpoch} context={context} />
      </Section>
      {finalEvaluation && (
        <Section title="Final evaluation" description="The trained model reading the validation pages through its backend, per dataset.">
          <FinalEvaluationTable evaluation={finalEvaluation} datasets={datasets} />
        </Section>
      )}
      {testEvaluation && (
        <Section title="Test pages" description="Test pages, never trained on, read by the base model and by the new one.">
          <TestEvaluationTable evaluation={testEvaluation} datasets={datasets} />
        </Section>
      )}
      <Section title="All settings"><RunSettings run={run} /></Section>
      {log && (
        <details data-testid="run-log-section">
          <summary className="cursor-pointer text-sm text-accent-ink">Log of the run</summary>
          <pre data-testid="run-log"
               className={`mt-2 max-h-80 overflow-auto ${cardChrome} p-2 font-ocr text-[11px] leading-snug text-ink-muted`}>
            {log}
          </pre>
        </details>
      )}
    </div>
  )
}

/** What the material looked like when the run was submitted. */
export function DataPanel({ run, preflight }: { run: Training; preflight: ShownPreflight | null }) {
  if (run.preflight_id === null) {
    return <EmptyState>This run was started without a pre-flight, so there is no record of its material.</EmptyState>
  }
  return (
    <Section title="Pre-flight" description={run.task === 'ocr'
      ? 'What the material looked like when the run was submitted: the split, the crops and the characters it was cut from.'
      : 'What the material looked like when the run was submitted: the split and the pages it was cut from.'}>
      <PreflightPanel preflight={preflight} pending={false} />
    </Section>
  )
}
