import { useRef } from 'react'
import { ApiError, conflictOf } from '../api'
import type { ConflictDetail } from '../api'

/** The revisions edits are based on. A row's is the newest of what it was loaded at and
 *  what this tab's own saves of it answered with, so two edits of one row in a row never
 *  refuse each other. */
export class RevisionBook {
  private readonly known = new Map<string, number>()

  of(noun: string, id: number, loaded = 0): number {
    return Math.max(loaded, this.known.get(`${noun}:${id}`) ?? 0)
  }

  note(noun: string, id: number, revision: number | undefined) {
    if (revision === undefined) return
    const key = `${noun}:${id}`
    this.known.set(key, Math.max(revision, this.known.get(key) ?? 0))
  }

  noteElement(el: { id: number; revision: number; lines: { id: number; revision: number }[] }) {
    this.note('box', el.id, el.revision)
    el.lines.forEach((l) => this.note('line', l.id, l.revision))
  }
}

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
export function guardedSaves(onConflict: (message: string) => void, book = new RevisionBook()): GuardedSave {
  const queues = new Map<string, Promise<unknown>>()
  return (noun, row, save) => {
    const key = `${noun}:${row.id}`
    const run = async () => {
      try {
        const saved = await save(book.of(noun, row.id, row.revision))
        book.note(noun, row.id, saved.revision)
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

export function useGuardedSave(onConflict: (message: string) => void, book?: RevisionBook): GuardedSave {
  const onConflictRef = useRef(onConflict)
  onConflictRef.current = onConflict
  const save = useRef<GuardedSave | null>(null)
  save.current ??= guardedSaves((message) => onConflictRef.current(message), book)
  return save.current
}
