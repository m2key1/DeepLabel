import { useLayoutEffect, useRef, useState } from 'react'

/** Where a panel hangs from its trigger. Anything anchored under a row opens downwards by
 *  default, which is right until the row is near the foot of a long list - the dataset
 *  list is six hundred rows, so most of them are. Measured rather than guessed, because
 *  what fits depends on the panel's own height, and the info panel is four times the
 *  height of the download menu.
 *
 *  Put `ref` on the panel and `className` in its class list. The panel must be the only
 *  positioned child of the trigger's relative wrapper, which is how it finds the trigger. */
export function useDropPlacement(open: boolean) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [up, setUp] = useState(false)

  useLayoutEffect(() => {
    const panel = ref.current
    if (!open || !panel) {
      setUp(false)
      return
    }
    const anchor = panel.parentElement
    if (!anchor) return
    const place = () => {
      const panelHeight = panel.getBoundingClientRect().height
      const { top, bottom } = anchor.getBoundingClientRect()
      const view = visibleArea(anchor)
      // Only flip when going up actually helps: near the top of a short window, neither
      // direction fits and downwards at least starts on screen.
      setUp(panelHeight > view.bottom - bottom && top - view.top > panelHeight)
    }
    place()
    // A panel that fetches what it shows is short until it arrives, so it is measured
    // again at its full height.
    const watch = new ResizeObserver(place)
    watch.observe(panel)
    return () => watch.disconnect()
  }, [open])

  return {
    ref,
    className: up ? 'absolute bottom-full mb-1' : 'absolute top-full mt-1',
  }
}

/** The part of the window an element can be seen in: a list that scrolls inside the page
 *  hides whatever hangs past its own edges, not the window's. */
function visibleArea(el: HTMLElement): { top: number; bottom: number } {
  for (let up = el.parentElement; up; up = up.parentElement) {
    if (/auto|scroll/.test(getComputedStyle(up).overflowY)) {
      const { top, bottom } = up.getBoundingClientRect()
      return { top: Math.max(top, 0), bottom: Math.min(bottom, window.innerHeight) }
    }
  }
  return { top: 0, bottom: window.innerHeight }
}
