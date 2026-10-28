import { useState } from 'react'
import { Link } from 'react-router-dom'
import type { Evaluation } from '../../api'
import { formatDate } from '../../util'
import { popoverChrome } from '../ui/Card'
import { TestDataChip } from '../TestPage'
import { useDismiss } from '../ui/menu'
import { percent } from './format'
import { buildRulers, scaleMax, type ModelMark, type Ruler } from './rulers'

const TICKS = 4

function waitingText(waiting: Evaluation[]): string {
  const count = (status: string) => waiting.filter((w) => w.status === status).length
  return [['queued', 'queued'], ['running', 'running'], ['error', 'failed'], ['cancelled', 'cancelled']]
    .map(([status, word]) => [count(status), word] as const)
    .filter(([n]) => n > 0)
    .map(([n, word]) => `${n} ${word}`)
    .join(' · ')
}

/** What one model scored on one ruler: every decode on file, each opening its page. */
function MarkCard({ mark, ruler, name, best, flip }: {
  mark: ModelMark; ruler: Ruler; name: string; best: boolean
  /** Near the right end the card opens leftwards, so it stays on the page. */
  flip: boolean
}) {
  const { shown } = mark
  return (
    <div data-testid="evaluation-card" onClick={(e) => e.stopPropagation()}
         className={`absolute ${flip ? 'right-0' : 'left-0'} top-full z-20 mt-2 w-80 p-3 text-left ${popoverChrome}`}>
      <div className="flex items-baseline justify-between gap-2">
        <Link to={`/models/${mark.modelId}`} className="truncate font-semibold hover:text-accent-ink">{name}</Link>
        {best && <span className="shrink-0 text-xs font-medium text-ok">best here</span>}
      </div>
      <div className="mb-2 text-xs text-ink-muted">
        on {ruler.label}{shown.line_count !== null && ` · ${shown.line_count.toLocaleString()} lines`}
      </div>
      <table className="mb-2 w-full text-sm">
        <thead>
          <tr className="text-[10px] uppercase tracking-wide text-ink-subtle">
            <th className="text-left font-medium">Decode</th>
            <th className="text-right font-medium">CER</th>
            <th className="text-right font-medium">WER</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {mark.decodes.map((ev) => (
            <tr key={ev.id} data-decode={ev.decode}>
              <td className={ev === shown ? 'font-medium' : 'text-ink-muted'}>{ev.decode}</td>
              <td className="text-right font-mono tabular-nums">{percent(ev.cer)}</td>
              <td className="text-right font-mono tabular-nums text-ink-muted">{percent(ev.wer)}</td>
              <td className="text-right">
                <Link to={`/evaluations/${ev.id}`} data-testid="evaluation-open" className="text-xs text-accent-ink hover:underline">open</Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="text-[11px] text-ink-subtle">evaluated {formatDate(shown.created_at)} by {shown.owner}</div>
    </div>
  )
}

/** Every evaluation as a ruler per thing scored on, a model as a dot at its CER: which
 *  model reads a collection best is answered by where the dots sit. A dot opens a card
 *  with all its decodes. */
export function EvaluationRulers({ evaluations, modelNames }: {
  evaluations: Evaluation[]
  modelNames: Map<number, string>
}) {
  const rulers = buildRulers(evaluations)
  const max = scaleMax(rulers)
  const [open, setOpen] = useState<string | null>(null)
  useDismiss(open !== null, () => setOpen(null))
  const at = (cer: number) => `${Math.min(100, (cer / max) * 100)}%`
  const name = (id: number) => modelNames.get(id) ?? `model ${id}`

  return (
    <div data-testid="evaluation-rulers" className="space-y-1">
      <div className="ml-[13rem] mr-2 flex justify-between text-[10px] text-ink-subtle" aria-hidden="true">
        {Array.from({ length: TICKS + 1 }, (_, i) => <span key={i}>{percent((max * i) / TICKS, max < 0.05 ? 1 : 0)}</span>)}
      </div>
      {rulers.map((ruler) => {
        const lines = ruler.marks[0]?.shown.line_count
        return (
          <div key={ruler.label} data-testid="evaluation-ruler" data-source={ruler.label}
               className="grid grid-cols-[12.5rem_minmax(0,1fr)] items-start gap-2 border-b border-line py-3">
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold" title={ruler.label}>{ruler.label}</div>
              {ruler.kind === 'test' && <TestDataChip data-testid="ruler-kind" data-kind="test" className="mt-0.5">test pages</TestDataChip>}
              {ruler.kind === 'validation' && (
                <span data-testid="ruler-kind" data-kind="validation"
                      title="The split that picked this run's checkpoint, so its score reads optimistic. Test pages are the fair measure."
                      className="mt-0.5 inline-flex rounded-full border border-warn/40 px-2 py-0.5 text-[11px] font-medium text-warn">
                  validation split
                </span>
              )}
              <div className="text-xs text-ink-subtle">
                {lines != null ? `${lines.toLocaleString()} checked lines` : 'not scored yet'}
              </div>
            </div>
            <div className="mr-2 min-w-0">
              <div className="relative h-6">
                <div className={`absolute inset-x-0 top-1/2 h-0.5 -translate-y-1/2 ${ruler.marks.length ? 'bg-line-strong' : 'border-t-2 border-dashed border-line-strong bg-transparent'}`} />
                {Array.from({ length: TICKS - 1 }, (_, i) => (
                  <div key={i} className="absolute top-1 h-4 w-px bg-line" style={{ left: `${((i + 1) / TICKS) * 100}%` }} />
                ))}
                {ruler.marks.map((mark, i) => {
                  const key = `${ruler.label}:${mark.modelId}`
                  const best = i === 0 && ruler.marks.length > 1
                  return (
                    <div key={mark.modelId} className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2"
                         style={{ left: at(mark.shown.cer!) }}>
                      <button type="button" data-testid="evaluation-dot" data-model={mark.modelId}
                              aria-expanded={open === key}
                              aria-label={`${name(mark.modelId)}: ${percent(mark.shown.cer)} CER on ${ruler.label}`}
                              title={`${name(mark.modelId)} · ${percent(mark.shown.cer)} ${mark.shown.decode}`}
                              onClick={(e) => { e.stopPropagation(); setOpen(open === key ? null : key) }}
                              className={`block size-3.5 rounded-full transition-transform hover:scale-125 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                                best ? 'bg-ok ring-2 ring-surface' : 'border-2 border-accent bg-surface'} ${open === key ? 'scale-125' : ''}`} />
                      {open === key && (
                        <MarkCard mark={mark} ruler={ruler} name={name(mark.modelId)} best={best}
                                  flip={mark.shown.cer! / max > 0.55} />
                      )}
                    </div>
                  )
                })}
              </div>
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs">
                {ruler.marks.map((mark, i) => (
                  <button key={mark.modelId} type="button" onClick={(e) => { e.stopPropagation(); setOpen(`${ruler.label}:${mark.modelId}`) }}
                          className="text-left hover:text-accent-ink">
                    <span className={i === 0 && ruler.marks.length > 1 ? 'font-semibold text-ok' : 'font-medium'}>{name(mark.modelId)}</span>
                    <span className="ml-1 font-mono tabular-nums text-ink-muted">{percent(mark.shown.cer)}</span>
                  </button>
                ))}
                {ruler.waiting.length > 0 && (
                  <span data-testid="evaluation-waiting" className="text-ink-subtle">{waitingText(ruler.waiting)}</span>
                )}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
