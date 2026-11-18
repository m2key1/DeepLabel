import { useState } from 'react'
import type { MouseEvent } from 'react'
import { takeReading, uncheckLine } from '../../api'
import type { EvalLine } from '../../api'
import { Button } from '../ui/Button'

type Outcome = 'taken' | 'unchecked'

const OUTCOME_LABELS: Record<Outcome, string> = { taken: 'Reading taken', unchecked: 'Unchecked' }

/** What a person may do with a scored line, one deliberate click each: take the reading as
 *  its text, keeping it checked, or leave it out of training. A line edited since it was
 *  read offers neither - the reading may be of text that is no longer there. */
export function LineActions({ line }: { line: EvalLine }) {
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (outcome) {
    return <span data-testid="line-fixed" data-outcome={outcome} className="text-xs text-ok">{OUTCOME_LABELS[outcome]}</span>
  }
  if (line.line.changed) return <span data-testid="line-changed" className="text-xs text-ink-subtle">Edited since</span>
  if (!line.line.checked) return null

  const act = (next: Outcome, call: () => Promise<unknown>) => (e: MouseEvent) => {
    e.stopPropagation()
    setBusy(true)
    setError(null)
    call().then(() => setOutcome(next)).catch((err: Error) => setError(err.message)).finally(() => setBusy(false))
  }
  return (
    <span className="flex items-center justify-end gap-1">
      {line.reading.prediction !== line.ground_truth && (
        <Button size="xs" variant="ghost" disabled={busy} data-testid="take-reading"
                onClick={act('taken', () => takeReading(line.line_id, line.reading.prediction, line.line.revision))}>
          Use reading
        </Button>
      )}
      <Button size="xs" variant="ghost" disabled={busy} data-testid="uncheck-line"
              onClick={act('unchecked', () => uncheckLine(line.line_id, line.line.revision))}>
        Uncheck
      </Button>
      {error && <span role="alert" className="text-xs text-danger">{error}</span>}
    </span>
  )
}
