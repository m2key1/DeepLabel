import type { LineCandidate } from '../../api'
import { displayed } from '../../lib/text'
import { CaretIcon } from '../icons'
import { READER_CHIP } from './LineCandidates'
import { readerName } from './readers'

interface UnmatchedReadingsProps {
  readings: LineCandidate[]
  /** Folded down to the count, or the readings themselves. */
  open: boolean
  onToggle: () => void
  /** The one waiting for a line, from a click. A drag carries its own. */
  armed: LineCandidate | null
  canEdit: boolean
  onArm: (candidate: LineCandidate | null) => void
}

/** What a language model transcribed that the matcher could place on no line - usually a
 *  line the segmentation missed, or the page number. Drag one onto a line to say where it
 *  belongs; clicking arms it instead, so the same thing can be done from the keyboard. */
export function UnmatchedReadings({ readings, open, onToggle, armed, canEdit, onArm }: UnmatchedReadingsProps) {
  return (
    <div data-testid="unmatched-readings"
         className="mb-2 rounded border border-warn p-1.5">
      <button type="button" data-testid="unmatched-toggle" aria-expanded={open} onClick={onToggle}
              className="flex w-full items-center gap-1 text-left text-xs font-medium text-warn">
        <span className={open ? '' : '-rotate-90'}><CaretIcon /></span>
        {readings.length} reading{readings.length === 1 ? '' : 's'} matched no line
      </button>
      {open && canEdit && (
        <p className="mb-1 mt-0.5 text-xs text-ink-muted">
          {armed
            ? 'Now click the line it belongs to, or Esc to stop.'
            : 'Drag one onto its line, or click it and then the line.'}
        </p>
      )}
      {open && <div className="space-y-0.5">
        {readings.map((candidate) => {
          const on = armed?.id === candidate.id
          return (
            <button
              key={candidate.id}
              type="button"
              disabled={!canEdit}
              draggable={canEdit}
              data-testid="unmatched-reading"
              data-author={candidate.author}
              aria-pressed={on}
              onDragStart={(e) => {
                // Firefox starts no drag at all without a payload, whatever it is.
                e.dataTransfer.setData('text/plain', candidate.text)
                e.dataTransfer.effectAllowed = 'copy'
                onArm(candidate)
              }}
              onDragEnd={() => onArm(null)}
              onClick={() => onArm(on ? null : candidate)}
              title={canEdit
                ? `${candidate.author}: ${displayed(candidate.text)}`
                : `${candidate.author}: ${displayed(candidate.text)} (read-only)`}
              className={`flex w-full min-w-0 items-center gap-1.5 rounded px-0.5 text-left ${
                on
                  ? 'bg-accent-wash'
                  : 'enabled:cursor-grab enabled:hover:bg-warn/15'
              }`}
            >
              <span className={`${READER_CHIP} bg-series-7/15 text-series-7`}>
                {readerName(candidate.source, candidate.author)}
              </span>
              <span className="min-w-0 flex-1 truncate font-ocr text-xs text-ink-muted">
                {displayed(candidate.text)}
              </span>
            </button>
          )
        })}
      </div>}
    </div>
  )
}
