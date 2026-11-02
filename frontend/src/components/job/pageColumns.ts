import type { Job, PageSort } from '../../api'
import { isTileTask } from '../../api'
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
  { key: 'status', label: 'Status', width: 112, min: 92, sort: 'status', drop: 3 },
  { key: 'layout', label: 'Layout', width: 84, min: 72, sort: 'layout', drop: 2 },
  { key: 'reviewed', label: 'Lines reviewed', width: 168, min: 128, sort: 'checked', drop: 7 },
  { key: 'confidence', label: 'Confidence', width: 136, min: 112, sort: 'confidence', drop: 5 },
  { key: 'llm', label: 'Read by', width: 82, min: 68, align: 'right', sort: 'llm', drop: 4 },
]

// The furthest step a page has been through, in words: the stored names are the
// pipeline's, and "done" says nothing about which step finished.
const PAGE_STATUS: Record<string, string> = {
  pending: 'Waiting',
  ingested: 'Uploaded',
  layout_done: 'Layout found',
  lines_done: 'Lines found',
  done: 'Read',
  duplicate: 'Duplicate',
  unreadable: 'Unreadable',
}

// Each step of a text dataset's run, the page status that means a page is through it, and
// what a page that did not get through it reads when the run failed there.
const STEP_PASSED: Record<string, { through: string; failed: string }> = {
  ingest: { through: 'ingested', failed: 'Upload failed' },
  layout: { through: 'layout_done', failed: 'Layout failed' },
  lines: { through: 'lines_done', failed: 'Lines failed' },
  ocr: { through: 'done', failed: 'Reading failed' },
}
const PROGRESS = ['pending', 'ingested', 'layout_done', 'lines_done', 'done']

type StatusOf = Pick<Job, 'task' | 'run_layout' | 'status' | 'phase'>

export function pageStatus(status: string, job: StatusOf): { label: string; failed: boolean } {
  if (isTileTask(job.task)) return { label: status === 'done' ? 'Processed' : PAGE_STATUS[status] ?? status, failed: false }
  const step = job.status === 'error' && job.phase ? STEP_PASSED[job.phase] : undefined
  const reached = PROGRESS.indexOf(status)
  if (step && reached >= 0 && reached < PROGRESS.indexOf(step.through)) return { label: step.failed, failed: true }
  // A dataset without layout moves its pages past the step untouched, so none was found.
  if (status === 'layout_done' && !job.run_layout) return { label: PAGE_STATUS.ingested, failed: false }
  return { label: PAGE_STATUS[status] ?? status, failed: false }
}

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
