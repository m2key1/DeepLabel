import { useState } from 'react'
import { setJobGroup } from '../../api'
import type { Group, Job } from '../../api'
import { Modal, modalBtn, modalPrimaryBtn } from '../Modal'

interface MoveToGroupDialogProps {
  job: Job
  groups: Group[]
  /** The groups the person may move datasets into. */
  targets: Group[]
  user: string
  onClose: () => void
  onMoved: () => void
  onError: (message: string) => void
}

const SANDBOX = ''

export function MoveToGroupDialog({ job, groups, targets, user, onClose, onMoved, onError }: MoveToGroupDialogProps) {
  const current = groups.find((g) => g.id === job.group_id)
  // A group the person may not move into still shows where the dataset is now.
  const options = current && !current.sandbox_of && !targets.includes(current) ? [current, ...targets] : targets
  const [target, setTarget] = useState(current && !current.sandbox_of ? String(current.id) : SANDBOX)
  const [busy, setBusy] = useState(false)
  const sandbox = job.owner === user ? 'Your Sandbox' : `${job.owner}'s Sandbox`
  const losesPeople = target === SANDBOX && current?.sandbox_of !== job.owner && job.shared_with.length > 0

  const move = async () => {
    setBusy(true)
    try {
      await setJobGroup(job.id, target === SANDBOX ? null : Number(target))
      onClose()
      onMoved()
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={`Move "${job.name}"`} onClose={onClose}>
      <p className="mb-3 text-sm text-ink-muted">
        Everyone in a workspace can open the datasets in it. A Sandbox is private to the person who made its datasets.
      </p>
      <select
        aria-label="Move to"
        value={target}
        onChange={(e) => setTarget(e.target.value)}
        className="mb-4 w-full rounded border border-line-strong bg-surface px-2 py-1.5 text-sm focus-visible:border-accent focus:outline-none"
      >
        <option value={SANDBOX}>{sandbox}</option>
        {options.map((g) => (
          <option key={g.id} value={g.id}>
            {g.name}
          </option>
        ))}
      </select>
      {losesPeople && (
        <p role="alert" data-testid="move-loses-people" className="-mt-2 mb-4 text-sm text-warn">
          {job.shared_with.join(', ')} {job.shared_with.length === 1 ? 'was' : 'were'} given this dataset.
          In {job.owner === user ? 'your' : `${job.owner}'s`} Sandbox it is private, so they lose it.
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className={modalBtn}>
          Cancel
        </button>
        <button onClick={move} disabled={busy} className={modalPrimaryBtn}>
          Move
        </button>
      </div>
    </Modal>
  )
}
