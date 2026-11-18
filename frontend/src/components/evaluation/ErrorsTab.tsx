import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import type { EvalSummary } from '../../api'
import { SectionNav } from '../ui/SectionNav'
import { tableCell, tableRow } from '../ui/Table'
import { Bar } from './Bar'
import { CharactersTab } from './CharactersTab'
import { ConfusionsTab } from './ConfusionsTab'
import { ContextTab } from './ContextTab'
import { HeadlineMore } from './Headline'
import { count, percent } from './format'

const SHOWN = 5
// Fewer than this and one slip makes a character look like the worst read.
const CHARACTER_MIN = 5
const MORE = [
  { id: 'confusions', label: 'Confusions' },
  { id: 'characters', label: 'Characters' },
  { id: 'context', label: 'Context and calibration' },
] as const
type More = (typeof MORE)[number]['id']

const shown = (text: string) => (text === ' ' ? 'space' : text === '' ? 'nothing' : text)

/** Where an evaluation's errors are, at a glance: the commonest mix-ups, the characters read
 *  worst, and the line lengths and pages that fare worst - each opening the lines behind it.
 *  Every figure and table there is sits under More measures. */
export function ErrorsTab({ summary }: { summary: EvalSummary }) {
  const [params] = useSearchParams()
  const [more, setMore] = useState<More | null>(null)
  const linesWith = (q: string) => {
    const next = new URLSearchParams(params)
    for (const key of ['cer_min', 'cer_max', 'conf_min', 'conf_max', 'offset']) next.delete(key)
    next.set('tab', 'lines')
    next.set('q', q)
    return `?${next}`
  }

  const { substitutions, insertions, deletions } = summary.confusions
  const edits = summary.headline.edits.total
  const mixups = [
    ...substitutions.map((c) => ({ label: `${shown(c.ref)} → ${shown(c.hyp)}`, q: c.ref, count: c.count })),
    ...deletions.map((c) => ({ label: `${shown(c.ref)} left out`, q: c.ref, count: c.count })),
    ...insertions.map((c) => ({ label: `${shown(c.hyp)} added`, q: c.hyp, count: c.count })),
  ].sort((a, b) => b.count - a.count)
  const top = mixups.slice(0, SHOWN)
  const rest = edits ? 1 - top.reduce((sum, m) => sum + m.count, 0) / edits : 0
  const worst = summary.characters
    .filter((c) => c.total >= CHARACTER_MIN && c.rate !== null)
    .sort((a, b) => b.rate! - a.rate!)
    .slice(0, SHOWN)
  const lengthPeak = Math.max(0, ...summary.by_length.map((b) => b.cer))
  const pages = [...summary.by_page].sort((a, b) => b.cer - a.cer).slice(0, 4)

  const heading = 'mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-muted'
  return (
    <div data-testid="errors-tab" className="space-y-8">
      <div className="grid gap-8 md:grid-cols-2">
        <section aria-labelledby="mixups">
          <h3 id="mixups" className={heading}>Most common mix-ups</h3>
          {top.length === 0 ? <p className="text-sm text-ink-subtle">No errors to mix up.</p> : (
            <table className="w-full border-collapse text-sm">
              <tbody>
                {top.map((m) => (
                  <tr key={m.label} data-testid="top-mixup" className={tableRow}>
                    <td className={`${tableCell} font-ocr`}><Link to={linesWith(m.q)} className="hover:text-accent-ink">{m.label}</Link></td>
                    <td className={`${tableCell} w-1/2`}><Bar value={m.count} peak={top[0].count} label={`${m.count} of ${edits}`} /></td>
                    <td className={`${tableCell} text-right font-mono text-xs tabular-nums`}>{percent(m.count / edits, 0)}</td>
                  </tr>
                ))}
                {rest > 0 && (
                  <tr className={tableRow}>
                    <td className={`${tableCell} text-ink-muted`}>all others</td>
                    <td className={tableCell} />
                    <td className={`${tableCell} text-right font-mono text-xs tabular-nums text-ink-muted`}>{percent(rest, 0)}</td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
          {mixups.length > SHOWN && (
            <button type="button" onClick={() => setMore('confusions')}
                    className="mt-2 text-xs text-accent-ink hover:underline">Show all {count(mixups.length)} mix-ups</button>
          )}
        </section>

        <section aria-labelledby="worst-characters">
          <h3 id="worst-characters" className={heading}>Characters read worst</h3>
          {worst.length === 0 ? <p className="text-sm text-ink-subtle">Too few characters to rank.</p> : (
            <table className="w-full border-collapse text-sm">
              <tbody>
                {worst.map((c) => (
                  <tr key={c.char} data-testid="worst-character" className={tableRow}>
                    <td className={`${tableCell} w-10 font-ocr text-base`}>
                      <Link to={linesWith(c.char)} className="hover:text-accent-ink">{shown(c.char)}</Link>
                    </td>
                    <td className={`${tableCell} text-ink-muted`}>{c.class}</td>
                    <td className={`${tableCell} text-right font-mono text-xs tabular-nums text-ink-muted`}>{count(c.total)}</td>
                    <td className={`${tableCell} text-right font-mono text-xs tabular-nums`}>{percent(1 - c.rate!, 0)} right</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <button type="button" onClick={() => setMore('characters')}
                  className="mt-2 text-xs text-accent-ink hover:underline">Show every character</button>
        </section>
      </div>

      <div className="grid gap-8 md:grid-cols-2">
        <section aria-labelledby="by-length">
          <h3 id="by-length" className={heading}>Error rate by line length</h3>
          <table className="w-full border-collapse text-sm">
            <tbody>
              {summary.by_length.map((b) => (
                <tr key={b.bucket} className={tableRow}>
                  <td className={`${tableCell} w-28`}>{b.bucket} chars</td>
                  <td className={tableCell}><Bar value={b.cer} peak={lengthPeak} label={percent(b.cer)} /></td>
                  <td className={`${tableCell} w-20 text-right text-xs text-ink-muted`}>{count(b.lines)} lines</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <section aria-labelledby="worst-pages">
          <h3 id="worst-pages" className={heading}>Worst pages</h3>
          <table className="w-full border-collapse text-sm">
            <tbody>
              {pages.map((p) => (
                <tr key={p.key} className={tableRow}>
                  <td className={`${tableCell} max-w-0 truncate`}>
                    {p.job_id
                      ? <Link to={`/jobs/${p.job_id}/pages/${p.key}`} className="hover:text-accent-ink">{p.filename ?? `page ${p.key}`}</Link>
                      : 'a page you cannot open'}
                  </td>
                  <td className={`${tableCell} w-24 text-right font-mono text-xs tabular-nums`}>{percent(p.cer)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>

      <details open={more !== null} data-testid="more-measures"
               onToggle={(e) => setMore((e.currentTarget as HTMLDetailsElement).open ? more ?? 'confusions' : null)}>
        <summary className="cursor-pointer text-sm text-accent-ink">
          More measures: word error rates, edits, character classes, every mix-up and character, context and calibration
        </summary>
        {more !== null && (
          <div className="mt-4">
            <HeadlineMore summary={summary} />
            <div className="flex flex-col gap-4 md:flex-row">
              <SectionNav label="More measures" active={more} items={[...MORE]} onSelect={(id) => setMore(id as More)} />
              <div className="min-w-0 flex-1">
                {more === 'confusions' && <ConfusionsTab summary={summary} />}
                {more === 'characters' && <CharactersTab summary={summary} />}
                {more === 'context' && <ContextTab summary={summary} />}
              </div>
            </div>
          </div>
        )}
      </details>
    </div>
  )
}
