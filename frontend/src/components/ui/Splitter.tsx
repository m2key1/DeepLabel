import { forwardRef, useEffect, useState } from 'react'
import type { HTMLAttributes, PointerEvent as ReactPointerEvent } from 'react'

/** The bar between two panes, wherever there is one.
 *
 *  Four of these had grown up separately - a hairline here, a six-pixel slab there, a
 *  rounded pill under the loupe - each with its own hover colour. They are one thing, so
 *  they look like one thing: a quiet rule at rest, an accent band while it is being
 *  aimed at or dragged, and a hit area wider than either, because a one-pixel target is
 *  not a target. The editor idiom, which is where most people have met it.
 *
 *  Layout footprint is the hit area, so a splitter between flex children reserves the
 *  same room whatever state it is in, and nothing shifts when it lights up. */
export type SplitterOrientation = 'vertical' | 'horizontal'

const HIT: Record<SplitterOrientation, string> = {
  // `vertical` describes the bar, which sits between two panes side by side.
  vertical: 'w-3 cursor-col-resize flex-col',
  horizontal: 'h-3 cursor-row-resize',
}

const LINE: Record<SplitterOrientation, string> = {
  vertical: 'h-full w-px group-hover:w-[3px] group-focus-visible:w-[3px] data-[dragging]:w-[3px]',
  horizontal: 'w-full h-px group-hover:h-[3px] group-focus-visible:h-[3px] data-[dragging]:h-[3px]',
}

interface SplitterProps extends HTMLAttributes<HTMLDivElement> {
  orientation: SplitterOrientation
}

export const Splitter = forwardRef<HTMLDivElement, SplitterProps>(function Splitter(
  { orientation, className = '', onPointerDown, ...props }, ref,
) {
  // Lit for the whole drag, not just while the cursor is still over the bar - a drag
  // takes the pointer away from it immediately, and a bar that goes dark the moment you
  // start moving it is the thing that reads as broken.
  const [dragging, setDragging] = useState(false)
  useEffect(() => {
    if (!dragging) return
    const done = () => setDragging(false)
    window.addEventListener('pointerup', done)
    window.addEventListener('pointercancel', done)
    return () => {
      window.removeEventListener('pointerup', done)
      window.removeEventListener('pointercancel', done)
    }
  }, [dragging])

  return (
    <div
      ref={ref}
      role="separator"
      aria-orientation={orientation}
      tabIndex={0}
      data-dragging={dragging ? '' : undefined}
      onPointerDown={(e: ReactPointerEvent<HTMLDivElement>) => {
        setDragging(true)
        onPointerDown?.(e)
      }}
      className={`group flex shrink-0 items-center justify-center focus:outline-none ${
        HIT[orientation]} ${className}`.trim()}
      {...props}
    >
      <div
        data-dragging={dragging ? '' : undefined}
        className={`rounded-full bg-line transition-all duration-100 group-hover:bg-accent
          group-focus-visible:bg-accent data-[dragging]:bg-accent ${LINE[orientation]}`}
      />
    </div>
  )
})
