import { useCallback, useEffect, useRef, useState } from 'react'
import { revertSpan } from '../api'
import type { EditSpan, RevertResult } from '../api'
import { Dropped } from './editQueue'
import type { Edit } from './editQueue'

const DEPTH = 100

/** One span over several writes that together made one gesture - an eraser stroke, a
 *  merge, a batch operation - so the whole gesture is one step back. Writes that answered
 *  with no span are skipped: see `record`. */
export function spanOf(...spans: (EditSpan | undefined)[]): EditSpan | undefined {
  const known = spans.filter((s): s is EditSpan => s !== undefined)
  if (known.length === 0) return undefined
  return { from: Math.min(...known.map((s) => s.from)), to: Math.max(...known.map((s) => s.to)) }
}

/** How an edit looks taken back and done again, shown while the server does it. */
export interface LocalSteps<S> {
  undo(state: S): S
  redo(state: S): S
}

interface Step<S> {
  span: Promise<EditSpan | undefined>
  local?: LocalSteps<S>
}

const reverts = (span: EditSpan | undefined) => !!span && span.to > span.from

/** Undo and redo for one page, kept as the spans its edits answered with. Taking a span
 *  back is the server's job - the revisions log holds how every row stood - so the stacks
 *  hold nothing but spans, and what the server hands back is applied to the page. A span
 *  somebody else has edited in or after is refused and dropped; the message says who.
 *
 *  With `enqueue`, a step goes out behind the edits still on their way, and its `local`
 *  look shows at once: an edit can be taken back before the server has even confirmed it. */
export function useEditHistory<S = unknown>(
  pageId: number | undefined,
  apply: (result: RevertResult) => void,
  onError: (message: string) => void,
  enqueue?: (edit: Edit<S, RevertResult>) => Promise<RevertResult>,
) {
  const stacks = useRef<{ undo: Step<S>[]; redo: Step<S>[] }>({ undo: [], redo: [] })
  const [depth, setDepth] = useState({ undo: 0, redo: 0 })
  const busy = useRef(false)
  const applyRef = useRef(apply)
  applyRef.current = apply
  const errorRef = useRef(onError)
  errorRef.current = onError
  const pageRef = useRef(pageId)
  pageRef.current = pageId
  const enqueueRef = useRef(enqueue)
  enqueueRef.current = enqueue

  const publish = () => setDepth({ undo: stacks.current.undo.length, redo: stacks.current.redo.length })

  const reset = useCallback(() => {
    stacks.current = { undo: [], redo: [] }
    publish()
  }, [])

  // History is per page: what was done on the last page is not what Ctrl+Z means here.
  useEffect(() => {
    reset()
  }, [pageId, reset])

  const forget = (step: Step<S>) => {
    stacks.current.undo = stacks.current.undo.filter((s) => s !== step)
    stacks.current.redo = stacks.current.redo.filter((s) => s !== step)
    publish()
  }

  // `span` is undefined when the write answered without one: a backend older than the
  // revert endpoint. The two are separate services and may be deployed apart, so that is
  // a thing to take in its stride - the edit stands, it just cannot be taken back. A span
  // still on its way is kept until it turns out to be nothing, or its edit was refused.
  const record = useCallback((span: EditSpan | undefined | Promise<EditSpan | undefined>, local?: LocalSteps<S>) => {
    if (!(span instanceof Promise) && !reverts(span)) return
    const step: Step<S> = { span: Promise.resolve(span).catch(() => undefined), local }
    const undo = stacks.current.undo
    undo.push(step)
    if (undo.length > DEPTH) undo.shift()
    stacks.current.redo = []
    publish()
    if (span instanceof Promise) void step.span.then((settled) => { if (!reverts(settled)) forget(step) })
  }, [])

  const step = useCallback(async (direction: 'undo' | 'redo') => {
    if (pageId === undefined) return
    const [from, to] = direction === 'undo'
      ? [stacks.current.undo, stacks.current.redo]
      : [stacks.current.redo, stacks.current.undo]
    const queued = enqueueRef.current
    if (queued) {
      const taken = from.pop()
      if (!taken) return
      to.push(taken)
      publish()
      const label = direction === 'undo' ? 'Undo' : 'Redo'
      queued({
        label,
        scope: pageId,
        apply: (state) => (taken.local ? taken.local[direction](state) : state),
        send: async () => {
          const span = await taken.span
          if (!reverts(span)) throw new Dropped(label)
          const result = await revertSpan(pageId, span!, direction)
          if (pageRef.current === pageId) applyRef.current(result)
          return result
        },
      }).catch(() => forget(taken))
      return
    }
    if (busy.current) return
    const taken = from.pop()
    if (!taken) return
    busy.current = true
    try {
      const span = await taken.span
      if (!span) return
      const result = await revertSpan(pageId, span, direction)
      // Turned to another page meanwhile: what came back belongs to the one left behind.
      if (pageRef.current !== pageId) return
      to.push(taken)
      applyRef.current(result)
    } catch (e) {
      if (pageRef.current === pageId) errorRef.current((e as Error).message)
    } finally {
      busy.current = false
      publish()
    }
  }, [pageId])

  const undo = useCallback(() => step('undo'), [step])
  const redo = useCallback(() => step('redo'), [step])

  return { record, undo, redo, reset, canUndo: depth.undo > 0, canRedo: depth.redo > 0 }
}
