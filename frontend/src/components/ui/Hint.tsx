import { useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

const WIDTH = 288
const MARGIN = 8

/** A small "?" that reveals its explanation on hover or keyboard focus. The bubble is
 *  rendered at the top of the document and placed from the button's own position, so it
 *  escapes any panel that would clip it and is kept inside the window on every edge.
 *  The button is named for what it explains rather than by the explanation itself, which
 *  the bubble carries as its description - a paragraph makes a poor control name. */
export function Hint({ text, about, className = '' }: {
  text: string
  /** What this explains, e.g. "std_range"; becomes "About std_range". */
  about: string
  className?: string
}) {
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const bubble = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [at, setAt] = useState({ left: 0, top: 0 })

  useLayoutEffect(() => {
    if (!open || !trigger.current || !bubble.current) return
    const anchor = trigger.current.getBoundingClientRect()
    const height = bubble.current.offsetHeight
    // Beside the button by preference, flipped to its left when that would run off the
    // right edge, and lifted when it would run off the bottom.
    const left = anchor.right + MARGIN + WIDTH > window.innerWidth - MARGIN
      ? Math.max(MARGIN, anchor.left - WIDTH - MARGIN)
      : anchor.right + MARGIN
    const top = Math.max(MARGIN, Math.min(anchor.top, window.innerHeight - height - MARGIN))
    setAt({ left, top })
  }, [open])

  return (
    <span className={`inline-flex ${className}`}>
      <button
        ref={trigger}
        type="button"
        aria-label={`About ${about}`}
        aria-describedby={open ? id : undefined}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        className="flex h-3.5 w-3.5 items-center justify-center rounded-full border border-line-strong text-[9px] font-semibold leading-none text-ink-subtle hover:border-accent hover:text-accent-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      >
        ?
      </button>
      {open && createPortal(
        <div
          ref={bubble}
          id={id}
          role="tooltip"
          style={{ left: at.left, top: at.top, width: WIDTH }}
          className="pointer-events-none fixed z-50 rounded border border-line bg-surface p-1.5 text-[11px] font-normal normal-case leading-snug tracking-normal text-ink-muted shadow-md"
        >
          {text}
        </div>,
        document.body,
      )}
    </span>
  )
}
