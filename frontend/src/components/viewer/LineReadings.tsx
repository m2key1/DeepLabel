import type { LineCandidate } from '../../api'
import { commonest, diffWords } from './diff'

export interface Reading {
  key: string
  reader: string
  text: string
  source: LineCandidate['source']
  /** The candidate behind a stored reading; absent for the line's own OCR. */
  candidateId?: number
}

const CHANGED = 'rounded-sm bg-warn/30'

/** What the readers said, weighed the way agreement is. The local OCR model does not vote
 *  unless the dataset says it may, so a line it alone reads differently is still measured
 *  against the models that agree - it is shown either way. */
function agreed(readings: Reading[], withOcr: boolean): string {
  const models = readings.filter((r) => r.source === 'llm')
  const voting = models.length === 0
    ? readings
    : withOcr
      ? readings.filter((r) => r.source === 'llm' || r.source === 'ocr')
      : models
  return commonest(voting.map((r) => r.text))
}

/** Every reader's transcription of one line, side by side, with what they disagree on
 *  marked. Shown on the agreement badge, which says how many agree but not on what. */
export function LineReadings({ readings, withOcr = false, onRemove }: {
  readings: Reading[]
  /** Whether this dataset counts Deep OCR among the voices, so the baseline is the one
   *  the line actually settled on. */
  withOcr?: boolean
  /** Delete a language model's reading for good; given only where that is allowed. */
  onRemove?: (reading: Reading) => void
}) {
  const baseline = agreed(readings, withOcr)
  return (
    <div
      data-testid="line-readings"
      className="w-[30rem] max-w-[80vw] rounded-md border border-line bg-surface p-2 text-xs shadow-lg"
    >
      {readings.map((reading) => (
        <div key={reading.key} data-testid="line-reading" data-reader={reading.reader}
             className="flex gap-2 py-0.5">
          <span className="w-24 shrink-0 truncate text-ink-muted">
            {reading.reader}
          </span>
          <span className="min-w-0 flex-1 font-ocr text-ink">
            {diffWords(baseline, reading.text).map((piece, index) => (
              <span key={index} data-changed={piece.changed || undefined}
                    className={piece.changed ? CHANGED : ''}>
                {piece.text}
              </span>
            ))}
          </span>
          {onRemove && reading.source === 'llm' && reading.candidateId !== undefined && (
            <button type="button" data-testid="remove-reading" onClick={() => onRemove(reading)}
                    title="Delete this language model reading for good"
                    className="shrink-0 rounded px-1 text-[10px] text-ink-subtle hover:text-danger">
              Delete
            </button>
          )}
        </div>
      ))}
    </div>
  )
}
