import type { Line } from '../../api'
import { displayed } from '../../lib/text'
import { Button } from '../ui/Button'

export interface Conflict {
  lineId: number
  author: string | null
  theirs: Line
  mine: string
}

interface LineConflictProps {
  conflict: Conflict
  busy: boolean
  onKeepTheirs: () => void
  onUseMine: () => void
}

// Shown when a save was refused because someone else changed the line first. Both
// readings side by side, and the choice is the person's - nothing is written until
// they pick.
export function LineConflict({ conflict, busy, onKeepTheirs, onUseMine }: LineConflictProps) {
  const theirs = displayed(conflict.theirs.corrected_text ?? conflict.theirs.text ?? '')
  const who = conflict.author ?? 'Someone'
  return (
    <div
      data-testid="line-conflict"
      role="alertdialog"
      aria-label="Line changed by someone else"
      className="mb-3 rounded border border-warn bg-warn/10 p-3 text-sm"
    >
      <p className="mb-2 font-medium text-warn">
        {who} changed this line while you were editing it.
      </p>
      <dl className="mb-3 grid gap-1 sm:grid-cols-[auto_1fr] sm:gap-x-3">
        <dt className="text-xs uppercase tracking-wide text-warn/70">Theirs</dt>
        <dd data-testid="conflict-theirs" className="font-ocr break-words">{theirs}</dd>
        <dt className="text-xs uppercase tracking-wide text-warn/70">Yours</dt>
        <dd data-testid="conflict-mine" className="font-ocr break-words">{displayed(conflict.mine)}</dd>
      </dl>
      <div className="flex gap-2">
        <Button size="xs" variant="primary" disabled={busy} onClick={onKeepTheirs}>
          Keep theirs
        </Button>
        <Button size="xs" disabled={busy} onClick={onUseMine}>
          Overwrite with mine
        </Button>
      </div>
    </div>
  )
}
