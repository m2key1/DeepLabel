import { useState } from 'react'
import { createAugmentPipeline } from '../../api'
import type { AugmentSpec, ModelTask } from '../../api'
import { PipelineEditor } from '../augment/PipelineEditor'
import { Modal, modalBtn, modalPrimaryBtn } from '../Modal'
import { Button } from '../ui/Button'
import { useAutoClear } from '../../messages'

/** The builder, opened from the training form on top of it. The stack it returns
 *  belongs to that one run unless it is also saved as a pipeline. */
export function AugmentOverlay({ task, spec, jobIds, onUse, onClose }: {
  task: ModelTask
  spec: AugmentSpec | null
  jobIds: string[]
  onUse: (spec: AugmentSpec) => void
  onClose: () => void
}) {
  const [draft, setDraft] = useState<AugmentSpec>(
    spec ?? { transform: { __class_fullname__: 'Compose', p: 1.0, transforms: [] } })
  const [saveName, setSaveName] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useAutoClear(error, setError)
  const [saved, setSaved] = useState<string | null>(null)

  const savePipeline = async () => {
    setSaving(true)
    setError(null)
    try {
      const pipeline = await createAugmentPipeline({ task, name: saveName.trim(), spec: draft })
      setSaved(pipeline.name)
      setSaveName('')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title="Augmentation for this run" width="xl" onClose={onClose}>
      <PipelineEditor task={task} spec={draft} onChange={setDraft} jobIds={jobIds} />
      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
        <input
          value={saveName}
          onChange={(e) => setSaveName(e.target.value)}
          placeholder="name it to keep it"
          aria-label="Save as pipeline"
          className="w-48 rounded border border-line-strong bg-surface px-2 py-1 text-sm focus-visible:border-accent focus:outline-none"
        />
        <Button variant="ghost" size="sm" data-testid="save-as-pipeline" disabled={saving || !saveName.trim()}
                onClick={savePipeline}>
          {saving ? 'Saving…' : 'Save as pipeline'}
        </Button>
        {saved && (
          <span data-testid="overlay-saved" className="text-xs text-ink-muted">
            Kept as "{saved}".
          </span>
        )}
        {error && (
          <span data-testid="overlay-error" className="text-xs text-danger">
            {error}
          </span>
        )}
        <div className="ml-auto flex gap-2">
          <button type="button" onClick={onClose} className={modalBtn}>
            Cancel
          </button>
          <button type="button" data-testid="use-augmentation" onClick={() => onUse(draft)} className={modalPrimaryBtn}>
            Use for this run
          </button>
        </div>
      </div>
    </Modal>
  )
}
