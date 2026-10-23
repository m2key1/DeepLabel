import type { ReactNode } from 'react'

/** One figure with its name over it, as a row of them across the top of a page. The
 *  name is small and muted, the figure is the thing you came for, and the change beside
 *  it says which way it moved - which is most of what a reading is worth. */
export function StatTile({ label, value, note, delta, tone = 'neutral', title, ...props }: {
  label: ReactNode
  value: ReactNode
  /** A qualifier the figure needs - which epoch it came from, what it is out of. */
  note?: ReactNode
  delta?: ReactNode
  /** Whether the delta reads as an improvement. */
  tone?: 'neutral' | 'good' | 'bad'
  title?: string
} & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div data-testid="stat-tile" title={title} {...props} className="min-w-28 px-3 py-1.5">
      <div className="text-[10px] uppercase tracking-widest text-ink-subtle">{label}</div>
      <div className="flex items-baseline gap-1.5">
        <span className="text-base font-medium font-mono tabular-nums text-ink">{value}</span>
        {note !== undefined && <span className="text-[11px] text-ink-subtle">{note}</span>}
        {delta !== undefined && (
          <span className={`text-[11px] font-mono tabular-nums ${
            tone === 'good' ? 'text-ok' : tone === 'bad' ? 'text-warn' : 'text-ink-subtle'
          }`}>
            {delta}
          </span>
        )}
      </div>
    </div>
  )
}

/** The row they sit in: one rule above, hairlines between. */
export function StatRow({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`flex flex-wrap items-stretch divide-x divide-line border-t border-line ${className}`.trim()}>
      {children}
    </div>
  )
}
