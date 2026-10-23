import type { AppUser } from '../../api'
import { capabilityHint, capabilityLabel } from './capabilities'

function cellTitle({ user, cap, name, self, allowed, overridden }: {
  user: AppUser
  cap: string
  name: string
  self: boolean
  allowed: boolean
  overridden: boolean
}): string {
  if (user.role === 'admin') return 'Admins may do everything'
  if (user.role === 'viewer') return `${name} is a viewer and may not write at all - promote the account to member first`
  if (self) return 'You cannot change your own permissions'
  if (overridden) return `${allowed ? 'Granted' : 'Taken away'} for ${name} - the ${user.role} role says otherwise`
  return `${capabilityHint(cap)} - what the ${user.role} role allows`
}

/** Who may do what: a row per account, a column per capability. A tick is what the role
 *  says unless it was overridden for this person, which the cell says in as many words -
 *  so an exception reads as an exception and not as the way things are. */
export function PermissionMatrix({ users, capabilities, myId, onPatch }: {
  users: AppUser[]
  capabilities: string[]
  myId: number | null
  onPatch: (id: number, permissions: Record<string, boolean>) => void
}) {
  if (capabilities.length === 0) return null
  return (
    <table data-testid="permission-matrix" className="w-full border-collapse text-sm">
      <thead>
        <tr className="border-b border-line-strong text-left text-xs uppercase tracking-wide text-ink-subtle">
          <th className="py-2 pr-2 font-medium">Account</th>
          <th className="py-2 pr-2 font-medium">Role</th>
          {capabilities.map((cap) => (
            <th key={cap} data-testid="permission-heading" data-cap={cap} title={capabilityHint(cap)}
                className="py-2 pr-2 text-center font-medium">
              {capabilityLabel(cap)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {users.map((user) => {
          const admin = user.role === 'admin'
          // Every write of a viewer's is refused before a capability is looked at.
          const viewer = user.role === 'viewer'
          const self = user.id === myId
          const name = user.username || user.subject
          return (
            <tr key={user.id} data-testid="permission-row" data-user={name} data-viewer={viewer || undefined}
                className={`border-b border-line ${user.active && !viewer ? '' : 'opacity-50'}`}>
              <td className="py-1.5 pr-2 font-medium">
                {user.username || user.subject}
                {self && <span className="ml-1.5 text-xs font-normal text-ink-subtle">(you)</span>}
              </td>
              <td className="py-1.5 pr-2 text-ink-muted">
                {user.role}
                {viewer && (
                  <span data-testid="promote-first" className="block text-xs text-ink-subtle">
                    promote to member to grant anything
                  </span>
                )}
              </td>
              {capabilities.map((cap) => {
                const allowed = user.capabilities.includes(cap)
                const overridden = Object.hasOwn(user.permissions, cap)
                return (
                  <td key={cap} className="py-1.5 pr-2 text-center">
                    <input
                      type="checkbox"
                      data-testid="permission-cell"
                      data-cap={cap}
                      data-overridden={overridden || undefined}
                      checked={allowed}
                      // An admin has everything by virtue of being one, and taking a
                      // capability off yourself is how an admin locks themselves out.
                      disabled={admin || viewer || self}
                      title={cellTitle({ user, cap, name, self, allowed, overridden })}
                      onChange={(e) => onPatch(user.id, { [cap]: e.target.checked })}
                      className={`cursor-pointer accent-accent disabled:cursor-default ${
                        overridden ? 'outline outline-2 outline-offset-2 outline-accent' : ''
                      }`}
                    />
                  </td>
                )
              })}
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
