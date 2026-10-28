import { createContext, useContext, useEffect, useState } from 'react'
import { Link, Outlet, useMatch, useNavigate } from 'react-router-dom'
import { getQueue } from '../api'
import type { QueueState } from '../api'
import { useAuth } from '../auth'
import { useCommand } from '../commands'
import { profilePath } from '../people'
import { AppFooter } from './AppFooter'
import { PresencePill } from './presence/PresencePill'
import { ThemeToggle, cycleTheme } from './ThemeToggle'
import { Avatar } from './ui/Avatar'
import { buttonClass } from './ui/Button'

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
  const inEditor = !!useMatch('/jobs/:id/pages/:pageId') || !!useMatch('/jobs/:id/tiles/:pageId')
  // The shell owns the viewport and the page scrolls inside it, rather than the document
  // scrolling around a nav bar of its own height. A full-height page (the editors) can then
  // ask for h-full and get exactly the space left under the nav — as the document, it would
  // overflow by the nav's height and raise a window scrollbar over the canvas edge.
  return (
    <CrumbContext.Provider value={setCrumbs}>
      <div className="flex h-screen flex-col">
        <div className="shrink-0">
          <NavBar crumbs={crumbs} />
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {inEditor ? <Outlet /> : (
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

function QueuePill({ queue }: { queue: QueueState | null }) {
  if (!queue) return null
  const running = queue.gpu.running
  return (
    <Link
      to="/queue"
      data-testid="queue-pill"
      title={running ? `running: ${running.name}` : 'pipeline idle'}
      className="flex items-center gap-1.5 rounded-full border border-line px-2.5 py-0.5 text-xs text-ink-subtle hover:border-accent hover:text-accent-ink"
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${running ? 'animate-pulse bg-accent' : 'bg-line-strong'}`}
      />
      {running ? <span className="max-w-48 truncate">{running.name}</span> : 'idle'}
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

export function NavBar({ crumbs }: { crumbs: Crumb[] }) {
  const { user, isAdmin, canEdit } = useAuth()
  const [queue, setQueue] = useState<QueueState | null>(null)
  const navigate = useNavigate()

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

  return (
    <header className="border-b border-line bg-surface">
      <div className="flex h-12 items-center gap-3 px-4">
        <nav className="flex min-w-0 items-center gap-2 text-sm">
          <Link to="/" className="shrink-0 font-serif text-base font-semibold hover:text-accent-ink">
            DeepLabel
          </Link>
          {crumbs.map((c, i) => (
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
        <QueuePill queue={queue} />
        <PresencePill />
        <div className="ml-auto flex items-center gap-2">
          <Link to="/queue" className={buttonClass({ variant: 'ghost', size: 'sm' })}>
            Queue
          </Link>
          <Link to="/models" className={buttonClass({ variant: 'ghost', size: 'sm' })}>
            Models
          </Link>
          {isAdmin && (
            <Link to="/admin" className={buttonClass({ variant: 'ghost', size: 'sm' })}>
              Admin
            </Link>
          )}
          {canEdit && (
            <Link to="/new" className={buttonClass({ variant: 'primary', size: 'md' })}>
              New job
            </Link>
          )}
          <ThemeToggle />
          <ProfileLink />
        </div>
      </div>
    </header>
  )
}
