import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { RefObject } from 'react'

export interface DragHandlers {
  onMove: (e: PointerEvent) => void
  onEnd: (e: PointerEvent) => void
  onCancel?: () => void
}

// One drag at a time, captured on a stable surface: once a pointer is captured its
// move and up events keep arriving there even when it leaves the element, the pane or
// the window, so no listener has to live on `window` and no mouseleave can strand a
// drag halfway. Mouse, pen and touch all arrive as the same pointer events.
//
// `surface` is the element that captures - the overlay or canvas the shapes sit on,
// never the handle that was pressed, because a handle can be re-rendered away while
// the drag runs and would take its capture with it.
export function usePointerDrag(surface: RefObject<(Element & GlobalEventHandlers) | null>) {
  const release = useRef<(() => void) | null>(null)

  const cancel = useCallback(() => {
    const stop = release.current
    if (!stop) return false
    stop()
    return true
  }, [])

  const isDragging = useCallback(() => release.current !== null, [])

  const begin = useCallback(
    (e: { pointerId: number }, handlers: DragHandlers) => {
      release.current?.()
      const el = surface.current
      if (!el) return
      const { pointerId } = e
      const detach = () => {
        release.current = null
        el.removeEventListener('pointermove', onMove)
        el.removeEventListener('pointerup', onUp)
        el.removeEventListener('pointercancel', onCancel)
        if (el.hasPointerCapture(pointerId)) el.releasePointerCapture(pointerId)
      }
      const onMove = (ev: PointerEvent) => {
        if (ev.pointerId === pointerId) handlers.onMove(ev)
      }
      const onUp = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return
        detach()
        handlers.onEnd(ev)
      }
      const onCancel = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return
        detach()
        handlers.onCancel?.()
      }
      el.addEventListener('pointermove', onMove)
      el.addEventListener('pointerup', onUp)
      el.addEventListener('pointercancel', onCancel)
      // A pointer that is no longer active (the press already ended) cannot be captured;
      // the listeners above still see its up, so the drag ends cleanly either way.
      try {
        el.setPointerCapture(pointerId)
      } catch {
        /* capture is an optimisation, not a requirement */
      }
      release.current = () => {
        detach()
        handlers.onCancel?.()
      }
    },
    [surface],
  )

  useEffect(() => () => void release.current?.(), [])

  return useMemo(() => ({ begin, cancel, isDragging }), [begin, cancel, isDragging])
}
