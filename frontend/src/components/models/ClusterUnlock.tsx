import { useCallback, useEffect, useRef, useState } from 'react'
import { answerClusterSession, getClusterSession, openClusterSession } from '../../api'
import type { ClusterSession, ClusterUnlock as Unlock } from '../../api'
import { modalBtn, modalPrimaryBtn } from '../Modal'
import { useAutoClear } from '../../messages'
import { controlClass } from '../ui/Field'

interface ClusterUnlockProps {
  // Begin the login as soon as this renders. The training form does; a reconnect
  // offered next to a running run waits for the click, so a page load never dials out.
  autoStart?: boolean
  // Whether this caller may open the session at all. Answering the cluster's second
  // factor needs the admin's own code, so everyone else sees the state and nothing more.
  canUnlock?: boolean
  onStatus?: (status: ClusterSession) => void
}

const inputClass = controlClass('md', 'w-full')

export function ClusterUnlock({ autoStart = false, canUnlock = true, onStatus }: ClusterUnlockProps) {
  const [session, setSession] = useState<ClusterSession | null>(null)
  const [unlock, setUnlock] = useState<Unlock | null>(null)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useAutoClear(error, setError)

  // Callers pass an inline callback, so it is read through a ref: depending on it would
  // ask the cluster for its state again on every render of the page around this.
  const onStatusRef = useRef(onStatus)
  useEffect(() => {
    onStatusRef.current = onStatus
  }, [onStatus])
  const report = useCallback((status: ClusterSession) => {
    setSession(status)
    onStatusRef.current?.(status)
  }, [])

  const connect = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const started = await openClusterSession()
      setUnlock(started.connected ? null : started)
      report({ enabled: true, connected: started.connected })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }, [report])

  useEffect(() => {
    getClusterSession()
      .then((s) => {
        report(s)
        if (autoStart && s.enabled && !s.connected) connect()
      })
      .catch((e: Error) => setError(e.message))
  }, [autoStart, connect, report])

  const verify = async () => {
    if (!unlock?.session_id) return
    setBusy(true)
    setError(null)
    try {
      await answerClusterSession(unlock.session_id, code)
      report({ enabled: true, connected: true })
      setUnlock(null)
      setCode('')
    } catch (e) {
      // The cluster accepts one answer per prompt, so a refused code means starting
      // over rather than typing into a spent attempt.
      setError((e as Error).message)
      setUnlock(null)
    } finally {
      setBusy(false)
    }
  }

  if (!session?.enabled) return null

  return (
    <div data-testid="cluster-session"
         className="rounded border border-line p-3 text-sm">
      {session.connected ? (
        <span className="text-ok">Cluster session active</span>
      ) : !canUnlock ? (
        <span className="text-warn">
          No cluster session - an admin has to connect before a run can be submitted.
        </span>
      ) : unlock ? (
        <>
          <label htmlFor="cluster-code" className="mb-1 block text-ink">
            {unlock.prompt}
          </label>
          <div className="flex gap-2">
            <input
              id="cluster-code"
              autoFocus
              autoComplete="one-time-code"
              inputMode="numeric"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && verify()}
              className={inputClass}
            />
            <button onClick={verify} disabled={busy || !code.trim()}
                    className={`${modalPrimaryBtn} disabled:opacity-40`}>
              {busy ? 'Verifying…' : 'Verify'}
            </button>
          </div>
        </>
      ) : (
        <button onClick={connect} disabled={busy} className={modalBtn}>
          {busy ? 'Connecting…' : 'Connect to cluster'}
        </button>
      )}
      {error && <p className="mt-2 text-danger">{error}</p>}
    </div>
  )
}
