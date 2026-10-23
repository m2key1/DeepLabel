import type { ReactNode } from 'react'

/** The frame both annotation editors share: one header strip, a left rail of panels,
 *  the canvas, and a status footer. The pages own everything inside the slots - the
 *  page viewer keeps its OCR panel and loupe in the canvas slot, the tile editor its
 *  brush and export panels in the rail - so the frame decides only where things go. */
export function EditorShell({ header, headerTestId, rail, canvas, status, style }: {
  header: { left: ReactNode; actions?: ReactNode }
  headerTestId?: string
  /** null when the editor has no rail to show, as the viewer outside edit mode. */
  rail: ReactNode | null
  canvas: ReactNode
  status: ReactNode
  style?: React.CSSProperties
}) {
  return (
    // h-full, not h-screen: the app shell already reserves the nav bar's height.
    <div className="flex h-full flex-col overflow-hidden" style={style}>
      {/* One row, always: nothing here may grow the header, or the canvas would move
          under the pointer whenever a name or a hint changed length. */}
      <header
        data-testid={headerTestId}
        className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-2"
      >
        <div className="flex min-w-0 flex-1 items-center gap-3 overflow-hidden whitespace-nowrap">
          {header.left}
        </div>
        {header.actions && <div className="flex shrink-0 items-center gap-2">{header.actions}</div>}
      </header>
      <div className="flex min-h-0 flex-1">
        {rail && (
          // min-h-0 as well as overflow: a flex child's minimum height is its content by
          // default, so without it the rail grows to fit and every overflow inside it is
          // moot - which is how a long list once painted over the panels below it.
          <aside className="flex min-h-0 w-56 shrink-0 flex-col gap-3 overflow-y-auto border-r border-line p-3">
            {rail}
          </aside>
        )}
        <main className="relative flex min-h-0 min-w-0 flex-1 flex-col">{canvas}</main>
      </div>
      {status}
    </div>
  )
}
