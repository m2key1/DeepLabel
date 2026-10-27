import { useEffect, useState } from 'react'
import { getLlmReadings, getPageLlmReadings, removeLlmReadings, removePageLlmReadings } from '../../api'
import type { LlmReadingsOnFile } from '../../api'
import { Modal, modalBtn, modalPrimaryBtn } from '../Modal'

interface RemoveReadingsDialogProps {
  jobId: string
  /** One page of the dataset instead of all of it, named in the title. */
  page?: { id: number; name: string }
  onClose: () => void
  onRemoved: () => void
  onError: (message: string) => void
}

const ALL = 'all'
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** Deleting a dataset's language model readings, or one page's - every model's, or
 *  one's - for good. */
export function RemoveReadingsDialog({ jobId, page, onClose, onRemoved, onError }: RemoveReadingsDialogProps) {
  const pageId = page?.id
  const [models, setModels] = useState<LlmReadingsOnFile[] | null>(null)
  const [choice, setChoice] = useState<string>(ALL)
  const [removed, setRemoved] = useState<number | null>(null)
  const [running, setRunning] = useState(false)

  useEffect(() => {
    const listed = pageId !== undefined ? getPageLlmReadings(pageId) : getLlmReadings(jobId)
    listed.then((r) => setModels(r.models)).catch((e: Error) => onError(e.message))
  }, [jobId, pageId, onError])

  const chosen = (models ?? []).filter((m) => choice === ALL || String(m.id) === choice)
  const readings = chosen.reduce((sum, m) => sum + m.readings, 0)
  const elsewhere = Math.max(0, ...chosen.map((m) => m.other_datasets))

  const run = () => {
    setRunning(true)
    const model = choice === ALL ? undefined : Number(choice)
    ;(page ? removePageLlmReadings(page.id, model) : removeLlmReadings(jobId, model))
      .then((r) => {
        setRemoved(r.readings)
        onRemoved()
      })
      .catch((e: Error) => onError(e.message))
      .finally(() => setRunning(false))
  }

  return (
    <Modal title={page ? `Remove LLM readings - ${page.name}` : 'Remove LLM readings'} onClose={onClose}>
      {models === null ? (
        <p className="mb-3 text-sm text-ink-muted">Counting the readings on file…</p>
      ) : models.length === 0 ? (
        <p className="mb-3 text-sm text-ink-muted" data-testid="remove-readings-none">
          {page ? 'No language model has read this page.' : "No language model has read this dataset's pages."}
        </p>
      ) : (
        <fieldset className="mb-3 space-y-1 text-sm">
          {[{ value: ALL, label: 'Every model', count: models.reduce((sum, m) => sum + m.readings, 0) },
            ...models.map((m) => ({ value: String(m.id), label: m.label, count: m.readings }))].map((option) => (
            <label key={option.value} className="flex items-center gap-2" data-testid="remove-readings-option"
                   data-model={option.value}>
              <input type="radio" name="remove-readings" value={option.value} checked={choice === option.value}
                     onChange={() => setChoice(option.value)} disabled={removed !== null} />
              <span className="flex-1">{option.label}</span>
              <span className="text-xs tabular-nums text-ink-muted">{plural(option.count, page ? 'reading' : 'page')}</span>
            </label>
          ))}
        </fieldset>
      )}
      {models !== null && models.length > 0 && (
        <p className="mb-3 text-sm text-ink-muted" data-testid="remove-readings-warning">
          {`The ${plural(readings, 'reading')} ${readings === 1 ? 'is' : 'are'} deleted for good: asking again calls the `
            + 'provider and is paid again. '}
          {elsewhere > 0 && `${plural(elsewhere, 'other dataset')} holding the same scans ${elsewhere === 1 ? 'loses' : 'lose'} them too. `}
          Lines the agreement filled in go back to their OCR text; a checked line keeps its text and the
          reading it was checked on.
        </p>
      )}
      {removed !== null && (
        <p className="mb-3 text-sm text-ok" data-testid="remove-readings-result">
          Removed {plural(removed, 'reading')}.
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className={modalBtn}>Close</button>
        <button data-testid="remove-readings-confirm" onClick={run}
                disabled={!readings || removed !== null || running}
                className={`${modalPrimaryBtn} disabled:opacity-40`}>
          Remove
        </button>
      </div>
    </Modal>
  )
}
