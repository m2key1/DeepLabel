import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { getSlurmAccounts, getUsers, patchUser, type AppUser, type Role } from '../api'
import { useAuth } from '../auth'
import { useCrumb } from '../components/NavBar'
import { Avatar, AvatarLink } from '../components/ui/Avatar'
import { Button } from '../components/ui/Button'
import { AdminTokens } from '../components/users/AdminTokens'
import { InvitePerson } from '../components/users/InvitePerson'
import { PermissionMatrix } from '../components/users/PermissionMatrix'
import { UserDetail } from '../components/users/UserDetail'
import { ONLINE_WITHIN_SECONDS, formatDate, formatRelative, isOnline } from '../util'
import { EmptyState } from '../components/ui/EmptyState'
import { controlClass } from '../components/ui/Field'
import { PageHeader } from '../components/ui/PageHeader'
import { tableCell, tableHeadRow, tableRow } from '../components/ui/Table'
import { pageShell } from '../components/ui/page'
import { useAutoClear } from '../messages'

const ROLES: Role[] = ['admin', 'member', 'viewer']

const ROLE_HINT: Record<Role, string> = {
  admin: 'Full access: pipeline, deletion, user management.',
  member: 'Annotate, run layout, lines and OCR, train locally; '
    + 'no discarding checked work, deleting datasets, managing models or admin actions.',
  viewer: 'Read-only.',
}

// Wider than the shared gutter: a long SLURM account and the column beside it run
// straight into each other at the table's own spacing.
const HEADER_CELL = `${tableCell} py-1.5 pr-6 font-semibold`
const CELL = `${tableCell} py-2 pr-6`

const ACCOUNT_LIST_ID = 'slurm-accounts'

type UserPatch = Parameters<typeof patchUser>[1]

// Committed on blur or Enter, not per keystroke: every change is a PATCH and an audit entry.
function SlurmAccountField({ user, onPatch }: { user: AppUser; onPatch: (body: UserPatch) => void }) {
  const [draft, setDraft] = useState(user.slurm_account)
  useEffect(() => setDraft(user.slurm_account), [user.slurm_account])
  const commit = () => {
    const next = draft.trim()
    if (next !== user.slurm_account) onPatch({ slurm_account: next })
  }
  return (
    <input
      list={ACCOUNT_LIST_ID}
      value={draft}
      data-testid="slurm-account"
      aria-label={`SLURM account for ${user.username || user.subject}`}
      placeholder="cluster default"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.key === 'Escape') setDraft(user.slurm_account)
      }}
      className={controlClass('sm', 'w-36 font-mono text-xs')}
    />
  )
}

interface UserRowProps {
  user: AppUser
  self: boolean
  live: boolean
  expanded: boolean
  onToggle: () => void
  onPatch: (body: UserPatch) => void
}

function UserRow({ user, self, live, expanded, onToggle, onPatch }: UserRowProps) {
  const isAdmin = user.role === 'admin'
  const seen = user.last_seen_at ?? user.last_login_at
  // Viewers never train, whatever the grants say - every training route is closed to them.
  const canTrainAtAll = user.role !== 'viewer'
  // The same capability the permission matrix below shows, so the two always agree.
  const grant = (capability: 'train.local' | 'train.cluster', label: string, hint: string) => (
    <label
      className="flex cursor-pointer items-center gap-1 text-xs text-ink-muted"
      title={isAdmin ? 'Admins always may' : canTrainAtAll ? hint : 'Viewers never train'}
    >
      <input
        type="checkbox"
        data-testid={capability.replace('.', '-')}
        checked={user.capabilities.includes(capability)}
        disabled={isAdmin || !canTrainAtAll}
        onChange={(e) => onPatch({ permissions: { [capability]: e.target.checked } })}
        className="cursor-pointer accent-accent disabled:cursor-default"
      />
      {label}
    </label>
  )
  return (
    <tr data-testid="user-row" className={`${tableRow} h-auto ${user.active ? '' : 'opacity-50'}`}>
      <td className={CELL}>
        <div className="flex items-center gap-2.5">
          {user.username
            ? <AvatarLink name={user.username} displayName={user.display_name} size="md" />
            : <Avatar name={user.subject} displayName={user.display_name} size="md" />}
          <div className="min-w-0">
            <div className="truncate font-medium">
              {user.username || user.subject}
              {self && <span className="ml-1.5 text-xs font-normal text-ink-subtle">(you)</span>}
            </div>
            {(user.display_name || user.email) && (
              <div className="truncate text-xs text-ink-muted">
                {[user.display_name, user.email].filter(Boolean).join(' · ')}
              </div>
            )}
          </div>
        </div>
      </td>
      <td className={CELL}>
        <select
          value={user.role}
          disabled={self}
          title={self ? 'You cannot change your own role' : ROLE_HINT[user.role]}
          onChange={(e) => onPatch({ role: e.target.value as Role })}
          className={controlClass('sm')}
        >
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </td>
      <td className={CELL}>
        {/* Two grants, not one setting: the local GPU is a card everyone queues for, the
            cluster is an allocation. Someone can have either without the other. */}
        <div className="flex items-center gap-3">
          {grant('train.local', 'Local', 'Allow training on the shared local GPU')}
          {grant('train.cluster', 'Cluster', 'Allow submitting trainings to the cluster')}
        </div>
      </td>
      <td className={CELL}>
        <SlurmAccountField user={user} onPatch={onPatch} />
      </td>
      <td className={`${CELL} whitespace-nowrap text-ink-muted`}>
        {/* When they were last here, and whether they are here now - the latter is simply
            the former being recent, so it holds for you as well as for everyone else and
            does not depend on a tab being open to send heartbeats. Where they are is
            their business and the detail panel's, not a column in a list of everybody.
            A session lasts weeks, so the login is only the fallback for an account that
            has not made a request since last_seen_at existed. */}
        {live && (
          <span data-testid="live-now" className="mr-2 inline-flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-ok" />
            <span className="text-ok">online</span>
          </span>
        )}
        <span data-testid="last-login" title={seen ? formatDate(seen) : 'Has not used the account yet'}>
          {seen ? formatRelative(seen) : <span className="text-ink-subtle">never</span>}
        </span>
      </td>
      <td className={CELL}>
        <div className="flex items-center gap-2">
          <span className={user.active ? 'text-ok' : 'text-ink-muted'}>
            {user.active ? 'Active' : 'Disabled'}
          </span>
          <Button
            size="xs"
            disabled={self}
            title={self ? 'You cannot disable your own account' : ''}
            onClick={() => onPatch({ active: !user.active })}
          >
            {user.active ? 'Disable' : 'Enable'}
          </Button>
        </div>
      </td>
      <td className="py-2 text-right">
        <Button
          size="xs"
          variant="ghost"
          aria-expanded={expanded}
          aria-label={`${expanded ? 'Hide' : 'Show'} details for ${user.username || user.subject}`}
          onClick={onToggle}
        >
          {expanded ? 'Hide' : 'Details'}
        </Button>
      </td>
    </tr>
  )
}

export function AdminPage() {
  useCrumb('Admin')
  const { id: myId, isAdmin } = useAuth()
  const [users, setUsers] = useState<AppUser[] | null>(null)
  // The capability catalogue comes with the accounts, so the matrix shows exactly what
  // this build offers rather than a copy of the list that can drift from the server's.
  const [capabilities, setCapabilities] = useState<string[]>([])
  const [invitations, setInvitations] = useState(false)
  const [accounts, setAccounts] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  useAutoClear(error, setError)
  const [expanded, setExpanded] = useState<number | null>(null)

  // Re-read on a timer, or the dots would say who was here when the page was opened.
  // A read sent before an edit started carries the old role, so its reply is dropped
  // however late it lands; none is sent while an edit is in flight.
  const patching = useRef(0)
  const edits = useRef(0)
  useEffect(() => {
    const load = () => {
      if (patching.current > 0) return
      const sentAfter = edits.current
      getUsers()
        .then((r) => {
          if (patching.current > 0 || sentAfter !== edits.current) return
          setUsers(r.users)
          setCapabilities(r.capabilities)
          setInvitations(r.invitations)
        })
        .catch((e: Error) => setError(e.message))
    }
    load()
    const timer = setInterval(load, (ONLINE_WITHIN_SECONDS / 10) * 1000)
    // Suggestions only: a locked or unconfigured cluster leaves the field free text.
    getSlurmAccounts()
      .then((r) => setAccounts(r.accounts))
      .catch(() => undefined)
    return () => clearInterval(timer)
  }, [])

  const replace = useCallback(
    (updated: AppUser) => setUsers((prev) => prev?.map((u) => (u.id === updated.id ? updated : u)) ?? null),
    [],
  )

  const apply = async (id: number, body: UserPatch) => {
    setError(null)
    patching.current += 1
    edits.current += 1
    try {
      replace(await patchUser(id, body))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      patching.current -= 1
    }
  }

  const onError = useCallback((message: string) => setError(message), [])

  if (!isAdmin) return <Navigate to="/" replace />

  return (
    <div className={pageShell}>
      <PageHeader title="Admin">
        Accounts live in Authentik. Here you invite people, set each person&rsquo;s role, choose which
        hardware they may train on, name the SLURM account their cluster jobs are charged to, and
        can disable access. Open a person&rsquo;s details to see what they can reach, what they have
        edited, and every change made to their account.
      </PageHeader>
      {error && <p className="mb-3 text-sm text-danger">{error}</p>}
      {invitations && <InvitePerson />}
      <datalist id={ACCOUNT_LIST_ID}>
        {accounts.map((a) => (
          <option key={a} value={a} />
        ))}
      </datalist>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className={tableHeadRow}>
            <th className={HEADER_CELL}>User</th>
            <th className={HEADER_CELL}>Role</th>
            <th className={HEADER_CELL}>Training</th>
            <th className={HEADER_CELL}>SLURM account</th>
            <th className={HEADER_CELL}>Last seen</th>
            <th className={HEADER_CELL}>Status</th>
            <th className={HEADER_CELL} />
          </tr>
        </thead>
        <tbody>
          {users?.map((u) => {
            const self = u.id === myId
            const open = expanded === u.id
            return (
              <Fragment key={u.id}>
                <UserRow
                  user={u}
                  self={self}
                  live={isOnline(u.last_seen_at ?? u.last_login_at)}
                  expanded={open}
                  onToggle={() => setExpanded(open ? null : u.id)}
                  onPatch={(body) => apply(u.id, body)}
                />
                {open && (
                  <tr className="border-b border-line bg-ground">
                    <td colSpan={7} className="px-2 py-3">
                      <UserDetail user={u} self={self} onChanged={replace} onError={onError} />
                    </td>
                  </tr>
                )}
              </Fragment>
            )
          })}
        </tbody>
      </table>
      {users && users.length === 0 && (
        <EmptyState className="mt-3">No accounts yet. One appears the first time somebody signs in.</EmptyState>
      )}

      {users && users.length > 0 && (
        <div className="mt-10">
          <h2 className="mb-1 font-serif text-base font-semibold">Permissions</h2>
          <p className="mb-3 text-sm text-ink-muted">
            A role is a name for a set of these, and every account starts from its role. A box
            with a ring round it is an exception made for that person; clearing it back to what
            the role says drops the exception, so a role that changes later reaches them again.
            A viewer may not write at all, so their row takes no exceptions: promote the account
            to member first. Changing anyone&rsquo;s role clears their exceptions.
          </p>
          <PermissionMatrix
            users={users}
            capabilities={capabilities}
            myId={myId}
            onPatch={(id, permissions) => void apply(id, { permissions })}
          />
        </div>
      )}

      <div className="mt-10">
        <AdminTokens />
      </div>
    </div>
  )
}
