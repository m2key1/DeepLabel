import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { Evaluation, Preflight, ProgressPoint, RegistryModel, Training } from '../../api'
import { trainedAugmentationLabel } from '../augment/pipeline'
import { percent } from '../evaluation/format'
import { ScoreChange } from '../evaluation/ScoreChange'
import { cardChrome } from '../ui/Card'
import { tableCell, tableHeadRow, tableRow } from '../ui/Table'
import { headlineScore } from './families'
import type { Check } from './runChecks'
import { bestEpoch, duration, materialOf, runSeconds } from './runFacts'

const heading = 'mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-muted'

function Block({ title, action, children, testid }: {
  title: string; action?: ReactNode; children: ReactNode; testid: string
}) {
  return (
    <section data-testid={testid} aria-label={title}>
      <div className="flex items-baseline gap-3">
        <h2 className={heading}>{title}</h2>
        {action}
      </div>
      {children}
    </section>
  )
}

/** The model against the one it was trained from, on every material its run scored: one
 *  number per cell, in the mode Automatic reads with, each opening its lines. */
export function ScoresTable({ model, base, run, evaluations, materialName }: {
  model: RegistryModel
  base: RegistryModel | null
  run: Training | null
  evaluations: Evaluation[]
  materialName: (key: string) => string
}) {
  const done = evaluations.filter((ev) => ev.status === 'done' && ev.cer !== null
    && (run ? ev.training_id === run.id : ev.model_id === model.id))
  const materials = [...new Set(done.filter((ev) => ev.model_id === model.id).map(materialOf))]
    .sort((a, b) => (a === 'valid' ? -1 : b === 'valid' ? 1 : a.localeCompare(b)))
  if (materials.length === 0) return null
  const rows = [{ role: 'new', model }, ...(base && run ? [{ role: 'base', model: base }] : [])]
  const scoreOf = (modelId: number, material: string) =>
    headlineScore(done.filter((ev) => ev.model_id === modelId && materialOf(ev) === material))
  // A test set spanning several datasets is shown per dataset too, from its breakdown.
  const columns = materials.flatMap((material) => {
    const jobs = material === 'valid' ? [] : material.split('+')
    return [...(jobs.length > 1 ? jobs.map((job) => ({ key: job, material, job, label: materialName(job) })) : []),
            { key: material, material, job: null as string | null,
              label: jobs.length > 1 ? 'All test pages' : materialName(material) }]
  })
  const valueOf = (modelId: number, column: (typeof columns)[number]) => {
    const ev = scoreOf(modelId, column.material)
    if (!ev) return null
    const cer = column.job ? ev.breakdown?.find((row) => row.job_id === column.job)?.cer : ev.cer!
    return cer === undefined ? null : { cer, to: `?tab=lines&eval=${ev.id}${column.job ? `&job=${column.job}` : ''}` }
  }
  return (
    <Block testid="model-scores" title="Scores"
           action={<span className="text-xs text-ink-subtle">character error rate in Automatic decoding, lower is better</span>}>
      <div className={`${cardChrome} overflow-x-auto`}>
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className={tableHeadRow}>
              <th className="px-3 py-2 font-semibold">Model</th>
              {columns.map((c) => <th key={c.key} className="px-3 py-2 text-right font-semibold">{c.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ role, model: row }) => (
              <tr key={role} data-testid="score-row" data-role={role} className={tableRow}>
                <td className={`${tableCell} px-3`}>
                  {role === 'new' ? <span className="font-medium">{row.name}</span>
                    : <><Link to={`/models/${row.id}`} className="text-ink-muted hover:text-accent-ink">{row.name}</Link>
                        <span className="ml-2 text-xs text-ink-subtle">base</span></>}
                </td>
                {columns.map((c) => {
                  const shown = valueOf(row.id, c)
                  const against = role === 'new' && base && run ? valueOf(base.id, c) : null
                  const change = shown && against ? shown.cer - against.cer : null
                  return (
                    <td key={c.key} data-material={c.key} className={`${tableCell} px-3 text-right font-mono text-xs tabular-nums`}>
                      {shown ? <Link to={shown.to} className="hover:text-accent-ink">{percent(shown.cer)}</Link>
                        : <span className="font-sans text-ink-subtle">not run</span>}
                      <ScoreChange change={change} />
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Block>
  )
}

/** Every dataset the run drew on, with what it gave to each split. */
export function TrainedOn({ run, preflight, evaluationFor }: {
  run: Training
  preflight: Preflight | null
  /** The model's evaluation of a split, whose lines a count opens. */
  evaluationFor: (split: 'val' | 'test') => Evaluation | undefined
}) {
  const result = preflight?.status === 'done' ? preflight.result : null
  const names = preflight?.datasets ?? {}
  const unit = result?.unit ?? (run.task === 'ocr' ? 'lines' : 'pages')
  const ids = [...new Set([...run.dataset_job_ids, ...run.valid_job_ids, ...run.test_job_ids])]
  const counted = new Map(result?.split.datasets.map((d) => [d.job_id, d]) ?? [])
  const cell = (jobId: string, split: 'train' | 'val' | 'test') => {
    const items = counted.get(jobId)?.[split].items
    if (items === undefined) return <span className="text-ink-subtle">-</span>
    if (items === 0) return <span className="text-ink-subtle">-</span>
    const ev = split === 'train' ? undefined : evaluationFor(split)
    return ev ? <Link to={`?tab=lines&eval=${ev.id}&job=${jobId}`} className="hover:text-accent-ink">{items.toLocaleString()}</Link>
      : items.toLocaleString()
  }
  return (
    <Block testid="trained-on" title="Trained on">
      <div className={`${cardChrome} overflow-x-auto`}>
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className={tableHeadRow}>
              <th className="px-3 py-2 font-semibold">Dataset</th>
              <th className="px-3 py-2 text-right font-semibold">Pages</th>
              <th className="px-3 py-2 text-right font-semibold">Training {unit}</th>
              <th className="px-3 py-2 text-right font-semibold">Validation {unit}</th>
              <th className="px-3 py-2 text-right font-semibold">Test {unit}</th>
            </tr>
          </thead>
          <tbody>
            {ids.map((jobId) => {
              const counts = counted.get(jobId)
              const pages = counts ? counts.train.pages + counts.val.pages + counts.test.pages : null
              return (
                <tr key={jobId} data-testid="trained-on-row" data-job={jobId} className={tableRow}>
                  <td className={`${tableCell} px-3`}>
                    <Link to={`/jobs/${jobId}`} className="text-accent-ink hover:underline">{names[jobId] ?? jobId}</Link>
                  </td>
                  <td className={`${tableCell} px-3 text-right font-mono text-xs tabular-nums`}>{pages?.toLocaleString() ?? '-'}</td>
                  {(['train', 'val', 'test'] as const).map((split) => (
                    <td key={split} data-column={split} className={`${tableCell} px-3 text-right font-mono text-xs tabular-nums`}>
                      {cell(jobId, split)}
                    </td>
                  ))}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Block>
  )
}

function gpuLabel(run: Training): string {
  if (run.target === 'local') return 'Local GPU'
  return `Cluster · ${run.gpu_count ?? 1} × ${run.gpu_type ?? 'GPU'}`
}

/** The run in a handful of facts; every setting is on the Training tab. */
export function TrainingFacts({ run, points, onAllSettings }: {
  run: Training
  points: ProgressPoint[]
  onAllSettings: () => void
}) {
  const seconds = runSeconds(run, points)
  const kept = bestEpoch(points)
  const perStep = (run.batch_size ?? 0) * (run.grad_accum_steps ?? 1) * (run.target === 'slurm' ? run.gpu_count ?? 1 : 1)
  const parts = [run.batch_size, run.grad_accum_steps && run.grad_accum_steps > 1 ? run.grad_accum_steps : null,
                 run.target === 'slurm' && (run.gpu_count ?? 1) > 1 ? `${run.gpu_count} GPUs` : null].filter(Boolean)
  const patience = run.hyperparams.patience
  const learningRate = run.hyperparams.learning_rate
  const finished = run.status === 'done' || run.status === 'error' || run.status === 'cancelled'
  const facts: [string, string, string][] = [
    ['took', finished ? 'Took' : 'Running for', seconds === null ? '-' : duration(seconds)],
    ['ran-on', 'Ran on', gpuLabel(run)],
    ['epochs', 'Epochs', run.epochs ? String(run.epochs)
      : run.default_epochs ? `${run.default_epochs} (model default)` : 'model default'],
    ['kept', finished ? 'Kept' : 'Best so far', kept === null ? '-' : `Epoch ${kept}`],
    ['lines-per-step', `${run.task === 'ocr' ? 'Lines' : 'Pages'} per step`,
     perStep ? `${perStep.toLocaleString()}${parts.length > 1 ? ` (${parts.join(' × ')})` : ''}` : 'model default'],
    ['learning-rate', 'Learning rate', `${learningRate ?? 'model default'}${run.lr_scale ? ` × ${run.lr_scale} for its GPUs` : ''}`],
    ['augmentation', 'Augmentation', trainedAugmentationLabel(run)],
    ['early-stopping', 'Early stopping', patience ? `after ${patience} epochs without gain` : 'off'],
  ]
  return (
    <Block testid="training-summary" title="Training"
           action={<button type="button" onClick={onAllSettings} className="text-xs text-accent-ink hover:underline">All settings and curves</button>}>
      <dl data-testid="training-facts" className={`${cardChrome} grid grid-cols-2 gap-x-6 gap-y-3 p-4 sm:grid-cols-4`}>
        {facts.map(([key, label, value]) => (
          <div key={key} data-fact={key}>
            <dt className="text-xs text-ink-muted">{label}</dt>
            <dd className="text-sm text-ink">{value}</dd>
          </div>
        ))}
      </dl>
    </Block>
  )
}

const TONE_CLASS: Record<Check['tone'], string> = {
  danger: 'bg-danger/15 text-danger',
  warn: 'bg-warn/15 text-warn',
  info: 'bg-raised text-ink-muted',
}
const TONE_LABEL: Record<Check['tone'], string> = { danger: 'FAILED', warn: 'CHECK', info: 'NOTE' }

/** Only what happened: one line per check that fired, each with where to look. */
export function HowItWent({ checks, finished, onShow }: {
  checks: Check[]
  finished: boolean
  onShow: (check: Check) => void
}) {
  return (
    <Block testid="how-it-went" title="How it went">
      <ul className={`${cardChrome} divide-y divide-line`}>
        {checks.length === 0 && (
          <li data-testid="run-check-ok" className="flex items-center gap-3 px-4 py-3 text-sm text-ink-muted">
            <span className="rounded bg-ok/15 px-2 py-0.5 text-[11px] font-semibold text-ok">OK</span>
            {finished ? 'No problems found' : 'Nothing to report so far'}
          </li>
        )}
        {checks.map((check) => (
          <li key={check.id} data-testid="run-check" data-check={check.id}
              className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
            <span className={`rounded px-2 py-0.5 text-[11px] font-semibold ${TONE_CLASS[check.tone]}`}>{TONE_LABEL[check.tone]}</span>
            <span className="min-w-0 flex-1">{check.text}</span>
            {check.show && (
              <button type="button" onClick={() => onShow(check)} className="text-xs text-accent-ink hover:underline">
                {check.show.label}
              </button>
            )}
          </li>
        ))}
      </ul>
    </Block>
  )
}
