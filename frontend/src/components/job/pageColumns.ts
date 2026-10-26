import type { PageSort } from '../../api'
import type { ColumnDef } from './columns'
import { loadColumnsFor, saveColumnsFor } from './columns'

/** The page table's columns. Same shape and same width solver as the dataset list, so the
 *  two tables in the app behave identically - what differs is only what a row is about.
 *  `sort` names the ordering the backend applies for this column; a column without one is
 *  not sortable, because the ordering happens in SQL rather than over the loaded slice. */
export interface PageColumnDef extends ColumnDef {
  sort?: PageSort
}

export const PAGE_COLUMNS: PageColumnDef[] = [
  { key: 'thumb', label: '', width: 52, min: 52, drop: 6 },
  { key: 'idx', label: '#', width: 56, min: 48, align: 'right', sort: 'idx', drop: 8 },
  { key: 'dimensions', label: 'Size', width: 104, min: 88, align: 'right', sort: 'dimensions', drop: 1 },
  { key: 'status', label: 'Status', width: 92, min: 76, sort: 'status', drop: 3 },
  { key: 'layout', label: 'Layout', width: 84, min: 72, sort: 'layout', drop: 2 },
  { key: 'reviewed', label: 'Lines reviewed', width: 168, min: 128, sort: 'checked', drop: 7 },
  { key: 'confidence', label: 'Confidence', width: 136, min: 112, sort: 'confidence', drop: 5 },
  { key: 'llm', label: 'Read by', width: 82, min: 68, align: 'right', sort: 'llm', drop: 4 },
]

export const DEFAULT_PAGE_COLUMNS = ['thumb', 'idx', 'reviewed', 'confidence', 'llm']

const STORE = 'deeplabel.pageColumns'

export const loadPageColumns = () => loadColumnsFor(STORE, PAGE_COLUMNS, DEFAULT_PAGE_COLUMNS)
export const savePageColumns = (keys: string[]) => saveColumnsFor(STORE, keys)

/** The filters the table offers, in the order they are shown. The labels change for a map
 *  dataset, whose pages are tiles with nothing to segment inside and no text to read - the
 *  same reason the dataset list calls its progress "reviewed" there. */
export const PAGE_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'lines-reviewed', label: 'Lines reviewed', textOnly: true },
  { key: 'layout-reviewed', label: 'Layout reviewed', textOnly: true },
  { key: 'reviewed', label: 'Reviewed', mapOnly: true },
  { key: 'unreviewed-lines', label: 'Unreviewed lines', textOnly: true },
  { key: 'layout-unchecked', label: 'Layout unchecked', mapLabel: 'Not reviewed' },
  { key: 'no-layout', label: 'No layout', textOnly: true },
  { key: 'test-pages', label: 'Test pages', textOnly: true },
  { key: 'deleted', label: 'Deleted', editorsOnly: true },
] as const


const HIDDEN_STORE = 'deeplabel.pageColumnsHidden'

/** Columns this person has put away, rather than the ones they keep. Stored as the
 *  absence so a column added to the table later shows up instead of staying invisible
 *  for everyone who ever opened the picker. Which columns exist at all is still decided
 *  by the dataset - a map dataset has no OCR to report - and this only hides within that. */
export function loadHiddenColumns(): string[] {
  try {
    const raw = localStorage.getItem(HIDDEN_STORE)
    if (raw) return JSON.parse(raw) as string[]
  } catch {
    // A private window, or storage the browser refuses. Show everything.
  }
  return []
}

export function saveHiddenColumns(keys: string[]): void {
  try {
    localStorage.setItem(HIDDEN_STORE, JSON.stringify(keys))
  } catch {
    // Not worth failing a click over.
  }
}
