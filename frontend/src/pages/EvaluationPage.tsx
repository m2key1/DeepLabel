import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { getEvaluation, getEvaluationSummary } from '../api'
import type { EvalSummary, EvaluationDetail, OcrDecode } from '../api'
import { useAuth } from '../auth'
import { useSetCrumbs } from '../components/NavBar'
import { CharactersTab } from '../components/evaluation/CharactersTab'
import { ConfusionsTab } from '../components/evaluation/ConfusionsTab'
import { ContextTab } from '../components/evaluation/ContextTab'
import { Headline } from '../components/evaluation/Headline'
import { LinesTab } from '../components/evaluation/LinesTab'
import { count } from '../components/evaluation/format'
import { Badge } from '../components/ui/Badge'
import { buttonClass } from '../components/ui/Button'
import { EmptyState } from '../components/ui/EmptyState'
import { PageHeader } from '../components/ui/PageHeader'
import { SectionNav } from '../components/ui/SectionNav'
import { Segmented } from '../components/ui/Segmented'
import { widePageShell } from '../components/ui/page'
import { STATUS_TONE, formatDate } from '../util'

const TABS = [
  { id: 'lines', label: 'Lines' },
  { id: 'confusions', label: 'Confusions' },
  { id: 'characters', label: 'Characters' },
  { id: 'context', label: 'Context and calibration' },
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
  const { canEdit } = useAuth()
  const [evaluation, setEvaluation] = useState<EvaluationDetail | null>(null)
  const [summary, setSummary] = useState<EvalSummary | null>(null)
  const [missing, setMissing] = useState(!Number.isFinite(evalId))
  const tab: Tab = TABS.some((t) => t.id === params.get('tab')) ? (params.get('tab') as Tab) : 'lines'

  // A finished run's lines are imported just after it reports done, so an empty answer
  // is asked once more before it is believed.
  const [doneChecks, setDoneChecks] = useState(0)
  const settled = evaluation !== null && (evaluation.status === 'error' || evaluation.line_rows > 0
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

  useEffect(() => {
    setCrumbs([
      { label: 'Models', to: '/models' },
      { label: 'Evaluations', to: '/models/evaluations' },
      { label: evaluation ? `${evaluation.model_name ?? 'model'} · ${evaluation.decode}` : `Evaluation ${evalId}` },
    ])
    return () => setCrumbs([])
  }, [setCrumbs, evaluation, evalId])

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
        title={<span data-testid="evaluation-title">{evaluation.model_name ?? `Model ${evaluation.model_id}`}</span>}
        actions={evaluation.decodes.length > 1 && (
          <span className="flex items-center gap-2" data-testid="decode-switch">
            <span className="text-xs text-ink-subtle">Decode</span>
            <Segmented value={evaluation.decode} onChange={switchDecode}
                       options={evaluation.decodes.map((d) => ({ value: d.decode, label: d.decode }))} />
          </span>
        )}
      >
        Scored on {evaluation.source_label}
        {evaluation.training_id !== null && (
          <> for run <Link to={`/models/runs/${evaluation.training_id}`} data-testid="evaluation-run"
                         className="text-accent-ink hover:underline">{evaluation.training_name ?? evaluation.training_id}</Link></>
        )}
        {` · ${evaluation.decode} decode · ${formatDate(evaluation.created_at)} · `}
        <Badge tone={STATUS_TONE[evaluation.status]}>{evaluation.status}</Badge>
        {evaluation.hidden_lines > 0 && (
          <span data-testid="hidden-lines" className="block text-xs text-ink-subtle">
            {count(evaluation.hidden_lines)} line{evaluation.hidden_lines === 1 ? '' : 's'} from datasets you cannot
            open are left out of every figure here.
          </span>
        )}
      </PageHeader>

      {evaluation.status === 'error' && (
        <EmptyState>This evaluation failed{evaluation.error ? `: ${evaluation.error}` : ''}.</EmptyState>
      )}
      {(evaluation.status === 'queued' || evaluation.status === 'running') && (
        <EmptyState>This evaluation is {evaluation.status}; its lines appear here when it finishes.</EmptyState>
      )}
      {evaluation.status === 'done' && lineRows === 0 && (
        <EmptyState>
          {evaluation.hidden_lines > 0
            ? 'Every line of this evaluation belongs to a dataset you cannot open.'
            : 'This evaluation has no per-line records - it was scored before they were kept.'}
        </EmptyState>
      )}

      {lineRows > 0 && (
        <>
          {summary && <Headline summary={summary} />}
          <div className="flex flex-col gap-4 md:flex-row">
            <SectionNav label="Evaluation tabs" active={tab} items={[...TABS]}
                        onSelect={(next) => {
                          const kept = new URLSearchParams(params)
                          kept.set('tab', next)
                          setParams(kept, { replace: true })
                        }} />
            <div className="min-w-0 flex-1">
              {tab === 'lines' && <LinesTab evaluation={evaluation} canSend={canEdit} />}
              {tab !== 'lines' && !summary && <p className="text-sm text-ink-subtle">Loading...</p>}
              {tab === 'confusions' && summary && <ConfusionsTab summary={summary} />}
              {tab === 'characters' && summary && <CharactersTab summary={summary} />}
              {tab === 'context' && summary && <ContextTab summary={summary} />}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
