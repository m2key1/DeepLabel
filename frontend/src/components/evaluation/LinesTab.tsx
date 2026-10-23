import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { listEvaluationLines, sendEvaluationToReview } from '../../api'
import type { EvalLine, EvalLineSort, EvaluationDetail } from '../../api'
import { Button } from '../ui/Button'
import { EmptyState } from '../ui/EmptyState'
import { Input, Select } from '../ui/Field'
import { Segmented } from '../ui/Segmented'
import { tableCell, tableHeadRow, tableRow } from '../ui/Table'
import { LineDiff } from './LineDiff'
import { count, editorLink, percent } from './format'
import { fractionToPercent, percentToFraction, readFilter } from './lineFilter'

const PAGE_SIZE = 50
const SORTS: { value: EvalLineSort; label: string }[] = [
  { value: 'cer', label: 'CER' },
  { value: 'confidence', label: 'Confidence' },
  { value: 'length', label: 'Length' },
]

type ReviewResult = Awaited<ReturnType<typeof sendEvaluationToReview>>

export function LinesTab({ evaluation, canSend }: { evaluation: EvaluationDetail; canSend: boolean }) {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const filter = readFilter(params)
  const sort = (params.get('sort') as EvalLineSort | null) ?? 'cer'
  const order = params.get('order') === 'asc' ? 'asc' : 'desc'
  const offset = Number(params.get('offset')) || 0
  const [result, setResult] = useState<{ total: number; lines: EvalLine[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState({
    min: fractionToPercent(filter.cer_min),
    max: fractionToPercent(filter.cer_max),
    q: filter.q ?? '',
  })
  const [sent, setSent] = useState<ReviewResult | null>(null)
  const [sending, setSending] = useState(false)
  const key = params.toString()

  useEffect(() => {
    let live = true
    setError(null)
    listEvaluationLines(evaluation.id, { ...filter, sort, order, offset, limit: PAGE_SIZE })
      .then((r) => live && setResult(r))
      .catch((e: Error) => {
        if (!live) return
        setResult(null)
        setError(e.message)
      })
    return () => { live = false }
    // The URL is the whole of the query; every value above is read from it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [evaluation.id, key])

  const update = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params)
    for (const [name, value] of Object.entries(changes)) {
      if (value === null || value === '') next.delete(name)
      else next.set(name, value)
    }
    if (!('offset' in changes)) next.delete('offset')
    setSent(null)
    setParams(next, { replace: true })
  }

  const applyDraft = (e: React.FormEvent) => {
    e.preventDefault()
    update({ cer_min: percentToFraction(draft.min), cer_max: percentToFraction(draft.max), q: draft.q.trim() || null })
  }

  const send = async () => {
    setSending(true)
    setError(null)
    try {
      setSent(await sendEvaluationToReview(evaluation.id, readFilter(params)))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSending(false)
    }
  }

  const total = result?.total ?? 0
  return (
    <div data-testid="lines-tab">
      <form onSubmit={applyDraft} className="mb-2 flex flex-wrap items-end gap-2" data-testid="lines-filter">
        <label className="text-xs text-ink-muted">
          CER from
          <Input aria-label="CER from (%)" inputMode="decimal" value={draft.min} size="xs"
                 onChange={(e) => setDraft({ ...draft, min: e.target.value })} className="ml-1 w-16" />
        </label>
        <label className="text-xs text-ink-muted">
          to
          <Input aria-label="CER to (%)" inputMode="decimal" value={draft.max} size="xs"
                 onChange={(e) => setDraft({ ...draft, max: e.target.value })} className="ml-1 w-16" />
          <span className="ml-0.5">%</span>
        </label>
        <Input aria-label="Search lines" placeholder="Search truth or reading" value={draft.q} size="xs"
               onChange={(e) => setDraft({ ...draft, q: e.target.value })} className="w-56" />
        <Button type="submit" size="xs">Apply</Button>
        {evaluation.datasets.length > 1 && (
          <Select aria-label="Dataset" size="xs" value={filter.job_id ?? ''} className="w-48"
                  onChange={(e) => update({ job: e.target.value })}>
            <option value="">All datasets</option>
            {evaluation.datasets.map((d) => <option key={d.job_id} value={d.job_id}>{d.name}</option>)}
          </Select>
        )}
        <span className="ml-auto flex items-center gap-2">
          <span className="text-xs text-ink-subtle">Sort</span>
          <Segmented value={sort} options={SORTS} onChange={(value) => update({ sort: value })} />
          <Button size="xs" variant="ghost" data-testid="sort-order"
                  aria-label={order === 'desc' ? 'Highest first' : 'Lowest first'}
                  onClick={() => update({ order: order === 'desc' ? 'asc' : 'desc' })}>
            {order === 'desc' ? 'highest first' : 'lowest first'}
          </Button>
        </span>
      </form>

      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-ink-muted">
        <span data-testid="lines-total">{count(total)} line{total === 1 ? '' : 's'}</span>
        {canSend && (
          <Button size="xs" data-testid="send-to-review" disabled={sending || total === 0} onClick={send}>
            Send {count(total)} to review
          </Button>
        )}
        {sent && (
          <span data-testid="review-sent">
            {sent.flagged} line{sent.flagged === 1 ? '' : 's'} flagged -{' '}
            {sent.jobs.map((job, i) => (
              <span key={job.job_id}>
                {i > 0 && ', '}
                <Link to={`/jobs/${job.job_id}/pages/${job.page_id}?review=0.85`} className="text-accent-ink hover:underline">
                  review {job.name} ({job.lines})
                </Link>
              </span>
            ))}
          </span>
        )}
        {error && <span data-testid="lines-error" role="alert" className="text-danger">{error}</span>}
      </div>

      {result && result.lines.length === 0 ? (
        <EmptyState>No scored line matches this filter.</EmptyState>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm" data-testid="eval-lines">
            <caption className="sr-only">Scored lines</caption>
            <thead>
              <tr className={tableHeadRow}>
                <th className="px-2 py-1.5 font-semibold">Line</th>
                <th className="px-2 py-1.5 font-semibold">Truth against reading</th>
                <th className="px-2 py-1.5 text-right font-semibold">CER</th>
                <th className="px-2 py-1.5 text-right font-semibold">Confidence</th>
              </tr>
            </thead>
            <tbody>
              {result?.lines.map((line) => {
                const to = editorLink(line)
                const crop = (
                  <img src={`/api/lines/${line.line_id}/crop`} alt={line.ground_truth} loading="lazy"
                       className="max-h-10 max-w-60 object-contain" />
                )
                return (
                  <tr key={line.line_id} data-testid="eval-line" data-line-id={line.line_id}
                      className={`${tableRow} ${to ? 'cursor-pointer' : ''}`}
                      onClick={() => to && navigate(to)}>
                    <td className={`${tableCell} w-64 py-1`}>
                      {to ? (
                        <Link to={to} onClick={(e) => e.stopPropagation()}
                              className="inline-block rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
                          {crop}
                        </Link>
                      ) : crop}
                    </td>
                    <td className={`${tableCell} py-1`}>
                      <LineDiff ops={line.reading.ops} />
                    </td>
                    <td className={`${tableCell} text-right font-mono text-xs tabular-nums`} data-col="cer">
                      {percent(line.reading.cer)}
                    </td>
                    <td className={`${tableCell} text-right font-mono text-xs tabular-nums`} data-col="confidence">
                      {line.reading.confidence === null ? '-' : percent(line.reading.confidence, 0)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {total > PAGE_SIZE && (
        <div className="mt-2 flex items-center gap-2 text-xs text-ink-muted" data-testid="lines-pager">
          <Button size="xs" variant="ghost" disabled={offset === 0}
                  onClick={() => update({ offset: String(Math.max(0, offset - PAGE_SIZE)) })}>Previous</Button>
          <span>{offset + 1}-{Math.min(offset + PAGE_SIZE, total)} of {count(total)}</span>
          <Button size="xs" variant="ghost" disabled={offset + PAGE_SIZE >= total}
                  onClick={() => update({ offset: String(offset + PAGE_SIZE) })}>Next</Button>
        </div>
      )}
    </div>
  )
}
