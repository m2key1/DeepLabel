import type { ReactNode } from 'react'

/** What the selection is and how to change it - a different question from what the
 *  next stroke will be, which the pens above answer. */
export function SelectionPanel({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <div data-testid="selection-panel" className="shrink-0 space-y-1">
      <div className="text-[10px] font-medium uppercase tracking-wide text-ink-subtle">{title}</div>
      {children}
    </div>
  )
}
