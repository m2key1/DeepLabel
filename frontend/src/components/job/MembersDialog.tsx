import { useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { getUserNames, shareGroup, shareJob } from '../../api'
import type { DatasetRole, Group, Job, UserName } from '../../api'
import { useAuth } from '../../auth'
import { ROLE_LABEL } from '../../lib/roles'
import { Modal, modalBtn, modalPrimaryBtn } from '../Modal'
import { Avatar } from '../ui/Avatar'
import { Button } from '../ui/Button'
import { Select, controlClass } from '../ui/Field'

export type MembersTarget = { kind: 'workspace'; group: Group } | { kind: 'dataset'; job: Job; group?: Group }

// Enough to pick from while typing; more means the name is not typed far enough yet.
const SHOWN_MATCHES = 6

const SWAPPABLE: DatasetRole[] = ['annotator', 'reviewer']

type People = { members: string[]; roles: Record<string, DatasetRole> }

const heading = 'mb-1 mt-4 text-xs font-semibold uppercase tracking-wide text-ink-subtle'

interface MembersDialogProps {
  target: MembersTarget
  onClose: () => void
  /** After each saved change, so the list behind the dialog shows it at once. */
  onChanged: () => void
  /** A dataset in a Sandbox takes no members: it is moved into a workspace instead. */
  onMoveInstead: () => void
  /** Hand the workspace to someone else (#79), offered to its owner and admins. */
  onTransfer?: () => void
}

/** Who belongs to a workspace, or who reaches one dataset, as in Label Studio's Manage
 *  Members: each change is saved as it is made. */
export function MembersDialog({ target, onClose, onChanged, onMoveInstead, onTransfer }: MembersDialogProps) {
  const { user, isAdmin } = useAuth()
  const job = target.kind === 'dataset' ? target.job : null
  const group = target.group
  const title = `Members of "${job ? job.name : group!.name}"`
  const [accounts, setAccounts] = useState<Map<string, UserName> | null>(null)
  // Invited and not signed in yet, who can already be members (#134).
  const [invited, setInvited] = useState<Set<string>>(new Set())
  const [members, setMembers] = useState<string[]>(job ? job.shared_with : group!.shared_with)
  const [roles, setRoles] = useState<Record<string, DatasetRole>>(job?.roles ?? {})
  // Each change is worked out from what the one before it saved, in the order they were made,
  // so one made while another is still saving is neither lost nor undoes it.
  const saved = useRef<People>({ members, roles })
  const queue = useRef(Promise.resolve())
  const [saving, setSaving] = useState(0)
  const busy = saving > 0
  const [error, setError] = useState<string | null>(null)
  const sandboxed = !!job && !!group?.sandbox_of

  useEffect(() => {
    if (sandboxed) return
    getUserNames()
      .then((r) => {
        setAccounts(new Map(r.users.map((u) => [u.username, u])))
        setInvited(new Set(r.invited ?? []))
      })
      .catch((e: Error) => setError(e.message))
  }, [sandboxed])

  if (sandboxed && job) {
    return (
      <Modal title={title} onClose={onClose}>
        <p data-testid="share-sandboxed" className="mb-4 text-sm text-ink-muted">
          {job.owner === user
            ? 'It is in your Sandbox, which only you can see.'
            : `It is in ${job.owner}'s Sandbox, which only ${job.owner} can see.`}
          {' '}To share it, move it into a workspace: everyone in that workspace can then open it.
        </p>
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className={modalBtn}>Cancel</button>
          <button onClick={onMoveInstead} className={modalPrimaryBtn}>Move to a workspace…</button>
        </div>
      </Modal>
    )
  }

  const save = (change: (now: People) => People) => {
    setSaving((n) => n + 1)
    queue.current = queue.current.then(async () => {
      setError(null)
      try {
        const wanted = change(saved.current)
        if (job) {
          const answer = await shareJob(job.id, wanted.members, wanted.roles)
          saved.current = { members: answer.shared_with, roles: answer.roles }
        } else {
          saved.current = { members: (await shareGroup(group!.id, wanted.members)).shared_with, roles: wanted.roles }
        }
        setMembers(saved.current.members)
        setRoles(saved.current.roles)
        onChanged()
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setSaving((n) => n - 1)
      }
    })
  }

  const add = (account: UserName) => save((now) => ({ ...now, members: [...now.members, account.username] }))
  const remove = (username: string) => {
    if (!job && username === user && !isAdmin
        && !confirm(`Leave "${group!.name}"? You will no longer see it or its datasets, apart from those you created.`)) {
      return
    }
    save((now) => ({ ...now, members: now.members.filter((m) => m !== username) }))
  }
  const setRole = (username: string, role: DatasetRole) => save((now) => {
    const others = Object.fromEntries(Object.entries(now.roles).filter(([name]) => name !== username))
    return { ...now, roles: role === accounts?.get(username)?.role ? others : { ...others, [username]: role } }
  })

  // People reaching the dataset through its workspace, less those also given it alone,
  // who are listed once, where they can be taken off it.
  const throughWorkspace = job ? (group?.shared_with ?? []).filter((m) => !members.includes(m)) : []
  // Whoever created the dataset manages it, so they are listed even from outside the workspace.
  const creatorApart = job && !members.includes(job.owner) && !throughWorkspace.includes(job.owner) ? job.owner : null
  const listed = new Set([...members, ...throughWorkspace, ...(job ? [job.owner] : [])])
  const candidates = accounts
    ? [...accounts.values()].filter((a) => !listed.has(a.username)).sort((a, b) => nameOf(a).localeCompare(nameOf(b)))
    : []

  const roleCell = (username: string): ReactNode => {
    const account = accounts?.get(username)
    if (!accounts) return <span className="text-xs text-ink-subtle">…</span>
    if (job && username === job.owner) {
      return (
        <span data-testid="member-role" className="text-xs text-ink-muted" title="Whoever created a dataset manages it">
          {account ? `${ROLE_LABEL[account.role === 'admin' ? 'admin' : 'manager']} (creator)` : 'Creator'}
        </span>
      )
    }
    if (!account) {
      return (
        <span data-testid="member-role" className="text-xs text-ink-subtle">
          {invited.has(username) ? 'Invited, not signed in yet' : 'No active account'}
        </span>
      )
    }
    if (job && (SWAPPABLE as string[]).includes(account.role)) {
      return (
        <Select size="xs" aria-label={`Role of ${username} on this dataset`} disabled={busy}
                value={roles[username] ?? account.role}
                onChange={(e) => setRole(username, e.target.value as DatasetRole)}>
          {SWAPPABLE.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
        </Select>
      )
    }
    return <span data-testid="member-role" className="text-xs text-ink-muted">{ROLE_LABEL[account.role]}</span>
  }

  /** Under the name of someone whose role here is not their account's. */
  const elsewhere = (username: string): string | undefined => {
    const account = accounts?.get(username)
    return account && roles[username] && roles[username] !== account.role
      ? `${ROLE_LABEL[account.role]} elsewhere` : undefined
  }

  const row = (username: string, removable: boolean) => (
    <MemberRow key={username} username={username} account={accounts?.get(username)} note={elsewhere(username)}>
      {roleCell(username)}
      {/* The same width with or without the button, so the roles line up in one column. */}
      <span className="flex w-16 justify-end">
        {removable && (
          <Button variant="ghost" size="xs" aria-label={`Remove ${username}`} disabled={busy}
                  onClick={() => remove(username)}>
            Remove
          </Button>
        )}
      </span>
    </MemberRow>
  )

  return (
    <Modal title={title} onClose={onClose}>
      <p className="mb-3 text-sm text-ink-muted">
        {job
          ? `Someone given this dataset alone opens it without seeing the rest of ${group?.name ?? 'its workspace'}. `
            + 'An Annotator or Reviewer can be made the other role on this dataset only.'
          : 'Everyone here opens every dataset in this workspace, now and later. Their role decides what they may do.'}
      </p>
      <AddSomeone candidates={candidates} loading={!accounts && !error} onAdd={add} />
      {job ? (
        <>
          <h3 className={heading}>Given this dataset</h3>
          <ul data-testid="members-given-alone" className="divide-y divide-line">
            {members.length ? members.map((m) => row(m, true))
              : <li className="py-1.5 text-sm text-ink-subtle">Nobody yet.</li>}
          </ul>
          {creatorApart && (
            <>
              <h3 className={heading}>Its creator</h3>
              <ul data-testid="members-creator" className="divide-y divide-line">{row(creatorApart, false)}</ul>
            </>
          )}
          {group && (
            <>
              <h3 className={heading}>Through the workspace {group.name}</h3>
              <ul data-testid="members-through-workspace" className="divide-y divide-line">
                {throughWorkspace.map((m) => row(m, false))}
              </ul>
            </>
          )}
        </>
      ) : (
        <ul className="mt-3 divide-y divide-line">{members.map((m) => row(m, true))}</ul>
      )}
      <div className="mt-4 flex items-center justify-end gap-3">
        {error && <p role="alert" className="mr-auto text-sm text-danger">{error}</p>}
        {!job && onTransfer && (
          <span className={`${error ? '' : 'mr-auto'} flex items-center gap-2 text-xs text-ink-subtle`}>
            Owned by {group!.owner}
            <button data-testid="members-transfer" onClick={onTransfer} className={modalBtn}>Transfer ownership…</button>
          </span>
        )}
        <button onClick={onClose} className={modalPrimaryBtn}>Done</button>
      </div>
    </Modal>
  )
}

function MemberRow({ username, account, note, children }: {
  username: string
  account?: UserName
  note?: string
  children: ReactNode
}) {
  return (
    <li data-testid="member" data-username={username} className="flex items-center gap-2 py-1.5">
      <Avatar name={username} displayName={account?.display_name} size="sm" />
      <span className="flex min-w-0 flex-1 flex-col">
        <PersonName username={username} displayName={account?.display_name} />
        {note && <span className="truncate text-xs text-ink-subtle">{note}</span>}
      </span>
      <span className="flex shrink-0 items-center gap-2">{children}</span>
    </li>
  )
}

function nameOf(account: UserName): string {
  return (account.display_name || account.username).toLowerCase()
}

function PersonName({ username, displayName }: { username: string; displayName?: string }) {
  const shown = displayName || username
  return (
    <span className="min-w-0 truncate text-sm">
      {shown}
      {shown !== username && <span className="ml-1.5 text-xs text-ink-subtle">{username}</span>}
    </span>
  )
}

/** A search field that offers the accounts not in yet, by username or display name. */
function AddSomeone({ candidates, loading, onAdd }: {
  candidates: UserName[]
  loading: boolean
  onAdd: (account: UserName) => void
}) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const listId = useId()
  const typed = query.trim().toLowerCase()
  const matches = typed
    ? candidates.filter((a) => a.username.toLowerCase().includes(typed) || a.display_name.toLowerCase().includes(typed))
    : []
  const shown = matches.slice(0, SHOWN_MATCHES)
  const pick = (account: UserName) => {
    onAdd(account)
    setQuery('')
    setActive(0)
  }

  return (
    <div>
      <input
        role="combobox"
        aria-label="Add someone"
        aria-expanded={shown.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={shown.length ? `${listId}-${active}` : undefined}
        placeholder={loading ? 'Loading people…' : 'Add someone: type a name'}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          setActive(0)
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && shown.length) {
            e.preventDefault()
            setActive((a) => Math.min(a + 1, shown.length - 1))
          } else if (e.key === 'ArrowUp' && shown.length) {
            e.preventDefault()
            setActive((a) => Math.max(a - 1, 0))
          } else if (e.key === 'Enter' && shown[active]) {
            e.preventDefault()
            pick(shown[active])
          } else if (e.key === 'Escape' && query) {
            // Clears the search rather than closing the dialog.
            e.preventDefault()
            setQuery('')
          }
        }}
        className={controlClass('md', 'w-full')}
      />
      {typed && !loading && (shown.length ? (
        <div className="mt-1 overflow-hidden rounded border border-line">
          <ul id={listId} role="listbox" aria-label="People to add">
            {shown.map((account, i) => (
              <li key={account.username} id={`${listId}-${i}`} role="option" aria-selected={i === active}
                  data-username={account.username}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => pick(account)}
                  className={`flex cursor-pointer items-center gap-2 px-2 py-1.5 ${i === active ? 'bg-raised' : ''}`}>
                <Avatar name={account.username} displayName={account.display_name} size="sm" />
                <PersonName username={account.username} displayName={account.display_name} />
                <span className="ml-auto shrink-0 text-xs text-ink-subtle">{ROLE_LABEL[account.role]}</span>
              </li>
            ))}
          </ul>
          {matches.length > shown.length && (
            <p className="border-t border-line px-2 py-1 text-xs text-ink-subtle">
              {matches.length - shown.length} more: type more of the name.
            </p>
          )}
        </div>
      ) : (
        <p className="mt-1 text-xs text-ink-subtle">Nobody else to add matches "{query.trim()}".</p>
      ))}
    </div>
  )
}
