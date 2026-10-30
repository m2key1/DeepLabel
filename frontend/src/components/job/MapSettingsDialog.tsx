import { useState } from 'react'
import { TILE_SIZE_MAX, TILE_SIZE_MIN, renameJob, setJobProcessing } from '../../api'
import type { Job } from '../../api'
import { Modal, modalBtn, modalPrimaryBtn } from '../Modal'
import { Input } from '../ui/Field'

interface MapSettingsDialogProps {
  job: Job
  onClose: () => void
  onSaved: () => void
  onError: (message: string) => void
}

/** What a map dataset can change once it exists: its name, and the size it cuts the maps
 *  added from now on into. */
export function MapSettingsDialog({ job, onClose, onSaved, onError }: MapSettingsDialogProps) {
  const [name, setName] = useState(job.name)
  const [draft, setDraft] = useState(String(job.tile_size))
  const [busy, setBusy] = useState(false)
  const size = Number(draft)
  const sizeValid = !job.run_tile || (Number.isInteger(size) && size >= TILE_SIZE_MIN && size <= TILE_SIZE_MAX)
  const valid = name.trim() !== '' && sizeValid

  const save = async () => {
    setBusy(true)
    try {
      if (name.trim() !== job.name) await renameJob(job.id, name.trim())
      if (job.run_tile && size !== job.tile_size) await setJobProcessing(job.id, { tile_size: size })
      onClose()
      onSaved()
    } catch (e) {
      onError((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <Modal title="Settings" onClose={onClose}>
      <label htmlFor="map-settings-name" className="mb-1 block text-sm font-medium text-ink">Name</label>
      <Input id="map-settings-name" value={name} onChange={(e) => setName(e.target.value)}
             aria-invalid={name.trim() === ''} className="mb-4 w-full" />
      {job.run_tile && (<>
        <label className="mb-1 flex items-center gap-2 text-sm font-medium text-ink">
          Tile size
          <input
            type="number"
            data-testid="processing-tile-size"
            min={TILE_SIZE_MIN} max={TILE_SIZE_MAX} step={1}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            aria-invalid={!sizeValid}
            className="w-24 rounded border border-line-strong bg-surface px-2 py-1 text-sm font-normal focus-visible:border-accent focus:outline-none"
          />
          px
        </label>
        <p className="mb-3 text-xs text-ink-subtle">
          {TILE_SIZE_MIN} to {TILE_SIZE_MAX} px square, for the maps added from now on. Tiles already
          cut keep their size and their annotations.
        </p>
      </>)}
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
