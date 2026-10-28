import type { QueueEntry } from '../../api'
import { overallProgress } from '../../util'

/** A bar on a lane: where it starts and ends, in seconds from now, and whether its length
 *  is a guess stood in for an estimate the backend could not make. */
export interface Placed {
  entry: QueueEntry
  start: number
  end: number
  unknown: boolean
  /** How much of it is done, 0 to 1, for what is running. */
  done: number
}

// A bar with no estimate still needs a length; this one says "some time" without
// pretending to know how much.
const UNKNOWN_FALLBACK = 300

export function doneShare(entry: QueueEntry): number {
  if (entry.status === 'queued') return 0
  if (entry.kind === 'dataset' && entry.job) return overallProgress(entry.job.counters, entry.job)
  if (entry.kind === 'training' && entry.training) {
    const { epochs, progress_last, snapshot_progress } = entry.training
    if (progress_last?.epoch !== undefined && epochs) return progress_last.epoch / epochs
    if (snapshot_progress?.total) return 0.02 * (snapshot_progress.done / snapshot_progress.total)
  }
  return 0
}

/** The local GPU runs one thing at a time, so each bar starts where the one before ends. */
export function placeLocal(running: QueueEntry | null, queued: QueueEntry[]): Placed[] {
  const known = [running, ...queued].flatMap((e) => (e?.eta?.seconds != null ? [e.eta.seconds] : []))
  const stand = known.length ? known.sort((a, b) => a - b)[Math.floor(known.length / 2)] : UNKNOWN_FALLBACK
  let at = 0
  return [running, ...queued].flatMap((entry) => {
    if (!entry) return []
    const unknown = entry.eta?.seconds == null
    const length = unknown ? stand : Math.max(entry.eta!.seconds!, 1)
    const placed = { entry, start: at, end: at + length, unknown, done: doneShare(entry) }
    at += length
    return [placed]
  })
}

/** Cluster runs run side by side, each from now. */
export function placeCluster(cluster: QueueEntry[]): Placed[] {
  return cluster.map((entry) => {
    const unknown = entry.eta?.seconds == null
    return { entry, start: 0, end: unknown ? UNKNOWN_FALLBACK : Math.max(entry.eta!.seconds!, 1), unknown,
             done: doneShare(entry) }
  })
}

const STEPS = [15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400]

/** A tick every so many seconds, so the axis carries at most six labels. */
export function tickStep(span: number): number {
  return STEPS.find((step) => span / step <= 6) ?? 86400 * Math.ceil(span / 86400 / 6)
}

export function spanLabel(seconds: number): string {
  if (seconds < 60) return `+${Math.round(seconds)} s`
  if (seconds < 3600) return `+${Math.round(seconds / 60)} min`
  if (seconds < 86400) return `+${+(seconds / 3600).toFixed(1)} h`
  return `+${+(seconds / 86400).toFixed(1)} d`
}

export function clock(fromNow: number, now: number): string {
  return new Date(now + fromNow * 1000).toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' })
}
