import { useEffect } from 'react'

/** How long a message stays on screen. Long enough to read a sentence twice, short enough
 *  that it is gone by the time you have fixed it and come back. */
export const MESSAGE_TIMEOUT_MS = 10_000

/**
 * Clear a message a while after it appears - a failure, or the confirmation of something
 * that worked. Sits next to the `useState` that holds it, rather than replacing it, so the
 * setter stays the stable one React hands out and every dependency array keeps working.
 *
 * Only for a message shown *beside* what you were doing. Where the message is the whole
 * view - a panel with nothing else to say, a page that failed to load - it has to stay, or
 * the view goes blank with no reason given.
 */
export function useAutoClear(
  message: string | null,
  clear: (value: null) => void,
  timeout = MESSAGE_TIMEOUT_MS,
) {
  useEffect(() => {
    if (!message) return
    // Keyed on the message, so a second failure restarts the clock rather than
    // inheriting what was left of the first one's.
    const timer = window.setTimeout(() => clear(null), timeout)
    return () => window.clearTimeout(timer)
  }, [message, clear, timeout])
}
