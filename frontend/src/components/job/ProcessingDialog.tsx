import { useState } from 'react'
import { TILE_SIZE_MAX, TILE_SIZE_MIN, setJobProcessing } from '../../api'
import type { Job } from '../../api'
import { Modal, modalBtn, modalPrimaryBtn } from '../Modal'

interface ProcessingDialogProps {
  job: Job
  onClose: () => void
  onSaved: () => void
  onError: (message: string) => void
}

/** The size a map dataset cuts its maps into, for the maps added from now on - the one
 *  setting of a map dataset that can change once it exists. */
export function ProcessingDialog({ job, onClose, onSaved, onError }: ProcessingDialogProps) {
  const [draft, setDraft] = useState(String(job.tile_size))
  const [busy, setBusy] = useState(false)
  const size = Number(draft)
  const valid = Number.isInteger(size) && size >= TILE_SIZE_MIN && size <= TILE_SIZE_MAX

  const save = async () => {
    setBusy(true)
    try {
      await setJobProcessing(job.id, { tile_size: size })
      onClose()
      onSaved()
    } catch (e) {
      onError((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <Modal title="How this dataset is processed" onClose={onClose}>
      <p className="mb-3 text-sm text-ink-muted">
        The tile size applies to the maps added from now on. Tiles already cut keep their size
        and their annotations.
      </p>
      <label className="mb-1 flex items-center gap-2 text-sm font-medium text-ink">
        Tile size
        <input
          type="number"
          data-testid="processing-tile-size"
          min={TILE_SIZE_MIN} max={TILE_SIZE_MAX} step={1}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          aria-invalid={!valid}
          className="w-24 rounded border border-line-strong bg-surface px-2 py-1 text-sm font-normal focus-visible:border-accent focus:outline-none"
        />
        px
      </label>
      <p className="mb-3 text-xs text-ink-subtle">{TILE_SIZE_MIN} to {TILE_SIZE_MAX} px square.</p>
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className={modalBtn}>Cancel</button>
        <button onClick={save} disabled={busy || !valid} data-testid="processing-save"
                className={modalPrimaryBtn}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </Modal>
  )
}

/** Which phases this dataset runs, and where its lines are looked for. Both were settled
 *  when it was created, so a dataset could never be moved between per-crop and per-page
 *  once its first run had happened. */
