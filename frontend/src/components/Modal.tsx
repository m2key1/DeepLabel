import {
  useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject,
} from 'react'

import { buttonClass } from './ui/Button'
import { openMenuTrigger } from './ui/menu'
import { cardChrome } from './ui/Card'

/** A dialog's footer buttons are the app's buttons - kept as names because two dozen
 *  dialogs say `className={modalPrimaryBtn}` rather than rendering a <Button>. */
export const modalBtn = buttonClass({ variant: 'outline', size: 'md' })
export const modalDangerBtn = buttonClass({ variant: 'danger', size: 'md' })
export const modalPrimaryBtn = buttonClass({ variant: 'primary', size: 'md' })

/** How wide the panel may grow. The augmentation builder carries side-by-side content
 *  that a phone-width column would stack into a scroll marathon; a list of class rows
 *  needs room for its controls on one line. */
const WIDTHS = { md: 'max-w-md', lg: 'max-w-3xl', xl: 'max-w-[1600px]' }

export function Modal({ title, width = 'md', onClose, children }: {
  title: ReactNode
  width?: keyof typeof WIDTHS
  /** Given when the dialog has a way out that changes nothing, which Escape then takes. */
  onClose?: () => void
  children: ReactNode
}) {
  const overlay = useRef<HTMLDivElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const titleId = useId()
  useOwnedKeyboard(overlay, panel, onClose)
  useFocusInside(panel)

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    e.stopPropagation()
    if (e.key === 'Tab') keepTabInside(e, panel.current)
    else if (e.key === 'Escape' && onClose && !e.defaultPrevented) {
      e.preventDefault()
      onClose()
    }
  }

  // Above every control and overlay a page draws (up to z-40), below hints and toasts
  // (z-50), so a hint inside a dialog still shows over it.
  return (
    <div ref={overlay} onKeyDown={onKeyDown}
         className="fixed inset-0 z-[45] flex items-center justify-center bg-black/40 p-4">
      {/* A dialog grows with its content, and centred in a fixed overlay the excess
          splits above *and* below the window - so the footer buttons leave the screen
          with nothing able to scroll them back: the panel had no overflow of its own,
          and the page behind is covered. Hence a ceiling of the viewport minus this
          wrapper's padding, and its own scrollbar. The one panel that outgrew even
          that is a page now. */}
      <div ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}
           className={`max-h-[calc(100vh-2rem)] w-full ${WIDTHS[width]} overflow-y-auto ${cardChrome} p-4 focus:outline-none`}>
        <h2 id={titleId} className="mb-2 font-serif text-base font-semibold">{title}</h2>
        {children}
      </div>
    </div>
  )
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), '
  + 'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

function focusables(panel: HTMLElement): HTMLElement[] {
  return [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length > 0)
}

/** Tab and Shift+Tab wrap around the dialog's own controls instead of walking out into
 *  the page it covers. */
function keepTabInside(e: KeyboardEvent<HTMLDivElement>, panel: HTMLElement | null) {
  if (!panel) return
  const inside = focusables(panel)
  if (inside.length === 0) {
    e.preventDefault()
    return
  }
  const first = inside[0]
  const last = inside[inside.length - 1]
  const at = document.activeElement
  if (e.shiftKey && (at === first || at === panel)) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && at === last) {
    e.preventDefault()
    first.focus()
  }
}

/** Focus starts in the dialog - on a field that asked for it, else on the dialog itself -
 *  and goes back to whatever opened it when the dialog closes: the button, or for an item
 *  of a menu, which closes with it, the menu's button. */
function useFocusInside(panel: RefObject<HTMLDivElement | null>) {
  const [opener] = useState(() => document.activeElement as HTMLElement | null)
  const [menuTrigger] = useState(openMenuTrigger)
  useEffect(() => {
    if (!panel.current?.contains(document.activeElement)) panel.current?.focus()
    return () => {
      const back = opener?.isConnected ? opener : menuTrigger
      if (back?.isConnected) back.focus({ preventScroll: true })
    }
  }, [panel, opener, menuTrigger])
}

/** While a dialog is open the page behind it hears no keys: one pressed with focus outside
 *  the dialog stops at the window's capture phase, one pressed inside stops at the dialog,
 *  so typing in it still works. A dialog's own capture listener on the window, as the
 *  shortcut sheet's, still hears them. A key pressed with focus on nothing - after a click
 *  on the backdrop - is the dialog's: Tab goes back into it and Escape closes it. */
function useOwnedKeyboard(
  overlay: RefObject<HTMLDivElement | null>,
  panel: RefObject<HTMLDivElement | null>,
  onClose: (() => void) | undefined,
) {
  const close = useRef(onClose)
  useEffect(() => {
    close.current = onClose
  })
  useEffect(() => {
    const swallow = (e: globalThis.KeyboardEvent) => {
      if (overlay.current?.contains(e.target as Node)) return
      e.stopPropagation()
      if (e.target !== document.body) return
      if (e.key === 'Tab') {
        e.preventDefault()
        panel.current?.focus()
      } else if (e.key === 'Escape' && close.current) {
        e.preventDefault()
        close.current()
      }
    }
    window.addEventListener('keydown', swallow, true)
    return () => window.removeEventListener('keydown', swallow, true)
  }, [overlay, panel])
}
