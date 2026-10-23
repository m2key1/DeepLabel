import { redetectLines, setAutoRedetect } from '../../api'
import type { StaleLines } from '../../api'
import { Modal, modalBtn, modalDangerBtn, modalPrimaryBtn } from '../Modal'

interface RedetectDialogProps {
  jobId: string
  stale: StaleLines
  autoRedetect: boolean
  onAutoRedetect: (value: boolean) => void
  onClose: () => void
  onDone: () => void
  onError: (message: string) => void
}

export function RedetectDialog({
  jobId, stale, autoRedetect, onAutoRedetect, onClose, onDone, onError,
}: RedetectDialogProps) {
  const run = () => {
    onClose()
    redetectLines(jobId).then(onDone).catch((e: Error) => onError(e.message))
  }

  return (
    <Modal title="Re-detect lines" onClose={onClose}>
      <div className="mb-3 space-y-1 text-sm text-ink-muted">
        <p>
          {stale.elements} box(es) across {stale.pages} page(s) have been drawn or reshaped since their
          lines were detected. Their lines will be found again and re-read.
        </p>
        {stale.corrected > 0 && (
          <p data-testid="redetect-corrections">
            {stale.corrected} correction(s) inside those boxes are kept and re-attached, verified
            again only where the box barely moved.
          </p>
        )}
        {stale.hand_edited > 0 && (
          <p className="text-warn">
            {stale.hand_edited} hand-edited line(s) are replaced. Their text is kept.
          </p>
        )}
      </div>
      <label className="mb-3 flex cursor-pointer items-center gap-2 text-sm text-ink-muted">
        <input
          type="checkbox"
          checked={autoRedetect}
          onChange={(e) => {
            onAutoRedetect(e.target.checked)
            setAutoRedetect(jobId, e.target.checked).catch((err: Error) => onError(err.message))
          }}
          className="cursor-pointer accent-accent"
        />
        Auto re-detect lines when a box is resized (whole job)
      </label>
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className={modalBtn}>
          Cancel
        </button>
        <button onClick={run} className={stale.hand_edited > 0 ? modalDangerBtn : modalPrimaryBtn}>
          Re-detect
        </button>
      </div>
    </Modal>
  )
}
