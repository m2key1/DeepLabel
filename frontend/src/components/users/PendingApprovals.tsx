import { useState } from 'react'
import { approveUser, rejectUser, type AppUser, type Role } from '../../api'
import { formatDate, formatRelative } from '../../util'
import { Button } from '../ui/Button'
import { Select } from '../ui/Field'
import { Section } from '../ui/Section'

const ROLES: Role[] = ['viewer', 'member', 'admin']

function Waiting({ user, onDecided, onError }: {
  user: AppUser
  onDecided: (user: AppUser) => void
  onError: (message: string) => void
}) {
  const [role, setRole] = useState<Role>('viewer')
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
          {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
        </Select>
      </label>
      <span className="flex gap-2">
        <Button size="sm" variant="primary" data-testid="approve" disabled={busy}
                onClick={() => void decide(() => approveUser(user.id, role))}>
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
