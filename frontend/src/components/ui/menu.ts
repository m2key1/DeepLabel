import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react'

/** What a button that opens a menu tells assistive technology about it. */
export function menuTrigger(open: boolean) {
  return { 'aria-haspopup': 'menu', 'aria-expanded': open } as const
}

let openedFrom: HTMLElement | null = null

/** The button the open menu was opened from, for a dialog one of its items opens: the
 *  item goes with the menu, so focus has to go back to the button instead. */
export function openMenuTrigger(): HTMLElement | null {
  return openedFrom?.isConnected ? openedFrom : null
}

/** An open menu or popover shuts on a click anywhere else, and on Escape - which goes
 *  no further, so a page's own Escape (the viewer's step back) waits for the next press,
 *  and hands the focus back to the button that opened it. */
export function useDismiss(open: boolean, close: () => void) {
  const latest = useRef(close)
  useEffect(() => {
    latest.current = close
  })
  useEffect(() => {
    if (!open) return
    let trigger = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
      ? document.activeElement : null
    openedFrom = trigger
    // One dismiss can cover several menus of a page, and a press on another one's button
    // swaps the menu without shutting it.
    const onPress = (e: MouseEvent) => {
      const button = e.target instanceof Element ? e.target.closest('[aria-haspopup]') : null
      if (button instanceof HTMLElement) trigger = openedFrom = button
    }
    const onClick = () => latest.current()
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      latest.current()
      trigger?.focus({ preventScroll: true })
    }
    document.addEventListener('click', onPress, true)
    document.addEventListener('click', onClick)
    document.addEventListener('keydown', onKey)
    return () => {
      if (openedFrom === trigger) openedFrom = null
      document.removeEventListener('click', onPress, true)
      document.removeEventListener('click', onClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
}

const HANG_GAP = 4
const HANG_MARGIN = 8

/** Where a menu drawn at the top of the document hangs below the element it opens from:
 *  under it, right edges aligned, kept inside the window. Drawn there, it escapes a row that
 *  scrolls sideways - which clips whatever sticks out of it, as the editors' header rows
 *  do - and it follows its button when that row or the window moves. */
export function useHangingBelow(open: boolean, anchor: RefObject<HTMLElement | null>,
                                menu: RefObject<HTMLElement | null>) {
  const [at, setAt] = useState({ left: 0, top: 0 })
  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      if (!anchor.current || !menu.current) return
      const below = anchor.current.getBoundingClientRect()
      const width = menu.current.offsetWidth
      setAt({
        left: Math.max(HANG_MARGIN, Math.min(below.right - width, window.innerWidth - width - HANG_MARGIN)),
        top: below.bottom + HANG_GAP,
      })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open, anchor, menu])
  return at
}
