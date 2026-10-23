import { useCallback, useRef } from 'react'

/** A zoom readout written straight into the DOM. The surface reports its drawn size on
 *  every frame of a zoom, and re-rendering a page of a hundred boxes to show a number
 *  cost 250ms frames; a text node costs nothing. */
export function useZoomReadout() {
  const readoutRef = useRef<HTMLSpanElement>(null)
  const publish = useCallback((scale: number) => {
    if (readoutRef.current) readoutRef.current.textContent = `Zoom ${Math.round(scale * 100)}%`
  }, [])
  return { readoutRef, publish }
}
