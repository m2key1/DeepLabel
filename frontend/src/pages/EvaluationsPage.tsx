import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { listEvaluations, listJobs, listModels, listTrainings } from '../api'
import type { Evaluation, RegistryModel, Training } from '../api'
import { useSetCrumbs } from '../components/NavBar'
import { percent } from '../components/evaluation/format'
import { ScoreChange } from '../components/evaluation/ScoreChange'
import { scoreGrid } from '../components/evaluation/scoreGrid'
import type { GridColumn } from '../components/evaluation/scoreGrid'
import { buildFamilies } from '../components/models/families'
import { Badge } from '../components/ui/Badge'
import { buttonClass } from '../components/ui/Button'
import { cardChrome } from '../components/ui/Card'
import { EmptyState } from '../components/ui/EmptyState'
import { Input } from '../components/ui/Field'
import { PageHeader } from '../components/ui/PageHeader'
import { tableCell, tableHeadRow, tableRow } from '../components/ui/Table'
import { pageShell } from '../components/ui/page'

const SHOWN_DATASETS = 6

function ColumnHead({ column, name }: { column: GridColumn; name: string }) {
  return (
    <th className="px-3 py-2 text-right align-bottom font-semibold">
      {column.job === null ? "Its run's validation lines" : name}
      {column.allPages && <span className="block font-normal normal-case tracking-normal">all pages</span>}
    </th>
  )
}

/** Every evaluated model against everything it was scored on: one row per model, grouped
 *  by family, one score per cell. */
export function EvaluationsPage() {
  const setCrumbs = useSetCrumbs()
  useEffect(() => {
    setCrumbs([{ label: 'Models', to: '/models' }, { label: 'Evaluations' }])
    return () => setCrumbs([])
  }, [setCrumbs])
  const [models, setModels] = useState<RegistryModel[] | null>(null)
  const [trainings, setTrainings] = useState<Training[]>([])
  const [evaluations, setEvaluations] = useState<Evaluation[]>([])
  const [jobNames, setJobNames] = useState<Map<string, string>>(new Map())
  const [error, setError] = useState<string | null>(null)
  const [allDatasets, setAllDatasets] = useState(false)
  const [params, setParams] = useSearchParams()
  const query = params.get('q') ?? ''
  const showArchived = params.has('archived')

  useEffect(() => {
    Promise.all([listModels(true), listTrainings(), listEvaluations()])
      .then(([m, t, e]) => {
        setTrainings(t.trainings)
        setEvaluations(e.evaluations)
        setModels(m.models)
      })
      .catch((e: Error) => setError(e.message))
    listJobs().then((jobs) => setJobNames(new Map(jobs.map((j) => [j.id, j.name])))).catch(() => {})
  }, [])

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params)
    if (value === null) next.delete(key)
    else next.set(key, value)
    setParams(next, { replace: true })
  }

  const grid = useMemo(() => scoreGrid(trainings, evaluations), [trainings, evaluations])
  const families = useMemo(() => {
    const ocr = (models ?? []).filter((m) => m.task === 'ocr')
    return buildFamilies(ocr, trainings, evaluations).sort((a, b) => Number(b.holdsDefault) - Number(a.holdsDefault))
  }, [models, trainings, evaluations])

  const needle = query.trim().toLowerCase()
  const groups = families.map((family) => ({
    family,
    rows: family.versions.flatMap((v) => (v.model ? [v.model] : [])).filter((m) => grid.isScored(m)
      && (showArchived || !m.archived) && m.name.toLowerCase().includes(needle)),
  })).filter((g) => g.rows.length > 0)
  // A family of one would only repeat its model's name, so those share one group at the end.
  const multiModel = groups.filter((g) => g.rows.length > 1)
  const loners = groups.filter((g) => g.rows.length === 1).flatMap((g) => g.rows)
  const sections = [
    ...multiModel.map((g) => ({ key: String(g.family.root.id), title: g.family.name as string | null, rows: g.rows })),
    ...(loners.length > 0 ? [{ key: 'others', title: multiModel.length > 0 ? 'Other models' : null, rows: loners }] : []),
  ]
  const columns = grid.columns(groups.flatMap((g) => g.rows))
  const datasetCount = columns.filter((c) => c.job !== null).length
  const shown = allDatasets ? columns : columns.slice(0, SHOWN_DATASETS + (columns[0]?.job === null ? 1 : 0))
  // A dataset only some datasets' scores name - one the viewer cannot open - keeps its breakdown name.
  const breakdownNames = useMemo(() => new Map(evaluations.flatMap((ev) =>
    (ev.breakdown ?? []).map((row) => [row.job_id, row.name] as const))), [evaluations])
  const nameOf = (job: string | null) =>
    (job && (jobNames.get(job) ?? breakdownNames.get(job))) || 'another dataset'
  const anyScored = families.some((f) => f.versions.some((v) => v.model && grid.isScored(v.model)))

  return (
    <div className={pageShell}>
      <PageHeader title="Evaluations">
        Character error rate in Automatic decoding, lower is better, with the change against the
        model each was trained from.
      </PageHeader>
      {error && <p className="mb-2 text-sm text-danger">{error}</p>}
      {models !== null && !anyScored ? (
        <EmptyState action={<Link to="/models" className={buttonClass()}>Models</Link>}>
          No model has been evaluated yet.
        </EmptyState>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
            <Input type="search" aria-label="Search models" placeholder="Search models" value={query}
                   onChange={(e) => setParam('q', e.target.value || null)} className="w-60" />
            <label className="flex cursor-pointer items-center gap-1.5 text-xs text-ink-muted">
              <input type="checkbox" checked={showArchived} className="cursor-pointer accent-accent"
                     onChange={(e) => setParam('archived', e.target.checked ? '' : null)} />
              Show archived
            </label>
            {datasetCount > SHOWN_DATASETS && (
              <button type="button" onClick={() => setAllDatasets(!allDatasets)}
                      className="text-xs text-accent-ink hover:underline">
                {allDatasets ? `Show the ${SHOWN_DATASETS} most scored test sets` : `Show all ${datasetCount} test sets`}
              </button>
            )}
          </div>
          {models !== null && groups.length === 0 ? (
            <p className="text-sm text-ink-subtle">No evaluated model matches.</p>
          ) : (
            <div className={`${cardChrome} overflow-x-auto`}>
              <table className="w-full border-collapse text-sm">
                <caption className="sr-only">Evaluations</caption>
                <thead>
                  <tr className={tableHeadRow}>
                    <th className="px-3 py-2 align-bottom font-semibold">Model</th>
                    {shown.map((c) => <ColumnHead key={c.key} column={c} name={nameOf(c.job)} />)}
                  </tr>
                </thead>
                {sections.map(({ key, title, rows }) => (
                  <tbody key={key}>
                    {title && (
                      <tr>
                        <th colSpan={shown.length + 1} scope="rowgroup"
                            className="bg-ground px-3 py-1.5 text-left text-xs font-semibold text-ink-muted">
                          {title}
                        </th>
                      </tr>
                    )}
                    {rows.map((model) => (
                      <tr key={model.id} data-testid="eval-model-row" data-model={model.id} className={tableRow}>
                        <td className={`${tableCell} whitespace-nowrap px-3`}>
                          <Link to={`/models/${model.id}`} className="font-medium hover:text-accent-ink">{model.name}</Link>
                          {model.is_default && <Badge tone="accent" className="ml-2">default</Badge>}
                          {model.archived && <span className="ml-2 text-xs text-ink-subtle">archived</span>}
                        </td>
                        {shown.map((column) => {
                          const cell = grid.cell(model, column.key)
                          return (
                            <td key={column.key} data-material={column.key}
                                className={`${tableCell} whitespace-nowrap px-3 text-right font-mono text-xs tabular-nums`}>
                              {cell ? <>
                                <Link to={cell.to} className="hover:text-accent-ink">{percent(cell.cer)}</Link>
                                <ScoreChange change={cell.change} />
                              </> : <span className="text-ink-subtle">-</span>}
                            </td>
                          )
                        })}
                      </tr>
                    ))}
                  </tbody>
                ))}
              </table>
            </div>
          )}
        </>
      )}
    </div>
  )
}
