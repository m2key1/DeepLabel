import { useCallback, useEffect, useRef, useState } from 'react'
import { revertSpan } from '../api'
import type { EditSpan, RevertResult } from '../api'

const DEPTH = 100

/** One span over several writes that together made one gesture - an eraser stroke, a
 *  merge, a batch operation - so the whole gesture is one step back. Writes that answered
 *  with no span are skipped: see `record`. */
export function spanOf(...spans: (EditSpan | undefined)[]): EditSpan | undefined {
  const known = spans.filter((s): s is EditSpan => s !== undefined)
  if (known.length === 0) return undefined
  return { from: Math.min(...known.map((s) => s.from)), to: Math.max(...known.map((s) => s.to)) }
}

/** Undo and redo for one page, kept as the spans its edits answered with. Taking a span
 *  back is the server's job - the revisions log holds how every row stood - so the stacks
 *  hold nothing but spans, and what the server hands back is applied to the page. A span
 *  somebody else has edited in or after is refused and dropped; the message says who. */
export function useEditHistory(
  pageId: number | undefined,
  apply: (result: RevertResult) => void,
  onError: (message: string) => void,
) {
  const stacks = useRef<{ undo: EditSpan[]; redo: EditSpan[] }>({ undo: [], redo: [] })
  const [depth, setDepth] = useState({ undo: 0, redo: 0 })
  const busy = useRef(false)
  const applyRef = useRef(apply)
  applyRef.current = apply
  const errorRef = useRef(onError)
  errorRef.current = onError
  const pageRef = useRef(pageId)
  pageRef.current = pageId

  const publish = () => setDepth({ undo: stacks.current.undo.length, redo: stacks.current.redo.length })

  const reset = useCallback(() => {
    stacks.current = { undo: [], redo: [] }
    publish()
  }, [])

  // History is per page: what was done on the last page is not what Ctrl+Z means here.
  useEffect(() => {
    reset()
  }, [pageId, reset])

  // `span` is undefined when the write answered without one: a backend older than the
  // revert endpoint. The two are separate services and may be deployed apart, so that is
  // a thing to take in its stride - the edit stands, it just cannot be taken back.
  const record = useCallback((span: EditSpan | undefined) => {
    if (!span || span.to <= span.from) return // nothing to revert
    const undo = stacks.current.undo
    undo.push(span)
    if (undo.length > DEPTH) undo.shift()
    stacks.current.redo = []
    publish()
  }, [])

  const step = useCallback(async (direction: 'undo' | 'redo') => {
    if (busy.current || pageId === undefined) return
    const [from, to] = direction === 'undo'
      ? [stacks.current.undo, stacks.current.redo]
      : [stacks.current.redo, stacks.current.undo]
    const span = from.pop()
    if (!span) return
    busy.current = true
    try {
      const result = await revertSpan(pageId, span, direction)
      // Turned to another page meanwhile: what came back belongs to the one left behind.
      if (pageRef.current !== pageId) return
      to.push(span)
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
