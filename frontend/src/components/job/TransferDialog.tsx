import { useEffect, useState } from 'react'
import { getUserNames, transferGroup, transferJob } from '../../api'
import type { UserName } from '../../api'
import { reaches } from '../../lib/roles'
import { Modal, modalBtn, modalPrimaryBtn } from '../Modal'
import { Select } from '../ui/Field'

export type TransferTarget =
  | { kind: 'dataset'; id: string; name: string; owner: string }
  /** `owned` is how many of its datasets the owner made, which go along unless unticked. */
  | { kind: 'workspace'; id: number; name: string; owner: string; owned: number }

/** Hand a dataset or a workspace over to someone else, who then owns it (#79). Whoever had it
 *  keeps the access they had, and a Viewer cannot be given one: they could do nothing with it. */
export function TransferDialog({ target, onClose, onDone }: {
  target: TransferTarget
  onClose: () => void
  onDone: (owner: string) => void
}) {
  const [people, setPeople] = useState<UserName[] | null>(null)
  const [to, setTo] = useState('')
  const [withDatasets, setWithDatasets] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getUserNames()
      .then(({ users }) => setPeople(users
        .filter((u) => u.role !== 'viewer' && u.username !== target.owner)
        .sort((a, b) => (a.display_name || a.username).localeCompare(b.display_name || b.username))))
      .catch((e: Error) => setError(e.message))
  }, [target.owner])

  const chosen = people?.find((u) => u.username === to)
  const workspace = target.kind === 'workspace'
  const carried = workspace && withDatasets ? target.owned : 0
  const what = workspace
    ? `"${target.name}"${carried > 0 ? ` and the ${carried} dataset${carried === 1 ? '' : 's'} ${target.owner} made in it` : ''}`
    : `"${target.name}"`

  const transfer = async () => {
    setBusy(true)
    setError(null)
    try {
      const done = target.kind === 'workspace'
        ? await transferGroup(target.id, to, withDatasets)
        : await transferJob(target.id, to)
      onDone(done.owner)
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <Modal title={`Transfer ownership of "${target.name}"`} onClose={onClose}>
      <p className="mb-3 text-sm text-ink-muted">
        {workspace
          ? `The workspace becomes theirs, and they join it. ${target.owner} stays a member.`
          : `The dataset becomes theirs, and they manage it. ${target.owner} keeps the access they had.`}
      </p>
      <label className="mb-3 flex flex-col gap-1 text-xs text-ink-muted">
        To
        <Select size="md" aria-label="Transfer to" value={to} disabled={!people || busy}
                onChange={(e) => setTo(e.target.value)}>
          <option value="" disabled>{people ? 'Choose someone…' : 'Loading…'}</option>
          {people?.map((u) => <option key={u.username} value={u.username}>{u.display_name || u.username}</option>)}
        </Select>
      </label>
      {workspace && target.owned > 0 && (
        <label className="mb-3 flex cursor-pointer items-center gap-2 text-sm">
          <input type="checkbox" className="cursor-pointer accent-accent" checked={withDatasets}
                 onChange={(e) => setWithDatasets(e.target.checked)} />
          Also transfer the {target.owned} dataset{target.owned === 1 ? '' : 's'} {target.owner} made in it
        </label>
      )}
      {chosen && workspace && !reaches(chosen.role, 'manager') && (
        <p data-testid="transfer-note" className="mb-3 text-sm text-warn">
          Managing a workspace takes a Manager: they will own it, but an admin has to make them a Manager first.
        </p>
      )}
      {chosen && (
        <p data-testid="transfer-summary" className="mb-3 text-sm text-ink">
          Transfer {what} to {chosen.display_name || chosen.username}?
        </p>
      )}
      {error && <p role="alert" className="mb-2 text-sm text-danger">{error}</p>}
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className={modalBtn}>Cancel</button>
        <button disabled={busy || !chosen} onClick={() => void transfer()} className={modalPrimaryBtn}>
          Transfer
        </button>
      </div>
    </Modal>
  )
}
