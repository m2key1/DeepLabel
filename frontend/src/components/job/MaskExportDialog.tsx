import { useEffect, useState } from 'react'
import { maskExportPreview, maskExportWrite } from '../../api'
import type { MaskManifest } from '../../api'
import { Modal, modalBtn, modalPrimaryBtn } from '../Modal'

interface MaskExportDialogProps {
  jobId: string
  // Only a job that cut its own tiles has source maps to fuse them back into.
  canFuse: boolean
  onClose: () => void
  onError: (message: string) => void
}

export function MaskExportDialog({ jobId, canFuse, onClose, onError }: MaskExportDialogProps) {
  const [fused, setFused] = useState(false)
  const [preview, setPreview] = useState<MaskManifest | null>(null)
  const [written, setWritten] = useState<MaskManifest | null>(null)

  useEffect(() => {
    setPreview(null)
    maskExportPreview(jobId, fused).then(setPreview).catch((e: Error) => onError(e.message))
  }, [jobId, fused, onError])

  const write = () => {
    maskExportWrite(jobId, fused)
      .then(setWritten)
      .catch((e: Error) => onError(e.message))
  }

  // The two variants write different directories, so a result from one says nothing about
  // the other - switching has to clear it, or the success line names the wrong export.
  const pickVariant = (next: boolean) => {
    setFused(next)
    setWritten(null)
  }

  const empty = fused ? !preview?.maps : !preview?.tiles

  return (
    <Modal title="Export mask set" onClose={onClose}>
      {canFuse && (
        <div className="mb-3 flex flex-col gap-1 text-sm text-ink">
          <label className="flex items-center gap-1.5">
            <input type="radio" checked={!fused} onChange={() => pickVariant(false)} />
            Per-tile masks
          </label>
          <label className="flex items-center gap-1.5">
            <input type="radio" data-testid="mask-export-fused" checked={fused}
                   onChange={() => pickVariant(true)} />
            Full-map masks - tiles stitched back into their source map
          </label>
        </div>
      )}
      {preview === null ? (
        <p className="mb-3 text-sm text-ink-muted">Checking what this exports…</p>
      ) : (
        <div data-testid="mask-export-preview" data-tiles={preview.tiles} data-regions={preview.regions}
             data-maps={preview.maps} className="mb-3 space-y-1 text-sm text-ink-muted">
          <p>
            {fused ? (
              <>
                Writes {preview.maps ?? 0} full map(s) - a class-index PNG mask at the original map
                size and a geometry JSON sidecar each, fused from {preview.tiles} reviewed
                tile(s) ({preview.regions} region(s) total) - plus a class map.
              </>
            ) : (
              <>
                Writes {preview.tiles} reviewed tile(s) - a class-index PNG mask and a geometry JSON
                sidecar each ({preview.regions} region(s) total) - plus a class map.
              </>
            )}
          </p>
          <p className="font-mono text-xs break-all text-ink-muted">{preview.dest}</p>
          {fused && !!preview.maps_skipped && (
            <p className="text-warn">
              {preview.maps_skipped} map(s) skipped - none of their tiles are marked reviewed.
            </p>
          )}
          {empty && (
            <p className="text-warn">
              No tiles are marked reviewed yet - nothing would be written.
            </p>
          )}
        </div>
      )}
      {written && (
        <p data-testid="mask-export-written" data-tiles={written.tiles}
           className="mb-3 text-sm text-ok">
          {fused
            ? `Wrote ${written.maps ?? 0} full map(s) to ${written.dest}.`
            : `Wrote ${written.tiles} tile(s) to ${written.dest}.`}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className={modalBtn}>
          Close
        </button>
        <button disabled={empty || written !== null} onClick={write}
                className={`${modalPrimaryBtn} disabled:opacity-40`}>
          Write to server
        </button>
      </div>
    </Modal>
  )
}
