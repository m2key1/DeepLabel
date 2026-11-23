import { useEffect, useState } from 'react'
import { rerunJob, rerunPreview } from '../../api'
import type { MissedStep, RerunPhase, RerunPreview, StepsNotRun } from '../../api'
import { plural } from '../../util'
import { Modal, modalBtn, modalDangerBtn, modalPrimaryBtn } from '../Modal'
import { CheckField } from '../ui/Field'

interface RerunDialogProps {
  jobId: string
  jobName: string
  layoutOn: boolean
  /** Pages each step has not run on; opened from the banner that names them, the dialog
   *  starts on the first such step with only those pages ticked. */
  notRun?: StepsNotRun
  startOnMissing?: boolean
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

// Re-running layout would switch it back on, so while it is off the first phase on offer
// starts the pages over without it instead.
const FIRST_PHASE: Record<'on' | 'off', [RerunPhase, string, string]> = {
  on: ['layout', 'Layout', 'redo layout, lines and OCR'],
  off: ['start', 'From the start, without layout', 'drop the boxes, redo lines on the whole page and OCR'],
}

export const MISSED_STEPS: MissedStep[] = ['layout', 'lines', 'ocr']
export const STEP_NAME: Record<MissedStep, string> = { layout: 'layout', lines: 'line detection', ocr: 'OCR' }

export function RerunDialog({
  jobId, jobName, layoutOn, notRun, startOnMissing = false, onClose, onDone, onError,
}: RerunDialogProps) {
  const first = FIRST_PHASE[layoutOn ? 'on' : 'off']
  const firstMissed = MISSED_STEPS.find((step) => (notRun?.[step] ?? 0) > 0)
  const [from, setFrom] = useState<RerunPhase>(startOnMissing && firstMissed ? firstMissed : 'lines')
  const [loss, setLoss] = useState<RerunPreview | null>(null)
  const [keepChecked, setKeepChecked] = useState(true)
  const [keepText, setKeepText] = useState(true)
  const [onlyMissing, setOnlyMissing] = useState(startOnMissing && firstMissed !== undefined)
  const missed = (MISSED_STEPS as RerunPhase[]).includes(from) ? notRun?.[from as MissedStep] ?? 0 : 0
  const scoped = onlyMissing && missed > 0

  useEffect(() => {
    setLoss(null)
    rerunPreview(jobId, from as MissedStep, scoped).then(setLoss).catch((e: Error) => onError(e.message))
  }, [jobId, from, scoped, onError])

  // Which second choice the phase asks for, if any. Alignment reads what is there and
  // replaces nothing, so it asks nothing.
  const choices = from === 'ocr' ? OCR_CHOICES : from === 'align' ? null : DETECT_CHOICES
  const chosen = from === 'ocr' ? keepChecked : keepText
  const pick = from === 'ocr' ? setKeepChecked : setKeepText
  const destructive = choices !== null && !chosen
  // Dropping the boxes of pages somebody marked complete is the one re-run the backend
  // refuses without `force`, and `force` is a discard - so it is sent only then.
  const dropsBoxes = from === 'layout' || from === 'start'
  const pastSignOff = dropsBoxes && (loss?.layout_checked ?? 0) > 0

  const run = () => {
    onClose()
    rerunJob(jobId, from, pastSignOff, { keepChecked, keepText, onlyMissing: scoped })
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
        ] as [RerunPhase, string, string][]).map(([v, label, hint]) => (
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
      {missed > 0 && (
        <div className="mb-3">
          <CheckField data-testid="rerun-only-missing"
                      label={`Only the ${plural(missed, 'page')} ${STEP_NAME[from as MissedStep]} has not run on`}
                      help="The pages it has run on keep what they have"
                      checked={onlyMissing} onChange={setOnlyMissing} />
        </div>
      )}
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
          {choices.map((c) => (
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
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className={modalBtn}>
          Cancel
        </button>
        <button onClick={run} data-testid="rerun-confirm" disabled={loss === null}
                className={destructive || pastSignOff ? modalDangerBtn : modalPrimaryBtn}>
          Re-run
        </button>
      </div>
    </Modal>
  )
}
