import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  createAugmentPipeline, deleteAugmentPipeline, duplicateAugmentPipeline, listAugmentPipelines, listJobs,
  setAugmentPipelineDefault, trainingPreview, updateAugmentPipeline,
} from '../api'
import type { AugmentPipeline, AugmentSpec, Job, ModelTask } from '../api'
import { useAuth } from '../auth'
import { PipelineEditor } from '../components/augment/PipelineEditor'
import { useCrumb } from '../components/NavBar'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { useAutoClear } from '../messages'
import { buttonClass } from '../components/ui/Button'
import { controlClass } from '../components/ui/Field'
import { PageHeader } from '../components/ui/PageHeader'

const TASK: ModelTask = 'ocr'
const EMPTY: AugmentSpec = { transform: { __class_fullname__: 'Compose', p: 1.0, transforms: [] } }

const inputClass = controlClass('md', 'w-full')

export function AugmentationsPage() {
  useCrumb('Augmentations')
  const { canEdit, isAdmin, user } = useAuth()
  const [pipelines, setPipelines] = useState<AugmentPipeline[]>([])
  const [builtin, setBuiltin] = useState<{ spec: AugmentSpec | null; error: string | null }>(
    { spec: null, error: null })
  const [selectedId, setSelectedId] = useState<number | 'new' | null>(null)
  const [name, setName] = useState('')
  const [spec, setSpec] = useState<AugmentSpec>(EMPTY)
  const [jobs, setJobs] = useState<Job[]>([])
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [previewJob, setPreviewJob] = useState('')
  const [error, setError] = useState<string | null>(null)
  useAutoClear(error, setError)
  const [notice, setNotice] = useState<string | null>(null)
  useAutoClear(notice, setNotice)
  const [busy, setBusy] = useState(false)

  const refresh = () =>
    listAugmentPipelines(TASK)
      .then((res) => {
        setPipelines(res.pipelines)
        setBuiltin(res.builtin)
        return res
      })
      .catch((e: Error) => {
        setError(e.message)
        return null
      })

  useEffect(() => {
    // Arrive in the builder, not in front of an empty list: the stack training uses today
    // is loaded as an unsaved draft, so the first thing on screen is the real thing.
    refresh().then((res) => {
      if (!res || res.pipelines.length > 0 || !res.builtin.spec) return
      setSelectedId('new')
      setSpec(res.builtin.spec)
    })
    listJobs()
      .then(async (rows) => {
        setJobs(rows)
        if (!rows.length) return
        const res = await trainingPreview(TASK, rows.map((j) => j.id))
        setCounts(res.counts)
        const first = rows.find((job) => (res.counts[job.id] ?? 0) > 0)
        if (first) setPreviewJob((current) => current || first.id)
      })
      .catch(() => undefined)
  }, [])

  const selected = useMemo(
    () => (typeof selectedId === 'number' ? pipelines.find((p) => p.id === selectedId) ?? null : null),
    [pipelines, selectedId])
  const editable = selectedId === 'new' || (selected?.editable ?? false)
  const eligible = jobs.filter((job) => (counts[job.id] ?? 0) > 0)

  const open = (pipeline: AugmentPipeline) => {
    setSelectedId(pipeline.id)
    setName(pipeline.name)
    setSpec(pipeline.spec)
    setError(null)
    setNotice(null)
  }

  const startNew = (from?: AugmentSpec | null) => {
    setSelectedId('new')
    setName('')
    setSpec(from ?? EMPTY)
    setError(null)
    setNotice(null)
  }

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      const saved = selectedId === 'new'
        ? await createAugmentPipeline({ task: TASK, name: name.trim(), spec })
        : await updateAugmentPipeline(selectedId as number, { name: name.trim(), spec })
      await refresh()
      setSelectedId(saved.id)
      setNotice(`Saved "${saved.name}".`)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const act = async (action: () => Promise<unknown>, after?: () => void) => {
    setBusy(true)
    setError(null)
    try {
      await action()
      await refresh()
      after?.()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="w-full px-6 py-6">
      <PageHeader
        title="Augmentations"
        actions={<Link to="/models" className={buttonClass()}>Back to models</Link>}
      >
        {selectedId === 'new' && pipelines.length === 0
          ? 'Starting from the stack OCR training uses today. Change what you like and name it to keep it - '
            + 'nothing here affects a training until you pick it on the training form.'
          : 'Stacks of image transforms a training can apply to its line crops. Pipelines are yours alone; '
            + 'the one an admin marks as the default is what every training form offers as Default.'}
      </PageHeader>

      <div className="grid gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
        <div>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-sm font-medium text-ink">Pipelines</span>
          </div>
          <div className="space-y-1 rounded border border-line p-1">
            {pipelines.length === 0 && (
              <p className="px-1 py-2 text-sm text-ink-muted">
                Nothing saved yet. Until something is, every training uses the model's own stack.
              </p>
            )}
            {pipelines.map((pipeline) => (
              <button
                key={pipeline.id}
                type="button"
                data-testid="pipeline-row"
                aria-current={pipeline.id === selectedId ? 'true' : undefined}
                onClick={() => open(pipeline)}
                className={`flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-sm ${
                  pipeline.id === selectedId ? 'bg-accent-wash'
                    : 'hover:bg-raised'
                }`}
              >
                <span className="min-w-0 flex-1 truncate">{pipeline.name}</span>
                {pipeline.is_default && (
                  <Badge tone="accent">Default</Badge>
                )}
                {!pipeline.editable && (
                  <span className="text-[10px] uppercase text-ink-subtle">{pipeline.owner}</span>
                )}
              </button>
            ))}
          </div>
          {canEdit && (
            <div className="mt-2 space-y-1">
              {builtin.spec && (
                <Button variant="ghost" size="xs" data-testid="start-from-builtin"
                        onClick={() => startNew(builtin.spec)}>
                  + New with default prefilled
                </Button>
              )}
              <Button variant="ghost" size="xs" data-testid="start-empty" onClick={() => startNew()}>
                + New from nothing
              </Button>
            </div>
          )}
          {builtin.error && (
            <p className="mt-2 text-xs text-warn">
              The model's own stack could not be read: {builtin.error}
            </p>
          )}
        </div>

        <div>
          {selectedId === null ? (
            <p className="text-sm text-ink-muted">
              Select a pipeline to edit it, or make a new one.
            </p>
          ) : (
            <>
              <div className="mb-3 flex flex-wrap items-end gap-2">
                <div className="min-w-48 flex-1">
                  <label className="mb-1 block text-sm font-medium text-ink"
                         htmlFor="pipeline-name">
                    Name
                  </label>
                  <input
                    id="pipeline-name"
                    value={name}
                    disabled={!editable}
                    onChange={(e) => setName(e.target.value)}
                    className={`${inputClass} disabled:opacity-60`}
                  />
                </div>
                <div className="min-w-48">
                  <label className="mb-1 block text-sm font-medium text-ink"
                         htmlFor="preview-dataset">
                    Preview on
                  </label>
                  <select id="preview-dataset" value={previewJob} onChange={(e) => setPreviewJob(e.target.value)}
                          className={inputClass}>
                    <option value="">No dataset</option>
                    {eligible.map((job) => (
                      <option key={job.id} value={job.id}>
                        {job.name} ({counts[job.id]})
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="mb-3 flex flex-wrap items-center gap-2">
                {editable && (
                  <Button
                    variant="primary"
                    size="sm"
                    data-testid="save-pipeline"
                    disabled={busy || !name.trim()}
                    onClick={save}
                  >
                    {busy ? 'Saving…' : selectedId === 'new' ? 'Save pipeline' : 'Save changes'}
                  </Button>
                )}
                {selectedId === 'new' && (
                  <span data-testid="draft-hint" className="text-xs text-ink-muted">
                    Unsaved draft{name.trim() ? '' : ' - name it to keep it'}
                  </span>
                )}
                {selected && canEdit && (
                  <Button variant="ghost" size="sm" data-testid="duplicate-pipeline" disabled={busy}
                          onClick={() => act(() => duplicateAugmentPipeline(selected.id).then(open))}>
                    Duplicate
                  </Button>
                )}
                {selected?.editable && isAdmin && (
                  <Button variant="ghost" size="sm" data-testid="toggle-default" disabled={busy}
                          onClick={() => act(() => setAugmentPipelineDefault(selected.id, !selected.is_default))}>
                    {selected.is_default ? 'Stop being the default' : 'Make it the default'}
                  </Button>
                )}
                {selected?.editable && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-danger hover:text-danger"
                    data-testid="delete-pipeline"
                    disabled={busy}
                    onClick={() => {
                      if (!window.confirm(`Delete the pipeline "${selected.name}"?`)) return
                      act(() => deleteAugmentPipeline(selected.id), () => setSelectedId(null))
                    }}
                  >
                    Delete
                  </Button>
                )}
                {notice && <span data-testid="pipeline-notice" className="text-xs text-ink-muted">{notice}</span>}
                {error && <span data-testid="pipeline-error" className="text-xs text-danger">{error}</span>}
                {selected && (
                  <span className="ml-auto text-[11px] text-ink-subtle">
                    Saved by {selected.owner === user ? 'you' : selected.owner} · updated {selected.updated_at}
                  </span>
                )}
              </div>

              <PipelineEditor
                task={TASK}
                spec={spec}
                onChange={setSpec}
                jobIds={previewJob ? [previewJob] : []}
                readOnly={!editable}
              >
                {selected && !selected.editable && (
                  <span className="text-warn">
                    {selected.owner}'s pipeline - duplicate it to change anything
                  </span>
                )}
              </PipelineEditor>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
