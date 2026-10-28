import type { ReactNode } from 'react'

export interface NavItem {
  id: string
  label: ReactNode
  /** A count or a warning dot, shown right-aligned. */
  badge?: ReactNode
  /** A heading over this item and the ones after it that share it. */
  group?: string
}

/** The rail beside a page that has more sections than fit in one read. Vertical rather
 *  than a row of tabs, because the next section costs a row here and a scrolling tab
 *  strip there. The caller keeps the active id, so it can live in the URL and a link can
 *  open the page where it means to. */
export function SectionNav({ items, active, onSelect, label, className = '' }: {
  items: NavItem[]
  active: string
  onSelect: (id: string) => void
  /** Names the rail for a screen reader, e.g. "Settings sections". */
  label: string
  className?: string
}) {
  return (
    <nav aria-label={label} data-testid="section-nav"
         className={`w-48 shrink-0 space-y-0.5 ${className}`.trim()}>
      {items.map((item, i) => {
        const on = item.id === active
        const heading = item.group && item.group !== items[i - 1]?.group
        return (
          <div key={item.id}>
          {heading && (
            <div className={`px-2 pb-1 text-[10px] font-medium uppercase tracking-widest text-ink-subtle ${i ? 'pt-3' : ''}`}>
              {item.group}
            </div>
          )}
          <button
            type="button"
            data-testid="section-nav-item"
            data-section={item.id}
            aria-current={on ? 'page' : undefined}
            onClick={() => onSelect(item.id)}
            className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm ${
              on ? 'bg-accent-wash font-medium text-accent-ink' : 'text-ink-muted hover:bg-raised hover:text-ink'
            }`}
          >
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
            {item.badge && <span className="shrink-0 text-xs text-ink-subtle">{item.badge}</span>}
          </button>
          </div>
        )
      })}
    </nav>
  )
}
