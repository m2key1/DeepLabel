import type { Job } from '../../api'

export interface ColumnDef {
  key: string
  label: string
  /** What it takes when there is room, and the least it can be squeezed to. */
  width: number
  min: number
  align?: 'right'
  /** Which to give up first when they do not all fit - 1 goes soonest, and a column
   *  without one is never given up. The row's name and its actions are not columns and
   *  are never given up either. */
  drop?: number
}

export const COLUMNS: ColumnDef[] = [
  { key: 'phases', label: 'Pipeline', width: 140, min: 118, drop: 4 },
  { key: 'pages', label: 'Pages', width: 76, min: 62, align: 'right', drop: 3 },
  { key: 'lines', label: 'Lines', width: 84, min: 68, align: 'right', drop: 1 },
  { key: 'unread', label: 'Unreviewed', width: 92, min: 76, align: 'right', drop: 2 },
  { key: 'progress', label: 'Reviewed', width: 200, min: 128, drop: 6 },
  { key: 'access', label: 'Access', width: 104, min: 84, drop: 7 },
  { key: 'when', label: 'Added', width: 96, min: 88, align: 'right', drop: 5 },
]

/** The chosen columns that this much room can actually hold, dropping the ones marked to
 *  go first until the rest fit. No breakpoints: the question is whether these particular
 *  columns fit this particular width, which a fixed pixel threshold can only guess at -
 *  and the guess is wrong as soon as somebody picks a different set. What a person chose
 *  is never overwritten; widen the window, or fold the rail, and the rest come back. */
export function columnsForWidth(chosen: ColumnDef[], available: number): ColumnDef[] {
  if (!available) return chosen
  let kept = [...chosen]
  while (kept.length > 1 && columnWidths(kept, available).overflows !== null) {
    const droppable = kept.filter((c) => c.drop !== undefined)
    if (droppable.length === 0) break
    const goes = droppable.reduce((worst, c) => (c.drop! < worst.drop! ? c : worst))
    kept = kept.filter((c) => c !== goes)
  }
  return kept
}

export const DEFAULT_COLUMNS = ['phases', 'pages', 'progress', 'access', 'when']

const STORE = 'deeplabel.columns'

/** Which columns this person keeps, for one table. Per browser rather than in the
 *  account: the shared settings record is exactly that - shared - and one person's choice
 *  of columns is not everyone's. See the note on collapsed groups for the other half of
 *  that story. Takes the table's own key so two tables do not overwrite each other. */
export function loadColumnsFor(store: string, known: ColumnDef[], fallback: string[]): string[] {
  try {
    const raw = localStorage.getItem(store)
    if (raw) {
      const keys = (JSON.parse(raw) as string[]).filter((k) => known.some((c) => c.key === k))
      if (keys.length) return keys
    }
  } catch {
    // A private window, or storage the browser refuses. The defaults are fine.
  }
  return fallback
}

export function saveColumnsFor(store: string, keys: string[]): void {
  try {
    localStorage.setItem(store, JSON.stringify(keys))
  } catch {
    // Not worth failing a click over.
  }
}

export const loadColumns = () => loadColumnsFor(STORE, COLUMNS, DEFAULT_COLUMNS)
export const saveColumns = (keys: string[]) => saveColumnsFor(STORE, keys)

/** Room taken by the checkbox and the actions cell, which never shrink. */
const CHROME = 162
/** The narrowest a dataset name may be squeezed to before the table scrolls instead. */
export const NAME_MIN = 190

/** Widths that add up to the space available, so the table divides its container rather
 *  than growing past it. Columns give width back in proportion until they reach their own
 *  floors; past that the chosen columns genuinely do not fit, and the caller is told so
 *  rather than the name being squeezed to nothing. */
export function columnWidths(
  columns: ColumnDef[], available: number,
): { widths: number[]; overflows: number | null } {
  const natural = columns.reduce((sum, c) => sum + c.width, 0)
  if (!available || natural + CHROME + NAME_MIN <= available) {
    return { widths: columns.map((c) => c.width), overflows: null }
  }
  const room = available - CHROME - NAME_MIN
  const floor = columns.reduce((sum, c) => sum + c.min, 0)
  if (room <= floor) {
    return { widths: columns.map((c) => c.min), overflows: CHROME + NAME_MIN + floor }
  }
  const t = (room - floor) / (natural - floor)
  return { widths: columns.map((c) => Math.round(c.min + (c.width - c.min) * t)), overflows: null }
}

export const phasesOf = (job: Job): { key: string; on: boolean }[] => [
  { key: 'layout', on: job.run_layout },
  { key: 'lines', on: job.run_lines },
  { key: 'ocr', on: job.run_ocr },
]
