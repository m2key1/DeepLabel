import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, Navigate, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import {
  cancelEvaluation, cancelTraining, deleteTraining, finishTraining, getLayoutTemplates, getModelUsage, getTrainingPreflight,
  listConventionFlags, listEvaluationLines, listEvaluations, listModels, listTrainings, patchModel, retryEvaluation,
  retryTraining, trainingProgress,
} from '../api'
import type {
  ConventionFlag, Evaluation, LayoutTemplate, ModelUsage, ProgressPoint, RegistryModel, Training,
} from '../api'
import { useAuth } from '../auth'
import { useSetCrumbs } from '../components/NavBar'
import { LIKELY_TRANSCRIPTION_ERROR } from '../components/evaluation/lineFilter'
import { percent } from '../components/evaluation/format'
import { EditModelDialog } from '../components/models/EditModelDialog'
import { scoreOf } from '../components/evaluation/score'
import { EvaluateDialog } from '../components/models/EvaluateDialog'
import { EvaluationTabs } from '../components/models/EvaluationTabs'
import { ModelDetails } from '../components/models/ModelDetails'
import { DataPanel, TrainingPanel } from '../components/models/RunPanels'
import { HowItWent, ScoresTable, TrainedOn, TrainingFacts } from '../components/models/RunSections'
import { LayoutComparison } from '../components/models/LayoutComparison'
import { bestOn, duration, headlineMetric, keptMetric, materialOf, runSeconds } from '../components/models/runFacts'
import { SOURCE_LABELS, buildFamilies, headlineScore } from '../components/models/families'
import { runChecks } from '../components/models/runChecks'
import { epochTotal, isFinished } from '../components/models/runStatus'
import { pollPreflight, type ShownPreflight } from '../components/models/usePreflight'
import { Badge } from '../components/ui/Badge'
import type { Tone } from '../components/ui/Badge'
import { Button, buttonClass } from '../components/ui/Button'
import { EmptyState } from '../components/ui/EmptyState'
import { Tabs, panelId, tabId } from '../components/ui/Tabs'
import { widePageShell } from '../components/ui/page'
import { usePolling } from '../hooks/usePolling'
import { useAutoClear } from '../messages'
import { formatDate } from '../util'

const STAGE: Record<string, string> = { layout: 'Layout detection', lines: 'Line segmentation', ocr: 'OCR' }

const STATUS_TONE: Record<Training['status'], Tone> = {
  queued: 'neutral', preparing: 'accent', running: 'accent', done: 'ok', error: 'danger', cancelled: 'warn',
}

const TAB_LABELS = { lines: 'Lines', errors: 'Errors', training: 'Training', data: 'Data', details: 'Details' } as const
type PageTab = keyof typeof TAB_LABELS
// The run page's tabs, so a link from before the two pages were one still lands.
const OLD_TABS: Record<string, PageTab> = { overview: 'training', curves: 'training', settings: 'training', evaluations: 'lines' }

/** What the page is read from: the registry, the runs and the evaluations, kept fresh while
 *  anything on it is still moving. */
function usePageData(modelId: number | null) {
  const [models, setModels] = useState<RegistryModel[] | null>(null)
  const [trainings, setTrainings] = useState<Training[] | null>(null)
  const [evaluations, setEvaluations] = useState<Evaluation[]>([])
  const [error, setError] = useState<string | null>(null)
  const refresh = useCallback(() => {
    listModels(true).then((r) => setModels(r.models)).catch((e: Error) => setError(e.message))
    listTrainings().then((r) => setTrainings(r.trainings)).catch((e: Error) => setError(e.message))
    listEvaluations().then((r) => setEvaluations(r.evaluations)).catch(() => {})
  }, [])
  const moving = (trainings ?? []).some((t) => !isFinished(t.status) && (modelId === null || t.model_id === modelId))
    || evaluations.some((ev) => ev.status === 'queued' || ev.status === 'running')
  usePolling(refresh, moving ? 5000 : 30000)
  return { models, trainings, evaluations, error, setError, refresh }
}

/** A run's own record: what it was cut from, its progress and its log. */
function useRunData(run: Training | null) {
  const [preflight, setPreflight] = useState<ShownPreflight | null>(null)
  const [points, setPoints] = useState<ProgressPoint[]>([])
  const [log, setLog] = useState('')
  const [datasets, setDatasets] = useState<Record<string, string>>({})
  const [canFinish, setCanFinish] = useState(false)
  const runId = run?.id ?? null
  const preflightId = run?.preflight_id ?? null
  const finished = run ? isFinished(run.status) : true
  const read = useCallback(() => {
    if (runId === null) return
    trainingProgress(runId).then((r) => {
      setPoints(r.points)
      setLog(r.log_tail)
      setDatasets(r.datasets)
      setCanFinish(r.can_finish)
    }).catch(() => {})
  }, [runId])
  useEffect(read, [read])
  usePolling(read, 5000, runId !== null && !finished)
  useEffect(() => {
    setPreflight(null)
    if (runId === null || preflightId === null) return
    return pollPreflight(() => getTrainingPreflight(runId), setPreflight, 2000, { retry: true })
  }, [runId, preflightId])
  return { preflight, points, log, datasets, canFinish: canFinish && !finished }
}

/** A model in the registry, with the run that made it when it was trained here. */
export function ModelPage() {
  const modelId = Number(useParams().id)
  const data = usePageData(modelId)
  const model = data.models?.find((m) => m.id === modelId) ?? null
  if (data.models === null || data.trainings === null) return <div className={widePageShell}><p className="text-sm text-ink-muted">Loading…</p></div>
  if (!model) return <div className={widePageShell}><p className="text-sm text-ink-muted">No model #{modelId}.</p></div>
  const run = data.trainings.find((t) => t.model_id === model.id) ?? null
  return <ModelView model={model} run={run} {...data} models={data.models} trainings={data.trainings} />
}

/** A run: the page of the model it made once there is one, else the same page without it. */
export function RunPage() {
  const runId = Number(useParams().id)
  const { search } = useLocation()
  const data = usePageData(null)
  const run = data.trainings?.find((t) => t.id === runId) ?? null
  if (!Number.isFinite(runId) || (data.trainings !== null && run === null)) {
    return (
      <div className={widePageShell}>
        <EmptyState action={<Link to="/models" className={buttonClass()}>Back to models</Link>}>
          There is no training run {Number.isFinite(runId) ? runId : ''}. It may have been deleted with its snapshot.
        </EmptyState>
      </div>
    )
  }
  if (data.models === null || data.trainings === null || run === null) return <div className={widePageShell} />
  if (run.model_id !== null && data.models.some((m) => m.id === run.model_id)) {
    return <Navigate to={`/models/${run.model_id}${search}`} replace />
  }
  return <ModelView model={null} run={run} {...data} models={data.models} trainings={data.trainings} />
}

function ModelView({ model, run, models, trainings, evaluations, error, setError, refresh }: {
  model: RegistryModel | null
  run: Training | null
  models: RegistryModel[]
  trainings: Training[]
  evaluations: Evaluation[]
  error: string | null
  setError: (message: string | null) => void
  refresh: () => void
}) {
  const { user, canEdit, isAdmin, can } = useAuth()
  const navigate = useNavigate()
  const setCrumbs = useSetCrumbs()
  const [params, setParams] = useSearchParams()
  const tabsRef = useRef<HTMLDivElement>(null)
  const [usage, setUsage] = useState<ModelUsage | null>(null)
  const [templates, setTemplates] = useState<LayoutTemplate[]>([])
  const [catalog, setCatalog] = useState<ConventionFlag[] | null>(null)
  const [editing, setEditing] = useState(false)
  const [evaluating, setEvaluating] = useState(false)
  const [likely, setLikely] = useState<number | null>(null)
  useAutoClear(error, setError)
  const { preflight, points, log, datasets, canFinish } = useRunData(run)
  const modelId = model?.id ?? null

  useEffect(() => {
    if (modelId === null) return
    getModelUsage(modelId).then(setUsage).catch(() => {})
    getLayoutTemplates().then(setTemplates).catch(() => {})
    listConventionFlags().then((r) => setCatalog(r.flags)).catch(() => {})
  }, [modelId])

  const title = model?.name ?? run?.name ?? ''
  useEffect(() => {
    setCrumbs([{ label: 'Models', to: '/models' }, { label: title }])
    return () => setCrumbs([])
  }, [setCrumbs, title])

  const base = run?.base_model_id != null ? models.find((m) => m.id === run.base_model_id) ?? null
    : model?.trained_from != null ? models.find((m) => m.id === model.trained_from) ?? null : null
  const ofModel = useMemo(() => (model ? evaluations.filter((ev) => ev.model_id === model.id) : []), [evaluations, model])
  const scored = ofModel.filter((ev) => ev.status === 'done' && scoreOf(ev) !== null)
  const shownFirst = (run && headlineScore(scored.filter((ev) => ev.training_id === run.id && ev.source.jobs !== undefined)))
    ?? (run && headlineScore(scored.filter((ev) => ev.source.snapshot === run.id)))
    ?? headlineScore(scored)
  const shownFirstId = model?.task === 'ocr' ? shownFirst?.id ?? null : null

  useEffect(() => {
    setLikely(null)
    if (shownFirstId === null) return
    let live = true
    listEvaluationLines(shownFirstId, { ...LIKELY_TRANSCRIPTION_ERROR, sort: 'cer', order: 'desc', offset: 0, limit: 1 })
      .then((r) => live && setLikely(r.total)).catch(() => {})
    return () => { live = false }
  }, [shownFirstId])

  const names: Record<string, string> = { ...datasets, ...(preflight?.datasets ?? {}) }
  const materialName = (key: string) => (key === 'valid' ? 'Validation lines'
    : key.split('+').map((id) => names[id] ?? scored.find((ev) => materialOf(ev) === key)?.source_label ?? id).join(', '))
  const checks = run ? runChecks({
    run, points, preflight: preflight?.status === 'done' ? preflight.result : null,
    likelyErrors: shownFirst && likely !== null
      ? { count: likely, of: shownFirst.line_count ?? 0, material: materialOf(shownFirst) === 'valid' ? 'validation lines' : 'test pages' }
      : null,
  }) : []

  const items = ([
    ...(model?.task === 'ocr' && scored.length > 0 ? ['lines', 'errors'] as const : []),
    ...(run ? ['training', 'data'] as const : []),
    ...(model ? ['details'] as const : []),
  ] as PageTab[]).map((id) => ({ id, label: TAB_LABELS[id] }))
  const asked = params.get('tab') ?? ''
  const tab: PageTab = items.find((t) => t.id === (OLD_TABS[asked] ?? asked))?.id ?? items[0]?.id ?? 'details'
  const show = (next: PageTab, extra: Record<string, string> = {}) => {
    setParams(new URLSearchParams({ tab: next, ...extra }), { replace: true })
    tabsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  // A link to a tab lands on the tab, not on the overview above it.
  const landedOnTab = useRef(params.has('tab'))
  useEffect(() => {
    if (landedOnTab.current) tabsRef.current?.scrollIntoView({ block: 'start' })
    landedOnTab.current = false
  }, [])

  const finished = run ? isFinished(run.status) : true
  const mine = run !== null && canEdit && (isAdmin || run.owner === user)
  const kept = run ? bestOn(points, keptMetric(run.metric_info))?.epoch ?? null : null
  const keepBest = () => run && finishTraining(run.id).then(refresh).catch((e: Error) => setError(e.message))
  const managesModels = can('models.manage')
  const ownsModel = model !== null && model.owner === user
  const family = model ? buildFamilies(models.filter((m) => m.task === model.task), trainings, evaluations)
    .find((f) => f.versions.some((v) => v.key === `m${model.id}`)) ?? null : null
  const version = family?.versions.find((v) => v.key === `m${model!.id}`) ?? null
  const apply = (body: { is_default?: boolean; archived?: boolean }) =>
    model && patchModel(model.id, body).then(refresh).catch((e: Error) => setError(e.message))

  return (
    <div className={widePageShell}>
      <header className="mb-8">
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="flex flex-wrap items-center gap-2 font-serif text-2xl font-semibold">
              {title}
              {model?.is_default && <Badge tone="accent">★ DEFAULT</Badge>}
              {model?.archived && <Badge>ARCHIVED</Badge>}
              {!model && run && <Badge tone={STATUS_TONE[run.status]} data-testid="run-status">{run.status}</Badge>}
              {!model && run?.phase && <span className="text-xs font-normal text-ink-subtle">{run.phase}</span>}
            </h1>
            <p className="mt-1 text-sm text-ink-muted">
              {STAGE[(model ?? run)!.task]}
              {base ? <> · fine-tuned from <Link to={`/models/${base.id}`} className="text-accent-ink hover:underline">{base.name}</Link></>
                : model && <> · {SOURCE_LABELS[model.source]}</>}
              {family && <> · {family.name} family</>}
              {' · '}{formatDate((model ?? run)!.created_at)}
              {(model?.owner ?? run?.owner) && (
                <span data-testid="model-owner"> · {(model?.owner ?? run?.owner) === user ? 'you' : (model?.owner ?? run?.owner)}</span>
              )}
            </p>
            {(model?.notes ?? run?.description) && (
              <p data-testid="model-notes" className="mt-2 max-w-3xl text-sm text-ink">{model?.notes ?? run?.description}</p>
            )}
            {!model && run && (points.length > 0 || run.error) && <RunProgress run={run} points={points} />}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {model && can('recognize') && model.task === 'ocr' && !model.archived && (
              <Link to={`/try?ocr=${model.id}`} className={buttonClass({ size: 'xs' })}>Try this model</Link>
            )}
            {model && canEdit && (model.task === 'ocr' || model.task === 'lines') && !model.archived && (
              <Button size="xs" onClick={() => setEvaluating(true)}>Evaluate…</Button>
            )}
            {model && managesModels && !model.is_default && !model.archived && (
              <Button size="xs" onClick={() => apply({ is_default: true })}>Set default</Button>
            )}
            {model && (managesModels || ownsModel) && <Button size="xs" onClick={() => setEditing(true)}>Edit</Button>}
            {model && (managesModels || ownsModel) && !model.is_default && (
              <Button size="xs" data-testid="archive-model" onClick={() => apply({ archived: !model.archived })}>
                {model.archived ? 'Unarchive' : 'Archive'}
              </Button>
            )}
            {run && finished && canEdit && (
              <Link to={`/models/train?task=${run.task}&from=${run.id}`} data-testid="rerun-training"
                    className={buttonClass({ size: 'xs' })} title="Open the training form on this run's settings">Rerun…</Link>
            )}
            {run && !model && canFinish && kept !== null && run.phase !== 'finishing' && (
              <Button size="xs" data-testid="finish-training" onClick={keepBest}
                      title="End the run now as finished, with this epoch's weights as its model">
                Stop and keep epoch {kept}
              </Button>
            )}
            {run && !model && !finished && mine && (
              <Button size="xs" onClick={() => cancelTraining(run.id).then(refresh).catch((e: Error) => setError(e.message))}>Cancel</Button>
            )}
            {run && !model && run.status === 'error' && mine && (
              <Button size="xs" data-testid="retry-training"
                      onClick={() => retryTraining(run.id).then(refresh).catch((e: Error) => setError(e.message))}>Retry</Button>
            )}
            {run && !model && finished && mine && (
              <Button size="xs" variant="danger" onClick={() => {
                if (!window.confirm(`Delete training "${run.name}" and free its snapshot?`)) return
                deleteTraining(run.id).then(() => navigate('/models?tab=runs')).catch((e: Error) => setError(e.message))
              }}>Delete</Button>
            )}
          </div>
        </div>
        {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
      </header>

      <div className="mb-10 space-y-8">
        {model && model.task === 'layout' && run ? (
          <LayoutComparison run={run} model={model} base={base} evaluations={evaluations} canCompare={mine}
                            onChange={refresh} onError={setError} />
        ) : model && <ScoresTable model={model} base={base} run={run} evaluations={evaluations} materialName={materialName} />}
        {run && (
          <TrainedOn run={run} preflight={preflight}
                     evaluationFor={(split) => headlineScore(scored.filter((ev) => ev.training_id === run.id
                       && ev.source.split === undefined
                       && (split === 'val' ? ev.source.snapshot !== undefined : ev.source.jobs !== undefined)))} />
        )}
        {run && <TrainingFacts run={run} points={points} onAllSettings={() => show('training')} />}
        {run && (
          <HowItWent checks={checks} finished={finished}
                     onKeep={canFinish && run.phase !== 'finishing' ? keepBest : undefined}
                     onShow={(check) => check.show?.tab === 'lines' && shownFirstId !== null
                       ? show('lines', { eval: String(shownFirstId), cer_min: String(LIKELY_TRANSCRIPTION_ERROR.cer_min),
                                         conf_min: String(LIKELY_TRANSCRIPTION_ERROR.conf_min) })
                       : check.show && show(check.show.tab)} />
        )}
      </div>

      {items.length > 0 && (
        <div ref={tabsRef} className="scroll-mt-4">
          <Tabs items={items} active={tab} label="Model sections" className="mb-4"
                onSelect={(next) => setParams(new URLSearchParams({ tab: next }), { replace: true })} />
          <div role="tabpanel" id={panelId(tab)} aria-labelledby={tabId(tab)}>
            {(tab === 'lines' || tab === 'errors') && shownFirstId !== null && (
              <EvaluationTabs tab={tab} evaluations={scored} shownFirst={shownFirstId} materialName={materialName}
                              canSend={canEdit} />
            )}
            {tab === 'training' && run && <TrainingPanel run={run} points={points} datasets={datasets} preflight={preflight} log={log} />}
            {tab === 'data' && run && <DataPanel run={run} preflight={preflight} />}
            {tab === 'details' && model && family && version && (
              <ModelDetails model={model} models={models} family={family} version={version} run={run}
                            evaluations={ofModel} usage={usage} templates={templates} catalog={catalog}
                            canRun={(ev) => isAdmin || ev.owner === user}
                            onRetry={(ev) => retryEvaluation(ev.id).then(refresh).catch((e: Error) => setError(e.message))}
                            onCancel={(ev) => cancelEvaluation(ev.id).then(refresh).catch((e: Error) => setError(e.message))} />
            )}
          </div>
        </div>
      )}

      {model && evaluating && <EvaluateDialog model={model} onClose={() => setEvaluating(false)} onStarted={refresh} />}
      {model && editing && family && (
        <EditModelDialog model={model} onClose={() => setEditing(false)} onSaved={refresh} onError={setError}
                         familyName={managesModels && family.root.id === model.id ? model.family_name ?? '' : undefined}
                         models={managesModels ? models : undefined} />
      )}
    </div>
  )
}

/** Where a run without a model stands: its best so far on its headline, its epoch and how long it has run. */
function RunProgress({ run, points }: { run: Training; points: ProgressPoint[] }) {
  const last = points[points.length - 1]
  const headline = headlineMetric(run.metric_info)
  const best = bestOn(points, headline)
  const seconds = runSeconds(run, points)
  return (
    <dl className="mt-3 flex flex-wrap items-baseline gap-5 text-xs">
      <div data-testid="stat-best" className="flex items-baseline gap-1 whitespace-nowrap">
        <dt className="text-ink-subtle">best {headline.label}</dt>
        <dd className="font-mono text-sm font-medium tabular-nums text-ink">{percent(best?.value ?? null)}</dd>
        {best && <dd className="text-ink-subtle">e{best.epoch}</dd>}
      </div>
      <div className="flex items-baseline gap-1">
        <dt className="text-ink-subtle">epoch</dt>
        <dd data-testid="stat-epoch" className="font-mono text-sm font-medium tabular-nums text-ink">
          {last?.epoch !== undefined ? `${last.epoch}${epochTotal(run) ? ` / ${epochTotal(run)}` : ''}` : '-'}
        </dd>
      </div>
      <div className="flex items-baseline gap-1">
        <dt className="text-ink-subtle">duration</dt>
        <dd data-testid="stat-duration" className="font-mono text-sm font-medium tabular-nums text-ink">
          {seconds === null ? '-' : duration(seconds)}
        </dd>
      </div>
      {run.error && <dd data-testid="run-error" className="basis-full text-sm text-danger">{run.error}</dd>}
    </dl>
  )
}
