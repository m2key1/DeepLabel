import { useEffect } from 'react'

/**
 * Calls `read` now and then every `intervalMs` while the tab is in view. A hidden tab is
 * not polled at all, not even once on mount, and coming back into view reads at once and
 * starts the interval over, so what the person returns to is current without waiting out
 * a tick.
 */
export function usePolling(read: () => void, intervalMs: number, enabled = true) {
  useEffect(() => {
    if (!enabled) return
    let timer: number | undefined
    const stop = () => window.clearInterval(timer)
    const start = () => {
      stop()
      timer = window.setInterval(read, intervalMs)
    }
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return stop()
      read()
      start()
    }
    if (document.visibilityState === 'visible') {
      read()
      start()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [read, intervalMs, enabled])
}
