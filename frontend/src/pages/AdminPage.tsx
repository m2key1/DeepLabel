import { useCallback, useEffect, useRef, useState } from 'react'
import { Navigate, useSearchParams } from 'react-router-dom'
import { getSlurmAccounts, getUsers, patchUser, type AppUser, type Role } from '../api'
import { useAuth } from '../auth'
import { useCrumb } from '../components/NavBar'
import { Button } from '../components/ui/Button'
import { AdminTokens } from '../components/users/AdminTokens'
import { InvitePerson } from '../components/users/InvitePerson'
import { RightsTable } from '../components/users/RightsTable'
import { Tabs, panelId, tabId } from '../components/ui/Tabs'
import { UserDetail } from '../components/users/UserDetail'
import { ONLINE_WITHIN_SECONDS } from '../util'
import { EmptyState } from '../components/ui/EmptyState'
import { controlClass } from '../components/ui/Field'
import { PageHeader } from '../components/ui/PageHeader'
import { pageShell } from '../components/ui/page'
import { useAutoClear } from '../messages'

const ROLES: Role[] = ['admin', 'member', 'viewer']

const ROLE_HINT: Record<Role, string> = {
  admin: 'Full access: pipeline, deletion, user management.',
  member: 'Annotate, run layout, lines and OCR, train locally; '
    + 'no discarding checked work, deleting datasets, managing models or admin actions.',
  viewer: 'Read-only.',
}

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

/** What changes an account itself, kept out of the table: role, cluster account, and
 *  whether it may sign in at all. */
function AccountControls({ user, self, onPatch }: { user: AppUser; self: boolean; onPatch: (body: UserPatch) => void }) {
  return (
    <div data-testid="user-account" data-user={user.username || user.subject}
         className="mb-3 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
      <label className="flex items-center gap-2">
        <span className="text-ink-muted">Role</span>
        <select data-testid="role-select" value={user.role} disabled={self}
                title={self ? 'You cannot change your own role' : ROLE_HINT[user.role]}
                onChange={(e) => onPatch({ role: e.target.value as Role })} className={controlClass('sm')}>
          {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
      </label>
      <label className="flex items-center gap-2">
        <span className="text-ink-muted">SLURM account</span>
        <SlurmAccountField user={user} onPatch={onPatch} />
      </label>
      <span className="flex items-center gap-2">
        <span className={user.active ? 'text-ok' : 'text-danger'}>{user.active ? 'Active' : 'Disabled'}</span>
        <Button size="xs" disabled={self} title={self ? 'You cannot disable your own account' : ''}
                onClick={() => onPatch({ active: !user.active })}>
          {user.active ? 'Disable' : 'Enable'}
        </Button>
      </span>
    </div>
  )
}

export function AdminPage() {
  useCrumb('Admin')
  const { id: myId, isAdmin } = useAuth()
  const [users, setUsers] = useState<AppUser[] | null>(null)
  // The capability catalogue comes with the accounts, so the matrix shows exactly what
  // this build offers rather than a copy of the list that can drift from the server's.
  const [capabilities, setCapabilities] = useState<string[]>([])
  const [roles, setRoles] = useState<Record<string, string[]>>({})
  const [params, setParams] = useSearchParams()
  const tab = params.get('tab') === 'tokens' ? 'tokens' : 'people'
  const setTab = (next: 'people' | 'tokens') => setParams(next === 'people' ? {} : { tab: next }, { replace: true })
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
          setRoles(r.roles ?? {})
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
        Accounts live in Authentik. Here you set what each person may do; click a name for
        their role, cluster account, sessions and history.
      </PageHeader>
      {error && <p className="mb-3 text-sm text-danger">{error}</p>}
      <Tabs label="Admin" className="mb-4" active={tab} onSelect={setTab}
            items={[{ id: 'people', label: `People${users ? ` ${users.length}` : ''}` }, { id: 'tokens', label: 'API tokens' }]} />
      <datalist id={ACCOUNT_LIST_ID}>
        {accounts.map((a) => (
          <option key={a} value={a} />
        ))}
      </datalist>
      {tab === 'people' && (
        <div role="tabpanel" id={panelId('people')} aria-labelledby={tabId('people')}>
          {invitations && <InvitePerson />}
          {users && users.length === 0 && (
            <EmptyState className="mt-3">No accounts yet. One appears the first time somebody signs in.</EmptyState>
          )}
          {users && users.length > 0 && (
            <RightsTable
              users={users}
              capabilities={capabilities}
              roles={roles}
              myId={myId}
              expanded={expanded}
              onToggle={(id) => setExpanded(expanded === id ? null : id)}
              onPatch={(id, permissions) => void apply(id, { permissions })}
              detail={(u) => (
                <>
                  <AccountControls user={u} self={u.id === myId} onPatch={(body) => apply(u.id, body)} />
                  <UserDetail user={u} self={u.id === myId} onChanged={replace} onError={onError} />
                </>
              )}
            />
          )}
        </div>
      )}
      {tab === 'tokens' && (
        <div role="tabpanel" id={panelId('tokens')} aria-labelledby={tabId('tokens')}>
          <AdminTokens />
        </div>
      )}
    </div>
  )
}
