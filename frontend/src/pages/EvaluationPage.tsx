import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { cancelEvaluation, getEvaluation, getEvaluationSummary, retryEvaluation } from '../api'
import type { EvalSummary, EvaluationDetail, OcrDecode } from '../api'
import { useAuth } from '../auth'
import { useSetCrumbs } from '../components/NavBar'
import { ErrorsTab } from '../components/evaluation/ErrorsTab'
import { HeadlineShort } from '../components/evaluation/Headline'
import { LinesTab } from '../components/evaluation/LinesTab'
import { LineEvaluation } from '../components/evaluation/LineEvaluation'
import { decodeName, isLayoutScores } from '../components/evaluation/score'
import { percent } from '../components/evaluation/format'
import { count } from '../components/evaluation/format'
import { Badge } from '../components/ui/Badge'
import { Button, buttonClass } from '../components/ui/Button'
import { EmptyState } from '../components/ui/EmptyState'
import { PageHeader } from '../components/ui/PageHeader'
import { Tabs, panelId, tabId } from '../components/ui/Tabs'
import { Segmented } from '../components/ui/Segmented'
import { widePageShell } from '../components/ui/page'
import { STATUS_TONE, formatDate } from '../util'

const TABS = [
  { id: 'lines', label: 'Lines' },
  { id: 'errors', label: 'Errors' },
] as const
type Tab = (typeof TABS)[number]['id']

/** Polled while the evaluation is still being scored; a finished one never changes. */
const POLL_MS = 3000

/** Keyed by the id, so moving to another evaluation starts from nothing rather than
 *  showing the last one under the new address. */
export function EvaluationPage() {
  const { id } = useParams<{ id: string }>()
  return <EvaluationView key={id} id={id} />
}

function EvaluationView({ id }: { id: string | undefined }) {
  const evalId = Number(id)
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const setCrumbs = useSetCrumbs()
  const { canEdit, isAdmin, user } = useAuth()
  const [actionError, setActionError] = useState<string | null>(null)
  const [evaluation, setEvaluation] = useState<EvaluationDetail | null>(null)
  const [summary, setSummary] = useState<EvalSummary | null>(null)
  const [missing, setMissing] = useState(!Number.isFinite(evalId))
  const tab: Tab = TABS.some((t) => t.id === params.get('tab')) ? (params.get('tab') as Tab) : 'lines'

  // A finished run's lines are imported just after it reports done, so an empty answer
  // is asked once more before it is believed.
  const [doneChecks, setDoneChecks] = useState(0)
  const settled = evaluation !== null && (evaluation.status === 'error' || evaluation.status === 'cancelled'
    || evaluation.line_rows > 0
    || doneChecks >= 2)
  useEffect(() => {
    if (!Number.isFinite(evalId)) return
    let live = true
    const load = () => getEvaluation(evalId)
      .then((ev) => {
        if (!live) return
        setEvaluation(ev)
        setMissing(false)
        if (ev.status === 'done') setDoneChecks((n) => n + 1)
      })
      .catch(() => live && setMissing(true))
    load()
    const timer = settled ? undefined : setInterval(load, POLL_MS)
    return () => {
      live = false
      if (timer) clearInterval(timer)
    }
  }, [evalId, settled])

  const lineRows = evaluation?.line_rows ?? 0
  useEffect(() => {
    setSummary(null)
    if (lineRows === 0) return
    let live = true
    getEvaluationSummary(evalId).then((s) => live && setSummary(s)).catch(() => {})
    return () => { live = false }
  }, [evalId, lineRows])

  const checkedJob = evaluation?.source.check ? evaluation.source.jobs?.[0] : undefined
  useEffect(() => {
    setCrumbs(checkedJob && evaluation ? [
      { label: evaluation.source_label ?? 'Dataset', to: `/jobs/${checkedJob}` },
      { label: 'Transcription check' },
    ] : [
      { label: 'Models', to: '/models' },
      { label: 'Evaluations', to: '/models/evaluations' },
      { label: evaluation ? [evaluation.model_name ?? 'model', evaluation.decode].filter(Boolean).join(' · ') : `Evaluation ${evalId}` },
    ])
    return () => setCrumbs([])
  }, [setCrumbs, evaluation, evalId, checkedJob])

  if (missing) {
    return (
      <div className={widePageShell}>
        <EmptyState action={<Link to="/models/evaluations" className={buttonClass()}>All evaluations</Link>}>
          There is no evaluation {id}.
        </EmptyState>
      </div>
    )
  }
  if (evaluation === null) return <div className={widePageShell} />

  const canRun = isAdmin || evaluation.owner === user
  const noun = checkedJob ? 'check' : 'evaluation'
  const countsLines = evaluation.model_task === 'lines'
  const findsBoxes = evaluation.model_task === 'layout'
  const modelLink = (
    <Link to={`/models/${evaluation.model_id}`} className="hover:text-accent-ink">
      <span data-testid="evaluation-title">{evaluation.model_name ?? `Model ${evaluation.model_id}`}</span>
    </Link>
  )
  const active = evaluation.status === 'queued' || evaluation.status === 'running'
  const act = (action: (id: number) => Promise<unknown>) => () => {
    setActionError(null)
    action(evaluation.id).then(() => getEvaluation(evaluation.id)).then(setEvaluation)
      .catch((e: Error) => setActionError(e.message))
  }

  const switchDecode = (decode: OcrDecode) => {
    const target = evaluation.decodes.find((d) => d.decode === decode)
    if (!target || target.evaluation_id === evaluation.id) return
    const keep = new URLSearchParams(params)
    keep.delete('offset')
    navigate(`/evaluations/${target.evaluation_id}?${keep}`)
  }

  return (
    <div className={widePageShell}>
      <PageHeader
        title={checkedJob ? 'Transcription check' : modelLink}
        actions={<>
          {evaluation.decode && evaluation.decodes.length > 1 && (
            <span className="flex items-center gap-2" data-testid="decode-switch">
              <span className="text-xs text-ink-subtle">Decode</span>
              <Segmented value={evaluation.decode} onChange={switchDecode}
                         options={evaluation.decodes.map((d) => ({ value: d.decode, label: d.decode }))} />
            </span>
          )}
          {canRun && active && (
            <Button variant="ghost" size="xs" data-testid="cancel-evaluation" onClick={act(cancelEvaluation)}>
              Cancel
            </Button>
          )}
          {canRun && (evaluation.status === 'error' || evaluation.status === 'cancelled') && (
            <Button variant="ghost" size="xs" data-testid="retry-evaluation" onClick={act(retryEvaluation)}>
              Retry
            </Button>
          )}
        </>}
      >
        {checkedJob
          ? <>The checked lines of <Link to={`/jobs/${checkedJob}`} className="text-accent-ink hover:underline">
              {evaluation.source_label}</Link> read with <Link to={`/models/${evaluation.model_id}`}
              data-testid="evaluation-title" className="text-accent-ink hover:underline">{evaluation.model_name}</Link></>
          : <>Scored on {evaluation.source_label}</>}
        {evaluation.training_id !== null && (
          <> for run <Link to={`/models/runs/${evaluation.training_id}`} data-testid="evaluation-run"
                         className="text-accent-ink hover:underline">{evaluation.training_name ?? evaluation.training_id}</Link></>
        )}
        {` · ${[decodeName(evaluation), formatDate(evaluation.created_at)].filter(Boolean).join(' · ')} · `}
        <Badge tone={STATUS_TONE[evaluation.status]}>{evaluation.status}</Badge>
        {evaluation.hidden_lines > 0 && (
          <span data-testid="hidden-lines" className="block text-xs text-ink-subtle">
            {count(evaluation.hidden_lines)} line{evaluation.hidden_lines === 1 ? '' : 's'} from datasets you cannot
            open are left out of every figure here.
          </span>
        )}
      </PageHeader>

      {actionError && <p role="alert" className="mb-3 text-sm text-danger">{actionError}</p>}
      {evaluation.status === 'cancelled' && (
        <EmptyState>This {noun} was cancelled before it finished; nothing it read is kept.</EmptyState>
      )}
      {evaluation.status === 'error' && (
        <EmptyState>This {noun} failed{evaluation.error ? `: ${evaluation.error}` : ''}.</EmptyState>
      )}
      {(evaluation.status === 'queued' || evaluation.status === 'running') && (
        <EmptyState>
          This {noun} is {evaluation.status}; its {countsLines || findsBoxes ? 'pages' : 'lines'} appear here when it finishes.
        </EmptyState>
      )}
      {evaluation.status === 'done' && evaluation.metrics && isLayoutScores(evaluation.metrics) && (
        <p data-testid="layout-evaluation" className="text-sm text-ink-muted">
          mAP50 {percent(evaluation.metrics.mAP_50)} · mAP50-95 {percent(evaluation.metrics.mAP_50_95)} on{' '}
          {evaluation.metrics.pages} pages and {evaluation.metrics.truth} checked boxes.
          {evaluation.training_id !== null && (
            <> Set beside its base model, page by page, on <Link to={`/models/runs/${evaluation.training_id}`}
                                                                   className="text-accent-ink hover:underline">its run</Link>.</>
          )}
        </p>
      )}
      {evaluation.status === 'done' && evaluation.metrics && !isLayoutScores(evaluation.metrics) && (
        <LineEvaluation evalId={evaluation.id} scores={evaluation.metrics} />
      )}
      {evaluation.status === 'done' && !countsLines && !findsBoxes && lineRows === 0 && (
        <EmptyState>
          {evaluation.hidden_lines > 0
            ? 'Every line of this evaluation belongs to a dataset you cannot open.'
            : 'This evaluation has no per-line records - it was scored before they were kept.'}
        </EmptyState>
      )}

      {lineRows > 0 && (
        <>
          {summary && <HeadlineShort summary={summary} />}
          <Tabs items={[...TABS]} active={tab} label="Evaluation sections" className="mb-4"
                onSelect={(next) => {
                  const kept = new URLSearchParams(params)
                  kept.set('tab', next)
                  setParams(kept, { replace: true })
                }} />
          <div role="tabpanel" id={panelId(tab)} aria-labelledby={tabId(tab)}>
            {tab === 'lines' && <LinesTab evaluation={evaluation} canEdit={canEdit} />}
            {tab === 'errors' && (summary ? <ErrorsTab summary={summary} /> : <p className="text-sm text-ink-subtle">Loading...</p>)}
          </div>
        </>
      )}
    </div>
  )
}
