import { createContext, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Link, Outlet, useLocation, useMatch, useNavigate } from 'react-router-dom'
import { getPendingCount, getQueue } from '../api'
import type { QueueState } from '../api'
import { useAuth } from '../auth'
import { useCommand } from '../commands'
import { useIsNarrow, useIsPhone } from '../hooks/useMediaQuery'
import { profilePath } from '../people'
import { AppFooter } from './AppFooter'
import { MenuIcon } from './icons'
import { PresencePill } from './presence/PresencePill'
import { ThemeToggle, cycleTheme } from './ThemeToggle'
import { Avatar } from './ui/Avatar'
import { Button, buttonClass } from './ui/Button'
import { popoverChrome } from './ui/Card'
import { useDismiss } from './ui/menu'

export interface Crumb {
  label: string
  to?: string
  onClick?: () => void
}

const CrumbContext = createContext<(crumbs: Crumb[]) => void>(() => {})

// Pages announce their location; the bar renders it after the brand.
// Call with the crumbs once the data they show (job name, page number) is loaded.
export function useSetCrumbs() {
  return useContext(CrumbContext)
}

export function useCrumb(label: string) {
  const set = useSetCrumbs()
  useEffect(() => {
    set([{ label }])
    return () => set([])
  }, [set, label])
}

export function Shell() {
  const [crumbs, setCrumbs] = useState<Crumb[]>([])
  const inPageEditor = !!useMatch('/jobs/:id/pages/:pageId')
  const inTileEditor = !!useMatch('/jobs/:id/tiles/:pageId')
  const inTranscript = !!useMatch('/jobs/:id/transcript')
  const inDatasetList = !!useMatch('/')
  const fullHeight = inPageEditor || inTileEditor || inTranscript || inDatasetList
  // The shell owns the viewport and the page scrolls inside it, rather than the document
  // scrolling around a nav bar of its own height. A full-height page (the editors, the
  // transcript, the dataset list) can then ask for h-full and get exactly the space left under
  // the nav - as the document, it would overflow by the nav's height and raise a window
  // scrollbar over the canvas edge. Under the footer's wrapper h-full has no height to fill,
  // so its panes grow with their content instead of scrolling; the dataset list, which
  // scrolls its rows under a toolbar that stays, ends its own scroll with the footer.
  return (
    <CrumbContext.Provider value={setCrumbs}>
      <div className="flex h-screen flex-col">
        <div className="shrink-0">
          <NavBar crumbs={crumbs} />
        </div>
        <div data-testid="app-main" className="min-h-0 flex-1 overflow-auto">
          {fullHeight ? <Outlet /> : (
            <div className="flex min-h-full flex-col">
              <div className="flex-1"><Outlet /></div>
              <AppFooter />
            </div>
          )}
        </div>
      </div>
    </CrumbContext.Provider>
  )
}

/** What has the GPU: a dataset, training or evaluation by name, else a recognition request. */
function busyWith(queue: QueueState): string | null {
  if (queue.gpu.running) return queue.gpu.running.name
  return queue.recognition?.length ? 'recognition request' : null
}

function queueSummary(queue: QueueState) {
  const busy = busyWith(queue)
  return [busy ? `running: ${busy}` : 'idle', `${queue.gpu.queued.length} queued`,
          ...(queue.cluster.length ? [`${queue.cluster.length} on cluster`] : [])].join(' · ')
}

/** The pipeline's state on the bar. Narrow, only its dot: the counts are in the menu. */
function QueuePill({ queue, compact }: { queue: QueueState | null; compact: boolean }) {
  if (!queue) return null
  const busy = busyWith(queue)
  const dot = <span className={`h-1.5 w-1.5 rounded-full ${busy ? 'animate-pulse bg-accent' : 'bg-line-strong'}`} />
  if (compact) {
    return (
      <Link to="/queue" data-testid="queue-pill" aria-label={`Queue: ${queueSummary(queue)}`}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full pointer-coarse:h-11 pointer-coarse:w-11">
        {dot}
      </Link>
    )
  }
  return (
    <Link
      to="/queue"
      data-testid="queue-pill"
      title={busy ? `running: ${busy}` : 'pipeline idle'}
      className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-line px-2.5 py-0.5 text-xs text-ink-subtle hover:border-accent hover:text-accent-ink"
    >
      {dot}
      {busy ? <span className="max-w-48 truncate">{busy}</span> : 'idle'}
      <span>· {queue.gpu.queued.length} queued</span>
      {queue.cluster.length > 0 && <span>· {queue.cluster.length} on cluster</span>}
    </Link>
  )
}

/** Your own avatar, which opens your profile - where your settings and logging out are. */
function ProfileLink() {
  const { user } = useAuth()
  return (
    <Link
      to={profilePath(user)}
      data-testid="user-menu"
      title={`${user} - your profile`}
      className="flex items-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <Avatar name={user} size="sm" />
    </Link>
  )
}

// How often an admin's top bar asks whether anyone is waiting to be let in.
const PENDING_EVERY_MS = 30_000

/** How many sign-ups wait for an admin, for the badge on Admin; 0 for anyone else. */
function usePendingCount(isAdmin: boolean): number {
  const [count, setCount] = useState(0)
  useEffect(() => {
    if (!isAdmin) return
    const refresh = () => getPendingCount().then((r) => setCount(r.count)).catch(() => {})
    refresh()
    const t = setInterval(refresh, PENDING_EVERY_MS)
    return () => clearInterval(t)
  }, [isAdmin])
  return count
}

export function NavBar({ crumbs }: { crumbs: Crumb[] }) {
  const { user, isAdmin, canEdit, can } = useAuth()
  const [queue, setQueue] = useState<QueueState | null>(null)
  const pending = usePendingCount(isAdmin)
  const navigate = useNavigate()
  const narrow = useIsNarrow()
  const phone = useIsPhone()

  // The nav is on every page, so these are the commands that work anywhere. Each is
  // offered only where its link is: a key must not reach a page its owner may not open.
  useCommand('goJobs', () => navigate('/'))
  useCommand('goQueue', () => navigate('/queue'))
  useCommand('goModels', () => navigate('/models'))
  useCommand('goSettings', () => navigate(profilePath(user)))
  useCommand('toggleTheme', cycleTheme)
  useCommand('goAdmin', () => navigate('/admin'), isAdmin)
  useCommand('newJob', () => navigate('/new'), canEdit)

  useEffect(() => {
    const refresh = () => getQueue().then(setQueue).catch(() => {})
    refresh()
    const t = setInterval(refresh, 5000)
    return () => clearInterval(t)
  }, [])

  const adminLink = (className: string) => (
    <Link to="/admin" className={className}
          title={pending ? `${pending} waiting for approval` : undefined}>
      Admin
      {pending > 0 && (
        <span data-testid="admin-pending" aria-label={`${pending} waiting for approval`}
              className="min-w-4 rounded-full bg-accent px-1 text-center text-[10px] font-semibold leading-4 text-on-accent">
          {pending}
        </span>
      )}
    </Link>
  )

  return (
    <header className="relative border-b border-line bg-surface">
      <div className="flex h-12 items-center gap-3 px-4">
        <nav className="flex min-w-0 items-center gap-2 text-sm">
          <Link to="/" className="shrink-0 font-serif text-base font-semibold hover:text-accent-ink">
            DeepLabel
          </Link>
          {/* On a phone the page's own title says where you are. */}
          {!phone && crumbs.map((c, i) => (
            <span key={i} className="flex min-w-0 items-center gap-2">
              <span className="text-line">/</span>
              {c.to ? (
                <Link to={c.to} className="truncate text-ink-muted hover:text-accent-ink">
                  {c.label}
                </Link>
              ) : c.onClick ? (
                <button
                  onClick={c.onClick}
                  className="truncate text-ink-muted hover:text-accent-ink"
                >
                  {c.label}
                </button>
              ) : (
                <span className="truncate font-medium">{c.label}</span>
              )}
            </span>
          ))}
        </nav>
        <QueuePill queue={queue} compact={narrow} />
        {narrow ? (
          <PhoneMenu queue={queue} adminLink={isAdmin ? adminLink : null} canEdit={canEdit} canTry={can('recognize')} />
        ) : (
          <>
            <PresencePill />
            <div className="ml-auto flex shrink-0 items-center gap-2">
              <Link to="/queue" className={buttonClass({ variant: 'ghost', size: 'sm' }, 'whitespace-nowrap')}>
                Queue
              </Link>
              <Link to="/models" className={buttonClass({ variant: 'ghost', size: 'sm' }, 'whitespace-nowrap')}>
                Models
              </Link>
              {can('recognize') && (
                <Link to="/try" className={buttonClass({ variant: 'ghost', size: 'sm' }, 'whitespace-nowrap')}>
                  Try
                </Link>
              )}
              {isAdmin && adminLink(buttonClass({ variant: 'ghost', size: 'sm' }, 'gap-1.5 whitespace-nowrap'))}
              {canEdit && (
                <Link to="/new" className={buttonClass({ variant: 'primary', size: 'md' }, 'whitespace-nowrap')}>
                  New job
                </Link>
              )}
              <ThemeToggle />
              <ProfileLink />
            </div>
          </>
        )}
      </div>
    </header>
  )
}

/** Everything the bar holds beyond the logo and the queue's dot, behind one button. It
 *  shuts on a pick, on a tap elsewhere and on Escape, and whenever the page changes. */
function PhoneMenu({ queue, adminLink, canEdit, canTry }: {
  queue: QueueState | null
  adminLink: ((className: string) => ReactNode) | null
  canEdit: boolean
  canTry: boolean
}) {
  const { user } = useAuth()
  const [open, setOpen] = useState(false)
  const { pathname } = useLocation()
  useDismiss(open, () => setOpen(false))
  useEffect(() => setOpen(false), [pathname])

  const item = buttonClass({ variant: 'ghost', size: 'md' }, 'w-full justify-start')
  return (
    <div className="ml-auto">
      <Button variant="ghost" size="icon" data-testid="nav-menu-button" aria-label="Menu" aria-expanded={open}
              onClick={(e) => {
                e.stopPropagation()
                setOpen((o) => !o)
              }}>
        <MenuIcon />
      </Button>
      {open && (
        <nav aria-label="Menu" data-testid="nav-menu"
             onClick={(e) => e.stopPropagation()}
             className={`absolute inset-x-2 top-12 z-40 flex flex-col gap-1 p-2 ${popoverChrome}`}>
          <Link to="/queue" className={item}>
            Queue
            {queue && <span className="ml-auto text-xs font-normal text-ink-subtle">{queueSummary(queue)}</span>}
          </Link>
          <Link to="/models" className={item}>Models</Link>
          {canTry && <Link to="/try" className={item}>Try</Link>}
          {adminLink?.(`${item} gap-1.5`)}
          {canEdit && (
            <Link to="/new" className={buttonClass({ variant: 'primary', size: 'md' }, 'w-full')}>
              New job
            </Link>
          )}
          <div className="mt-1 flex items-center gap-2 border-t border-line pt-2">
            <ProfileLink />
            <Link to={profilePath(user)} className="truncate text-sm text-ink-muted">{user}</Link>
            <span className="ml-auto"><ThemeToggle /></span>
          </div>
        </nav>
      )}
    </div>
  )
}
