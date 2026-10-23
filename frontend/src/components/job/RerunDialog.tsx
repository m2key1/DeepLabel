import { useEffect, useState } from 'react'
import { PHASE_CAPABILITY, rerunJob, rerunPreview } from '../../api'
import type { RerunPhase, RerunPreview } from '../../api'
import { Modal, modalBtn, modalDangerBtn, modalPrimaryBtn } from '../Modal'
import { useAuth } from '../../auth'

interface RerunDialogProps {
  jobId: string
  jobName: string
  layoutOn: boolean
  onClose: () => void
  onDone: () => void
  onError: (message: string) => void
}

/** One choice per phase, always with the careful answer first. What it costs is spelled
 *  out beside it in the counts this dataset actually holds, because "re-run" means a
 *  different thing to a page nobody has read and to one somebody has signed off. */
type Choice = { value: boolean; label: string; cost: (loss: RerunPreview) => string; warn?: boolean }

const OCR_CHOICES: Choice[] = [
  { value: true, label: 'Re-read the lines nobody has checked',
    cost: (l) => `${(l.lines - l.checked).toLocaleString()} lines · ${l.checked.toLocaleString()} checked left as they are` },
  { value: false, label: 'Re-read everything, checked lines too',
    cost: (l) => `${l.lines.toLocaleString()} lines · ${l.checked.toLocaleString()} checked and ${l.corrected.toLocaleString()} corrected are cleared`,
    warn: true },
]

const DETECT_CHOICES: Choice[] = [
  { value: true, label: 'Detect again, and re-offer the text on what it finds',
    cost: (l) => `${l.corrected.toLocaleString()} corrected and ${l.checked.toLocaleString()} checked go to the pool` },
  { value: false, label: 'Detect again and start the pages clean',
    cost: (l) => `${l.corrected.toLocaleString()} corrected and ${l.checked.toLocaleString()} checked are not offered again`,
    warn: true },
]

const RERUN_CAPABILITY: Record<Exclude<RerunPhase, 'align'>, string> = {
  ...PHASE_CAPABILITY, start: PHASE_CAPABILITY.layout,
}

// Re-running layout would switch it back on, so while it is off the first phase on offer
// starts the pages over without it instead.
const FIRST_PHASE: Record<'on' | 'off', [RerunPhase, string, string]> = {
  on: ['layout', 'Layout', 'redo layout, lines and OCR'],
  off: ['start', 'From the start, without layout', 'drop the boxes, redo lines on the whole page and OCR'],
}

export function RerunDialog({ jobId, jobName, layoutOn, onClose, onDone, onError }: RerunDialogProps) {
  const { can } = useAuth()
  const mayRun = (phase: RerunPhase) => phase === 'align' || can(RERUN_CAPABILITY[phase])
  const first = FIRST_PHASE[layoutOn ? 'on' : 'off']
  const [from, setFrom] = useState<RerunPhase>(() => (['lines', 'ocr', first[0], 'align'] as RerunPhase[]).find(mayRun) ?? 'align')
  const [loss, setLoss] = useState<RerunPreview | null>(null)
  const [keepChecked, setKeepChecked] = useState(true)
  const [keepText, setKeepText] = useState(true)

  useEffect(() => {
    rerunPreview(jobId).then(setLoss).catch((e: Error) => onError(e.message))
  }, [jobId, onError])

  // Which second choice the phase asks for, if any. Alignment reads what is there and
  // replaces nothing, so it asks nothing.
  const choices = from === 'ocr' ? OCR_CHOICES : from === 'align' ? null : DETECT_CHOICES
  const chosen = from === 'ocr' ? keepChecked : keepText
  const pick = from === 'ocr' ? setKeepChecked : setKeepText
  const destructive = choices !== null && !chosen
  // Throwing away what somebody checked is a permission of its own; without it the
  // careful answer is the only one on offer.
  const mayDiscard = can('pipeline.discard')
  // Dropping the boxes of pages somebody marked complete is the one re-run the backend
  // refuses without `force`, and `force` is a discard - so it is sent only then.
  const dropsBoxes = from === 'layout' || from === 'start'
  const pastSignOff = dropsBoxes && (loss?.layout_checked ?? 0) > 0
  const refused = pastSignOff && !mayDiscard

  const run = () => {
    onClose()
    rerunJob(jobId, from, pastSignOff, { keepChecked, keepText })
      .then(onDone)
      .catch((e: Error) => onError(e.message))
  }

  return (
    <Modal title={`Re-run "${jobName}"`} onClose={onClose}>
      <div className="mb-3 space-y-1.5 text-sm">
        {([
          first,
          ['lines', 'Lines', 'redo line detection and OCR'],
          ['ocr', 'OCR', 'redo OCR only'],
          ['align', 'Alignment', 're-match the transcriptions, keep the OCR'],
        ] as [RerunPhase, string, string][]).filter(([v]) => mayRun(v)).map(([v, label, hint]) => (
          <label key={v} className="flex cursor-pointer items-center gap-2">
            <input
              type="radio"
              data-testid="rerun-phase"
              data-phase={v}
              checked={from === v}
              onChange={() => setFrom(v)}
              className="cursor-pointer accent-accent"
            />
            <span className="font-medium">{label}</span>
            <span className="text-ink-muted">- {hint}</span>
          </label>
        ))}
      </div>
      {loss === null ? (
        <p className="mb-3 text-sm text-ink-muted">Checking what this discards…</p>
      ) : choices === null ? (
        <p className="mb-3 text-sm text-ink-muted">
          Nothing is discarded: the {loss.lines.toLocaleString()} lines keep their text, and the
          transcriptions are matched to them again under this dataset's current settings. Lines
          already checked are left as they are.
        </p>
      ) : (
        <div data-testid="rerun-choices" className="mb-3 space-y-1.5 border-t border-line pt-3 text-sm">
          {from !== 'ocr' && (
            <p className="mb-2 text-ink-muted">
              Detection replaces every line on {loss.lines.toLocaleString()} of them; the rows
              themselves stay in the history either way.
            </p>
          )}
          {choices.filter((c) => c.value || mayDiscard).map((c) => (
            <label key={String(c.value)} className="flex cursor-pointer items-start gap-2">
              <input
                type="radio"
                data-testid="rerun-choice"
                data-keep={String(c.value)}
                checked={chosen === c.value}
                onChange={() => pick(c.value)}
                className="mt-1 cursor-pointer accent-accent"
              />
              <span className="min-w-0">
                <span className="font-medium">{c.label}</span>
                <span className={`block text-xs ${c.warn ? 'text-warn' : 'text-ink-muted'}`}>
                  {c.cost(loss)}
                </span>
              </span>
            </label>
          ))}
        </div>
      )}
      {dropsBoxes && loss !== null && (loss.layout_checked > 0 || loss.elements_edited > 0) && (
        <p className="mb-3 text-sm text-warn">
          {loss.layout_checked} page(s) are marked layout complete and {loss.elements_edited} box(es)
          were edited by hand. Re-running retires them - the edits stay in the history, but the boxes are replaced
          and the pages stop being export-eligible.
          {refused && ' Re-running past a sign-off needs the permission to discard, which you do not have.'}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className={modalBtn}>
          Cancel
        </button>
        <button onClick={run} data-testid="rerun-confirm" disabled={loss === null || refused}
                className={destructive || pastSignOff ? modalDangerBtn : modalPrimaryBtn}>
          Re-run
        </button>
      </div>
    </Modal>
  )
}
