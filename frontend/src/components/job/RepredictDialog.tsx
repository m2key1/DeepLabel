import { useEffect, useState } from 'react'
import { repredictJob, repredictPreview } from '../../api'
import type { RepredictScope } from '../../api'
import { Modal, modalBtn, modalPrimaryBtn } from '../Modal'

interface RepredictDialogProps {
  jobId: string
  onClose: () => void
  onDone: () => void
  onError: (message: string) => void
}

export function RepredictDialog({ jobId, onClose, onDone, onError }: RepredictDialogProps) {
  const [force, setForce] = useState(false)
  const [scope, setScope] = useState<RepredictScope | null>(null)

  useEffect(() => {
    repredictPreview(jobId, force).then(setScope).catch((e: Error) => onError(e.message))
  }, [jobId, force, onError])

  const run = () => {
    onClose()
    repredictJob(jobId, force)
      .then(onDone)
      .catch((e: Error) => onError(e.message))
  }

  return (
    <Modal title="Re-predict tiles" onClose={onClose}>
      <p className="mb-3 text-sm text-ink-muted">
        {scope === null
          ? 'Checking what this discards…'
          : `Re-runs the segmentation model on ${scope.tiles} tile(s). ${scope.regions_discard} model annotation(s) will be discarded; ${scope.regions_kept} human-edited annotation(s) are kept.`}
      </p>
      {scope !== null && scope.reviewed > 0 && (
        <label className="mb-3 flex cursor-pointer items-start gap-2 text-sm text-warn">
          <input
            type="checkbox"
            checked={force}
            onChange={(e) => setForce(e.target.checked)}
            className="mt-0.5 cursor-pointer accent-accent"
          />
          <span>
            {scope.reviewed} reviewed tile(s) are skipped by default. Include them (their reviewed
            flag is cleared).
          </span>
        </label>
      )}
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className={modalBtn}>
          Cancel
        </button>
        <button disabled={!scope?.tiles} onClick={run} className={`${modalPrimaryBtn} disabled:opacity-40`}>
          Re-predict
        </button>
      </div>
    </Modal>
  )
}
