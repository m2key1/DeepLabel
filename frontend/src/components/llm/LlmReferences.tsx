import { useCallback, useEffect, useRef, useState } from 'react'
import {
  addLlmReference, deleteLlmReference, listLlmReferences, llmReferenceImageUrl,
} from '../../api'
import type { LlmReferenceList } from '../../api'
import { Button } from '../ui/Button'
import { humanBytes } from '../../util'

interface LlmReferencesProps {
  /** Omitted for the caller's own default set; given for a dataset's own. */
  jobId?: string
  canEdit: boolean
  /** Heading, for a caller that already says whose pictures these are. */
  label?: string
  onError: (message: string) => void
  /** Reports what is on show, for a caller summarising it while collapsed. */
  onSummary?: (summary: { count: number; inherited: boolean }) => void
}

/** The pictures the models are shown before each page: a chart of the glyphs a corpus
 *  prints, a specimen alphabet. Sent in the order listed, so a prompt saying "the first
 *  image is a reference chart" is describing where they actually land. */
export function LlmReferences({
  jobId, canEdit, label = 'Shown to the models', onError, onSummary,
}: LlmReferencesProps) {
  const [listing, setListing] = useState<LlmReferenceList | null>(null)
  const [busy, setBusy] = useState(false)
  const picker = useRef<HTMLInputElement>(null)

  const refresh = useCallback(() => {
    listLlmReferences(jobId).then(setListing).catch((e: Error) => onError(e.message))
  }, [jobId, onError])

  useEffect(refresh, [refresh])

  useEffect(() => {
    if (listing) onSummary?.({ count: listing.references.length, inherited: listing.inherited })
  }, [listing, onSummary])

  const upload = async (files: FileList | null) => {
    if (!files?.length) return
    setBusy(true)
    try {
      for (const file of Array.from(files)) await addLlmReference(file, jobId)
      refresh()
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setBusy(false)
      if (picker.current) picker.current.value = ''
    }
  }

  const remove = async (referenceId: number) => {
    try {
      await deleteLlmReference(referenceId)
      refresh()
    } catch (e) {
      onError((e as Error).message)
    }
  }

  if (!listing) return null
  const { references, inherited, limit } = listing
  return (
    <div data-testid="llm-references" data-inherited={inherited || undefined}>
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <span className="text-sm">{label}</span>
        <span className="text-xs text-ink-muted">
          {references.length === 0
            ? 'nothing - the page only'
            : inherited
              ? `${references.length} from your default`
              : `${references.length} of ${limit}`}
        </span>
        {canEdit && references.length < limit && (
          <Button size="xs" disabled={busy} data-testid="add-llm-reference"
                  onClick={() => picker.current?.click()}>
            {busy ? 'Adding…' : 'Add image'}
          </Button>
        )}
        <input
          ref={picker}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          multiple
          hidden
          aria-label="Reference image"
          data-testid="llm-reference-file"
          onChange={(e) => upload(e.target.files)}
        />
      </div>
      {references.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {references.map((reference) => (
            <li
              key={reference.id}
              data-testid="llm-reference"
              data-name={reference.filename}
              title={`${reference.filename} - ${humanBytes(reference.bytes)}`}
              className="relative"
            >
              <img
                src={llmReferenceImageUrl(reference.id)}
                alt={reference.filename}
                className="h-14 w-20 rounded border border-line bg-ground object-contain"
              />
              {canEdit && !inherited && (
                <button
                  data-testid="remove-llm-reference"
                  aria-label={`Remove ${reference.filename}`}
                  onClick={() => remove(reference.id)}
                  className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full border border-line-strong bg-surface text-xs leading-none text-ink-muted hover:text-danger"
                >
                  ×
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!jobId && (
        <p className="mt-1 text-xs text-ink-muted">
          Sent before every page, unless a dataset shows its own instead.
        </p>
      )}
    </div>
  )
}
