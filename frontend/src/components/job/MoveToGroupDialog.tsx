import { useState } from 'react'
import { setJobGroup } from '../../api'
import type { Group } from '../../api'
import { Modal, modalBtn, modalPrimaryBtn } from '../Modal'

interface MoveToGroupDialogProps {
  jobId: string
  jobName: string
  groupId: number | null
  groups: Group[]
  onClose: () => void
  onMoved: () => void
  onError: (message: string) => void
}

export function MoveToGroupDialog({ jobId, jobName, groupId, groups, onClose, onMoved, onError }: MoveToGroupDialogProps) {
  const [target, setTarget] = useState<string>(groupId === null ? '' : String(groupId))
  const [busy, setBusy] = useState(false)

  const move = async () => {
    setBusy(true)
    try {
      await setJobGroup(jobId, target === '' ? null : Number(target))
      onClose()
      onMoved()
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={`Move "${jobName}"`} onClose={onClose}>
      <select
        value={target}
        onChange={(e) => setTarget(e.target.value)}
        className="mb-4 w-full rounded border border-line-strong bg-surface px-2 py-1.5 text-sm focus-visible:border-accent focus:outline-none"
      >
        <option value="">No group</option>
        {groups.map((g) => (
          <option key={g.id} value={g.id}>
            {g.name}
          </option>
        ))}
      </select>
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
