import type { ReactNode } from 'react'

/** The dense table the dashboard reads as, for the pages that need its look without its
 *  machinery - no column resizing, no sticky split head, no picker. Those belong to the
 *  dataset list alone, which is six hundred rows; this is for the dozens. */

// text-left because a th centres by default, and a column of figures that wants
// the other edge says so on the cell.
export const tableHeadRow = 'text-left text-[10px] uppercase tracking-widest text-ink-subtle'
export const tableRow = 'h-9 border-b border-line/60 hover:bg-ground'
export const tableCell = 'px-2'

export interface Column<T> {
  key: string
  label: ReactNode
  align?: 'left' | 'right'
  /** A fixed width, when the content would otherwise push the table around. */
  width?: string
  cell: (row: T) => ReactNode
}

export function Table<T>({ columns, rows, rowKey, rowProps, caption }: {
  columns: Column<T>[]
  rows: T[]
  rowKey: (row: T) => string | number
  /** Per-row attributes - a testid, a status accent on the left border, a click. */
  rowProps?: (row: T) => React.HTMLAttributes<HTMLTableRowElement> & { 'data-testid'?: string }
  caption?: string
}) {
  return (
    <table className="w-full border-collapse text-sm">
      {caption && <caption className="sr-only">{caption}</caption>}
      <thead>
        <tr className={tableHeadRow}>
          {columns.map((c) => (
            <th
              key={c.key}
              data-col={c.key}
              style={c.width ? { width: c.width } : undefined}
              className={`px-2 py-1.5 font-semibold ${c.align === 'right' ? 'text-right' : 'text-left'}`}
            >
              {c.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const extra = rowProps?.(row)
          return (
            <tr key={rowKey(row)} {...extra} className={`${tableRow} ${extra?.className ?? ''}`.trim()}>
              {columns.map((c) => (
                <td
                  key={c.key}
                  data-col={c.key}
                  className={`${tableCell} ${c.align === 'right' ? 'text-right' : ''}`.trim()}
                >
                  {c.cell(row)}
                </td>
              ))}
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
