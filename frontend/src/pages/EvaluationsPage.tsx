import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { listEvaluations, listModels } from '../api'
import type { Evaluation } from '../api'
import { useSetCrumbs } from '../components/NavBar'
import { percent } from '../components/evaluation/format'
import { EvaluationRulers } from '../components/evaluation/EvaluationRulers'
import { Segmented } from '../components/ui/Segmented'
import { Badge } from '../components/ui/Badge'
import { buttonClass } from '../components/ui/Button'
import { EmptyState } from '../components/ui/EmptyState'
import { PageHeader } from '../components/ui/PageHeader'
import { Table } from '../components/ui/Table'
import { pageShell } from '../components/ui/page'
import { STATUS_TONE, formatDate } from '../util'

/** Every evaluation, newest first, each opening its own page. */
export function EvaluationsPage() {
  const setCrumbs = useSetCrumbs()
  useEffect(() => {
    setCrumbs([{ label: 'Models', to: '/models' }, { label: 'Evaluations' }])
    return () => setCrumbs([])
  }, [setCrumbs])
  const navigate = useNavigate()
  const [evaluations, setEvaluations] = useState<Evaluation[] | null>(null)
  const [modelNames, setModelNames] = useState<Map<number, string>>(new Map())
  const [error, setError] = useState<string | null>(null)
  const [params, setParams] = useSearchParams()
  const view = params.get('view') === 'table' ? 'table' : 'rulers'

  useEffect(() => {
    listEvaluations().then((r) => setEvaluations(r.evaluations)).catch((e: Error) => setError(e.message))
    listModels(true).then((r) => setModelNames(new Map(r.models.map((m) => [m.id, m.name])))).catch(() => {})
  }, [])

  return (
    <div className={pageShell}>
      <PageHeader title="Evaluations" actions={<Link to="/models" className={buttonClass()}>Models</Link>}>
        Every model scored on a training's split or on datasets' checked lines, one ruler per thing
        scored on. Click a dot for its scores; each evaluation opens a page with its lines,
        confusions, characters and calibration.
      </PageHeader>
      <Segmented className="mb-3 w-fit" value={view}
                 onChange={(next) => setParams(next === 'table' ? { view: 'table' } : {}, { replace: true })}
                 options={[{ value: 'rulers', label: 'Rulers' }, { value: 'table', label: 'Table' }]} />
      {error && <p className="mb-2 text-sm text-danger">{error}</p>}
      {evaluations !== null && evaluations.length === 0 ? (
        <EmptyState action={<Link to="/models" className={buttonClass()}>Models</Link>}>
          No model has been evaluated yet.
        </EmptyState>
      ) : view === 'rulers' ? (
        <EvaluationRulers evaluations={evaluations ?? []} modelNames={modelNames} />
      ) : (
        <div className="overflow-x-auto">
          <Table
            caption="Evaluations"
            rows={evaluations ?? []}
            rowKey={(ev) => ev.id}
            rowProps={(ev) => ({
              'data-testid': 'evaluation-row',
              className: 'cursor-pointer',
              onClick: () => navigate(`/evaluations/${ev.id}`),
            })}
            columns={[
              { key: 'model', label: 'Model', cell: (ev) => (
                <Link to={`/evaluations/${ev.id}`} data-testid="evaluation-open" className="font-medium hover:text-accent-ink"
                      onClick={(e) => e.stopPropagation()}>
                  {modelNames.get(ev.model_id) ?? `model ${ev.model_id}`}
                </Link>) },
              { key: 'source', label: 'Scored on', cell: (ev) => <span className="text-ink-muted">{ev.source_label}</span> },
              { key: 'decode', label: 'Decode', cell: (ev) => ev.decode },
              { key: 'cer', label: 'CER', align: 'right', cell: (ev) => <span className="font-mono tabular-nums">{percent(ev.cer)}</span> },
              { key: 'wer', label: 'WER', align: 'right', cell: (ev) => <span className="font-mono tabular-nums">{percent(ev.wer)}</span> },
              { key: 'lines', label: 'Lines', align: 'right', cell: (ev) => ev.line_count ?? '-' },
              { key: 'status', label: 'Status', cell: (ev) => <Badge tone={STATUS_TONE[ev.status]}>{ev.status}</Badge> },
              { key: 'created', label: 'Created', cell: (ev) => <span className="text-xs text-ink-subtle">{formatDate(ev.created_at)}</span> },
            ]}
          />
        </div>
      )}
    </div>
  )
}
