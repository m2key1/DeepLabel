import { useState } from 'react'
import { addToWorkspaces, approveUser, rejectUser, type AppUser, type Role } from '../../api'
import { ROLES, ROLE_DESCRIPTION, ROLE_LABEL } from '../../lib/roles'
import { formatDate, formatRelative } from '../../util'
import { Button } from '../ui/Button'
import { Select } from '../ui/Field'
import { Section } from '../ui/Section'
import { WorkspacePicker } from './WorkspacePicker'

// Lowest first: a new person starts with the least and is given more.
const LOWEST_FIRST = [...ROLES].reverse()

function Waiting({ user, onDecided, onError }: {
  user: AppUser
  onDecided: (user: AppUser) => void
  onError: (message: string) => void
}) {
  const [role, setRole] = useState<Role>('viewer')
  const [workspaces, setWorkspaces] = useState<number[]>([])
  const [busy, setBusy] = useState(false)
  const decide = async (how: () => Promise<AppUser>) => {
    setBusy(true)
    try {
      onDecided(await how())
    } catch (e) {
      onError((e as Error).message)
      setBusy(false)
    }
  }
  return (
    <li data-testid="pending-user" data-user={user.username}
        className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line py-2 last:border-b-0">
      <span className="min-w-48 flex-1">
        <span className="block text-sm text-ink">{user.display_name || user.email}</span>
        <span className="block text-xs text-ink-subtle">
          {user.email} · signed up <span title={formatDate(user.created_at)}>{formatRelative(user.created_at)}</span>
        </span>
      </span>
      <label className="flex items-center gap-2 text-sm">
        <span className="text-ink-muted">Role</span>
        <Select size="sm" data-testid="pending-role" value={role} disabled={busy}
                onChange={(e) => setRole(e.target.value as Role)}>
          {LOWEST_FIRST.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
        </Select>
        <span data-testid="pending-role-description" className="text-xs text-ink-muted">{ROLE_DESCRIPTION[role]}</span>
      </label>
      <WorkspacePicker testId="pending-workspaces" chosen={workspaces} onChange={setWorkspaces} disabled={busy} />
      <span className="flex gap-2">
        <Button size="sm" variant="primary" data-testid="approve" disabled={busy}
                onClick={() => void decide(async () => {
                  const approved = await approveUser(user.id, role)
                  // Approved either way; the workspaces follow, and a failure is said.
                  if (workspaces.length > 0) {
                    await addToWorkspaces(user.username, workspaces).catch((e: Error) => onError(
                      `${user.email} is in, but could not be added to the workspaces (${e.message}).`))
                  }
                  return approved
                })}>
          Approve
        </Button>
        <Button size="sm" variant="danger" data-testid="reject" disabled={busy}
                title="Switches the account off here and in Authentik"
                onClick={() => void decide(() => rejectUser(user.id))}>
          Reject
        </Button>
      </span>
    </li>
  )
}

/** People who signed up and wait to be let in, at the top of the Admin page. */
export function PendingApprovals({ users, onDecided, onError }: {
  users: AppUser[]
  onDecided: (user: AppUser) => void
  onError: (message: string) => void
}) {
  if (users.length === 0) return null
  return (
    <Section title={`Waiting for approval (${users.length})`} data-testid="pending-approvals"
             description="They signed up themselves. Approve lets them in with the role you pick; reject switches the account off.">
      <ul>
        {users.map((u) => <Waiting key={u.id} user={u} onDecided={onDecided} onError={onError} />)}
      </ul>
    </Section>
  )
}
