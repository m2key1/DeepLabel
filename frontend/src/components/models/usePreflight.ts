import { useEffect, useRef, useState } from 'react'

import { ApiError, getPreflight, startPreflight } from '../../api'
import type { Preflight, TrainingRequest } from '../../api'

export type PreflightRequest = Omit<TrainingRequest, 'name' | 'description' | 'preflight_id'>

/** A pre-flight as shown. `failure` says why one could not be had at all: the server
 *  refusing these settings (which no run starts from either), or the request failing. */
export type ShownPreflight = Preflight & { failure?: 'refused' | 'request' }

const POLL_MS = 800
const MAX_RETRY_MS = 30_000

const isRefusal = (error: Error) => error instanceof ApiError && error.status >= 400 && error.status < 500

/** A pre-flight that could not be had, shown like one the backend failed to compute. */
export function failedPreflight(error: Error): ShownPreflight {
  return { id: -1, status: 'error', error: error.message, created_at: '', result: null, datasets: {},
           failure: isRefusal(error) ? 'refused' : 'request' }
}

/** Loads a pre-flight until it is no longer running and hands over the settled one. A
 *  failed request settles it as an error, or with `retry` is asked again later, waiting
 *  twice as long after each failure in a row. A refusal always settles: asking again
 *  would only be refused again. Returns the cancel. */
export function pollPreflight(load: () => Promise<Preflight>, onSettled: (found: ShownPreflight) => void,
                              intervalMs = POLL_MS, { retry = false } = {}): () => void {
  let cancelled = false
  let failures = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const poll = () => {
    load()
      .then((found) => {
        if (cancelled) return
        failures = 0
        if (found.status === 'running') timer = setTimeout(poll, intervalMs)
        else onSettled(found)
      })
      .catch((e: Error) => {
        if (cancelled) return
        if (!retry || isRefusal(e)) return onSettled(failedPreflight(e))
        failures += 1
        timer = setTimeout(poll, Math.min(intervalMs * 2 ** failures, MAX_RETRY_MS))
      })
  }
  poll()
  return () => {
    cancelled = true
    clearTimeout(timer)
  }
}

interface Review {
  key: string
  id: number | null
  preflight: ShownPreflight | null
}

/** What to do when settings are reviewed: keep a settled review of the same settings,
 *  pick up one still being computed, or start afresh. A failed review is always retried. */
export function nextStep(last: Review | null, key: string): 'keep' | 'resume' | 'start' {
  if (last?.key !== key) return 'start'
  if (last.preflight) return last.preflight.status === 'error' ? 'start' : 'keep'
  return last.id === null ? 'start' : 'resume'
}

/** A pre-flight for these settings, started when they are given and polled until the
 *  background job is done. `id` is the review for these settings, sent with the run so it
 *  keeps what the review step showed. Going back and reviewing the same settings again
 *  shows the same review rather than computing another. */
export function usePreflight(request: PreflightRequest | null) {
  const key = request ? JSON.stringify(request) : null
  const [review, setReview] = useState<Review | null>(null)
  const last = useRef<Review | null>(null)

  useEffect(() => {
    if (key === null) return
    const remember = (next: Review) => {
      last.current = next
      setReview(next)
    }
    const step = nextStep(last.current, key)
    if (step === 'keep') return
    let cancelled = false
    let stopPolling = () => {}
    const follow = (id: number) => {
      stopPolling = pollPreflight(() => getPreflight(id), (found) => remember({ key, id, preflight: found }))
    }
    if (step === 'resume') {
      follow(last.current!.id!)
    } else {
      remember({ key, id: null, preflight: null })
      startPreflight(JSON.parse(key) as PreflightRequest)
        .then((started) => {
          if (cancelled) return
          remember({ key, id: started.id, preflight: null })
          follow(started.id)
        })
        .catch((e: Error) => {
          if (!cancelled) remember({ key, id: null, preflight: failedPreflight(e) })
        })
    }
    return () => {
      cancelled = true
      stopPolling()
    }
  }, [key])

  const current = review !== null && review.key === key ? review : null
  return {
    preflight: current?.preflight ?? null,
    pending: key !== null && !current?.preflight,
    id: current?.id ?? null,
  }
}
