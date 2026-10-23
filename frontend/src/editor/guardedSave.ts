import { useRef } from 'react'
import { ApiError, conflictOf } from '../api'
import type { ConflictDetail } from '../api'

export type GuardedSave = <T extends { revision: number }>(
  noun: string,
  row: { id: number; revision: number },
  save: (revision: number) => Promise<T>,
) => Promise<T>

export function conflictMessage(noun: string, clash: ConflictDetail<unknown>): string {
  return `${clash.author ?? 'Someone'} changed this ${noun} since you loaded it - ` +
    'theirs is shown now; make your change again to replace it.'
}

/** Saves of one row hand back the revision they were based on, so a colleague's edit in
 *  between is refused rather than overwritten. They go out one after another, each on
 *  the newest revision known for the row, so two quick edits of your own - a held nudge
 *  key - never refuse each other. A refusal is reported, and rejects with the same
 *  message for callers that show their own errors. */
export function guardedSaves(onConflict: (message: string) => void): GuardedSave {
  const queues = new Map<string, Promise<unknown>>()
  const known = new Map<string, number>()
  return (noun, row, save) => {
    const key = `${noun}:${row.id}`
    const run = async () => {
      try {
        const saved = await save(Math.max(row.revision, known.get(key) ?? 0))
        known.set(key, saved.revision)
        return saved
      } catch (e) {
        const clash = conflictOf(e)
        if (!clash) throw e
        const message = conflictMessage(noun, clash)
        onConflict(message)
        throw new ApiError(message, 409, clash)
      }
    }
    const queued = (queues.get(key) ?? Promise.resolve()).catch(() => undefined).then(run)
    queues.set(key, queued)
    return queued
  }
}

export function useGuardedSave(onConflict: (message: string) => void): GuardedSave {
  const onConflictRef = useRef(onConflict)
  onConflictRef.current = onConflict
  const save = useRef<GuardedSave | null>(null)
  save.current ??= guardedSaves((message) => onConflictRef.current(message))
  return save.current
}
