import { useState } from 'react'
import { Link } from 'react-router-dom'
import { displayed } from '../../lib/text'
import { lineShapeLabel } from '../../api'

import type {
  Preflight, PreflightChar, PreflightCharFlag, PreflightDistribution, PreflightFlagged, PreflightJoint,
  PreflightMetric, PreflightResult, PreflightSplit,
} from '../../api'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { cardChrome } from '../ui/Card'
import { StatRow, StatTile } from '../ui/StatTile'
import { SubHeading } from '../ui/Section'
import { tableCell, tableHeadRow, tableRow } from '../ui/Table'
import { count } from '../evaluation/format'
import { linkedCounts } from './preflightLinks'
import type { ShownPreflight } from './usePreflight'

const SPLITS: PreflightSplit[] = ['train', 'val', 'test']
const SPLIT_LABEL: Record<PreflightSplit, string> = { train: 'train', val: 'valid', test: 'test' }

type FlagTone = 'neutral' | 'warn' | 'danger'

/** Each flag's own mark, so a tile says which warning it carries rather than only that it
 *  carries one; red for what the model cannot learn at all, yellow for what to look at. */
const FLAGS: Record<PreflightCharFlag, { label: string; mark: string; tone: FlagTone }> = {
  rare: { label: 'rare', mark: '', tone: 'neutral' },
  split_only: { label: 'not in train', mark: '∅', tone: 'danger' },
  lookalike: { label: 'lookalike', mark: '≈', tone: 'warn' },
  odd: { label: 'odd codepoint', mark: '!', tone: 'danger' },
  mixed_forms: { label: 'mixed forms', mark: '±', tone: 'warn' },
  new_to_base: { label: 'new to base', mark: '+', tone: 'warn' },
}

const FLAG_ORDER = Object.keys(FLAGS) as PreflightCharFlag[]

const TILE_RING: Record<FlagTone, string> = {
  neutral: 'border-line',
  warn: 'border-warn ring-1 ring-warn',
  danger: 'border-danger ring-1 ring-danger',
}

const MARK_INK: Record<FlagTone, string> = {
  neutral: 'text-ink-subtle',
  warn: 'text-warn',
  danger: 'text-danger',
}

function worstTone(flags: PreflightCharFlag[]): FlagTone {
  const tones = flags.map((f) => FLAGS[f].tone)
  return tones.includes('danger') ? 'danger' : tones.includes('warn') ? 'warn' : 'neutral'
}

function flagText(flag: PreflightCharFlag): string {
  return `${FLAGS[flag].mark} ${FLAGS[flag].label}`.trim()
}

function FlagBadge({ flag }: { flag: PreflightCharFlag }) {
  return <Badge variant="chip" tone={FLAGS[flag].tone} data-flag={flag}>{flagText(flag)}</Badge>
}

type CharView = 'all' | 'flagged' | PreflightCharFlag

function inView(row: PreflightChar, view: CharView): boolean {
  if (view === 'all') return true
  if (view === 'flagged') return row.flags.length > 0
  return row.flags.includes(view)
}

const CHARS_SHOWN = 40

/** How a character reads in a table cell: invisible ones get a visible stand-in. */
function glyph(row: PreflightChar): string {
  if (row.char === ' ') return '␣'
  if (row.flags.includes('odd')) return row.codepoints.join(' ')
  return row.char
}

function binLabel(lo: number, hi: number | null): string {
  return hi === null ? `${lo}+` : `${lo}-${hi}`
}

type Distribution = { label: string; metric: PreflightMetric; dist: PreflightDistribution; unit?: string }

type BarFocus = { metric: PreflightMetric; index: number }

function share(n: number, total: number): string {
  return total ? `${((n / total) * 100).toFixed(1)}%` : '-'
}

function sameBar(a: BarFocus | null, metric: PreflightMetric, index: number): boolean {
  return a !== null && a.metric === metric && a.index === index
}

/** One distribution as a row of bars. The bar under the pointer, or the one a click
 *  pinned, lights up and the row's right-hand side says what it holds; while a bar of
 *  another row has the focus, each bar here shows how many of that bar's lines it holds. */
function DistributionRow({ label, metric, dist, unit, focus, pinned, linked, onHover, onPin }: Distribution & {
  focus: BarFocus | null
  pinned: BarFocus | null
  linked: { counts: number[]; of: number } | null
  onHover: (bar: BarFocus | null) => void
  onPin: (bar: BarFocus | null) => void
}) {
  const peak = Math.max(...dist.bins.map((b) => b.n), 1)
  const total = dist.bins.reduce((sum, b) => sum + b.n, 0)
  const shown = focus?.metric === metric ? dist.bins[focus.index] : undefined
  const suffix = unit ? ` ${unit}` : ''
  const range = (bin: { lo: number; hi: number | null }) => `${binLabel(bin.lo, bin.hi)}${suffix}`
  return (
    <figure data-testid="preflight-histogram" data-metric={label}
            className="grid min-w-0 grid-cols-[8rem_minmax(0,1fr)] items-end gap-x-3 gap-y-0.5 sm:grid-cols-[8rem_minmax(0,1fr)_18rem]">
      <figcaption className="self-center text-xs text-ink-muted">{label}</figcaption>
      <div className="flex h-12 items-end gap-0.5">
        {dist.bins.map((bin, index) => {
          const lit = shown === bin
          const isPinned = sameBar(pinned, metric, index)
          const held = linked?.counts[index]
          return (
            <button
              key={bin.lo}
              type="button"
              data-testid="preflight-bin"
              data-lo={bin.lo}
              data-highlighted={lit ? 'true' : 'false'}
              data-pinned={isPinned ? 'true' : 'false'}
              data-linked={held}
              aria-pressed={isPinned}
              aria-label={`${range(bin)}: ${count(bin.n)}, ${share(bin.n, total)}${
                held === undefined ? '' : `, ${count(held)} of the ${count(linked!.of)} lines in focus`}`}
              onMouseEnter={() => onHover({ metric, index })}
              onFocus={() => onHover({ metric, index })}
              onBlur={() => onHover(null)}
              onClick={() => onPin(isPinned ? null : { metric, index })}
              className="relative flex h-full flex-1 items-end focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            >
              <span
                className={`block w-full rounded-t-sm ${bin.n ? (lit ? 'bg-accent-ink' : 'bg-accent') : 'bg-line'} ${
                  focus !== null && !lit ? 'opacity-40' : ''}`}
                style={{ height: bin.n ? `${Math.max(6, (bin.n / peak) * 100)}%` : '2px' }}
              />
              {held ? (
                <span aria-hidden className="absolute inset-x-0 bottom-0 rounded-t-sm bg-accent-ink"
                      style={{ height: `${Math.max(6, (held / peak) * 100)}%` }} />
              ) : null}
            </button>
          )
        })}
      </div>
      <p data-testid="preflight-bin-detail" className="row-span-2 self-center font-mono text-xs tabular-nums text-ink-muted">
        {shown
          ? <>{range(shown)} · <span className="text-ink">{count(shown.n)}</span> · {share(shown.n, total)}</>
          : linked
            ? <>of these {count(linked.of)}: {dist.bins
                .map((bin, i) => ({ bin, held: linked.counts[i] }))
                .filter(({ held }) => held > 0)
                .map(({ bin, held }) => `${count(held)} at ${range(bin)}`)
                .join(', ') || 'none measured'}</>
            : <span className="text-ink-subtle">min {dist.min} · median {dist.median} · max {dist.max}{suffix}</span>}
      </p>
      <span />
      <div className="flex gap-0.5 font-mono text-[9px] text-ink-subtle">
        {dist.bins.map((bin) => (
          <span key={bin.lo} className="flex-1 truncate text-center">{binLabel(bin.lo, bin.hi)}</span>
        ))}
      </div>
    </figure>
  )
}

/** The first lines a bar holds, as the crops the model reads, each opening its line. */
function BinLines({ item, index, datasets }: { item: Distribution; index: number; datasets: Record<string, string> }) {
  const bin = item.dist.bins[index]
  const lines = bin.examples ?? []
  if (lines.length === 0) return null
  return (
    <div data-testid="preflight-bin-examples" className="border-t border-line pt-2">
      <p className="mb-1 text-xs text-ink-muted">
        Lines at {binLabel(bin.lo, bin.hi)}{item.unit ? ` ${item.unit}` : ''} {item.label}
      </p>
      <ul className="grid gap-1 sm:grid-cols-2">
        {lines.map((line) => (
          <li key={line.line_id} data-testid="preflight-bin-example" data-line-id={line.line_id}>
            <Link to={`/jobs/${line.job_id}/pages/${line.page_id}?line=${line.line_id}`}
                  title={`${datasets[line.job_id] ?? line.job_id}, line ${line.line_id}`}
                  className="flex min-w-0 items-center gap-2 rounded px-1 py-0.5 hover:bg-raised">
              <img src={`/api/lines/${line.line_id}/crop`} alt={line.text} loading="lazy"
                   className="h-8 max-w-[50%] shrink-0 rounded-sm border border-line object-contain object-left" />
              <span className="truncate font-ocr text-xs text-ink">{displayed(line.text)}</span>
            </Link>
          </li>
        ))}
      </ul>
      {bin.n > lines.length && (
        <p className="mt-1 text-[11px] text-ink-subtle">and {count(bin.n - lines.length)} more</p>
      )}
    </div>
  )
}

/** Every distribution the pre-flight measured, stacked in one block on the same layout,
 *  so their shapes read against each other. One bar has the focus at a time across the
 *  block - the one under the pointer, else the pinned one - and the other rows follow it
 *  through the lines they share. */
function Distributions({ items, joint, datasets }: {
  items: (Distribution | { dist: null })[]
  joint: PreflightJoint | null | undefined
  datasets: Record<string, string>
}) {
  const [hovered, setHovered] = useState<BarFocus | null>(null)
  const [pinned, setPinned] = useState<BarFocus | null>(null)
  const shown = items.filter((d): d is Distribution => d.dist !== null)
  if (shown.length === 0) return null
  const focus = hovered ?? pinned
  const focused = shown.find((d) => d.metric === focus?.metric)
  const linkedFor = (metric: PreflightMetric) => {
    if (!focus || !focused || metric === focus.metric) return null
    const counts = linkedCounts(joint, focus.metric, focus.index, metric)
    return counts && { counts, of: focused.dist.bins[focus.index].n }
  }
  return (
    <div>
      <SubHeading>Distributions</SubHeading>
      <div data-testid="preflight-distributions" className={`${cardChrome} space-y-3 p-3`}
           onMouseLeave={() => setHovered(null)}>
        {shown.map((d) => (
          <DistributionRow key={d.label} {...d} focus={focus} pinned={pinned} linked={linkedFor(d.metric)}
                           onHover={setHovered} onPin={setPinned} />
        ))}
        {focus && focused && <BinLines item={focused} index={focus.index} datasets={datasets} />}
      </div>
    </div>
  )
}

function Examples({ flagged, datasets }: { flagged: PreflightFlagged; datasets: Record<string, string> }) {
  if (flagged.examples.length === 0) return null
  return (
    <ul className="mt-1 space-y-0.5 text-[11px] text-ink-muted">
      {flagged.examples.map((e) => (
        <li key={e.line_id}>
          <Link to={`/jobs/${e.job_id}/pages/${e.page_id}`} className="text-accent-ink hover:underline">
            {datasets[e.job_id] ?? e.job_id}, line {e.line_id}
          </Link>
          {e.text && <span className="ml-1 font-ocr">"{displayed(e.text)}"</span>}
        </li>
      ))}
      {flagged.count > flagged.examples.length && (
        <li className="text-ink-subtle">and {count(flagged.count - flagged.examples.length)} more</li>
      )}
    </ul>
  )
}

function FlaggedTile({ label, flagged, testid, datasets }: {
  label: string
  flagged: PreflightFlagged | null
  testid: string
  datasets: Record<string, string>
}) {
  if (!flagged) return null
  return (
    <div data-testid={testid} className="min-w-40 flex-1 rounded px-1 hover:bg-raised">
      <div className="text-[10px] uppercase tracking-widest text-ink-subtle">{label}</div>
      <div className={`font-mono text-base tabular-nums ${flagged.count ? 'text-warn' : 'text-ink'}`}>
        {count(flagged.count)}
      </div>
      <Examples flagged={flagged} datasets={datasets} />
    </div>
  )
}

function SplitTable({ result, datasets }: { result: PreflightResult; datasets: Record<string, string> }) {
  const unit = result.unit
  const hasTest = result.split.totals.test.pages > 0 ||
    result.split.datasets.some((d) => d.test.pages > 0) || result.settings.test_datasets > 0
  const splits = hasTest ? SPLITS : SPLITS.slice(0, 2)
  const [hovered, setHovered] = useState<string | null>(null)
  const hoveredRow = result.split.datasets.find((d) => d.job_id === hovered)
  const cell = (c: { pages: number; items: number }) =>
    c.pages === 0 ? <span className="text-ink-subtle">-</span>
      : <>{count(c.items)} <span className="text-ink-subtle">/ {count(c.pages)} p</span></>
  return (
    <div className="overflow-x-auto">
      <table data-testid="preflight-split" className="w-full border-collapse text-sm">
        <caption className="sr-only">{unit} and pages per dataset and split</caption>
        <thead>
          <tr className={tableHeadRow}>
            <th className="px-2 py-1.5 font-semibold">Dataset</th>
            {splits.map((s) => (
              <th key={s} className="px-2 py-1.5 text-right font-semibold">{SPLIT_LABEL[s]} {unit} / pages</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.split.datasets.map((row) => (
            <tr key={row.job_id} data-testid="preflight-split-row" data-job={row.job_id}
                data-highlighted={row.job_id === hovered ? 'true' : 'false'}
                onMouseEnter={() => setHovered(row.job_id)} onMouseLeave={() => setHovered(null)}
                className={`${tableRow} ${row.job_id === hovered ? 'bg-accent-wash' : ''}`}>
              <td className={tableCell}>{datasets[row.job_id] ?? row.job_id}</td>
              {splits.map((s) => (
                <td key={s} data-split={s} className={`${tableCell} text-right font-mono tabular-nums`}>
                  {cell(row[s])}
                </td>
              ))}
            </tr>
          ))}
          <tr data-testid="preflight-split-total" className={`${tableRow} font-medium`}>
            <td className={tableCell}>Total</td>
            {splits.map((s) => (
              <td key={s} data-split={s} className={`${tableCell} text-right font-mono tabular-nums ${
                result.split.totals[s].items === 0 ? 'text-warn' : ''}`}>
                {count(result.split.totals[s].items)}
                <span className="text-ink-subtle"> / {count(result.split.totals[s].pages)} p</span>
              </td>
            ))}
          </tr>
        </tbody>
      </table>
      <p data-testid="preflight-split-detail" className="mt-1 h-4 text-xs text-ink-muted">
        {hoveredRow && `${datasets[hoveredRow.job_id] ?? hoveredRow.job_id}: ${splits
          .map((s) => `${share(hoveredRow[s].items, result.split.totals[s].items)} of ${SPLIT_LABEL[s]} ${unit}`)
          .join(', ')}`}
      </p>
      {result.split.duplicate_count > 0 && (
        <div data-testid="preflight-duplicates" className="mt-2 text-xs text-ink-muted">
          <SubHeading className="text-warn">
            {result.split.duplicate_count} scan{result.split.duplicate_count === 1 ? '' : 's'} in more than one split
          </SubHeading>
          <ul className="space-y-0.5">
            {result.split.duplicates.map((d) => (
              <li key={d.content_hash}>
                <span className="font-mono">{d.splits.map((s) => SPLIT_LABEL[s]).join(' + ')}</span>:{' '}
                {d.pages.map((p, i) => (
                  <span key={`${p.job_id}-${p.page_id}`}>
                    {i > 0 && ', '}
                    <Link to={`/jobs/${p.job_id}/pages/${p.page_id}`} className="text-accent-ink hover:underline">
                      {datasets[p.job_id] ?? p.job_id} / {p.filename}
                    </Link>
                  </span>
                ))}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

/** Every character as a small tile, shaded by how often it occurs - the same number the
 *  table ranks by - with flagged ones ringed in their worst flag's colour and marked with
 *  each flag's sign, so a stray codepoint stands out of the set and says why. */
function charKey(row: PreflightChar): string {
  return row.codepoints.join(' ')
}

interface CharHover {
  hovered: string | null
  onHover: (key: string | null) => void
}

function CharFilter({ rows, view, onChange }: { rows: PreflightChar[]; view: CharView; onChange: (v: CharView) => void }) {
  const options: { value: CharView; text: string; n: number; tone: FlagTone }[] = [
    { value: 'all', text: 'All', n: rows.length, tone: 'neutral' },
    { value: 'flagged', text: 'Flagged', n: rows.filter((r) => r.flags.length > 0).length, tone: 'neutral' },
    ...FLAG_ORDER.map((flag) => ({
      value: flag as CharView, text: FLAGS[flag].label, n: rows.filter((r) => r.flags.includes(flag)).length,
      tone: FLAGS[flag].tone,
    })).filter((o) => o.n > 0),
  ]
  return (
    <div role="group" aria-label="Show characters" className="flex flex-wrap gap-1">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          data-testid="preflight-char-filter"
          data-view={o.value}
          aria-pressed={view === o.value}
          onClick={() => onChange(view === o.value && o.value !== 'all' ? 'all' : o.value)}
          className={`flex items-center gap-1 rounded border px-2 py-0.5 text-xs font-medium focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent ${
            view === o.value ? 'border-accent bg-accent-wash text-accent-ink' : 'border-line text-ink-muted hover:bg-raised hover:text-ink'}`}
        >
          {o.value !== 'all' && o.value !== 'flagged' && FLAGS[o.value].mark && (
            <span aria-hidden className={`font-mono ${MARK_INK[o.tone]}`}>{FLAGS[o.value].mark}</span>
          )}
          {o.text}
          <span className="font-mono tabular-nums text-ink-subtle">{count(o.n)}</span>
        </button>
      ))}
    </div>
  )
}

function CharsetGrid({ rows, view, hovered, onHover }: { rows: PreflightChar[]; view: CharView } & CharHover) {
  const peak = Math.log1p(Math.max(...rows.map((r) => r.total), 1))
  return (
    <div data-testid="preflight-charset" className="flex flex-wrap gap-0.5" onMouseLeave={() => onHover(null)}>
      {rows.map((row) => {
        const shown = inView(row, view)
        const marks = row.flags.filter((f) => FLAGS[f].mark)
        return (
          <span
            key={row.char}
            data-char={charKey(row)}
            data-flags={row.flags.join(' ')}
            data-dimmed={shown ? 'false' : 'true'}
            data-highlighted={charKey(row) === hovered ? 'true' : 'false'}
            onMouseEnter={() => onHover(charKey(row))}
            title={[row.flags.map((f) => FLAGS[f].label).join(', '), row.hint].filter(Boolean).join(': ') || undefined}
            className={`relative flex h-7 min-w-7 items-center justify-center overflow-hidden rounded-sm border px-1 font-ocr text-sm ${
              shown ? '' : 'opacity-25'} ${
              charKey(row) === hovered ? 'border-accent ring-2 ring-accent' : TILE_RING[worstTone(row.flags)]}`}
          >
            <span aria-hidden className="absolute inset-0 bg-accent"
                  style={{ opacity: 0.08 + 0.5 * (Math.log1p(row.total) / peak) }} />
            <span className="relative text-ink">{row.flags.includes('odd') ? '?' : glyph(row)}</span>
            {marks.length > 0 && (
              <span data-testid="preflight-char-marks" aria-hidden
                    className="absolute right-0.5 top-0 flex font-mono text-[9px] font-bold leading-none">
                {marks.map((f) => <span key={f} className={MARK_INK[FLAGS[f].tone]}>{FLAGS[f].mark}</span>)}
              </span>
            )}
          </span>
        )
      })}
    </div>
  )
}

function CharacterTable({ rows, view, hasTest, hovered, onHover }: {
  rows: PreflightChar[]
  view: CharView
  hasTest: boolean
} & CharHover) {
  const [showAll, setShowAll] = useState(false)
  const visible = rows.filter((r) => inView(r, view))
  const shown = showAll ? visible : visible.slice(0, CHARS_SHOWN)
  const peak = Math.max(...rows.map((r) => r.total), 1)
  const splits = hasTest ? SPLITS : SPLITS.slice(0, 2)
  return (
    <div>
      <div className="overflow-x-auto">
        <table data-testid="preflight-characters" className="w-full border-collapse text-sm">
          <caption className="sr-only">Characters ranked by frequency</caption>
          <thead>
            <tr className={tableHeadRow}>
              <th className="px-2 py-1.5 font-semibold">Char</th>
              <th className="px-2 py-1.5 font-semibold">Codepoint</th>
              <th className="w-1/4 px-2 py-1.5 font-semibold">Count</th>
              {splits.map((s) => (
                <th key={s} className="px-2 py-1.5 text-right font-semibold">{SPLIT_LABEL[s]}</th>
              ))}
              <th className="px-2 py-1.5 font-semibold">Flags</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => (
              <tr key={row.char} data-testid="preflight-char" data-char={charKey(row)}
                  data-flags={row.flags.join(' ')}
                  data-highlighted={charKey(row) === hovered ? 'true' : 'false'}
                  onMouseEnter={() => onHover(charKey(row))} onMouseLeave={() => onHover(null)}
                  className={`${tableRow} ${charKey(row) === hovered ? 'bg-accent-wash' : ''}`}>
                <td className={`${tableCell} font-ocr text-base`}>{glyph(row)}</td>
                <td className={`${tableCell} whitespace-nowrap font-mono text-[11px] text-ink-muted`} title={row.name}>
                  {row.codepoints.join(' ')}
                  <span className="ml-1 hidden text-ink-subtle lg:inline">{row.name.toLowerCase()}</span>
                </td>
                <td className={tableCell}>
                  <div className="flex items-center gap-1.5">
                    <div className="h-1.5 flex-1 rounded-sm bg-line">
                      <div className="h-full rounded-sm bg-accent" style={{ width: `${(row.total / peak) * 100}%` }} />
                    </div>
                    <span className="w-12 text-right font-mono text-xs tabular-nums">{count(row.total)}</span>
                  </div>
                </td>
                {splits.map((s) => (
                  <td key={s} data-split={s} className={`${tableCell} text-right font-mono text-xs tabular-nums ${
                    s === 'train' && row.train === 0 ? 'text-warn' : ''}`}>
                    {count(row[s])}
                  </td>
                ))}
                <td className={tableCell} title={row.hint || undefined}>
                  <span className="flex flex-wrap gap-1">
                    {row.flags.map((flag) => <FlagBadge key={flag} flag={flag} />)}
                  </span>
                  {row.hint && row.flags.some((f) => f !== 'rare') && (
                    <span className="block text-[11px] text-ink-subtle">{row.hint}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {visible.length > CHARS_SHOWN && (
        <Button variant="ghost" size="xs" className="mt-1" onClick={() => setShowAll((v) => !v)}>
          {showAll ? `Show the first ${CHARS_SHOWN}` : `Show all ${visible.length}`}
        </Button>
      )}
    </div>
  )
}

/** The charset grid and the ranked table read as one: the character under the pointer in
 *  either is lit in both, its counts are spelled out between them, and the filter above
 *  picks one kind of warning out of both. */
function Characters({ rows, hasTest }: { rows: PreflightChar[]; hasTest: boolean }) {
  const [hovered, setHovered] = useState<string | null>(null)
  const [view, setView] = useState<CharView>('all')
  const row = rows.find((r) => charKey(r) === hovered)
  return (
    <div className="space-y-2">
      <CharFilter rows={rows} view={view} onChange={setView} />
      <CharsetGrid rows={rows} view={view} hovered={hovered} onHover={setHovered} />
      <p className="flex h-5 items-center gap-2 text-xs text-ink-muted">
        {row ? (
          <>
            <span data-testid="preflight-char-detail" className="font-mono tabular-nums">
              {charKey(row)} {row.name} · {count(row.total)} · train {count(row.train)} · valid {count(row.val)}
              {hasTest ? ` · test ${count(row.test)}` : ''}
            </span>
            {row.flags.map((flag) => <FlagBadge key={flag} flag={flag} />)}
          </>
        ) : <span className="text-ink-subtle">Point at a character for its counts.</span>}
      </p>
      <CharacterTable rows={rows} view={view} hasTest={hasTest} hovered={hovered} onHover={setHovered} />
    </div>
  )
}

function Conventions({ flags }: { flags: NonNullable<PreflightResult['conventions']> }) {
  const label = (name: string) => flags.labels[name] ?? name
  const listed = (names: string[]) => names.map((name) => (
    <span key={name} data-testid="preflight-convention" data-flag={name}
          className="mr-3 inline-flex items-baseline gap-1 whitespace-nowrap">
      <span className="text-ink">{label(name)}</span>
      <span className="font-mono text-[11px] tabular-nums text-ink-subtle">{count(flags.lines[name] ?? 0)} lines</span>
    </span>
  ))
  return (
    <div data-testid="preflight-conventions">
      <SubHeading>Transcription conventions</SubHeading>
      {!flags.supported ? (
        <p className="text-xs text-ink-muted">
          The datasets set {flags.names.map(label).join(', ')}, but this model's backend cannot be taught
          convention flags, so the run ignores them.
        </p>
      ) : (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs">
          {flags.new.length > 0 && <>
            <dt className="text-ink-muted">This run teaches</dt>
            <dd data-testid="preflight-conventions-new">{listed(flags.new)}</dd>
          </>}
          {flags.base.length > 0 && <>
            <dt className="text-ink-muted">Kept from the base</dt>
            <dd data-testid="preflight-conventions-base">{listed(flags.base)}</dd>
          </>}
        </dl>
      )}
    </div>
  )
}

function Settings({ result }: { result: PreflightResult }) {
  const s = result.settings
  const entries: [string, string][] = [
    ['base model', s.base_model ?? 'from scratch'],
    ['target', s.target === 'slurm' ? `cluster${s.gpu_type ? ` · ${s.devices}x ${s.gpu_type}` : ''}` : 'local GPU'],
    ['epochs', s.epochs === null ? 'model default' : `${s.epochs}${s.epochs_is_default ? ' (default)' : ''}`],
    ['batch', `${s.batch_size}${s.batch_is_default ? ' (default)' : ''}`],
    ...(s.grad_accum_steps ? [['gradient accumulation', String(s.grad_accum_steps)] as [string, string]] : []),
    ...(s.effective_batch && s.effective_batch !== s.batch_size
      ? [['effective batch', String(s.effective_batch)] as [string, string]] : []),
    ...(s.lr_scale ? [['learning rates', `x ${s.lr_scale}`] as [string, string]] : []),
    ['steps per epoch', count(s.steps_per_epoch)],
    ['total steps', s.total_steps === null ? '-' : count(s.total_steps)],
    ['validation', s.validation],
    ['test sets', String(s.test_datasets)],
    ...(result.task === 'ocr'
      ? [['person-verified only', s.human_checked_only ? 'yes' : 'no'] as [string, string]] : []),
    ...(s.line_shape ? [['line shape', lineShapeLabel(s.line_shape)] as [string, string]] : []),
    ['augmentation', s.augmentation],
    ...(s.tuned.length ? [['tuned', s.tuned.join(', ').replace(/_/g, ' ')] as [string, string]] : []),
  ]
  return (
    <dl data-testid="preflight-settings" className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-4">
      {entries.map(([label, value]) => (
        <div key={label} data-setting={label}>
          <dt className="text-ink-subtle">{label}</dt>
          <dd className="font-mono tabular-nums text-ink">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

/** The pre-flight's findings and statistics: the same view before the run starts and on
 *  its page afterwards. Warnings point at what to look at; nothing here stops a run. */
export function PreflightReport({ preflight }: { preflight: Preflight }) {
  const result = preflight.result
  if (!result) return null
  const datasets = preflight.datasets
  const hasTest = result.settings.test_datasets > 0
  const warnings = result.findings.filter((f) => f.level === 'warn')
  return (
    <div data-testid="preflight-report" className="space-y-5">
      <div>
        <SubHeading>
          {warnings.length === 0 ? 'Nothing stood out' : `${warnings.length} thing${warnings.length === 1 ? '' : 's'} worth a look`}
        </SubHeading>
        {result.findings.length > 0 && (
          <ul className="space-y-1">
            {result.findings.map((f, i) => (
              <li key={`${f.code}-${i}`} data-testid="preflight-finding" data-code={f.code} data-level={f.level}
                  className="flex items-start gap-2 text-xs text-ink">
                <Badge variant="chip" tone={f.level === 'warn' ? 'warn' : 'neutral'}>
                  {f.level === 'warn' ? 'warning' : 'note'}
                </Badge>
                <span>{f.message}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <SubHeading>The split</SubHeading>
        <SplitTable result={result} datasets={datasets} />
      </div>

      {result.conventions && <Conventions flags={result.conventions} />}

      <Distributions joint={result.joint} datasets={datasets} items={[
        { label: 'height', metric: 'height', dist: result.crops?.height ?? null, unit: 'px' },
        { label: 'width', metric: 'width', dist: result.crops?.width ?? null, unit: 'px' },
        { label: 'aspect', metric: 'aspect', dist: result.crops?.aspect ?? null },
        { label: 'characters per line', metric: 'chars_per_line', dist: result.text?.chars_per_line ?? null },
      ]} />

      {result.crops && (
        <div>
          <SubHeading>Crops</SubHeading>
          <div className="flex flex-wrap gap-4">
            <FlaggedTile label="tiny crops" testid="preflight-tiny" flagged={result.crops.tiny} datasets={datasets} />
            <FlaggedTile label="no crop possible" testid="preflight-degenerate" flagged={result.crops.degenerate} datasets={datasets} />
            <FlaggedTile label={result.crops.too_wide ? `wider than ${result.crops.too_wide.max_width} px at ${result.crops.too_wide.target_height} px` : 'too wide'}
                         testid="preflight-too-wide" flagged={result.crops.too_wide} datasets={datasets} />
          </div>
        </div>
      )}

      {result.text && (
        <div>
          <SubHeading>Text and characters</SubHeading>
          <div>
            <StatRow>
              <StatTile label="verified by a person" data-testid="preflight-source-person"
                        value={count(result.text.sources.person)} />
              <StatTile label="matched transcription" data-testid="preflight-source-transcription"
                        value={count(result.text.sources.transcription)} />
              <StatTile label="settled by models" data-testid="preflight-source-models"
                        value={count(result.text.sources.models)} />
            </StatRow>
          </div>
          <div className="mt-3 flex flex-wrap gap-4">
            <FlaggedTile label="empty lines" testid="preflight-empty" flagged={result.text.empty} datasets={datasets} />
            <FlaggedTile label="run-on lines" testid="preflight-run-on" flagged={result.text.run_on} datasets={datasets} />
          </div>
          {result.text.characters.length > 0 && (
            <div className="mt-3 space-y-3">
              <Characters rows={result.text.characters} hasTest={hasTest} />
              {!result.text.base_charset_known && (
                <p className="text-[11px] text-ink-subtle">
                  The base model's own characters are not on record, so none are flagged as new to it.
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {result.classes && (
        <div>
          <SubHeading>Classes per split</SubHeading>
          <div className="overflow-x-auto">
            <table data-testid="preflight-classes" className="w-full border-collapse text-sm">
              <thead>
                <tr className={tableHeadRow}>
                  <th className="px-2 py-1.5 font-semibold">Class</th>
                  {SPLITS.map((s) => <th key={s} className="px-2 py-1.5 text-right font-semibold">{SPLIT_LABEL[s]}</th>)}
                  <th className="px-2 py-1.5 font-semibold">Flags</th>
                </tr>
              </thead>
              <tbody>
                {result.classes.map((row) => (
                  <tr key={row.name} data-testid="preflight-class" data-class={row.name} className={tableRow}>
                    <td className={tableCell}>{row.name}</td>
                    {SPLITS.map((s) => (
                      <td key={s} data-split={s} className={`${tableCell} text-right font-mono tabular-nums`}>{count(row[s])}</td>
                    ))}
                    <td className={tableCell}>
                      {row.flags.map((flag) => (
                        <Badge key={flag} variant="chip" tone={flag === 'split_only' ? 'warn' : 'neutral'}>
                          {flag === 'split_only' ? 'not in train' : 'not validated'}
                        </Badge>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div>
        <SubHeading>Settings</SubHeading>
        <Settings result={result} />
      </div>
    </div>
  )
}

/** Why there is no review. Only one the backend failed to compute leaves the run free to
 *  start; settings it refused would be refused by the submit as well. */
function failedText(preflight: ShownPreflight): string {
  if (preflight.failure === 'refused') return `These settings were refused: ${preflight.error}.`
  if (preflight.failure === 'request') return `The pre-flight could not be read: ${preflight.error}.`
  return `The pre-flight could not be computed: ${preflight.error}. The run can still start.`
}

/** The pre-flight in whatever state it is in: computing, failed, or done. */
export function PreflightPanel({ preflight, pending }: { preflight: ShownPreflight | null; pending: boolean }) {
  const running = pending || !preflight || preflight.status === 'running'
  return (
    <div data-testid="preflight" data-status={running ? 'running' : preflight.status}
         className={`${cardChrome} p-3`}>
      {running && (
        <p data-testid="preflight-running" className="flex items-center gap-2 text-xs text-ink-muted" role="status">
          <span aria-hidden className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-line border-t-accent" />
          Reading the material this run would train on…
        </p>
      )}
      {!running && preflight.status === 'error' && (
        <p data-testid="preflight-error" className="text-xs text-danger">
          {failedText(preflight)}
        </p>
      )}
      {!running && preflight.status === 'done' && <PreflightReport preflight={preflight} />}
    </div>
  )
}
