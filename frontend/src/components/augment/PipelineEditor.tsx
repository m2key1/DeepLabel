import { useEffect, useMemo, useState } from 'react'
import { getAugmentCatalog } from '../../api'
import type { AugmentCatalog, AugmentSpec, ModelTask } from '../../api'
import { PipelineBuilder } from './PipelineBuilder'
import { PipelinePreview } from './PipelinePreview'
import { countSteps, fromSpec, groupNames, toSpec } from './pipeline'
import type { PipelineNode } from './pipeline'

const cached = new Map<ModelTask, Promise<AugmentCatalog>>()
/** A task's catalog never changes while its trainer does not, and every editor of the task
 *  wants it. A failed read is not kept, so the next editor asks again. */
function loadCatalog(task: ModelTask): Promise<AugmentCatalog> {
  let loading = cached.get(task)
  if (!loading) {
    loading = getAugmentCatalog(task).catch((e: Error) => {
      cached.delete(task)
      throw e
    })
    cached.set(task, loading)
  }
  return loading
}

interface EditorProps {
  task: ModelTask
  spec: AugmentSpec | null
  onChange: (spec: AugmentSpec) => void
  /** Datasets the preview draws its line crops from. */
  jobIds: string[]
  readOnly?: boolean
  children?: React.ReactNode
}

/** The builder and its live preview, shared by the Augmentations page and the overlay the
 *  training form opens. */
export function PipelineEditor({ task, spec, onChange, jobIds, readOnly, children }: EditorProps) {
  const [catalog, setCatalog] = useState<AugmentCatalog | null>(null)
  const [nodes, setNodes] = useState<PipelineNode[]>([])
  const [loadedFor, setLoadedFor] = useState<string | null>(null)

  useEffect(() => {
    loadCatalog(task).then(setCatalog).catch(() => setCatalog(null))
  }, [task])

  const byName = useMemo(
    () => new Map((catalog?.transforms ?? []).map((t) => [t.name, t])), [catalog])

  // The tree is seeded from the spec handed in; later edits flow the other way.
  const incoming = JSON.stringify(spec)
  useEffect(() => {
    if (loadedFor === incoming || catalog === null) return
    setNodes(fromSpec(spec, groupNames(catalog), byName))
    setLoadedFor(incoming)
  }, [incoming, spec, catalog, byName, loadedFor])

  const update = (next: PipelineNode[]) => {
    setNodes(next)
    const nextSpec = toSpec(next)
    setLoadedFor(JSON.stringify(nextSpec))
    onChange(nextSpec)
  }

  const previewSpec = useMemo(() => toSpec(nodes, { skipMuted: true }), [nodes])
  const muted = useMemo(
    () => countSteps(nodes) - countSteps(fromSpec(previewSpec, groupNames(catalog))),
    [nodes, previewSpec, catalog])

  return (
    <div className="space-y-3">
      {catalog?.error && (
        <p data-testid="catalog-error" className="text-xs text-warn">
          The transform catalog could not be read from a training backend ({catalog.error}), so no steps can be added.
        </p>
      )}
      {/* The preview leads, full width and pinned: a line crop is wide and short, so it
          reads at the page's width and not in a column beside it. */}
      <PipelinePreview task={task} spec={previewSpec} jobIds={jobIds} />
      <PipelineBuilder catalog={catalog} nodes={nodes} onChange={update} readOnly={readOnly} />
      <div className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
        <span data-testid="step-count">
          {countSteps(nodes)} step{countSteps(nodes) === 1 ? '' : 's'}
        </span>
        {muted > 0 && <span data-testid="muted-count">· {muted} skipped in the preview only</span>}
        <span className="ml-auto flex gap-2">{children}</span>
      </div>
    </div>
  )
}
