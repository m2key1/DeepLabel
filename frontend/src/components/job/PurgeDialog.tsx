import { useEffect, useState } from 'react'
import { purgePages, purgePreview } from '../../api'
import type { PurgeManifest } from '../../api'
import { humanBytes } from '../../util'
import { Modal, modalBtn, modalDangerBtn } from '../Modal'

interface PurgeDialogProps {
  jobId: string
  onClose: () => void
  onPurged: () => void
  onError: (message: string) => void
}

export function PurgeDialog({ jobId, onClose, onPurged, onError }: PurgeDialogProps) {
  const [preview, setPreview] = useState<PurgeManifest | null>(null)
  const [purged, setPurged] = useState<PurgeManifest | null>(null)

  useEffect(() => {
    purgePreview(jobId).then(setPreview).catch((e: Error) => onError(e.message))
  }, [jobId, onError])

  const run = () => {
    purgePages(jobId)
      .then((m) => {
        setPurged(m)
        onPurged()
      })
      .catch((e: Error) => onError(e.message))
  }

  return (
    <Modal title="Purge deleted pages" onClose={onClose}>
      {preview === null ? (
        <p className="mb-3 text-sm text-ink-muted">Checking what this frees…</p>
      ) : (
        <div className="mb-3 space-y-1 text-sm text-ink-muted">
          <p>
            Permanently deletes {preview.files} image file(s) for {preview.pages} page(s), freeing{' '}
            {humanBytes(preview.bytes)}. The page rows, their annotations, corrections and history stay.
          </p>
          {preview.external_sources > 0 && (
            <p>
              {preview.external_sources} page(s) reference scans outside the app; those files are left
              untouched.
            </p>
          )}
          <p className="text-warn">
            This cannot be undone - purged pages can no longer be restored.
          </p>
        </div>
      )}
      {purged && (
        <p className="mb-3 text-sm text-ok">
          Freed {humanBytes(purged.bytes)}
          {purged.pairs_written ? `, kept ${purged.pairs_written} correction pair(s)` : ''}.
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className={modalBtn}>
          Close
        </button>
        <button disabled={!preview?.files || purged !== null} onClick={run}
                className={`${modalDangerBtn} disabled:opacity-40`}>
          Purge
        </button>
      </div>
    </Modal>
  )
}
