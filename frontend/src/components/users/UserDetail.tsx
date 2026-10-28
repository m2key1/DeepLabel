import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import {
  getContributorAccess, getContributorActivity, getUserAudit, revokeUserSessions,
  type AppUser, type ContributorAccess, type ContributorActivity, type UserAuditEntry,
} from '../../api'
import { formatDate, formatRelative } from '../../util'
import { Button } from '../ui/Button'
import { AccessPanel } from './AccessPanel'
import { ActivityPanel } from './ActivityPanel'
import { ADMIN_TOKENS_ID } from './AdminTokens'
import { auditLine } from './auditLine'
import { EmptyState } from '../ui/EmptyState'

/** One section, in a card of its own. Three of these ran together as bare headings before,
 *  and the eye had nothing to tell it where one ended. */
function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="min-w-0 rounded border border-line bg-surface p-3">
      <h3 className="mb-2 border-b border-line pb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-muted">
        {title}
      </h3>
      {children}
    </section>
  )
}

const manageLink = 'ml-1.5 text-xs text-accent-ink hover:underline'

interface UserDetailProps {
  user: AppUser
  self: boolean
  onChanged: (user: AppUser) => void
  onError: (message: string) => void
}

export function UserDetail({ user, self, onChanged, onError }: UserDetailProps) {
  const [access, setAccess] = useState<ContributorAccess | null>(null)
  const [activity, setActivity] = useState<ContributorActivity | null>(null)
  const [audit, setAudit] = useState<UserAuditEntry[] | null>(null)
  const [busy, setBusy] = useState(false)

  const loadAudit = useCallback(
    () => getUserAudit(user.id).then((r) => setAudit(r.entries)).catch((e: Error) => onError(e.message)),
    [user.id, onError],
  )

  useEffect(() => {
    getContributorAccess(user.username).then(setAccess).catch((e: Error) => onError(e.message))
    getContributorActivity(user.username).then(setActivity).catch((e: Error) => onError(e.message))
  }, [user.username, onError])

  // The account can change while this is open - its role, rights or status are set right
  // above it - and the history has to show that change too.
  const changed = `${user.role}|${user.active}|${user.slurm_account}|${JSON.stringify(user.permissions)}`
  useEffect(() => {
    loadAudit()
  }, [loadAudit, changed])

  const signOutEverywhere = async () => {
    setBusy(true)
    try {
      await revokeUserSessions(user.id)
      onChanged({ ...user, sessions: 0 })
      await loadAudit()
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const loading = <p className="text-sm text-ink-subtle">Loading…</p>

  return (
    <div data-testid="user-detail" className="grid gap-4 rounded border border-line bg-ground p-4 md:grid-cols-3 [&>section:last-child]:md:col-span-3">
      <Panel title="Access">
        {access ? <AccessPanel access={access} isAdmin={user.role === 'admin'} /> : loading}
      </Panel>
      <Panel title="Activity">
        {activity ? <ActivityPanel activity={activity} /> : loading}
      </Panel>
      <Panel title="Account">
        <dl className="space-y-1 text-sm">
          <div className="flex justify-between gap-3">
            <dt className="text-ink-muted">Joined</dt>
            <dd>{formatDate(user.created_at).slice(0, 10)}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-ink-muted">Last seen</dt>
            <dd title={user.last_seen_at ? formatDate(user.last_seen_at) : undefined}>
              {user.last_seen_at ? formatRelative(user.last_seen_at) : 'never'}
            </dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-ink-muted">Last login</dt>
            <dd title={user.last_login_at ? formatDate(user.last_login_at) : undefined}>
              {user.last_login_at ? formatRelative(user.last_login_at) : 'never'}
            </dd>
          </div>
          <div className="flex items-center justify-between gap-3">
            <dt className="text-ink-muted">Sessions</dt>
            <dd className="flex items-center gap-2">
              <span data-testid="session-count">{user.sessions}</span>
              <Button
                size="xs"
                disabled={busy || self || user.sessions === 0}
                title={self ? 'Use Log out for your own sessions' : 'Sign this person out of every browser'}
                onClick={signOutEverywhere}
              >
                Sign out everywhere
              </Button>
            </dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-ink-muted">API tokens</dt>
            <dd>
              <span data-testid="token-count">{user.tokens}</span>
              {/* Expired ones stay in the list until revoked, so the count says where they went. */}
              {user.expired_tokens > 0 && (
                <span data-testid="expired-token-count" className="ml-1.5 text-xs text-ink-subtle">
                  + {user.expired_tokens} expired
                </span>
              )}
              {user.tokens + user.expired_tokens > 0 && (
                self ? (
                  <Link to="/settings?section=tokens" className={manageLink}>manage</Link>
                ) : (
                  <Link to={`?tab=tokens#${ADMIN_TOKENS_ID}`} className={manageLink}>manage</Link>
                )
              )}
            </dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-ink-muted">Subject</dt>
            <dd className="truncate font-mono text-xs" title={user.subject}>{user.subject}</dd>
          </div>
        </dl>
      </Panel>
      <Panel title="History">
        {audit === null ? loading : audit.length === 0 ? (
          <EmptyState>No changes recorded for this account.</EmptyState>
        ) : (
          <ul data-testid="user-audit" className="space-y-1 text-sm md:columns-2 md:gap-6">
            {audit.map((entry) => (
              <li key={entry.id} className="flex flex-wrap items-baseline gap-x-1.5">
                <span>{auditLine(entry, user.username || user.subject)}</span>
                <span className="text-xs text-ink-subtle" title={formatDate(entry.created_at)}>
                  by {entry.actor} · {formatRelative(entry.created_at)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  )
}
