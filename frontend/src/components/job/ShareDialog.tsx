import { useEffect, useState } from 'react'
import { getUserNames, shareGroup, shareJob } from '../../api'
import { useAuth } from '../../auth'
import { Modal, modalBtn, modalPrimaryBtn } from '../Modal'

interface ShareDialogProps {
  target: { kind: 'dataset'; id: string } | { kind: 'group'; id: number }
  title: string
  /** The dataset is in its creator's Sandbox: nobody is added to it there, it is moved out instead. */
  sandboxed: boolean
  onMoveInstead: () => void
  owner: string
  sharedWith: string[]
  onClose: () => void
  onShared: () => void
  onError: (message: string) => void
}

export function ShareDialog({
  target, title, sandboxed, onMoveInstead, owner, sharedWith, onClose, onShared, onError,
}: ShareDialogProps) {
  const [names, setNames] = useState<string[] | null>(null)
  const [chosen, setChosen] = useState<Set<string>>(new Set(sharedWith))
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (sandboxed) return
    getUserNames()
      .then((r) => setNames(r.users.map((u) => u.username)))
      .catch((e: Error) => onError(e.message))
  }, [sandboxed, onError])

  const toggle = (name: string) =>
    setChosen((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })

  const save = async () => {
    setBusy(true)
    try {
      if (target.kind === 'dataset') await shareJob(target.id, [...chosen])
      else await shareGroup(target.id, [...chosen])
      onClose()
      onShared()
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const { user } = useAuth()

  if (sandboxed) {
    return (
      <Modal title={`Share "${title}"`} onClose={onClose}>
        <p data-testid="share-sandboxed" className="mb-4 text-sm text-ink-muted">
          {owner === user
            ? 'It is in your Sandbox, which only you can see.'
            : `It is in ${owner}'s Sandbox, which only ${owner} can see.`}
          {' '}To share it, move it into a workspace: everyone in that workspace can then open it.
        </p>
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className={modalBtn}>
            Cancel
          </button>
          <button onClick={onMoveInstead} className={modalPrimaryBtn}>
            Move to a workspace…
          </button>
        </div>
      </Modal>
    )
  }

  return (
    <Modal title={`Share "${title}"`} onClose={onClose}>
      <p className="mb-3 text-sm text-ink-muted">
        {target.kind === 'group'
          ? 'These people can open and work on every dataset in this workspace, including ones added later. The owner and admins always have access.'
          : 'These people can open and work on this dataset. The owner and admins always have access.'}
      </p>
      {names === null && <p className="text-sm text-ink-muted">Loading…</p>}
      <div className="mb-4 max-h-64 space-y-1 overflow-auto">
        {names?.map((name) => (
          <label key={name} className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-sm hover:bg-raised">
            <input
              type="checkbox"
              checked={chosen.has(name)}
              disabled={name === owner}
              onChange={() => toggle(name)}
              className="cursor-pointer accent-accent"
            />
            {name}
            {name === owner && <span className="text-xs text-ink-subtle">(owner)</span>}
          </label>
        ))}
      </div>
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className={modalBtn}>
          Cancel
        </button>
        <button onClick={save} disabled={busy || names === null} className={modalPrimaryBtn}>
          Save
        </button>
      </div>
    </Modal>
  )
}
