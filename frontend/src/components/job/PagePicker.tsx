import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

const PREVIEWABLE = /\.(jpe?g|png|bmp|webp)$/i

export interface PickItem<K> {
  key: K
  name: string
  /** A thumbnail to show; without one the tile names the file type. */
  preview?: string
}

/** Local files as pickable pages, each image with a preview that lives as long as the list. */
export function useFileItems(files: File[]): PickItem<File>[] {
  const previews = useMemo(
    () => new Map(files.filter((f) => PREVIEWABLE.test(f.name)).map((f) => [f, URL.createObjectURL(f)])),
    [files])
  useEffect(() => () => previews.forEach((url) => URL.revokeObjectURL(url)), [previews])
  return useMemo(() => files.map((f) => ({ key: f, name: f.name, preview: previews.get(f) })), [files, previews])
}

/** Positions from "3-22, 35", counted from 1; null when the text is not a list of ranges. */
export function parseRanges(text: string, count: number): Set<number> | null {
  const picked = new Set<number>()
  for (const part of text.split(',').map((p) => p.trim()).filter(Boolean)) {
    const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part)
    if (!match) return null
    const from = Number(match[1])
    const to = Number(match[2] ?? match[1])
    if (from < 1 || to < from || to > count) return null
    for (let n = from; n <= to; n++) picked.add(n)
  }
  return picked.size ? picked : null
}

/** The pages picked for a new dataset as thumbnails, each ticked unless left out, with a
 *  range field for long volumes. */
export function PagePicker<K>({ items, excluded, onToggle, onExclude, unit = 'file', note }: {
  items: PickItem<K>[]
  excluded: Set<K>
  onToggle: (key: K) => void
  onExclude: (keys: Set<K>) => void
  unit?: string
  note?: ReactNode
}) {
  const [range, setRange] = useState('')
  const [rangeError, setRangeError] = useState(false)
  const included = items.filter((item) => !excluded.has(item.key)).length

  const applyRange = () => {
    const picked = parseRanges(range, items.length)
    setRangeError(picked === null)
    if (picked) onExclude(new Set(items.filter((_, i) => !picked.has(i + 1)).map((item) => item.key)))
  }

  return (
    <div data-testid="page-picker">
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-muted">
        <span data-testid="page-picker-count">{included} of {items.length} {unit}{items.length === 1 ? '' : 's'} included</span>
        <button type="button" onClick={() => onExclude(new Set())} className="text-accent-ink hover:underline">select all</button>
        <button type="button" onClick={() => onExclude(new Set(items.map((item) => item.key)))}
                className="text-accent-ink hover:underline">select none</button>
        <span className="ml-auto flex items-center gap-1.5">
          <label htmlFor="page-range">Pages</label>
          <input id="page-range" data-testid="page-range" value={range} placeholder="e.g. 3-22, 35"
                 aria-invalid={rangeError}
                 onChange={(e) => { setRange(e.target.value); setRangeError(false) }}
                 onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); applyRange() } }}
                 className={`w-32 rounded border bg-surface px-1.5 py-0.5 text-xs text-ink ${rangeError ? 'border-danger' : 'border-line-strong'}`} />
          <button type="button" onClick={applyRange} className="rounded border border-line-strong px-2 py-0.5 text-ink hover:bg-raised">
            Apply
          </button>
        </span>
      </div>
      {rangeError && (
        <p data-testid="page-range-error" className="-mt-2 mb-2 text-xs text-danger">
          Give page numbers from 1 to {items.length}, like 3-22, 35.
        </p>
      )}
      {note && <p className="-mt-1 mb-2 text-xs text-ink-muted">{note}</p>}
      {/* Its own scroller, so a long volume leaves the count above and Back and Next below on screen. */}
      <div data-testid="page-picker-grid"
           className="grid max-h-[60vh] grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-2.5 overflow-y-auto rounded-md border border-line bg-ground p-2.5">
        {items.map((item, i) => {
          const on = !excluded.has(item.key)
          return (
            <label key={`${item.name}-${i}`} data-testid="page-pick" data-file={item.name} data-included={on}
                   className={`relative cursor-pointer rounded-md border border-line bg-surface p-1.5 ${on ? '' : 'opacity-45'}`}>
              <input type="checkbox" checked={on} onChange={() => onToggle(item.key)} aria-label={item.name}
                     className="absolute left-3 top-3 cursor-pointer accent-accent" />
              {item.preview ? (
                <img src={item.preview} alt="" loading="lazy" className="h-32 w-full rounded-sm bg-raised object-contain" />
              ) : (
                <div className="grid h-32 place-items-center rounded-sm bg-raised font-mono text-xs uppercase text-ink-muted">
                  {item.name.split('.').pop()}
                </div>
              )}
              <span className="mt-1 block truncate text-[11px] text-ink-muted" title={item.name}>{item.name}</span>
            </label>
          )
        })}
      </div>
    </div>
  )
}
