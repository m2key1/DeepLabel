import type { ReactNode, RefObject } from 'react'
import { Button } from '../components/ui/Button'

export interface Notice {
  text: string
  tone: 'info' | 'error'
}

/** The footer both editors share: the zoom cluster, one sentence saying what the
 *  active tool does right now, a notice slot, and the keys that are always there. */
export function StatusBar({ zoom, sentence, notice, keys, onShortcuts, provenance }: {
  /** null where there is no scan on screen to zoom. */
  zoom: { out: () => void; in: () => void; reset: () => void; readoutRef: RefObject<HTMLSpanElement | null> } | null
  sentence: ReactNode
  notice: Notice | null
  keys: ReactNode
  onShortcuts: () => void
  /** Which models produced what is shown; the page editor's footer carries it. */
  provenance?: ReactNode
}) {
  return (
    <footer className="flex shrink-0 items-center gap-x-4 border-t border-line px-4 py-1 text-xs text-ink-muted pointer-coarse:max-md:flex-wrap">
      {zoom && (
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="xs" onClick={zoom.out} title="Zoom out">−</Button>
          <span ref={zoom.readoutRef} className="w-20 whitespace-nowrap text-center tabular-nums">Zoom</span>
          <Button variant="ghost" size="xs" onClick={zoom.in} title="Zoom in">+</Button>
          <Button variant="ghost" size="xs" onClick={zoom.reset} title="Reset zoom">1×</Button>
        </div>
      )}
      {/* The sentence speaks of keys and a mouse, which a phone has neither of. */}
      <span className="min-w-0 truncate pointer-coarse:max-md:hidden">{sentence}</span>
      {notice && (
        <span
          data-testid="editor-notice"
          className={`shrink-0 font-medium ${notice.tone === 'error' ? 'text-danger' : 'text-accent-ink'}`}
        >
          {notice.text}
        </span>
      )}
      <span className="ml-auto flex min-w-0 items-center gap-2">
        {provenance}
        {/* The keys a mouse and keyboard reach for, cut short where the footer runs out
            and left out on a phone, which has neither. */}
        <span className="min-w-0 truncate pointer-coarse:max-md:hidden">{keys}</span>
        <Button variant="ghost" size="xs" onClick={onShortcuts} aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)">
          ?
        </Button>
      </span>
    </footer>
  )
}
