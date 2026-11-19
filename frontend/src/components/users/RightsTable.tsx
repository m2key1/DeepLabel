import { Fragment, type ReactNode } from 'react'
import type { AppUser, Role } from '../../api'
import { ROLES, ROLE_DESCRIPTION, ROLE_LABEL } from '../../lib/roles'
import { formatDate, formatRelative, isOnline } from '../../util'
import { Avatar, AvatarLink } from '../ui/Avatar'
import { capabilityHint, capabilityLabel } from './capabilities'

const ROLE_TITLE: Record<Role, string> = {
  admin: 'Admins', manager: 'Managers', reviewer: 'Reviewers', annotator: 'Annotators', viewer: 'Viewers',
}

// The columns read as a sentence: manage models, train, use the API. What someone may do
// with a dataset's data is their role's, described on the role's own line.
const GROUPS: { title: string; caps: string[] }[] = [
  { title: 'models', caps: ['models.manage'] },
  { title: 'train', caps: ['train.local', 'train.cluster'] },
  { title: 'API', caps: ['recognize'] },
]

function groupsFor(capabilities: string[]) {
  const known = new Set(GROUPS.flatMap((g) => g.caps))
  const groups = GROUPS.map((g) => ({ ...g, caps: g.caps.filter((c) => capabilities.includes(c)) }))
  const other = capabilities.filter((c) => !known.has(c))
  return [...groups, ...(other.length ? [{ title: 'other', caps: other }] : [])].filter((g) => g.caps.length)
}

const dot = 'inline-block size-3 rounded-full border align-middle'

function cellTitle(user: AppUser, cap: string, self: boolean, allowed: boolean, overridden: boolean,
                   grantable: boolean): string {
  const name = user.username || user.subject
  if (user.role === 'admin') return 'Admins may do everything'
  if (user.role === 'viewer' && !grantable) return `${name} is a Viewer and may not write at all - give the account a role that writes first`
  if (self) return 'You cannot change your own permissions'
  if (overridden) return `${allowed ? 'Granted' : 'Taken away'} for ${name} - the ${ROLE_LABEL[user.role]} role says otherwise. Click to go back to the role.`
  return `${capabilityHint(cap)} - as the ${ROLE_LABEL[user.role]} role allows. Click to make an exception.`
}

/** Who may do what, in one table: people under their role, and the role's own line just
 *  above them as the default, so an exception is simply the dot that breaks the line.
 *  The dots are checkboxes; clicking one makes or lifts an exception. */
export function RightsTable({ users, capabilities, roles, viewerGrantable, myId, expanded, onToggle, onPatch, detail }: {
  users: AppUser[]
  capabilities: string[]
  roles: Record<string, string[]>
  /** What a viewer can still be given: the capabilities that write nothing. */
  viewerGrantable: string[]
  myId: number | null
  expanded: number | null
  onToggle: (id: number) => void
  onPatch: (id: number, permissions: Record<string, boolean>) => void
  detail: (user: AppUser) => ReactNode
}) {
  const groups = groupsFor(capabilities)
  const caps = groups.flatMap((g) => g.caps)
  const columns = caps.length + 2
  const groupStart = new Set(groups.slice(1).map((g) => g.caps[0]))
  const edge = (cap: string) => (groupStart.has(cap) ? 'border-l border-line' : '')

  return (
    <div className="overflow-x-auto">
      <table data-testid="permission-matrix" className="w-full min-w-[640px] border-collapse text-sm">
        <thead>
          <tr className="text-[10px] uppercase tracking-widest text-ink-subtle">
            <th />
            {groups.map((g, i) => (
              <th key={g.title} colSpan={g.caps.length}
                  className={`border-b border-line-strong px-1 pb-1 font-medium ${i ? 'border-l border-line' : ''}`}>
                {g.title}
              </th>
            ))}
            <th />
          </tr>
          <tr className="text-[11px] text-ink-subtle">
            <th className="py-1.5 text-left font-medium">Person</th>
            {caps.map((cap) => (
              <th key={cap} data-testid="permission-heading" data-cap={cap} title={capabilityHint(cap)}
                  className={`px-2 py-1.5 text-center font-medium ${edge(cap)}`}>
                {capabilityLabel(cap)}
              </th>
            ))}
            <th className="px-2 py-1.5 text-right font-medium">Seen</th>
          </tr>
        </thead>
        {ROLES.map((role) => {
          const people = users.filter((u) => u.role === role)
          const defaults = roles[role] ?? []
          return (
            <tbody key={role}>
              <tr data-testid="role-row" data-role={role} className="bg-raised">
                <td className="py-1.5 pl-2 font-semibold">
                  {ROLE_TITLE[role]}
                  <span className="ml-1.5 text-xs font-normal text-ink-subtle">{ROLE_DESCRIPTION[role]}</span>
                </td>
                {caps.map((cap) => (
                  <td key={cap} className={`text-center ${edge(cap)}`} title={`${ROLE_TITLE[role]} ${defaults.includes(cap) ? 'may' : 'may not'}: ${capabilityHint(cap)}`}>
                    <span className={`${dot} ${defaults.includes(cap) ? 'border-ink-subtle bg-ink-subtle' : 'border-line-strong'}`} />
                  </td>
                ))}
                <td />
              </tr>
              {people.length === 0 && (
                <tr><td colSpan={columns} className="py-1.5 pl-6 text-xs text-ink-subtle">nobody</td></tr>
              )}
              {people.map((user) => {
                const self = user.id === myId
                const name = user.username || user.subject
                const seen = user.last_seen_at ?? user.last_login_at
                const locked = (cap: string) =>
                  role === 'admin' || self || (role === 'viewer' && !viewerGrantable.includes(cap))
                const open = expanded === user.id
                return (
                  <Fragment key={user.id}>
                    <tr data-testid="user-row" data-user={name} data-viewer={role === 'viewer' || undefined}
                        className={`border-b border-line ${user.active ? '' : 'opacity-50'}`}>
                      <td className="py-1.5 pl-6">
                        <span className="flex items-center gap-2">
                          {user.username
                            ? <AvatarLink name={user.username} displayName={user.display_name} size="xs" />
                            : <Avatar name={user.subject} displayName={user.display_name} size="xs" />}
                          <button type="button" onClick={() => onToggle(user.id)} aria-expanded={open}
                                  aria-label={`${open ? 'Hide' : 'Show'} details for ${name}`}
                                  className="truncate font-medium hover:text-accent-ink">
                            {name}
                          </button>
                          {self && <span className="text-xs text-ink-subtle">(you)</span>}
                          {!user.active && <span className="text-xs text-danger">Disabled</span>}
                          {role === 'viewer' && (
                            <span data-testid="promote-first" className="sr-only">give the account a role that writes to grant anything that writes</span>
                          )}
                        </span>
                      </td>
                      {caps.map((cap) => {
                        const allowed = user.capabilities.includes(cap)
                        const overridden = Object.hasOwn(user.permissions, cap)
                        return (
                          <td key={cap} className={`text-center ${edge(cap)}`}>
                            <input
                              type="checkbox"
                              data-testid="permission-cell"
                              data-cap={cap}
                              data-overridden={overridden || undefined}
                              aria-label={`${capabilityLabel(cap)} for ${name}`}
                              checked={allowed}
                              disabled={locked(cap)}
                              title={cellTitle(user, cap, self, allowed, overridden, viewerGrantable.includes(cap))}
                              onChange={(e) => onPatch(user.id, { [cap]: e.target.checked })}
                              className={`${dot} cursor-pointer appearance-none disabled:cursor-default ${
                                overridden
                                  ? (allowed ? 'border-warn bg-warn' : 'border-2 border-warn')
                                  : (allowed ? 'border-accent bg-accent' : 'border-line-strong')}`}
                            />
                          </td>
                        )
                      })}
                      <td className="whitespace-nowrap px-2 text-right text-xs text-ink-muted">
                        {isOnline(seen) && (
                          <span data-testid="live-now" className="mr-1.5 text-ok">● online</span>
                        )}
                        <span data-testid="last-login" title={seen ? formatDate(seen) : 'Has not used the account yet'}>
                          {seen ? formatRelative(seen) : 'never'}
                        </span>
                      </td>
                    </tr>
                    {open && (
                      <tr className="border-b border-line bg-ground">
                        <td colSpan={columns} className="px-2 py-3">{detail(user)}</td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          )
        })}
      </table>
      <p className="mt-2 text-xs text-ink-subtle">
        A role&apos;s line is what its people get. An amber dot differs from the role: click it to go
        back to the role, or click any other dot to make an exception. Changing someone&apos;s role
        clears their exceptions.
      </p>
    </div>
  )
}
