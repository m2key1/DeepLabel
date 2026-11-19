import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { getEvaluationPage, getEvaluationPages, renditionUrl } from '../../api'
import type { EvaluatedPage, EvaluatedPageOutlines, LineKind, LineScores } from '../../api'
import { cardChrome } from '../ui/Card'
import { StatRow, StatTile } from '../ui/StatTile'
import { tableCell, tableHeadRow, tableRow } from '../ui/Table'
import { count, percent } from './format'

const KINDS: { kind: LineKind | 'extra'; label: string; meaning: string; stroke: string }[] = [
  { kind: 'found', label: 'found', meaning: 'one found line for one checked line', stroke: 'stroke-ok' },
  { kind: 'missed', label: 'missed', meaning: 'no found line covers it', stroke: 'stroke-danger' },
  { kind: 'merged', label: 'merged', meaning: 'one found line runs over it and another', stroke: 'stroke-warn' },
  { kind: 'split', label: 'split', meaning: 'cut up across several found lines', stroke: 'stroke-test' },
  { kind: 'loose', label: 'loose', meaning: 'found, but its outline is too far off to count', stroke: 'stroke-ink-muted' },
  { kind: 'extra', label: 'extra', meaning: 'found lines over no checked line', stroke: 'stroke-danger' },
]
const STROKE = Object.fromEntries(KINDS.map((k) => [k.kind, k.stroke]))

const points = (polygon: [number, number][]) => polygon.map(([x, y]) => `${x},${y}`).join(' ')

/** The checked outlines in the colour of what they were counted as, and the found lines
 *  dashed over them, on the scan. */
function PageOutlines({ evalId, page }: { evalId: number; page: EvaluatedPage }) {
  const [outlines, setOutlines] = useState<EvaluatedPageOutlines | null>(null)
  useEffect(() => {
    let live = true
    setOutlines(null)
    getEvaluationPage(evalId, page.page_id).then((o) => live && setOutlines(o)).catch(() => {})
    return () => { live = false }
  }, [evalId, page.page_id])

  return (
    <figure data-testid="page-outlines" className={`${cardChrome} overflow-hidden`}>
      <div className="relative mx-auto w-fit max-w-full">
        <img src={renditionUrl(page.page_id, 'screen')} alt={page.filename ?? 'scan'}
             className="block max-h-[60vh] w-auto max-w-full" />
        {outlines && (
          <svg viewBox="0 0 1 1" preserveAspectRatio="none" className="absolute inset-0 h-full w-full" aria-hidden>
            {outlines.outlines.truth.map((line) => (
              <polygon key={`t${line.line_id}`} data-kind={line.kind} points={points(line.polygon)}
                       className={`fill-none ${STROKE[line.kind]}`} strokeWidth={2} vectorEffect="non-scaling-stroke" />
            ))}
            {outlines.outlines.detected.map((line, i) => (
              <polygon key={`d${i}`} data-found={line.kind} points={points(line.polygon)} strokeDasharray="5 3"
                       className={line.kind === 'extra' ? 'fill-danger/10 stroke-danger' : 'fill-none stroke-ink'}
                       strokeWidth={1} vectorEffect="non-scaling-stroke" />
            ))}
          </svg>
        )}
      </div>
      <figcaption className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-xs text-ink-muted">
        {KINDS.filter((k) => k.kind !== 'extra').map((k) => (
          <span key={k.kind} className="flex items-center gap-1" title={k.meaning}>
            <svg width="14" height="8" aria-hidden><rect x="1" y="1" width="12" height="6" className={`fill-none ${k.stroke}`} strokeWidth={2} /></svg>
            {k.label}
          </span>
        ))}
        <span className="flex items-center gap-1">
          <svg width="14" height="8" aria-hidden><rect x="1" y="1" width="12" height="6" className="fill-none stroke-ink" strokeDasharray="3 2" /></svg>
          found by the model
        </span>
        <Link to={`/jobs/${page.job_id}/pages/${page.page_id}`} className="ml-auto text-accent-ink hover:underline">
          Open in the editor
        </Link>
      </figcaption>
    </figure>
  )
}

function Counts({ scores }: { scores: LineScores }) {
  return (
    <StatRow className="mb-4">
      {KINDS.map((k) => (
        <StatTile key={k.kind} data-testid="line-count" data-kind={k.kind} label={k.label} title={k.meaning}
                  value={count(scores[k.kind])} />
      ))}
      <StatTile data-testid="line-fit" label="outline overlap" value={percent(scores.iou, 0)} note="mean, of found lines" />
      <StatTile data-testid="line-height" label="outline height"
                value={scores.height_ratio === null ? '-' : `${scores.height_ratio.toFixed(2)}×`} note="of the checked one, median" />
    </StatRow>
  )
}

/** A line model's evaluation: how many of the checked lines it found, what became of the
 *  rest, and every page worst first beside its outlines. */
export function LineEvaluation({ evalId, scores }: { evalId: number; scores: LineScores }) {
  const [params, setParams] = useSearchParams()
  const [pages, setPages] = useState<EvaluatedPage[] | null>(null)
  useEffect(() => {
    let live = true
    getEvaluationPages(evalId).then((r) => live && setPages(r.pages)).catch(() => {})
    return () => { live = false }
  }, [evalId])
  const asked = Number(params.get('page'))
  const shown = pages?.find((p) => p.page_id === asked) ?? pages?.[0] ?? null
  const choose = (pageId: number) => {
    const next = new URLSearchParams(params)
    next.set('page', String(pageId))
    setParams(next, { replace: true })
  }

  return (
    <div data-testid="line-evaluation">
      <StatRow className="mb-2">
        <StatTile data-testid="line-f1" label="F1" value={percent(scores.f1)}
                  note={`${count(scores.found)} of ${count(scores.truth)} checked lines found`} />
        <StatTile data-testid="line-precision" label="precision" value={percent(scores.precision)}
                  note={`of ${count(scores.detected)} found lines`} />
        <StatTile data-testid="line-recall" label="recall" value={percent(scores.recall)} />
      </StatRow>
      <Counts scores={scores} />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm" data-testid="evaluated-pages">
            <caption className="sr-only">Pages, worst first</caption>
            <thead>
              <tr className={tableHeadRow}>
                <th className="px-2 py-1.5 font-semibold">Page</th>
                <th className="px-2 py-1.5 text-right font-semibold">F1</th>
                {KINDS.slice(1).map((k) => <th key={k.kind} className="px-2 py-1.5 text-right font-semibold">{k.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {pages?.map((page) => (
                <tr key={page.page_id} data-testid="evaluated-page" data-page-id={page.page_id}
                    aria-selected={page.page_id === shown?.page_id}
                    className={`${tableRow} cursor-pointer ${page.page_id === shown?.page_id ? 'bg-accent-wash' : ''}`}
                    onClick={() => choose(page.page_id)}>
                  <td className={tableCell}>
                    <button type="button" className="text-left hover:text-accent-ink" onClick={() => choose(page.page_id)}>
                      {page.filename ?? `page ${page.page_id}`}
                    </button>
                  </td>
                  <td className={`${tableCell} text-right font-mono text-xs tabular-nums`} data-col="f1">{percent(page.f1)}</td>
                  {KINDS.slice(1).map((k) => (
                    <td key={k.kind} data-col={k.kind}
                        className={`${tableCell} text-right font-mono text-xs tabular-nums ${page[k.kind] ? '' : 'text-ink-subtle'}`}>
                      {page[k.kind]}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {shown && <PageOutlines evalId={evalId} page={shown} />}
      </div>
    </div>
  )
}
