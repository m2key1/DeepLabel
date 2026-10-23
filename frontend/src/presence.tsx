import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { getPresence, PRESENCE_LEAVE_URL, sendPresence } from './api'
import type { PresenceEntry, PresenceLocation, PresenceTargetKind } from './api'
import { useAuth } from './auth'
import { useSettings } from './settings'

// Who else has which page open. Every visible tab that shares its activity sends a
// heartbeat with its location; the backend forgets a tab a minute after the last one.
// Reading is a plain poll: a handful of annotators do not need a socket.
const HEARTBEAT_MS = 20_000
const POLL_MS = 10_000
const ANNOUNCE_DEBOUNCE_MS = 300
const TAB_KEY = 'deeplabel.tab'

// A tab id only has to be unique and opaque. crypto.randomUUID would do it, but it is
// secure-context only and a deployment is reached over plain HTTP on its published port,
// where it is not merely undefined - reading it throws and the app never boots.
function freshTabId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// Stable per tab across reloads, so a reload replaces the entry instead of adding one.
function tabId(): string {
  try {
    const stored = sessionStorage.getItem(TAB_KEY)
    if (stored) return stored
    const fresh = freshTabId()
    sessionStorage.setItem(TAB_KEY, fresh)
    return fresh
  } catch {
    return freshTabId()
  }
}

const TAB = tabId()

interface PresenceCtx {
  others: PresenceEntry[]
  announce: (location: PresenceLocation | null) => void
}

const Ctx = createContext<PresenceCtx | null>(null)

export function PresenceProvider({ children }: { children: ReactNode }) {
  const { user, canEdit } = useAuth()
  const { shareActivity, showActivity } = useSettings()
  const [others, setOthers] = useState<PresenceEntry[]>([])
  const location = useRef<PresenceLocation | null>(null)
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Viewers cannot write, and a heartbeat is a write; they still see everyone else.
  const broadcasting = shareActivity && canEdit

  const beat = useCallback(() => {
    if (!broadcasting || document.visibilityState !== 'visible') return
    sendPresence({ tab: TAB, ...(location.current ?? {}) }).catch(() => undefined)
  }, [broadcasting])

  // Pages announce where they are; arrow-keying through lines must not post per key.
  const announce = useCallback((next: PresenceLocation | null) => {
    location.current = next
    if (pending.current) clearTimeout(pending.current)
    pending.current = setTimeout(beat, ANNOUNCE_DEBOUNCE_MS)
  }, [beat])

  useEffect(() => {
    if (!broadcasting) return
    beat()
    const timer = setInterval(beat, HEARTBEAT_MS)
    const leave = () => {
      const body = new Blob([JSON.stringify({ tab: TAB })], { type: 'application/json' })
      navigator.sendBeacon(PRESENCE_LEAVE_URL, body)
    }
    document.addEventListener('visibilitychange', beat)
    window.addEventListener('pagehide', leave)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', beat)
      window.removeEventListener('pagehide', leave)
      leave()
    }
  }, [broadcasting, beat])

  useEffect(() => {
    if (!showActivity) {
      setOthers([])
      return
    }
    let live = true
    const poll = () => {
      if (document.visibilityState !== 'visible') return
      getPresence()
        .then((r) => live && setOthers(r.users.filter((u) => u.username !== user)))
        .catch(() => undefined)
    }
    poll()
    const timer = setInterval(poll, POLL_MS)
    document.addEventListener('visibilitychange', poll)
    return () => {
      live = false
      clearInterval(timer)
      document.removeEventListener('visibilitychange', poll)
    }
  }, [showActivity, user])

  const value = useMemo(() => ({ others, announce }), [others, announce])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

function usePresenceCtx(): PresenceCtx {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('presence hooks used outside PresenceProvider')
  return ctx
}

// A page declares where the user is while it is mounted, the way useCrumb declares
// the breadcrumb. Pass null while the page has nothing to say yet.
export function usePresenceLocation(location: PresenceLocation | null) {
  const { announce } = usePresenceCtx()
  // Callers build the object inline, so compare by value or every render would re-announce.
  const key = JSON.stringify(location)
  const latest = useRef(location)
  latest.current = location
  useEffect(() => {
    announce(latest.current)
    return () => announce(null)
  }, [announce, key])
}

export interface Presence {
  /** Everyone but you, one entry per open tab. Empty when "show others' activity" is off. */
  others: PresenceEntry[]
  onJob: (jobId: string) => PresenceEntry[]
  onPage: (pageId: number) => PresenceEntry[]
  onTarget: (kind: PresenceTargetKind, id: number) => PresenceEntry[]
}

export function usePresence(): Presence {
  const { others } = usePresenceCtx()
  return useMemo(() => ({
    others,
    onJob: (jobId) => others.filter((o) => o.job_id === jobId),
    onPage: (pageId) => others.filter((o) => o.page_id === pageId),
    onTarget: (kind, id) => others.filter((o) => o.target?.kind === kind && o.target.id === id),
  }), [others])
}
