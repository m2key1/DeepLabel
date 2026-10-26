import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'

import {
  cancelTraining, deleteTraining, getTrainingPreflight, lineShapeLabel, listEvaluations, listTrainings,
  retryTraining, trainingProgress,
} from '../api'
import type { Evaluation, FinalEvaluation, OcrDecode, ProgressPoint, TestEvaluation, Training } from '../api'
import { useAuth } from '../auth'
import { useSetCrumbs } from '../components/NavBar'
import { FinalEvaluationTable, TestEvaluationTable } from '../components/models/FinalEvaluation'
import { RunMetrics } from '../components/models/RunMetrics'
import { describeMetric, headlineKeys } from '../components/models/metrics'
import { PreflightPanel } from '../components/models/PreflightReport'
import { pollPreflight, type ShownPreflight } from '../components/models/usePreflight'
import { isFinished, languageModelLabel } from '../components/models/runStatus'
import { percent } from '../components/evaluation/format'
import { trainedAugmentationLabel } from '../components/augment/pipeline'
import { Badge } from '../components/ui/Badge'
import type { Tone } from '../components/ui/Badge'
import { Button, buttonClass } from '../components/ui/Button'
import { EmptyState } from '../components/ui/EmptyState'
import { Section } from '../components/ui/Section'
import { StatRow, StatTile } from '../components/ui/StatTile'
import { Tabs, panelId, tabId } from '../components/ui/Tabs'
import { widePageShell } from '../components/ui/page'
import { formatDate, formatRelative } from '../util'
import { useAutoClear } from '../messages'
import { usePolling } from '../hooks/usePolling'
import { cardChrome } from '../components/ui/Card'

const STATUS_TONE: Record<Training['status'], Tone> = {
  queued: 'neutral',
  preparing: 'accent',
  running: 'accent',
  done: 'ok',
  error: 'danger',
  cancelled: 'warn',
}

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'curves', label: 'Curves' },
  { id: 'data', label: 'Data' },
  { id: 'evaluations', label: 'Evaluations' },
  { id: 'settings', label: 'Settings' },
] as const
type RunTab = typeof TABS[number]['id']

/** Every decode is scored because they disagree; the pair a run is read by is the default
 *  beam decode (the backend's DEFAULT_DECODE), never whichever was written last. */
const HEADLINE_DECODE: OcrDecode = 'beam'

/** How long the run has been going, from its own timestamps rather than the clock. */
function elapsed(points: ProgressPoint[]): number | null {
  const stamps = points.map((p) => p.ts).filter((t): t is number => typeof t === 'number')
  return stamps.length > 1 ? Math.max(...stamps) - Math.min(...stamps) : null
}

function duration(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.round((seconds % 3600) / 60)
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

/** One run, in as much detail as it reported.
 *
 *  A page rather than a panel that unfolds inside the list: a run is read for minutes,
 *  compared against its own history, and linked to from elsewhere - all of which want an
 *  address. */
export function TrainingRunPage() {
  const { id } = useParams<{ id: string }>()
  const runId = Number(id)
  const { user, canEdit, isAdmin } = useAuth()
  const navigate = useNavigate()
  const setCrumbs = useSetCrumbs()
  const [params, setParams] = useSearchParams()
  const asked = params.get('tab')
  const tab: RunTab = TABS.find((t) => t.id === asked)?.id ?? 'overview'

  const [run, setRun] = useState<Training | null>(null)
  // `/models/runs/nonsense` is as gone as a deleted run, and has to say so rather than
  // waiting for a request it will never make.
  const [missing, setMissing] = useState(!Number.isFinite(runId))
  const [evaluations, setEvaluations] = useState<Evaluation[]>([])
  const [points, setPoints] = useState<ProgressPoint[]>([])
  const [log, setLog] = useState('')
  const [datasets, setDatasets] = useState<Record<string, string>>({})
  const [preflight, setPreflight] = useState<ShownPreflight | null>(null)
  const [error, setError] = useState<string | null>(null)
  useAutoClear(error, setError)

  const refresh = useCallback(() => {
    listTrainings()
      .then((r) => {
        const found = r.trainings.find((t) => t.id === runId) ?? null
        setRun(found)
        setMissing(found === null)
      })
      .catch((e: Error) => setError(e.message))
    listEvaluations().then((r) => setEvaluations(r.evaluations)).catch(() => {})
    trainingProgress(runId)
      .then((r) => {
        setPoints(r.points)
        setLog(r.log_tail)
        setDatasets(r.datasets)
      })
      .catch(() => {})
  }, [runId])

  useEffect(() => {
    if (!Number.isFinite(runId)) setMissing(true)
  }, [runId])

  const forRun = useMemo(
    () => evaluations.filter((e) => e.training_id === runId), [evaluations, runId])
  // A finished run has nothing more to say once the scores it queued are in, so it is
  // read once rather than every five seconds for as long as the tab is open.
  const settled = run !== null && isFinished(run.status)
    && !forRun.some((e) => e.status === 'queued' || e.status === 'running')
  usePolling(refresh, 5000, Number.isFinite(runId) && !settled)

  // Computed at submit when the form had none for these settings, so it may still be
  // running when the page opens. A failed look is tried again: the run keeps its review
  // whether or not one request for it got through.
  const preflightId = run?.preflight_id ?? null
  useEffect(() => {
    setPreflight(null)
    if (preflightId === null) return
    return pollPreflight(() => getTrainingPreflight(runId), setPreflight, 2000, { retry: true })
  }, [runId, preflightId])

  useEffect(() => {
    setCrumbs([{ label: 'Models', to: '/models?tab=runs' }, { label: run?.name ?? `Run ${runId}` }])
    return () => setCrumbs([])
  }, [setCrumbs, run?.name, runId])

  const metricInfo = run?.metric_info ?? null
  const trainItems = run?.snapshot_counts?.train ?? 0
  const metricContext = useMemo(() => ({ info: metricInfo, trainItems }), [metricInfo, trainItems])

  const mine = run !== null && canEdit && (isAdmin || run.owner === user)

  const scored = (modelId: number | null, onJobs: boolean) =>
    forRun.find((e) => e.model_id === modelId && e.status === 'done' && e.decode === HEADLINE_DECODE &&
      (onJobs ? e.source.jobs !== undefined : e.source.snapshot !== undefined)) ?? null
  const modelRole = (modelId: number) =>
    modelId === run?.model_id ? 'new' : modelId === run?.base_model_id ? 'base' : `model ${modelId}`

  if (missing) {
    return (
      <div className={widePageShell}>
        <EmptyState action={<Link to="/models" className={buttonClass()}>Back to models</Link>}>
          There is no training run {id}. It may have been deleted with its snapshot.
        </EmptyState>
      </div>
    )
  }
  if (!run) return <div className={widePageShell}><p className="text-sm text-ink-subtle">Loading…</p></div>

  const last = points[points.length - 1]
  // The best epoch is the checkpoint that gets registered, so the figure is worth
  // nothing without saying which epoch it came from.
  const bestPoint = points.reduce<ProgressPoint | null>(
    (b, p) => (typeof p.cer === 'number' && (b === null || p.cer < b.cer!) ? p : b), null)
  const best = bestPoint?.cer ?? null
  const bestEpoch = bestPoint?.epoch ?? null
  const baseline = scored(run.base_model_id, false)?.cer ?? null
  const seconds = elapsed(points)
  const trainLines = run.snapshot_counts?.train ?? 0
  const validLines = run.snapshot_counts?.val ?? 0

  const stepsPerEpoch = preflight?.status === 'done' ? preflight.result?.settings.steps_per_epoch ?? null : null
  const scoreTiles = ([
    ['score-valid-base', 'valid · base', scored(run.base_model_id, false)],
    ['score-valid-new', 'valid · new', scored(run.model_id, false)],
    ['score-test-base', 'test · base', scored(run.base_model_id, true)],
    ['score-test-new', 'test · new', scored(run.model_id, true)],
  ] as const).map(([testid, label, ev]) => ev === null || ev.cer === null ? null : (
    <StatTile key={testid} data-testid={testid} label={label} note={HEADLINE_DECODE}
              value={<Link to={`/evaluations/${ev.id}`} className="hover:text-accent-ink">{percent(ev.cer)}</Link>} />
  ))
  const logSection = log && (
    <Section title="Log" description={`The tail of the run's own output${points.length ? ` · last point ${formatRelative(new Date((points[points.length - 1].ts ?? 0) * 1000).toISOString())}` : ''}`}>
      <pre data-testid="run-log"
           className={`max-h-80 overflow-auto ${cardChrome} p-2 font-ocr text-[11px] leading-snug text-ink-muted`}>
        {log}
      </pre>
    </Section>
  )

  // A page task is read by its declared headline; OCR keeps its CER tiles and evaluations.
  const headline = run.task === 'ocr' ? null : metricInfo?.find((m) => m.headline) ?? null
  const headlineValues = headline
    ? points.flatMap((p) => {
      const value = (p as unknown as Record<string, unknown>)[headline.key]
      return typeof value === 'number' ? [{ epoch: p.epoch ?? null, value }] : []
    })
    : []
  const bestHeadline = headlineValues.reduce<{ epoch: number | null; value: number } | null>(
    (b, v) => (b === null || (headline?.better === 'lower' ? v.value < b.value : v.value > b.value) ? v : b), null)
  const showHeadline = (value: number) =>
    headline?.unit === 'fraction' ? percent(value) : value.toFixed(4).replace(/\.?0+$/, '')
  const lossKey = headlineKeys(metricInfo)[1] ?? 'loss'
  const lastLoss = last ? (last as unknown as Record<string, unknown>)[lossKey] : undefined
  const itemsLabel = run.task === 'ocr' ? 'lines' : 'pages'
  const finalEvaluation = (run.metrics?.evaluation ?? null) as FinalEvaluation | null
  const testEvaluation = (run.metrics?.test_evaluation ?? null) as TestEvaluation | null
  const headlineLabel = headline ? describeMetric(headline.key, metricInfo ?? []).info?.label ?? headline.key : null

  const panels: Record<RunTab, ReactNode> = {
    overview: (
      <>
        <StatRow className="mb-6">
          {headline && (
            <StatTile data-testid="headline-tile" label={`best ${headlineLabel}`}
                      value={bestHeadline ? showHeadline(bestHeadline.value) : '-'}
                      note={bestHeadline?.epoch ? `epoch ${bestHeadline.epoch}` : undefined} />
          )}
          <StatTile label="last loss"
                    value={typeof lastLoss === 'number' ? lastLoss.toFixed(4).replace(/\.?0+$/, '') : '-'} />
          <StatTile label={`${itemsLabel} trained`}
                    value={trainLines ? trainLines.toLocaleString() : '-'}
                    note={run.snapshot_counts ? `${validLines.toLocaleString()} validation` : undefined}
                    title={`The ${itemsLabel} the run trained on, and the validation ${itemsLabel} it was scored on`} />
          <StatTile label="batch" value={run.batch_size ?? 'default'} />
          {run.status === 'preparing' && run.snapshot_progress && (
            <StatTile
              label="snapshot"
              value={`${run.snapshot_progress.done.toLocaleString()} / ${run.snapshot_progress.total.toLocaleString()}`}
              title="Lines cut so far"
            />
          )}
          {scoreTiles}
        </StatRow>
        {finalEvaluation && (
          <Section title="Final evaluation"
                   description="The trained model reading the validation pages through its backend, per dataset.">
            <FinalEvaluationTable evaluation={finalEvaluation} datasets={datasets} />
          </Section>
        )}
        {testEvaluation && (
          <Section title="Test pages"
                   description="Test pages, never trained on, read once the run was trained by the base model and by the new one.">
            <TestEvaluationTable evaluation={testEvaluation} datasets={datasets} />
          </Section>
        )}
        <Section title="Headline curves"
                 description={`${headline ? `${headlineLabel} and loss` : 'CER and loss'}; every metric the run reported is under Curves.`}>
          <RunMetrics points={points} datasets={datasets} stepsPerEpoch={stepsPerEpoch} only={headlineKeys(metricInfo)}
                      context={metricContext} />
        </Section>
        {logSection}
      </>
    ),
    curves: (
      <Section title="Curves" description="Everything this run reported, as it reported it.">
        <RunMetrics points={points} datasets={datasets} stepsPerEpoch={stepsPerEpoch} context={metricContext} />
      </Section>
    ),
    data: preflightId === null ? (
      <EmptyState>This run was started without a pre-flight, so there is no record of its material.</EmptyState>
    ) : (
      <Section title="Pre-flight" description={run.task === 'ocr'
        ? 'What the material looked like when the run was submitted: the split, the crops and the characters it was cut from.'
        : 'What the material looked like when the run was submitted: the split and the pages it was cut from.'}>
        <PreflightPanel preflight={preflight} pending={false} />
      </Section>
    ),
    evaluations: (
      <Section title="Scores" description="The valid split is cut from the training snapshot; a test set is material the run never saw. Each tile is the default beam decode; every decode is listed below it. A score appears once it exists - there is nothing to show for a base model a run never had.">
        {forRun.length === 0 ? (
          <EmptyState>No evaluations yet. The run queues its own once it has finished.</EmptyState>
        ) : (
          <>
            <StatRow>{scoreTiles}</StatRow>
            <ul className="mt-3 divide-y divide-line/60 text-xs" data-testid="run-evaluations">
              {forRun.map((ev) => (
                <li key={ev.id}>
                  <Link to={`/evaluations/${ev.id}`} data-testid="run-evaluation"
                        className="flex items-center gap-3 px-1 py-1.5 text-ink-muted hover:bg-raised hover:text-accent-ink">
                    <span className="w-20">{modelRole(ev.model_id)}</span>
                    <span className="w-12">{ev.source.snapshot !== undefined ? 'valid' : 'test'}</span>
                    <span className="w-20">{ev.decode}</span>
                    <span className="font-mono tabular-nums text-ink">
                      {ev.status === 'done' && ev.cer !== null ? percent(ev.cer) : ev.status}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </Section>
    ),
    settings: (
      <Section title="Settings">
        <dl data-testid="run-settings" className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-4">
          {[
            ['epochs', run.epochs ?? 'default'],
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
              [k.replace(/_/g, ' '), typeof v === 'boolean' ? (v ? 'on' : 'off') : v] as const),
          ].map(([label, value]) => (
            <div key={String(label)} data-setting={label}>
              <dt className="text-ink-subtle">{label}</dt>
              <dd className="font-mono tabular-nums text-ink">{String(value)}</dd>
            </div>
          ))}
        </dl>
      </Section>
    ),
  }

  return (
    <div className={widePageShell}>
      <header className="sticky top-0 z-20 -mx-4 -mt-6 mb-4 bg-ground px-4 pt-4">
        <div className="flex flex-wrap items-center gap-2">
          <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${
            run.status === 'running' ? 'animate-pulse bg-accent'
              : run.status === 'error' ? 'bg-danger'
              : run.status === 'done' ? 'bg-ok' : 'bg-line-strong'}`} />
          <h1 className="font-serif text-xl font-semibold">{run.name}</h1>
          <Badge tone="neutral">{run.task}</Badge>
          <Badge tone={STATUS_TONE[run.status]} data-testid="run-status">{run.status}</Badge>
          {run.phase && <span className="text-xs text-ink-subtle">{run.phase}</span>}
          <dl className="ml-4 flex items-baseline gap-4 text-xs">
            <div data-testid="stat-best-cer" title={baseline === null ? undefined : `The model it started from scored ${percent(baseline)}`}
                 className="flex items-baseline gap-1">
              <dt className="text-ink-subtle">best cer</dt>
              <dd className="font-mono text-sm font-medium tabular-nums text-ink">{percent(best)}</dd>
              {bestEpoch !== null && <dd className="text-ink-subtle">e{bestEpoch}</dd>}
              {best !== null && baseline !== null && (
                <dd className={`font-mono tabular-nums ${best < baseline ? 'text-ok' : 'text-warn'}`}>
                  {best < baseline ? '▾' : '▴'}{percent(Math.abs(best - baseline))}
                </dd>
              )}
            </div>
            <div className="flex items-baseline gap-1">
              <dt className="text-ink-subtle">epoch</dt>
              <dd data-testid="stat-epoch" className="font-mono text-sm font-medium tabular-nums text-ink">
                {last?.epoch !== undefined ? `${last.epoch}${run.epochs ? ` / ${run.epochs}` : ''}` : '-'}
              </dd>
            </div>
            <div className="flex items-baseline gap-1">
              <dt className="text-ink-subtle">duration</dt>
              <dd data-testid="stat-duration" className="font-mono text-sm font-medium tabular-nums text-ink">
                {seconds === null ? '-' : duration(seconds)}
              </dd>
            </div>
          </dl>
          <span className="ml-auto flex items-center gap-1">
            {isFinished(run.status) && canEdit && (
              <Link
                to={`/models/train?task=${run.task}&from=${run.id}`}
                className={buttonClass({ variant: 'ghost', size: 'xs' })}
                data-testid="rerun-training"
                title="Open the training form on this run's settings"
              >
                Rerun…
              </Link>
            )}
            {!isFinished(run.status) && mine && (
              <Button variant="ghost" size="xs"
                      onClick={() => cancelTraining(run.id).then(refresh).catch((e: Error) => setError(e.message))}>
                Cancel
              </Button>
            )}
            {run.status === 'error' && mine && (
              <Button variant="ghost" size="xs" data-testid="retry-training"
                      onClick={() => retryTraining(run.id).then(refresh).catch((e: Error) => setError(e.message))}>
                Retry
              </Button>
            )}
            {isFinished(run.status) && mine && (
              <Button variant="ghost" size="xs" className="text-danger hover:text-danger"
                      onClick={() => {
                        if (!window.confirm(`Delete training "${run.name}" and free its snapshot and checkpoint?`)) return
                        deleteTraining(run.id)
                          .then(() => navigate('/models?tab=runs'))
                          .catch((e: Error) => setError(e.message))
                      }}>
                Delete
              </Button>
            )}
          </span>
        </div>
        <p className="mt-1 text-xs text-ink-subtle">
          {run.target === 'slurm' ? 'cluster' : 'local'}
          {run.gpu_type && ` · ${run.gpu_type}${run.gpu_count && run.gpu_count > 1 ? ` ×${run.gpu_count}` : ''}`}
          {' · '}{run.owner === user ? 'you' : run.owner}
          {' · started '}{formatDate(run.created_at)}
        </p>
        {run.description && <p className="mt-1 max-w-3xl text-sm text-ink-muted">{run.description}</p>}
        {run.error && <p data-testid="run-error" className="mt-2 text-sm text-danger">{run.error}</p>}
        {error && <p className="mt-2 text-sm text-danger">{error}</p>}
        <Tabs items={[...TABS]} active={tab} label="Run sections" className="mt-3"
              onSelect={(id) => setParams((p) => { p.set('tab', id); return p })} />
      </header>

      <div role="tabpanel" id={panelId(tab)} aria-labelledby={tabId(tab)}>
        {panels[tab]}
      </div>
    </div>
  )
}
