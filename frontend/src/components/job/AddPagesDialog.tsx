import { useState } from 'react'
import { addPagesFromPath } from '../../api'
import { Modal, modalBtn, modalPrimaryBtn } from '../Modal'
import { SkippedSymlinks } from './SkippedSymlinks'

interface AddPagesDialogProps {
  jobId: string
  isMap?: boolean
  onClose: () => void
  onAdded: () => void
  onError: (message: string) => void
}

export function AddPagesDialog({ jobId, isMap = false, onClose, onAdded, onError }: AddPagesDialogProps) {
  const [path, setPath] = useState('')
  const [busy, setBusy] = useState(false)
  const [skipped, setSkipped] = useState<string[]>([])

  const add = async () => {
    setBusy(true)
    try {
      const res = await addPagesFromPath(jobId, path.trim())
      onAdded()
      if (res.skipped_symlinks.length > 0) setSkipped(res.skipped_symlinks)
      else onClose()
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const title = isMap ? 'Add tiles from a server path' : 'Add pages from a server path'
  if (skipped.length > 0) {
    return (
      <Modal title={title} onClose={onClose}>
        <div className="mb-3">
          <SkippedSymlinks paths={skipped} />
        </div>
        <div className="flex justify-end">
          <button onClick={onClose} className={modalPrimaryBtn}>
            Close
          </button>
        </div>
      </Modal>
    )
  }

  return (
    <Modal title={title} onClose={onClose}>
      <p className="mb-3 text-sm text-ink-muted">
        {isMap
          ? 'A directory on the backend host with map tiles (PNG/JPG). Existing tiles are untouched; the new ones are ingested.'
          : 'A directory on the backend host with images or PDFs. Existing pages are untouched; the new ones run through the pipeline. A .txt next to an image with the same name is used as that page’s transcription.'}
      </p>
      <input
        autoFocus
        value={path}
        onChange={(e) => setPath(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && path.trim()) add()
        }}
        placeholder="/absolute/path/on/server"
        className="mb-3 w-full rounded border border-line-strong bg-surface px-2 py-1.5 text-sm focus-visible:border-accent focus:outline-none"
      />
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className={modalBtn}>
          Cancel
        </button>
        <button
          disabled={busy || path.trim() === ''}
          onClick={add}
          className={`${modalPrimaryBtn} disabled:opacity-40`}
        >
          {busy ? 'Adding…' : 'Add'}
        </button>
      </div>
    </Modal>
  )
}
