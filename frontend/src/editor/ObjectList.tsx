import { useEffect, useMemo, useRef } from 'react'
import type { ReactNode } from 'react'
import { EyeIcon } from '../components/icons'
import { Select } from '../components/ui/Field'

export type ObjectGrouping = 'order' | 'class'

export interface ObjectRow {
  id: number
  label: string
  color: string
  /** The reading-order number shown ahead of the label. */
  index?: number
  /** What follows the label inside the row's button: a line count, a container mark. */
  meta?: ReactNode
  /** A control of the row's own, outside its button: the tile editor's reviewed box. */
  trailing?: ReactNode
  /** Dimmed, with the eye showing it can be brought back. */
  hidden?: boolean
  /** What the row files under when the list is grouped by class. */
  group?: string
  /** The shapes inside this one - a region's lines - listed under it, indented. */
  lines?: ObjectLineRow[]
}

export type ObjectLineRow = Pick<ObjectRow, 'id' | 'label' | 'color' | 'index' | 'meta' | 'hidden'>

function RowLabel({ row, active }: { row: ObjectLineRow; active: boolean }) {
  return (
    <>
      {row.index !== undefined && (
        <span className="w-4 shrink-0 text-right tabular-nums text-ink-subtle">{row.index}</span>
      )}
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: row.color }} />
      <span className={`truncate ${active ? 'font-medium text-accent-ink' : 'text-ink'}`}>{row.label}</span>
      {row.meta}
    </>
  )
}

// Rows can share a label - a page holds many paragraphs - so the reading-order number goes
// with it wherever a row has to be named.
const nameOf = (row: ObjectLineRow) => (row.index !== undefined ? `${row.label} ${row.index}` : row.label)

/** The list of what is on the page - layout regions on a scan, shapes on a tile - that
 *  both editors keep in their rail. It is the rail's one scroller, so it never pushes the
 *  panels below it off the screen however long it gets. */
export function ObjectList({
  heading, count, items, selectedId, selectedLineId = null, hoveredId = null, grouping, onSelect, onSelectLine,
  onHover, onToggleHidden, unassigned, empty,
}: {
  heading: ReactNode
  count?: ReactNode
  items: ObjectRow[]
  selectedId: number | null
  /** The selected line, when it is a line rather than a region that is selected. */
  selectedLineId?: number | null
  hoveredId?: number | null
  grouping?: { value: ObjectGrouping; onChange: (value: ObjectGrouping) => void }
  onSelect: (id: number) => void
  onSelectLine?: (id: number) => void
  onHover?: (id: number | null) => void
  onToggleHidden?: (id: number) => void
  /** Lines that belong to no listed object at all - counted, so the page never reads as
   *  empty while it is full. */
  unassigned?: { count: number; label: string }
  empty: ReactNode
}) {
  const listRef = useRef<HTMLDivElement>(null)

  const groups = useMemo(() => {
    if (grouping?.value !== 'class') return [{ label: null as string | null, items }]
    const byGroup = new Map<string, ObjectRow[]>()
    for (const row of items) {
      const key = row.group ?? row.label
      byGroup.set(key, [...(byGroup.get(key) ?? []), row])
    }
    return [...byGroup.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([label, rows]) => ({ label, items: rows }))
  }, [items, grouping?.value])

  // Selecting on the canvas must reveal the row, so the list and the canvas never
  // disagree about what is selected.
  useEffect(() => {
    const selector = selectedLineId !== null
      ? `[data-line-id="${selectedLineId}"]`
      : selectedId !== null ? `[data-region-id="${selectedId}"]` : null
    if (selector) listRef.current?.querySelector(selector)?.scrollIntoView({ block: 'nearest' })
  }, [selectedId, selectedLineId, grouping?.value])

  return (
    <div className="flex min-h-[7rem] min-w-0 flex-1 flex-col">
      <div className="mb-1 flex shrink-0 items-baseline gap-1">
        <span className="text-[10px] font-medium uppercase tracking-wide text-ink-subtle">{heading}</span>
        {count !== undefined && (
          <span data-testid="region-count" className="text-[10px] text-ink-subtle">{count}</span>
        )}
        {grouping && (
          <Select
            size="xs"
            value={grouping.value}
            onChange={(e) => grouping.onChange(e.target.value as ObjectGrouping)}
            title="Sort the list"
            aria-label="Sort regions"
            className="ml-auto text-ink-muted"
          >
            <option value="order">order</option>
            <option value="class">class</option>
          </Select>
        )}
      </div>
      <div
        ref={listRef}
        data-testid="region-list"
        className="min-h-0 flex-1 space-y-px overflow-y-auto rounded border border-line p-0.5"
      >
        {items.length === 0 && <p className="px-1 py-2 text-[11px] text-ink-subtle">{empty}</p>}
        {groups.map(({ label, items: rows }) => (
          <div key={label ?? 'all'}>
            {label && <div className="px-1 pb-px pt-1 text-[10px] font-medium text-ink-subtle">{label}</div>}
            {rows.map((row) => {
              const active = row.id === selectedId
              // Region and line rows nest, so their keys never meet: an element and a
              // line may well share a number.
              return (
                <div key={row.id}>
                  <div
                    data-region-id={row.id}
                    data-testid="region-row"
                    data-selected={active}
                    onMouseEnter={onHover ? () => onHover(row.id) : undefined}
                    onMouseLeave={onHover ? () => onHover(null) : undefined}
                    className={`flex items-center gap-1 rounded px-1 py-0.5 text-xs ${
                      active ? 'bg-accent-wash' : row.id === hoveredId ? 'bg-raised' : ''
                    } ${row.hidden ? 'opacity-40' : ''}`}
                  >
                    <button
                      onClick={() => onSelect(row.id)}
                      aria-pressed={active}
                      className="flex min-w-0 flex-1 items-center gap-1 text-left"
                    >
                      <RowLabel row={row} active={active} />
                    </button>
                    {row.trailing}
                    {onToggleHidden && (
                      <button
                        onClick={() => onToggleHidden(row.id)}
                        title={row.hidden ? 'show' : 'hide'}
                        aria-label={`${row.hidden ? 'Show' : 'Hide'} ${nameOf(row)}`}
                        className="shrink-0 text-ink-subtle hover:text-ink"
                      >
                        <EyeIcon off={!!row.hidden} />
                      </button>
                    )}
                  </div>
                  {row.lines?.map((line) => {
                    const lineActive = line.id === selectedLineId
                    return (
                      <div
                        key={line.id}
                        data-line-id={line.id}
                        data-testid="region-line-row"
                        data-selected={lineActive}
                        className={`ml-4 flex items-center gap-1 rounded px-1 py-0.5 text-xs ${
                          lineActive ? 'bg-accent-wash' : 'hover:bg-raised'
                        } ${line.hidden ? 'opacity-40' : ''}`}
                      >
                        <button
                          onClick={() => onSelectLine?.(line.id)}
                          aria-pressed={lineActive}
                          className="flex min-w-0 flex-1 items-center gap-1 text-left"
                        >
                          <RowLabel row={line} active={lineActive} />
                        </button>
                      </div>
                    )
                  })}
                </div>
              )
            })}
          </div>
        ))}
        {unassigned && unassigned.count > 0 && (
          <div
            data-testid="region-unassigned"
            title="Lines outside every region - draw a region over them to assign them"
            className="flex items-center gap-1 rounded px-1 py-0.5 text-xs text-ink-muted"
          >
            <span className="w-4 shrink-0" />
            <span className="h-2 w-2 shrink-0 rounded-full border border-current" />
            <span className="truncate">{unassigned.label}</span>
            <span className="ml-auto shrink-0 tabular-nums text-ink-subtle">{unassigned.count}</span>
          </div>
        )}
      </div>
    </div>
  )
}
