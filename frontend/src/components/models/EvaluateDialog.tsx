import { useEffect, useState } from 'react'
import { createEvaluation, listGroups, listJobs, trainingPreview } from '../../api'
import type { Group, Job, OcrDecode, RegistryModel } from '../../api'
import { DatasetPicker } from './DatasetPicker'
import { Modal, modalBtn, modalPrimaryBtn } from '../Modal'
import { useAutoClear } from '../../messages'

interface EvaluateDialogProps {
  model: RegistryModel
  onClose: () => void
  onStarted: () => void
}

export function EvaluateDialog({ model, onClose, onStarted }: EvaluateDialogProps) {
  const [jobs, setJobs] = useState<Job[] | null>(null)
  const [groups, setGroups] = useState<Group[]>([])
  const [allCounts, setAllCounts] = useState<Record<string, number>>({})
  const [testCounts, setTestCounts] = useState<Record<string, number>>({})
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  // Unset follows the selection: test pages when a chosen dataset has some.
  const [pages, setPages] = useState<'test' | 'all' | null>(null)
  const [decode, setDecode] = useState<OcrDecode>('beam')
  const [error, setError] = useState<string | null>(null)
  useAutoClear(error, setError)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    listJobs()
      .then(async (rows) => {
        setJobs(rows)
        if (rows.length) {
          const ids = rows.map((j) => j.id)
          const [all, test] = await Promise.all([trainingPreview('ocr', ids, 'all'), trainingPreview('ocr', ids, 'test')])
          setAllCounts(all.counts)
          setTestCounts(test.counts)
        }
      })
      .catch((e: Error) => setError(e.message))
    listGroups().then(setGroups).catch(() => undefined)
  }, [])

  const toggle = (id: string) =>
    setChosen((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const setMany = (ids: string[], on: boolean) =>
    setChosen((prev) => {
      const next = new Set(prev)
      for (const id of ids) {
        if (on) next.add(id)
        else next.delete(id)
      }
      return next
    })

  const hasTestPages = [...chosen].some((id) => (jobs?.find((j) => j.id === id)?.test_pages ?? 0) > 0)
  const scored = pages ?? (hasTestPages ? 'test' : 'all')
  const scoredCounts = scored === 'test' ? testCounts : allCounts
  const totalLines = [...chosen].reduce((sum, id) => sum + (scoredCounts[id] ?? 0), 0)

  const start = async () => {
    setBusy(true)
    setError(null)
    try {
      await createEvaluation({ model_id: model.id, job_ids: [...chosen], decode, pages: scored })
      onClose()
      onStarted()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const inputClass =
    'w-full rounded border border-line-strong bg-surface px-2 py-1.5 text-sm focus-visible:border-accent focus:outline-none'

  return (
    <Modal title={`Evaluate ${model.name}`} onClose={onClose}>
      <p className="mb-2 text-xs text-ink-muted">
        Scores the model's output against the checked lines of the chosen datasets. Nothing is
        written to the datasets.
      </p>
      <div className="mb-1 text-sm font-medium text-ink">Datasets</div>
      <DatasetPicker
        jobs={jobs}
        groups={groups}
        counts={allCounts}
        chosen={chosen}
        onToggle={toggle}
        onSetMany={setMany}
      />
      {hasTestPages && (
        <fieldset className="mb-3" data-testid="eval-pages">
          <legend className="mb-1 text-sm font-medium text-ink">Pages</legend>
          {([['test', 'Test pages only'], ['all', 'All pages']] as const).map(([value, label]) => (
            <label key={value} className="mr-4 inline-flex items-center gap-1.5 text-sm text-ink">
              <input type="radio" name="eval-pages" value={value} checked={scored === value}
                     onChange={() => setPages(value)} className="accent-accent" />
              {label}
            </label>
          ))}
        </fieldset>
      )}
      <label className="mb-1 block text-sm font-medium text-ink" htmlFor="eval-decode">
        Decoding
      </label>
      <select
        id="eval-decode"
        value={decode}
        onChange={(e) => setDecode(e.target.value as OcrDecode)}
        className={`${inputClass} mb-4`}
      >
        <option value="beam">Beam search with the model's language model</option>
        <option value="rescored">Beam search reranked by the decoder head (no language model)</option>
        <option value="greedy">Fast - raw greedy CTC output</option>
      </select>
      {error && (
        <p data-testid="dialog-error" className="mb-2 text-sm text-danger">
          {error}
        </p>
      )}
      <div className="flex items-center justify-between">
        <span className="text-xs text-ink-muted">{totalLines} checked lines selected</span>
        <div className="flex gap-2">
          <button onClick={onClose} className={modalBtn}>
            Cancel
          </button>
          <button
            disabled={busy || chosen.size === 0 || totalLines === 0}
            onClick={start}
            className={`${modalPrimaryBtn} disabled:opacity-40`}
          >
            {busy ? 'Starting…' : 'Start evaluation'}
          </button>
        </div>
      </div>
    </Modal>
  )
}
