import type { LineCandidate } from '../../api'
import { displayed, sameText } from '../../lib/text'
import { TrashIcon, UnlinkIcon } from '../icons'
import { commonest, diffWords } from './diff'
import { readerName } from './readers'

const SOURCE_STYLE: Record<LineCandidate['source'], string> = {
  llm: 'bg-series-7/15 text-series-7',
  ocr: 'bg-raised text-ink-muted',
  human: 'bg-warn/15 text-warn',
  align: 'bg-series-1/15 text-series-1',
}

// One width for every reader, so the readings line up in a column that can be read down.
// A name too long for it wraps rather than being cut: telling models apart is the point.
export const READER_CHIP = 'w-28 shrink-0 wrap-anywhere rounded px-1 text-[10px] font-medium'

const CHANGED = 'rounded-sm bg-warn/30'

interface LineCandidatesProps {
  candidates: LineCandidate[]
  /** What the line says now, so the reading already in use is marked rather than offered,
   *  and so the others are shown as their difference from it. */
  current: string
  canEdit: boolean
  /** The reading the arrow keys are resting on, marked so the cursor is visible. */
  activeId?: number | null
  onAccept: (candidate: LineCandidate) => void
  /** Send a reading back to the pool - how a reading dropped onto the wrong line is undone
   *  where it landed. Absent where there is nothing to release it from. */
  onRelease?: (candidate: LineCandidate) => void
  /** Delete a language model's reading for good. */
  onRemove?: (candidate: LineCandidate) => void
  /** What the model read, offered like any other reading once a correction covers it. */
  machine?: { text: string; author: string } | null
}

// The machine's read is no row in the pool, so it is dressed as one. Negative, where a
// row id never is.
export const MACHINE_ID = -1

/** What a line offers: the readings held for it, minus what it already says, plus what the
 *  model read. The arrow keys walk this too, so it cannot be computed twice. */
export function offeredReadings(
  candidates: LineCandidate[], current: string, machine?: { text: string; author: string } | null,
): LineCandidate[] {
  const held = candidates.filter((c) => !sameText(c.text, current))
  // Not when a reader already offers the same words: a list to pick from must not hold
  // one twice.
  const spare = machine?.text && !sameText(machine.text, current)
    && !held.some((c) => sameText(c.text, machine.text))
  return spare
    ? [...held, { id: MACHINE_ID, page_id: 0, line_id: null, source: 'ocr', author: machine.author,
                  text: machine.text, order_idx: 0, similarity: null, checked: false,
                  dismissed: false, llm_model_id: null }]
    : held
}

/** Every reading held for one line, so choosing beats typing. Accepting one is the same
 *  as typing it: it becomes the correction, checked, on the person who clicked. The whole
 *  row is the button - the target used to be a "Use" link at the far right of it.
 *
 *  The readings start at the left edge, under the line's own text, so they can be read down
 *  as a column and against the line itself. The reader's name is the right-hand column: it
 *  says who, which is only ever wanted after seeing what. */
export function LineCandidates({
  candidates, current, canEdit, activeId, onAccept, onRelease, onRemove, machine,
}: LineCandidatesProps) {
  const offered = offeredReadings(candidates, current, machine)
  // The readings the line already says are listed too, so the one it wears can be let go
  // of here rather than from the row; they are not offered, as choosing them changes nothing.
  const inUse = candidates.filter((c) => sameText(c.text, current))
  if (offered.length === 0 && inUse.length === 0) return null
  // What the line already says is the reference where there is one. Before anything is
  // settled there is none, so the readers are held against the reading most of them gave.
  const baseline = current || commonest(offered.map((c) => c.text))
  return (
    <div data-testid="line-candidates" className="ml-6 mt-0.5 space-y-0.5">
      {inUse.map((candidate) => (
        <div key={candidate.id} data-testid="line-candidate-in-use" data-source={candidate.source}
             data-author={candidate.author} className="group flex items-start gap-1.5 rounded">
          <span className="flex min-w-0 flex-1 items-start gap-1.5 px-0.5">
            <span className="min-w-0 flex-1 whitespace-pre-wrap wrap-anywhere font-ocr text-xs text-ink-subtle">
              {displayed(candidate.text)}
            </span>
            <span className="shrink-0 rounded bg-raised px-1 text-[10px] font-medium text-ink-muted">in use</span>
            <span title={candidate.author} className={`${READER_CHIP} ${SOURCE_STYLE[candidate.source]}`}>
              {readerName(candidate.source, candidate.author)}
            </span>
          </span>
          <ReadingActions candidate={candidate} canEdit={canEdit} onRelease={onRelease} onRemove={onRemove} />
        </div>
      ))}
      {offered.map((candidate) => {
        const takeable = canEdit
        return (
          <div key={candidate.id} data-testid="line-candidate" data-source={candidate.source}
               data-author={candidate.author}
               data-cursor={candidate.id === activeId || undefined}
               ref={(n) => { if (n && candidate.id === activeId) n.scrollIntoView({ block: 'nearest' }) }}
               className={`group flex items-start gap-1.5 rounded ${
                 // Stronger than the line it sits under, and outlined, which the line never
                 // is - so which of the two the keys are on is never a guess. An outline
                 // rather than a border because it takes no space and nothing shifts.
                 candidate.id === activeId
                   ? 'bg-accent-wash outline outline-1 outline-accent'
                   : ''}`}>
            <button
              type="button"
              data-testid={takeable ? 'accept-candidate' : undefined}
              disabled={!takeable}
              onClick={(e) => { e.stopPropagation(); onAccept(candidate) }}
              title={takeable ? `Use this reading (${candidate.author})` : candidate.author}
              className="flex min-w-0 flex-1 items-start gap-1.5 rounded px-0.5 text-left enabled:hover:bg-accent-wash"
            >
              <span data-testid="candidate-text"
                    title={`${candidate.author}: ${displayed(candidate.text)}`}
                    className="min-w-0 flex-1 whitespace-pre-wrap wrap-anywhere font-ocr text-xs text-ink-muted">
                {diffWords(baseline, candidate.text).map((piece, index) => (
                  <span key={index} data-changed={piece.changed || undefined}
                        className={piece.changed ? CHANGED : ''}>
                    {piece.text}
                  </span>
                ))}
              </span>
              {takeable && (
                // The hint for what a click on the row does, not the target itself.
                <span aria-hidden className="shrink-0 rounded px-1 text-[10px] font-medium text-accent-ink">
                  Use
                </span>
              )}
              <span data-testid="candidate-reader"
                    title={candidate.author}
                    className={`${READER_CHIP} ${SOURCE_STYLE[candidate.source]}`}>
                {readerName(candidate.source, candidate.author)}
              </span>
            </button>
            <ReadingActions candidate={candidate} canEdit={canEdit} onRelease={onRelease} onRemove={onRemove} />
          </div>
        )
      })}
    </div>
  )
}

function ReadingActions({ candidate, canEdit, onRelease, onRemove }: {
  candidate: LineCandidate
  canEdit: boolean
  onRelease?: (candidate: LineCandidate) => void
  onRemove?: (candidate: LineCandidate) => void
}) {
  if (!canEdit) return null
  return (
    <>
      {onRelease && candidate.id !== MACHINE_ID && (
        <button
          type="button"
          data-testid="release-candidate"
          onClick={(e) => { e.stopPropagation(); onRelease(candidate) }}
          title="Take this reading off the line and put it back in the list"
          aria-label="Release this reading"
          className="shrink-0 rounded px-0.5 text-ink-subtle hover:text-accent-ink"
        >
          <UnlinkIcon />
        </button>
      )}
      {onRemove && candidate.source === 'llm' && (
        <button
          type="button"
          data-testid="remove-candidate"
          onClick={(e) => { e.stopPropagation(); onRemove(candidate) }}
          title="Delete this language model reading for good"
          aria-label="Delete this reading"
          className="shrink-0 rounded px-0.5 text-ink-subtle hover:text-danger"
        >
          <TrashIcon />
        </button>
      )}
    </>
  )
}
