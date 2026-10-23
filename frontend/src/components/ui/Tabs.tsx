import { useRef } from 'react'
import type { KeyboardEvent } from 'react'

export interface TabItem<T extends string> {
  id: T
  label: string
}

export function tabId(id: string): string {
  return `tab-${id}`
}

export function panelId(id: string): string {
  return `tabpanel-${id}`
}

/** A row of tabs over one panel. The caller keeps the active id, so it can live in the
 *  URL. Arrow keys, Home and End move between tabs and select as they go. */
export function Tabs<T extends string>({ items, active, onSelect, label, className = '' }: {
  items: TabItem<T>[]
  active: T
  onSelect: (id: T) => void
  /** Names the strip for a screen reader. */
  label: string
  className?: string
}) {
  const strip = useRef<HTMLDivElement>(null)
  const move = (e: KeyboardEvent<HTMLDivElement>) => {
    const index = items.findIndex((t) => t.id === active)
    const next = {
      ArrowRight: (index + 1) % items.length,
      ArrowLeft: (index - 1 + items.length) % items.length,
      Home: 0,
      End: items.length - 1,
    }[e.key]
    if (next === undefined) return
    e.preventDefault()
    onSelect(items[next].id)
    strip.current?.querySelector<HTMLButtonElement>(`#${tabId(items[next].id)}`)?.focus()
  }
  return (
    <div ref={strip} role="tablist" aria-label={label} onKeyDown={move}
         className={`flex gap-1 border-b border-line ${className}`.trim()}>
      {items.map((item) => {
        const on = item.id === active
        return (
          <button
            key={item.id}
            id={tabId(item.id)}
            type="button"
            role="tab"
            aria-selected={on}
            aria-controls={panelId(item.id)}
            tabIndex={on ? 0 : -1}
            onClick={() => onSelect(item.id)}
            className={`-mb-px border-b-2 px-3 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent ${
              on ? 'border-accent font-medium text-accent-ink' : 'border-transparent text-ink-muted hover:text-ink'
            }`}
          >
            {item.label}
          </button>
        )
      })}
    </div>
  )
}
