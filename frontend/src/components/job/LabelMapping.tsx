import { useEffect, useState } from 'react'
import { decideJobLayoutLabels, getJobLayoutClasses, getJobLayoutLabels } from '../../api'
import type { DatasetLayoutClass, LayoutLabels } from '../../api'
import { Select } from '../ui/Field'

/** The layout model's labels this dataset has no class of that name for, and what becomes
 *  of their boxes: one of the dataset's classes, or left out. A label not
 *  decided on is left out too, until someone decides. Each choice is saved as it is made. */
export function LabelMapping({ jobId, canEdit, onError }: {
  jobId: string
  canEdit: boolean
  onError: (message: string) => void
}) {
  const [plan, setPlan] = useState<LayoutLabels | null>(null)
  const [classes, setClasses] = useState<DatasetLayoutClass[]>([])

  useEffect(() => {
    getJobLayoutLabels(jobId).then(setPlan).catch(() => setPlan(null))
    getJobLayoutClasses(jobId).then((found) => setClasses(found.classes)).catch(() => setClasses([]))
  }, [jobId])

  if (!plan || plan.model_id == null) return null
  const open = plan.labels.filter((p) => p.how !== 'name')
  if (plan.error) return <p className="mb-3 text-xs text-warn" data-testid="label-mapping-error">{plan.error}</p>
  if (open.length === 0) return null
  const undecided = open.filter((p) => p.how === 'undecided').length

  const decide = (label: string, value: string) =>
    decideJobLayoutLabels(jobId, plan.model_id!, [{ label, class_id: value === 'skip' ? null : Number(value) }])
      .then(setPlan)
      .catch((e: Error) => onError(e.message))

  return (
    <div className="mb-3" data-testid="label-mapping">
      <span className="mb-1 block text-sm font-medium text-ink">Model labels</span>
      <p className="mb-1.5 text-xs text-ink-muted">
        The layout model predicts these labels, which this dataset has no class of that name for.
        Choose the class each one's boxes become, or leave them out.
        {undecided > 0 && ` Until decided, their boxes are left out (${undecided} to decide).`}
      </p>
      <div className="space-y-1">
        {open.map((p) => (
          <label key={p.label} className="flex items-center gap-2 text-sm" data-testid="label-choice" data-label={p.label}>
            <span className="w-36 truncate font-mono text-xs">{p.label}</span>
            <Select size="xs" className="w-48" aria-label={`Class for ${p.label}`} disabled={!canEdit}
                    value={p.how === 'mapped' ? String(p.class_id) : p.how === 'skipped' ? 'skip' : ''}
                    onChange={(e) => decide(p.label, e.target.value)}>
              {p.how === 'undecided' && <option value="" disabled>Choose...</option>}
              <option value="skip">Leave out</option>
              {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </label>
        ))}
      </div>
    </div>
  )
}
