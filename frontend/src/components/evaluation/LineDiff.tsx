import type { EditOp } from '../../api'
import { displayed } from '../../lib/text'
import { visibleGlyph } from './format'

const MISSED = 'rounded-sm bg-danger/15 text-danger line-through decoration-danger/60'
const ADDED = 'rounded-sm bg-ok/15 text-ok no-underline'

/** The ground truth and the reading in one run of text: agreement plain, what the model
 *  missed struck through in the danger tone, what it wrote instead or in addition in the
 *  ok tone. Each edit says in its title what it was, so colour is never the only cue. */
export function LineDiff({ ops }: { ops: EditOp[] }) {
  return (
    <span data-testid="line-diff" className="whitespace-pre-wrap font-ocr text-sm">
      {ops.map(([kind, truth, read], i) => {
        if (kind === '=') return <span key={i}>{displayed(read)}</span>
        if (kind === 'i')
          return <ins key={i} data-op="insertion" title={`inserted ${read}`} className={ADDED}>{visibleGlyph(read)}</ins>
        if (kind === 'd')
          return <del key={i} data-op="deletion" title={`missed ${truth}`} className={MISSED}>{visibleGlyph(truth)}</del>
        return (
          <span key={i} data-op="substitution" title={`${truth} read as ${read}`}>
            <del className={MISSED}>{visibleGlyph(truth)}</del>
            <ins className={ADDED}>{visibleGlyph(read)}</ins>
          </span>
        )
      })}
    </span>
  )
}

const LABEL = 'mr-2 inline-block w-8 font-sans text-[10px] uppercase tracking-wider text-ink-subtle'

/** A line read at least half wrong: a diff would interleave two different texts, so the
 *  transcription and the reading stand one above the other, to compare with the crop. */
export function LineTexts({ truth, reading }: { truth: string; reading: string }) {
  return (
    <span data-testid="line-texts" className="block font-ocr text-sm">
      <span className="block text-ink-muted"><span className={LABEL}>text</span>{displayed(truth)}</span>
      <span className="block"><span className={LABEL}>read</span>{displayed(reading)}</span>
    </span>
  )
}
