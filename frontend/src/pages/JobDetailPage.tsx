import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import {
  cancelJob,
  startJob,
  redetectPreview,
  reocr,
  reocrPreview,
  downloadMaskSet,
  exportUrl,
  getJob,
  isUncounted,
  getLlmReadStatus,
  cancelLlmRead,
  getJobMapClasses,
  getPage,
  getReviewQueue,
  isTileTask,
  jobEventsUrl,
  purgePreview,
  renditionUrl,
  setJobChecked,
  setLineWidth,
  setJobNote,
  setNewPagesTest,
  setPageNote,
  markTestPages,
  setPageLayoutChecked,
  setPagesDeleted,
  runPagesPhase,
  PHASE_CAPABILITY,
  uploadPages,
  listPageRows,
  ApiError,
} from '../api'
import type {
  ExportFormat, JobEvent, JobWithoutPages, LlmReadStatus, MapClass, PageDetail,
  PageFilter as PageFilterKey, PagePhase, PageRows, PageSort, PageSummary, PurgeManifest, Region,
  ReviewQueue, StaleLines, UnreadablePage,
} from '../api'
import { useAuth } from '../auth'
import { useCommand } from '../commands'
import { usePresence, usePresenceLocation } from '../presence'
import { useSetCrumbs } from '../components/NavBar'
import { PresenceAvatars } from '../components/presence/PresenceAvatars'
import { Modal, modalBtn, modalPrimaryBtn } from '../components/Modal'
import { NoteTag } from '../components/NoteTag'
import { StatusBadge } from '../components/StatusBadge'
import { Badge } from '../components/ui/Badge'
import { PhaseStrip } from '../components/job/PhaseStrip'
import { loadHiddenColumns, saveHiddenColumns } from '../components/job/pageColumns'
import { appendRows, fetchWindow } from '../components/job/pageWindow'

/** A screenful. Large enough that a volume is scrolled rather than paged through,
 *  small enough that 18,580 pages never arrive at once. */
const PAGE_SIZE = 200
const INGEST_REFRESH_MS = 5_000
const ROWS_RETRY_MS = 1_000
const ROWS_RETRY_MAX_MS = 30_000

/** A read lost on the way or failed by a server that may be back in a moment; a refusal
 *  answers the same however often it is asked. */
const worthRetrying = (error: unknown) => !(error instanceof ApiError) || error.status >= 500
// Far above the slowest real answer (well under a second on the largest dataset), so only a
// read that will never answer is given up on.
const ROWS_TIMEOUT_MS = 30_000

function withinTime<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error('the page table did not answer in time')), ms)
    promise.then(
      (value) => { window.clearTimeout(timer); resolve(value) },
      (error) => { window.clearTimeout(timer); reject(error) })
  })
}
import { Button, buttonClass } from '../components/ui/Button'
import { AddPagesDialog } from '../components/job/AddPagesDialog'
import { UploadProgress, type UploadState } from '../components/ui/UploadProgress'
import { PHASE_CHOICES } from '../components/job/processing'
import { MaskExportDialog } from '../components/job/MaskExportDialog'
import { PurgeDialog } from '../components/job/PurgeDialog'
import { RedetectDialog } from '../components/job/RedetectDialog'
import { LlmReadDialog } from '../components/job/LlmReadDialog'
import { LayoutClassesDialog } from '../components/job/LayoutClassesDialog'
import { RemoveReadingsDialog } from '../components/job/RemoveReadingsDialog'
import { SettleAgainDialog } from '../components/job/SettleAgainDialog'
import { RepredictDialog } from '../components/job/RepredictDialog'
import { RerunDialog } from '../components/job/RerunDialog'
import { CopyImageButton } from '../components/CopyImageButton'
import {
  REVIEW_THRESHOLDS, classColor, confBadgeClass, confOutlineClass, getReviewConf,
  setReviewConf,
} from '../util'
import { widePageShell } from '../components/ui/page'
import { menuTrigger, useDismiss } from '../components/ui/menu'
import { useAutoClear } from '../messages'
import { Check } from '../components/ui/Field'
import { usePolling } from '../hooks/usePolling'
import { cardChrome, popoverChrome } from '../components/ui/Card'

const EXPORT_FORMATS: ExportFormat[] = ['json', 'md', 'txt', 'zip']

const PHASE_LABELS: Record<PagePhase, string> = {
  layout: 'Layout detection',
  lines: 'Line detection',
  ocr: 'A re-read',
}

const TEST_PAGE_MEANING = 'Test data - no training uses these pages, nor pages with the same scan'

type SortKey = 'idx' | 'filename' | 'dimensions' | 'status' | 'layout' | 'checked' | 'confidence'
  | 'llm' | 'regions' | 'test'

/** What a run changes on a dataset, as one string two looks at it can be compared by. */
const runState = (job: Pick<JobWithoutPages, 'status' | 'counters'>) =>
  JSON.stringify([job.status, job.counters])

type Column = { key: SortKey; label: string; title?: string }

type PageFilter = PageFilterKey

type PageFilterDef = { key: PageFilter; label: string; editorsOnly?: boolean }

// What each chip matches, and how many, is the backend's (page_rows.FILTERS): one rule in
// one place, so a chip's count and its rows cannot disagree. This only says which chips a
// dataset of this shape offers.
//
// A delete has to read as permanent, so a deleted page shows up in no filter but its
// own - which only someone who may edit the dataset sees, to restore it from.
//
// A tile has no layout and no lines: its one review is the Reviewed flag, so a map job gets
// that chip and none of the text ones, which could only ever come back empty. A dataset
// that skipped layout has no layout to mark complete, so the layout chips go there.
const pageFilters = (isMap: boolean, noLayout: boolean): PageFilterDef[] => [
  { key: 'all', label: 'All' },
  ...(isMap ? [
    { key: 'reviewed' as PageFilter, label: 'Reviewed' },
  ] : [
    { key: 'lines-reviewed' as PageFilter, label: 'Lines reviewed' },
    ...(noLayout ? [] : [{ key: 'layout-reviewed' as PageFilter, label: 'Layout reviewed' }]),
    { key: 'unreviewed-lines' as PageFilter, label: 'Unreviewed lines' },
  ]),
  ...(noLayout ? [] : [{ key: 'layout-unchecked' as PageFilter, label: isMap ? 'Not reviewed' : 'Layout unchecked' }]),
  // Detection found no box here, so on a per-crop dataset its lines are whatever the
  // fallback scraped off the whole page - which is exactly the set worth re-running. Only
  // offered where layout runs: without it every page has no boxes and the chip means
  // nothing.
  ...(isMap || noLayout ? [] : [{ key: 'no-layout' as PageFilter, label: 'No layout' }]),
  ...(isMap ? [] : [{ key: 'test-pages' as PageFilter, label: 'Test pages' }]),
  ...(isMap ? [] : [{ key: 'has-note' as PageFilter, label: 'Has note' }]),
  { key: 'deleted', label: 'Deleted', editorsOnly: true },
]

const TEXT_COLUMNS: Column[] = [
  { key: 'idx', label: '#' },
  { key: 'filename', label: 'Filename' },
  { key: 'dimensions', label: 'Dimensions' },
  { key: 'status', label: 'Status' },
  { key: 'layout', label: 'Layout', title: 'Marked layout complete - auto-exported as a COCO layout dataset' },
  { key: 'checked', label: 'OCR checked', title: 'Lines whose text has been reviewed' },
  { key: 'confidence', label: 'Confidence', title: 'Worst / average line confidence' },
  { key: 'llm', label: 'LLM', title: 'Language models holding a reading of this page' },
  { key: 'test', label: 'Test', title: TEST_PAGE_MEANING },
]

// Without a layout there is nothing to mark complete, and the review unit is the line.
const NO_LAYOUT_COLUMNS: Column[] = TEXT_COLUMNS
  .filter((c) => c.key !== 'layout')
  .map((c) => (c.key === 'checked'
    ? { ...c, label: 'Lines checked', title: 'Lines that have been reviewed' }
    : c))

const MAP_COLUMNS: Column[] = [
  { key: 'idx', label: '#' },
  { key: 'filename', label: 'Filename' },
  { key: 'dimensions', label: 'Dimensions' },
  { key: 'status', label: 'Status' },
  { key: 'layout', label: 'Reviewed', title: 'Marked reviewed - eligible for mask export' },
  { key: 'regions', label: 'Regions', title: 'Annotations on this tile' },
]

// Map tiles are reviewed whole (the Reviewed column), so this column counts shapes rather
// than rating them. A line job only renames it.
const LINE_COLUMNS: Column[] = MAP_COLUMNS.map((c) =>
  c.key === 'regions' ? { key: 'regions', label: 'Lines', title: 'Traced lines on this tile' } : c,
)

function thumbWidth(page: PageSummary): number {
  return page.width && page.height ? Math.max(16, Math.round((56 * page.width) / page.height)) : 42
}

export function JobDetailPage() {
  const { user, isAdmin, canEdit, can } = useAuth()
  const { id } = useParams<{ id: string }>()
  const jobId = id!
  const navigate = useNavigate()
  const [job, setJob] = useState<JobWithoutPages | null>(null)
  const [error, setError] = useState<string | null>(null)
  useAutoClear(error, setError)
  const [notice, setNotice] = useState<string | null>(null)
  useAutoClear(notice, setNotice)
  const [sseRetry, setSseRetry] = useState(0)
  const [rerunOpen, setRerunOpen] = useState(false)
  const [stale, setStale] = useState<StaleLines | null>(null)
  const [redetectOpen, setRedetectOpen] = useState(false)
  const [reocrCount, setReocrCount] = useState(0)
  const [addOpen, setAddOpen] = useState(false)
  const [dragging, setDragging] = useState(false)
  const dragDepth = useRef(0)
  const [upload, setUpload] = useState<UploadState | null>(null)
  const fileInput = useRef<HTMLInputElement | null>(null)
  // Unset follows the dataset's "New pages are test pages".
  const [addAsTest, setAddAsTest] = useState<boolean | null>(null)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [anchor, setAnchor] = useState<number | null>(null)
  const [purgeOpen, setPurgeOpen] = useState(false)
  const [purgeable, setPurgeable] = useState<PurgeManifest | null>(null)
  const [maskOpen, setMaskOpen] = useState(false)
  const [downloadingMasks, setDownloadingMasks] = useState(false)
  const [downloadingFullMaps, setDownloadingFullMaps] = useState(false)
  const [repredictOpen, setRepredictOpen] = useState(false)
  const [llmOpen, setLlmOpen] = useState(false)
  const [settleOpen, setSettleOpen] = useState(false)
  const [removeReadingsOpen, setRemoveReadingsOpen] = useState(false)
  const [classesOpen, setClassesOpen] = useState(false)
  // The pages a read is scoped to, or undefined for the whole dataset. Held apart from the
  // table's selection, which the dialog must not follow while it is open.
  const [llmPages, setLlmPages] = useState<number[] | undefined>(undefined)
  const [llmStatus, setLlmStatus] = useState<LlmReadStatus | null>(null)
  // A failed reading is counted for as long as it is stored, so the banner stayed up for
  // good once anything had failed. Dismissing hides it until the next run starts.
  const [llmDismissed, setLlmDismissed] = useState(false)

  const [review, setReview] = useState<ReviewQueue | null>(null)
  const [maxConf, setMaxConf] = useState(getReviewConf)
  const [exportOpen, setExportOpen] = useState(false)

  useDismiss(exportOpen, () => setExportOpen(false))

  const setCrumbs = useSetCrumbs()
  const jobName = job?.name
  useEffect(() => {
    setCrumbs(jobName ? [{ label: jobName }] : [])
    return () => setCrumbs([])
  }, [setCrumbs, jobName])

  const { onPage } = usePresence()
  usePresenceLocation({ job_id: jobId })

  // Hover a page row to peek at its marked-up layout on the side; click still opens it.
  // The table's rows come a screenful at a time. Every row ever loaded is also kept by
  // id, because a selection made under one filter has to keep meaning something under
  // the next - which of them are deleted decides whether the bulk bar offers Restore.
  const [rows, setRows] = useState<PageSummary[]>([])
  const [matched, setMatched] = useState(0)
  const [chipCounts, setChipCounts] = useState<Record<string, number>>({})
  // How deep the table has been walked, which a reload after an edit fetches again.
  const shown = useRef(PAGE_SIZE)
  // Only the newest request may write the rows: an older answer arriving after it
  // would put back a filter, an ordering or an edit that has since moved on.
  const rowsRequest = useRef(0)
  const rowsRetry = useRef<number | undefined>(undefined)
  const [rowsLoading, setRowsLoading] = useState(false)
  const seenRows = useRef<Map<number, PageSummary>>(new Map())
  const [hiddenColumns, setHiddenColumns] = useState<string[]>(loadHiddenColumns)
  const [columnsOpen, setColumnsOpen] = useState(false)

  useDismiss(columnsOpen, () => setColumnsOpen(false))

  const [hoverId, setHoverId] = useState<number | null>(null)
  const [preview, setPreview] = useState<PageDetail | null>(null)
  const previewCache = useRef<Map<number, PageDetail>>(new Map())
  const hoverRef = useRef<number | null>(null)
  const hoverTimer = useRef<number | null>(null)

  /** A page has something to show once it has been ingested. Deleted, duplicate and
   *  unreadable pages never got a rendition, and a pending one has not been written yet. */
  const previewable = (page: PageSummary) =>
    !page.deleted && page.status !== 'pending' && !isUncounted(page)

  const loadPreview = useCallback((pageId: number) => {
    getPage(jobId, String(pageId))
      .then((d) => {
        previewCache.current.set(pageId, d)
        if (hoverRef.current === pageId) setPreview(d)
      })
      .catch(() => undefined)
  }, [jobId])

  const previewPage = (page: PageSummary, immediate = false) => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    if (!previewable(page)) return
    hoverTimer.current = window.setTimeout(() => {
      hoverRef.current = page.id
      setHoverId(page.id)
      const cached = previewCache.current.get(page.id)
      setPreview(cached ?? null)
      if (!cached) loadPreview(page.id)
    }, immediate ? 0 : 120)
  }


  useEffect(() => {
    redetectPreview(jobId).then(setStale).catch(() => undefined)
    reocrPreview(jobId).then((r) => setReocrCount(r.lines)).catch(() => undefined)
  }, [jobId, job?.status])

  // Language-model readings run outside the job queue, so they have their own progress to
  // poll - and only while something is actually in flight.
  const pollLlm = useCallback(() => {
    getLlmReadStatus(jobId).then(setLlmStatus).catch(() => undefined)
  }, [jobId])

  useEffect(() => {
    pollLlm()
  }, [pollLlm])

  useEffect(() => {
    if (!llmStatus?.active) return
    setLlmDismissed(false)
    const timer = window.setInterval(pollLlm, 1500)
    return () => window.clearInterval(timer)
  }, [llmStatus?.active, pollLlm])

  const refetch = useCallback(() => {
    getJob(jobId, { pages: false }).then(setJob).catch((e: Error) => setError(e.message))
    loadRowsRef.current()
    getReviewQueue(jobId, maxConf).then(setReview).catch((e: Error) => setError(e.message))
    // What a purge would actually free. Deleted rows outlive a purge, so counting them
    // instead would leave the button offering work that frees nothing.
    if (isAdmin) purgePreview(jobId).then(setPurgeable).catch(() => setPurgeable(null))
    // Whatever made this reload may have changed the pages, so the previews kept of them
    // are dropped and the one on screen is read again.
    previewCache.current.clear()
    if (hoverRef.current !== null) loadPreview(hoverRef.current)
  }, [jobId, maxConf, isAdmin, loadPreview])

  useEffect(() => {
    refetch()
  }, [refetch])

  const active = job !== null && (job.status === 'queued' || job.status === 'running')
  // Sent in parts by the client: it waits until the last part is in, then is started.
  const uploading = job?.status === 'uploading'
  // What the backend lets through for the settings that decide how the dataset is
  // processed, and for queueing work on it: the owner, or an admin.
  const canOwn = job !== null && (isAdmin || job.owner === user)
  // Both tile tasks share the job page, tile grid, review flags and mask export; only
  // the geometry inside a tile differs, which lives in the editor.
  const isMap = !!job && isTileTask(job.task)
  const lineJob = job?.task === 'map_lines'
  // Nothing detected the boxes, so the lines are what gets reviewed and counted.
  const noLayout = !!job && !isMap && !job.run_layout
  // Which columns this dataset has at all is decided by what it is - a map dataset has no
  // OCR to report - and the picker below only hides within that set.
  const available = lineJob ? LINE_COLUMNS
    : isMap ? MAP_COLUMNS
    : noLayout ? NO_LAYOUT_COLUMNS : TEXT_COLUMNS
  const columns = available.filter((c) => !hiddenColumns.includes(c.key))

  const startReview = () =>
    review?.total && navigate(`/jobs/${jobId}/pages/${review.lines[0].page_id}?review=${maxConf}`)
  // Offered exactly when the buttons are: a map dataset has neither, and there is nothing
  // to review until something is flagged.
  useCommand('transcript', () => navigate(`/jobs/${jobId}/transcript`), !isMap)
  useCommand('review', startReview, !isMap && !!review?.total)

  // jobs.line_width is export-only — it decides how wide polylines are stroked into the
  // mask PNGs and changes nothing on screen — so it lives beside the export buttons, and
  // is committed on blur/Enter rather than per keystroke: typing "12" would otherwise
  // PATCH "1" on the way, and a momentarily empty field is not a width at all.
  const [widthDraft, setWidthDraft] = useState('')
  const jobLineWidth = job?.line_width
  useEffect(() => {
    if (jobLineWidth !== undefined) setWidthDraft(String(jobLineWidth))
  }, [jobLineWidth])

  const commitLineWidth = () => {
    if (jobLineWidth === undefined) return
    const typed = widthDraft.trim()
    const parsed = Number(typed)
    // Blanking the field means "never mind", not width 0 - snap back to what the job has.
    if (!typed || !Number.isFinite(parsed)) return setWidthDraft(String(jobLineWidth))
    const next = Math.min(25, Math.max(1, Math.round(parsed)))
    setWidthDraft(String(next))
    if (next === jobLineWidth) return
    setJob((p) => (p ? { ...p, line_width: next } : p))
    setLineWidth(jobId, next).catch((err: Error) => {
      setError(err.message)
      setJob((p) => (p ? { ...p, line_width: jobLineWidth } : p))
      setWidthDraft(String(jobLineWidth))
    })
  }

  // The hover preview must colour regions from the job's own editable palette, exactly as
  // the tile editor does — deriving a colour from the class name instead would disagree
  // with the editor and would not follow a recolour.
  const [mapClasses, setMapClasses] = useState<MapClass[]>([])
  useEffect(() => {
    if (!isMap) return setMapClasses([])
    getJobMapClasses(jobId).then(setMapClasses).catch(() => setMapClasses([]))
  }, [isMap, jobId])
  const regionColor = useCallback(
    (r: Region) => {
      const c = mapClasses.find((k) => k.id === r.class_id)?.color
      // Before the palette loads (or for a class removed from the job) fall back to the
      // name hash rather than flashing a wrong solid colour.
      return c ? `rgb(${c[0]}, ${c[1]}, ${c[2]})` : classColor(r.class_name)
    },
    [mapClasses],
  )

  // A run can be started from another tab, by someone else or over the API. While idle,
  // look for one as often as the dataset list does; finding one opens the stream below.
  // A one-page run is over between two looks, so the look compares what a run leaves
  // behind - the counters - and not only whether one is under way right now.
  // Read through a ref, so a look that finds news does not restart the poll with it.
  const idleState = job && !active ? runState(job) : null
  const idleStateRef = useRef(idleState)
  useEffect(() => {
    idleStateRef.current = idleState
  }, [idleState])
  const lookForRun = useCallback(() => {
    getJob(jobId, { pages: false })
      .then((next) => { if (runState(next) !== idleStateRef.current) refetch() })
      .catch(() => undefined)
  }, [jobId, refetch])
  usePolling(lookForRun, 5000, idleState !== null)

  // How many pages the stream last said were in, so an event can tell the count moved.
  const ingested = useRef<number | undefined>(undefined)
  const jobIngested = job?.counters.pages_ingested
  useEffect(() => {
    ingested.current = jobIngested
  }, [jobIngested])

  useEffect(() => {
    if (!active) return
    const es = new EventSource(jobEventsUrl(jobId))
    let closed = false
    // An ingest moves the count several times a second. The table follows the first move
    // at once and then at most once per INGEST_REFRESH_MS, with a read after the last.
    let lastRead = 0
    let trailing: number | undefined
    const readSoon = () => {
      if (trailing !== undefined) return
      const read = () => {
        trailing = undefined
        lastRead = Date.now()
        refetch()
      }
      const wait = lastRead + INGEST_REFRESH_MS - Date.now()
      if (wait <= 0) read()
      else trailing = window.setTimeout(read, wait)
    }
    es.onmessage = (e) => {
      const ev = JSON.parse(e.data) as JobEvent
      const moved = ingested.current !== undefined && ev.counters.pages_ingested !== ingested.current
      ingested.current = ev.counters.pages_ingested
      setJob((prev) => (prev ? { ...prev, status: ev.status, phase: ev.phase, counters: ev.counters } : prev))
      // The run is over and the stream with it: what it wrote is in the rows now.
      if (ev.status !== 'queued' && ev.status !== 'running') {
        closed = true
        es.close()
        window.clearTimeout(trailing)
        refetch()
      } else if (moved) {
        readSoon()
      }
    }
    es.onerror = () => {
      if (closed) return
      closed = true
      es.close()
      refetch()
      setTimeout(() => setSseRetry((n) => n + 1), 2000)
    }
    return () => {
      closed = true
      es.close()
      window.clearTimeout(trailing)
    }
  }, [jobId, active, sseRetry, refetch])

  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'idx', dir: 1 })
  const toggleSort = (key: SortKey) =>
    setSort((prev) => ({ key, dir: prev.key === key && prev.dir === 1 ? -1 : 1 }))

  const [searchParams, setSearchParams] = useSearchParams()
  const filters = useMemo(
    () => pageFilters(isMap, noLayout).filter((f) => canEdit || !f.editorsOnly),
    [isMap, noLayout, canEdit])
  const filter = filters.find((f) => f.key === searchParams.get('filter')) ?? filters[0]
  const setFilter = (key: PageFilter) =>
    setSearchParams(key === 'all' ? {} : { filter: key }, { replace: true })

  const fetchRows = useCallback((offset: number, limit: number) => listPageRows(jobId, {
    filter: filter.key as PageFilterKey,
    // Only map jobs have this column, and it counts: sort by the count, not by the
    // per-shape reviewed ratio the server's 'regions' key still ranks by.
    sort: (sort.key === 'regions' ? 'regions-total' : sort.key) as PageSort,
    desc: sort.dir === -1,
    offset,
    limit,
  }), [jobId, filter.key, sort.key, sort.dir])

  /** Runs one request for the table's rows, and applies its answer only if no newer one
   *  has started since. A read that is lost or fails is asked again, ever more slowly,
   *  until it answers - and one that does not answer at all is given up after
   *  ROWS_TIMEOUT_MS and asked again: nothing else would read the rows of a dataset that is
   *  not running, and its table would go on saying it has no pages. */
  const requestRows = useCallback((fetch: () => Promise<PageRows>, apply: (answer: PageRows) => void) => {
    const request = ++rowsRequest.current
    window.clearTimeout(rowsRetry.current)
    setRowsLoading(true)
    const attempt = (wait: number) => withinTime(fetch(), ROWS_TIMEOUT_MS)
      .then((answer) => {
        if (request !== rowsRequest.current) return
        for (const row of answer.rows) seenRows.current.set(row.id, row)
        apply(answer)
        setMatched(answer.matched)
        setChipCounts(answer.counts)
        setRowsLoading(false)
      })
      .catch((e: Error) => {
        if (request !== rowsRequest.current) return
        setError(e.message)
        if (!worthRetrying(e)) return setRowsLoading(false)
        rowsRetry.current = window.setTimeout(() => attempt(Math.min(wait * 2, ROWS_RETRY_MAX_MS)), wait)
      })
    attempt(ROWS_RETRY_MS)
  }, [])

  useEffect(() => () => {
    rowsRequest.current += 1
    window.clearTimeout(rowsRetry.current)
  }, [])

  /** The table's rows, as deep as it has been walked. Reloaded after anything that edits
   *  pages - a deleted page has to leave the Deleted chip's count as well as the row it
   *  was on. */
  // Held in a ref so `refetch`, which is defined above and used by a dozen handlers, can
  // reload the rows without either of them having to depend on the other's identity - and
  // without capturing the filter and ordering as they were when it was created.
  const loadRowsRef = useRef<() => void>(() => {})

  const loadRows = useCallback(() => {
    requestRows(() => fetchWindow(fetchRows, shown.current, PAGE_SIZE), (answer) => setRows(answer.rows))
  }, [fetchRows, requestRows])

  // A filter or an ordering change starts at the top again; asking for the same deep
  // slice of a different set would land somewhere arbitrary.
  useEffect(() => {
    shown.current = PAGE_SIZE
    loadRowsRef.current = loadRows
    loadRows()
  }, [loadRows])

  /** The next screenful, appended rather than everything above it fetched again. */
  const showMore = () => {
    const offset = rows.length
    shown.current = offset + PAGE_SIZE
    requestRows(() => fetchRows(offset, PAGE_SIZE), (answer) => setRows((prev) => appendRows(prev, answer.rows)))
  }


  // Filtering and ordering happen in the database. Doing either here would page through
  // the wrong set - the first screenful of unreviewed pages is not the unreviewed pages
  // of the first screenful.
  const pages = rows

  const actionClass = buttonClass({ variant: 'outline', size: 'xs' })
  // New pages run the dataset's phases, so adding them asks for what running those does.
  const ungrantedPhase = job === null ? undefined
    : PHASE_CHOICES.find(([key]) => job[`run_${key}`] && !can(PHASE_CAPABILITY[key]))?.[1]
  const canAppend = canOwn && !active && !ungrantedPhase

  // Map jobs have no transcriptions, so a .txt only rides along for text datasets.
  const acceptRe = isMap ? /\.(jpe?g|png|tiff?|bmp|webp)$/i : /\.(jpe?g|png|tiff?|bmp|webp|pdf|txt)$/i

  const addFiles = async (list: FileList | File[]) => {
    const files = Array.from(list).filter((f) => acceptRe.test(f.name))
    if (!files.some((f) => !/\.txt$/i.test(f.name))) {
      setError('no image or PDF files in drop')
      return
    }
    setError(null)
    setUpload({ loaded: 0, total: files.reduce((sum, f) => sum + f.size, 0) })
    try {
      await uploadPages(jobId, files, (loaded, total) => setUpload({ loaded, total }), addAsTest ?? undefined)
      refetch()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setUpload(null)
    }
  }
  // Counted over every page, not the filtered view: a selection made before switching
  // filter still decides which bulk actions apply.
  const known = (id: number) => seenRows.current.get(id)
  const selectedDeleted = [...selected].filter((id) => known(id)?.deleted).length
  const selectedPages = useMemo(
    () => [...selected].map(known).filter((p): p is PageSummary => !!p && !p.deleted),
    // seenRows is a ref, so it is the selection changing that matters here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selected, rows])
  const selectedLive = selectedPages.length
  // Nothing left to mark means the button's job is to unmark instead - see bulkLayoutChecked.
  const allChecked = selectedLive > 0 && selectedPages.every((p) => p.layout_checked)
  const allTest = selectedLive > 0 && selectedPages.every((p) => p.is_test)

  const toggleRow = (page: PageSummary, shift: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev)
      // Range runs over the sorted view, which is what the user actually sees.
      const from = anchor === null ? -1 : pages.findIndex((p) => p.id === anchor)
      const to = pages.findIndex((p) => p.id === page.id)
      if (shift && from !== -1 && to !== -1) {
        const [lo, hi] = from < to ? [from, to] : [to, from]
        for (let i = lo; i <= hi; i++) next.add(pages[i].id)
        return next
      }
      if (next.has(page.id)) next.delete(page.id)
      else next.add(page.id)
      return next
    })
    if (!shift) setAnchor(page.id)
  }

  // One phase over the ticked pages - the ones layout found nothing on, usually. The
  // dataset is queued once, and a page the phase has nothing to do on is reported rather
  // than failing the rest.
  const runOnSelection = async (phase: PagePhase) => {
    try {
      const outcome = await runPagesPhase(jobId, phase, selectedPages.map((p) => p.id))
      setSelected(new Set())
      refetch()
      const [first] = outcome.skipped
      setNotice(`${PHASE_LABELS[phase]} queued for ${outcome.pages} page`
        + `${outcome.pages === 1 ? '' : 's'}`
        + `${first ? `. ${outcome.skipped.length} left alone: ${first.reason}` : '.'}`)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const bulkDelete = async (deleted: boolean) => {
    try {
      await setPagesDeleted(jobId, [...selected], deleted)
      // The rows leave the current filter, so a selection pointing at them would only
      // arm actions on pages the user can no longer see.
      setSelected(new Set())
      refetch()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  // Marking a selection that is already fully marked used to be a click that did nothing,
  // so it undoes instead. A partial selection still only ever marks: the unmarked pages
  // flip and the already-marked ones are left alone, since "finish the rest" is what
  // picking a mixed range means - toggling each page individually would undo half of it.
  const bulkLayoutChecked = async () => {
    const next = !allChecked
    const targets = selectedPages.filter((p) => p.layout_checked !== next)
    // Every page is waited for, so the table reloads with the ones that did save even
    // when another was refused.
    const outcomes = await Promise.allSettled(targets.map((p) => setPageLayoutChecked(p.id, next)))
    refetch()
    const refused = outcomes.find((o): o is PromiseRejectedResult => o.status === 'rejected')
    if (refused) setError((refused.reason as Error).message)
  }

  // As with the layout flag: a selection already all test pages is unmarked instead.
  const markTest = async (pageIds: number[] | null, test: boolean) => {
    try {
      const counts = await markTestPages(jobId, pageIds, test)
      setJob((j) => (j ? { ...j, new_pages_test: counts.new_pages_test } : j))
      refetch()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const onCancel = async () => {
    try {
      await cancelJob(jobId)
      refetch()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  // Building the zip takes as long as the job is large, so the button says so and stops
  // taking clicks; anything the server refuses is reported here like any other action.
  // `fused` picks the variant, and each variant tracks its own busy state so one running
  // export does not blank out the other button's label.
  const downloadMasks = async (fused: boolean) => {
    const setBusy = fused ? setDownloadingFullMaps : setDownloadingMasks
    setBusy(true)
    setError(null)
    try {
      await downloadMaskSet(jobId, fused)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  // The preview opens on the first page rather than on an empty panel telling you to
  // hover something. Once a page is chosen it stays chosen, so moving the mouse away
  // does not empty the pane you were reading from.
  useEffect(() => {
    if (hoverId !== null) return
    const first = pages.find(previewable)
    if (first) previewPage(first, true)
    // Only ever seeds; `pages` changing under a filter must not steal a chosen page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages.length, hoverId])

  // Arrow keys walk the previewed page down the visible list, so a volume can be looked
  // through without a click each. The table's own rows stay the thing that opens a page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      const target = e.target as HTMLElement | null
      if (target && /input|textarea|select/i.test(target.tagName)) return
      const shown = pages.filter(previewable)
      if (!shown.length) return
      const at = shown.findIndex((p) => p.id === hoverId)
      const next = shown[Math.min(shown.length - 1, Math.max(0, at + (e.key === 'ArrowDown' ? 1 : -1)))]
      if (!next || next.id === hoverId) return
      e.preventDefault()
      previewPage(next, true)
      document.querySelector(`[data-page-row="${next.id}"]`)?.scrollIntoView({ block: 'nearest' })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (!job) {
    // A dataset that is gone, or was never this caller's to see, comes back as a bare
    // "Not Found" from the API - which on an otherwise empty page tells nobody anything.
    const missing = error === 'Not Found'
    return (
      <div className={widePageShell}>
        {error ? (
          <div className="text-sm">
            <p className="text-danger">
              {missing
                ? 'That dataset does not exist, or it is not shared with you.'
                : error}
            </p>
            <Link to="/" className="mt-2 inline-block text-accent-ink underline underline-offset-2">
              Back to the datasets
            </Link>
          </div>
        ) : (
          <p className="text-sm text-ink-subtle">Loading…</p>
        )}
      </div>
    )
  }

  const hoverPage = hoverId === null ? null : seenRows.current.get(hoverId) ?? null


  const badge = (text: string) => (
    <span className="rounded bg-ok/10 px-1.5 py-0.5 text-[11px] font-medium text-ok">
      {text}
    </span>
  )
  const ratioBadge = (checked: number, total: number, title?: string) =>
    total > 0 ? (
      <span
        title={title}
        className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${
          checked === total
            ? 'bg-ok/10 text-ok'
            : 'text-ink-muted'
        }`}
      >
        {checked}/{total}
      </span>
    ) : null

  const pageHref = (page: PageSummary) => `/jobs/${jobId}/${isMap ? 'tiles' : 'pages'}/${page.id}`

  const renderCell = (key: SortKey, page: PageSummary) => {
    switch (key) {
      case 'idx':
        return <span className="text-ink-muted">{page.idx + 1}</span>
      case 'filename':
        return (
          <span className="inline-flex max-w-full items-center gap-1.5">
            {/* The row opens the page on a click; the name is the way in by keyboard. */}
            <Link to={pageHref(page)} onClick={(e) => e.stopPropagation()}
                  className={`truncate hover:underline ${page.deleted ? 'line-through' : ''}`}>
              {page.filename}
            </Link>
            {page.status === 'duplicate' && (
              <Badge data-testid="page-duplicate" className="shrink-0"
                     title="The same scan as another page here - not counted, nothing to review">
                duplicate
              </Badge>
            )}
            {page.status === 'unreadable' && (
              <Badge data-testid="page-unreadable" tone="danger" className="shrink-0"
                     title="Ingest could not read this scan - not counted, nothing to review">
                unreadable
              </Badge>
            )}
            <NoteTag note={page.note} title={page.filename} canEdit={canEdit} onSave={async (text) => {
              const note = await setPageNote(page.id, text)
              refetch()
              return note
            }} />
            <PresenceAvatars entries={onPage(page.id)} />
          </span>
        )
      case 'dimensions':
        return (
          <span className="text-ink-muted">
            {page.width && page.height ? `${page.width} × ${page.height}` : '-'}
          </span>
        )
      case 'status':
        return page.deleted ? (
          <span className="rounded bg-raised px-1.5 py-0.5 text-[11px] font-medium text-ink-muted">
            deleted
          </span>
        ) : (
          <span className="text-ink-muted">{page.status}</span>
        )
      case 'layout':
        return page.layout_checked ? badge(isMap ? 'reviewed' : 'complete') : null
      case 'checked':
        // Lines, whatever the dataset is shaped like: this column is about text that was
        // read and reviewed, and a region is neither. How the boxes stand is on hover.
        return ratioBadge(page.lines_reviewed, page.lines_total, noLayout ? undefined
          : `${page.elements_checked}/${page.elements_total} regions with every line reviewed`)
      case 'regions': {
        // A plain count: maps are reviewed per tile (the Reviewed column), not shape by
        // shape. An empty cell keeps reading as "nobody has touched this tile".
        const total = page.regions_total ?? 0
        return total > 0 ? (
          <span className="rounded px-1.5 py-0.5 text-[11px] font-medium text-ink-muted">
            {total}
          </span>
        ) : null
      }
      case 'confidence':
        return page.min_confidence !== null ? (
          <span className="inline-flex items-center gap-1">
            <span title="Worst line on the page"
                  className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${confBadgeClass(page.min_confidence)}`}>
              {Math.round(page.min_confidence * 100)}%
            </span>
            <span title="Average over the page's lines"
                  className={`rounded border px-1.5 py-0.5 text-[11px] font-medium ${confOutlineClass(page.avg_confidence)}`}>
              ø {Math.round((page.avg_confidence ?? 0) * 100)}%
            </span>
          </span>
        ) : (
          <span className="text-ink-subtle">-</span>
        )
      case 'test':
        return canOwn ? (
          <button
            data-testid="page-test"
            aria-pressed={page.is_test}
            aria-label={`Test page: ${page.filename}`}
            title={page.is_test ? 'Test page - click to let training use it again' : 'Click to make this a test page'}
            onClick={(e) => {
              e.stopPropagation()
              markTest([page.id], !page.is_test)
            }}
            className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${page.is_test
              ? 'bg-accent-wash text-accent-ink' : 'text-ink-subtle hover:bg-raised hover:text-ink'}`}
          >
            {page.is_test ? 'test' : 'no'}
          </button>
        ) : page.is_test ? (
          <Badge data-testid="page-test" title={TEST_PAGE_MEANING}>test</Badge>
        ) : null
      case 'llm': {
        const models = page.llm_models ?? 0
        return models > 0 ? (
          <span
            data-testid="page-llm-models"
            title={`${models} language model${models === 1 ? '' : 's'} have read this page`}
            className="rounded bg-accent-wash px-1.5 py-0.5 text-[11px] font-medium text-accent-ink"
          >
            {models}
          </span>
        ) : null
      }
    }
  }

  return (
    <div
      className={widePageShell}
      onDragEnter={(e) => {
        if (!canAppend || !e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        dragDepth.current++
        setDragging(true)
      }}
      onDragOver={(e) => {
        if (dragging) e.preventDefault()
      }}
      onDragLeave={() => {
        if (!dragging) return
        dragDepth.current--
        if (dragDepth.current <= 0) {
          dragDepth.current = 0
          setDragging(false)
        }
      }}
      onDrop={(e) => {
        if (!dragging) return
        e.preventDefault()
        dragDepth.current = 0
        setDragging(false)
        addFiles(e.dataTransfer.files)
      }}
    >
      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-accent/10">
          <div className="rounded-md border-2 border-dashed border-accent bg-surface px-6 py-4 text-sm font-medium text-accent-ink shadow-lg">
            Drop to add pages to "{job.name}"
          </div>
        </div>
      )}
      <header className="mb-3 border-b border-line pb-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <h1 className="font-serif text-lg font-semibold">{job.name}</h1>
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-ink-subtle">
            <input
              type="checkbox"
              checked={job.checked}
              onChange={(e) => {
                const checked = e.target.checked
                setJob((p) => (p ? { ...p, checked } : p))
                setJobChecked(jobId, checked).catch((err: Error) => setError(err.message))
              }}
              className="cursor-pointer accent-accent"
            />
            checked
          </label>
          <StatusBadge status={job.status} />
          <span data-testid="job-review-count" className="text-xs text-ink-subtle">
            {job.pages_checked}/{(isMap ? job.tiles_total : job.pages_live) ?? 0}{' '}
            {isMap ? 'tiles reviewed' : 'pages with every line reviewed'}
          </span>
          {(job.counters.gt_total ?? 0) > 0 && (
            <span
              className="text-xs text-ink-subtle"
              title="Transcription lines matched to recognized lines"
            >
              transcriptions {job.counters.gt_matched ?? 0}/{job.counters.gt_total}
            </span>
          )}
          <span className="text-xs text-ink-subtle" title="Owner">
            {job.owner}
          </span>
          {!isMap && (
            <TestDataControls
              testPages={chipCounts['test-pages'] ?? 0}
              pages={job.pages_live ?? 0}
              newPagesTest={job.new_pages_test ?? false}
              canOwn={canOwn}
              onSwitch={(on) => {
                setJob((p) => (p ? { ...p, new_pages_test: on } : p))
                setNewPagesTest(jobId, on).catch((err: Error) => setError(err.message))
              }}
              onMarkAll={(test) => markTest(null, test)}
            />
          )}
          <NoteTag note={job.note} title={job.name} canEdit={canEdit} addable onSave={async (text) => {
            const note = await setJobNote(jobId, text)
            setJob((p) => (p ? { ...p, note } : p))
            return note
          }} />
          <div className="ml-auto flex items-center gap-2">
            {!isMap && (
              <Link
                to={`/jobs/${jobId}/transcript`}
                title="Read the recognized text in order - reviewed lines in full ink"
                className={buttonClass({ variant: 'outline', size: 'sm' })}
              >
                Transcript
              </Link>
            )}
            {!isMap && (
              <Link
                to={`/jobs/${jobId}/corpus`}
                data-testid="corpus-open"
                title="Cut a transcribed corpus across the pages and read them against it"
                className={buttonClass({ variant: 'outline', size: 'sm' })}
              >
                Corpus
              </Link>
            )}
            {!isMap && (
            <div className="flex items-center overflow-hidden rounded border border-warn/40">
              <button
                onClick={startReview}
                disabled={!review?.total}
                title="Walk every unchecked line below the confidence threshold"
                className="px-2.5 py-1 text-sm font-medium text-warn hover:bg-warn/10 disabled:cursor-default disabled:text-ink-subtle disabled:hover:bg-transparent"
              >
                {review ? `Review ${review.total} flagged` : 'Review…'}
              </button>
              <select
                value={maxConf}
                onChange={(e) => {
                  const next = Number(e.target.value)
                  setMaxConf(next)
                  setReviewConf(next)
                }}
                title="Confidence threshold"
                className="cursor-pointer border-l border-warn/40 bg-transparent py-1 pl-1.5 pr-0.5 text-xs text-warn"
              >
                {REVIEW_THRESHOLDS.map((t) => (
                  <option key={t} value={t}>
                    &lt;{Math.round(t * 100)}%
                  </option>
                ))}
              </select>
            </div>
            )}
            {/* Re-running the dataset is its owner's call, like running a phase on its
                pages, and a permission per phase on top: the button is there for an owner
                who may run at least one of them - and the dialog offers only those. A
                read-only account is refused every write before its capabilities are
                looked at, so a capability it was given draws nothing. */}
            {canOwn && uploading && (
              <Button
                data-testid="start-job"
                onClick={() => startJob(jobId).then(refetch).catch((e: Error) => setError(e.message))}
                title="This dataset was uploaded in parts and waits for the rest. Start it once every part is in."
              >
                Start processing
              </Button>
            )}
            {canEdit && canOwn && !active && !uploading && !isMap
              && ['pipeline.layout', 'pipeline.lines', 'pipeline.ocr'].some(can) && (
              <Button onClick={() => setRerunOpen(true)}>Re-run</Button>
            )}
            {isAdmin && active && (
              <button
                onClick={onCancel}
                className="rounded border border-warn/40 px-2.5 py-1 text-sm text-warn hover:bg-warn/10"
              >
                Cancel
              </button>
            )}
            {canEdit && can('pipeline.ocr') && !active && !uploading && !isMap && reocrCount > 0 && (
              <Button
                onClick={() => reocr(jobId).then(refetch).catch((e: Error) => setError(e.message))}
                title="Re-read the text of edited or newly drawn lines"
              >
                Re-read {reocrCount} line{reocrCount === 1 ? '' : 's'}
              </Button>
            )}
            {canEdit && !isMap && (
              <Button onClick={() => { setLlmPages(undefined); setLlmOpen(true) }}
                      data-testid="llm-read-open"
                      title="Have language models transcribe the pages, then match their reading to the lines">
                Transcribe with LLMs
              </Button>
            )}
            {/* Owner or admin, like the agreement settings it applies; shown once readings
                are on file, since there is nothing to settle before. */}
            {!isMap && (
              <Button onClick={() => setClassesOpen(true)} data-testid="layout-classes"
                      title="The layout classes of this dataset: names, colours, which are containers">
                Layout classes
              </Button>
            )}
            {canOwn && !isMap && (llmStatus?.done ?? 0) > 0 && (
              <Button onClick={() => setSettleOpen(true)} data-testid="llm-settle-again"
                      title="Match the readings already on file again under the dataset's agreement rules - no model is asked">
                Re-apply LLM agreement
              </Button>
            )}
            {canOwn && !isMap && (llmStatus?.done ?? 0) > 0 && (
              <Button onClick={() => setRemoveReadingsOpen(true)} data-testid="remove-readings"
                      title="Delete this dataset's language model readings, from every model or one">
                Remove LLM readings
              </Button>
            )}
            {canEdit && can('pipeline.lines') && !active && !isMap && !!stale?.elements && (
              <Button onClick={() => setRedetectOpen(true)} title="Re-detect lines for boxes whose geometry changed">
                Re-detect lines ({stale.elements})
              </Button>
            )}
            {isAdmin && !active && !!purgeable?.files && (
              <Button variant="danger" onClick={() => setPurgeOpen(true)}
                      title="Delete the image files of deleted pages">
                Purge {purgeable.pages}
              </Button>
            )}
            {isMap ? (
              <>
                {isAdmin && !active && (
                  <Button
                    onClick={() => setRepredictOpen(true)}
                    title="Re-run the segmentation model, keeping any annotations you edited"
                  >
                    Re-predict
                  </Button>
                )}
                {/* Only polylines are stroked; a polygon job's masks are filled areas, so
                    the width would steer nothing there. Hidden from viewers, who cannot
                    PATCH the job - an input that always 403s is worse than no input. */}
                {lineJob && canEdit && (
                  <label
                    className="flex items-center gap-1.5 text-sm text-ink-muted"
                    title="Stroke width in pixels traced lines are rasterized with in exported masks. The JSON sidecar always keeps the exact coordinates."
                  >
                    Line width
                    <input
                      data-testid="job-line-width"
                      type="number"
                      min={1}
                      max={25}
                      step={1}
                      value={widthDraft}
                      onChange={(e) => setWidthDraft(e.target.value)}
                      onBlur={commitLineWidth}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') e.currentTarget.blur()
                      }}
                      className="w-14 rounded border border-line-strong bg-surface px-1.5 py-1 text-sm text-ink focus-visible:border-accent focus:outline-none"
                    />
                  </label>
                )}
                {/* The title lives on the wrapper: a disabled button takes no pointer
                    events, so its own tooltip would never appear — and "why is this off"
                    is exactly what needs saying then. */}
                <span title={job.tiles_reviewed
                  ? 'Download class-index mask PNGs + geometry JSON for reviewed tiles'
                  : 'Nothing to export yet - mark tiles reviewed in the tile editor first'}>
                  <Button
                    size="xs"
                    disabled={!job.tiles_reviewed || downloadingMasks}
                    onClick={() => downloadMasks(false)}
                  >
                    {downloadingMasks ? 'Preparing…' : 'Masks (zip)'}
                  </Button>
                </span>
                {/* Only a job that cut its own tiles can put them back: tiles uploaded
                    ready-made carry no source map to fuse them into. */}
                {job.run_tile && (
                  <span title={job.tiles_reviewed
                    ? 'Download one mask per source map, reviewed tiles stitched back into place'
                    : 'Nothing to export yet - mark tiles reviewed in the tile editor first'}>
                    <Button
                      size="xs"
                      disabled={!job.tiles_reviewed || downloadingFullMaps}
                      onClick={() => downloadMasks(true)}
                    >
                      {downloadingFullMaps ? 'Preparing…' : 'Full maps (zip)'}
                    </Button>
                  </span>
                )}
                {isAdmin && (
                  <Button onClick={() => setMaskOpen(true)} title="Write the mask set to a directory on the server">
                    Export to server
                  </Button>
                )}
              </>
            ) : (
              <div className="relative">
                <Button
                  {...menuTrigger(exportOpen)}
                  onClick={(e) => {
                    e.stopPropagation()
                    setExportOpen((v) => !v)
                  }}
                >
                  Export
                </Button>
                {exportOpen && (
                  <div className={`absolute right-0 top-full z-10 mt-1 w-40 overflow-hidden ${popoverChrome}`}>
                    {EXPORT_FORMATS.map((f) => (
                      <a
                        key={f}
                        href={exportUrl(jobId, f)}
                        target="_blank"
                        rel="noreferrer"
                        onClick={() => setExportOpen(false)}
                        className="block px-2.5 py-1.5 text-sm text-ink hover:bg-accent-wash hover:text-accent-ink"
                      >
                        {f}
                      </a>
                    ))}
                    <div className="border-t border-line px-2.5 py-1 text-[10px] uppercase tracking-wide text-ink-subtle">
                      reviewed only
                    </div>
                    {EXPORT_FORMATS.map((f) => (
                      <a
                        key={`${f}-reviewed`}
                        href={exportUrl(jobId, f, true)}
                        target="_blank"
                        rel="noreferrer"
                        onClick={() => setExportOpen(false)}
                        className="block px-2.5 py-1.5 text-sm text-ink hover:bg-accent-wash hover:text-accent-ink"
                      >
                        {f} · reviewed
                      </a>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
        <div className="mt-1.5">
          <PhaseStrip job={job} />
        </div>
        {job.error && <p className="mt-2 text-sm text-danger">{job.error}</p>}
        {!!job.unreadable?.length && <UnreadablePages pages={job.unreadable} />}
        {error && <p className="mt-2 text-sm text-danger">{error}</p>}
        {notice && (
          <p data-testid="job-notice" className="mt-2 text-sm text-ink-muted">
            {notice}
          </p>
        )}
      </header>
      {rerunOpen && (
        <RerunDialog jobId={jobId} jobName={job.name} layoutOn={job.run_layout} onClose={() => setRerunOpen(false)}
                     onDone={refetch} onError={setError} />
      )}
      {repredictOpen && (
        <RepredictDialog jobId={jobId} onClose={() => setRepredictOpen(false)}
                         onDone={refetch} onError={setError} />
      )}
      {addOpen && (
        <AddPagesDialog jobId={jobId} isMap={isMap} onClose={() => setAddOpen(false)} onAdded={refetch} onError={setError} />
      )}
      {redetectOpen && stale && (
        <RedetectDialog
          jobId={jobId}
          stale={stale}
          autoRedetect={job.auto_redetect}
          onAutoRedetect={(v) => setJob((j) => (j ? { ...j, auto_redetect: v } : j))}
          onClose={() => setRedetectOpen(false)}
          onDone={refetch}
          onError={setError}
        />
      )}
      {llmOpen && (
        <LlmReadDialog
          jobId={jobId}
          pageIds={llmPages}
          pageCount={job.pages_live ?? 0}
          selected={job.llm_model_ids ?? []}
          consensusMin={job.llm_consensus_min ?? 2}
          autocheck={job.llm_autocheck ?? false}
          consensusWithOcr={job.llm_consensus_with_ocr ?? false}
          prompt={job.llm_prompt ?? ''}
          canOwn={canOwn}
          onClose={() => setLlmOpen(false)}
          onStarted={(outcome) => {
            pollLlm()
            refetch()
            // Nothing queued means every page was already read: the progress strip has
            // nothing to show, so without this the click looks like it did nothing.
            if (outcome.queued === 0) {
              setNotice(outcome.reused > 0
                ? `Nothing new to read - ${outcome.reused} reading${outcome.reused === 1 ? '' : 's'} `
                  + 'already on file, now on this dataset\'s lines.'
                : 'Nothing to read - this dataset has no pages a model can be sent.')
            }
          }}
          onError={setError}
        />
      )}
      {purgeOpen && (
        <PurgeDialog jobId={jobId} onClose={() => setPurgeOpen(false)} onPurged={refetch} onError={setError} />
      )}
      {classesOpen && (
        <LayoutClassesDialog jobId={jobId} canEdit={canEdit} onClose={() => setClassesOpen(false)} onChanged={refetch} />
      )}
      {removeReadingsOpen && (
        <RemoveReadingsDialog jobId={jobId} onClose={() => setRemoveReadingsOpen(false)}
                              onRemoved={() => { refetch(); pollLlm() }} onError={setError} />
      )}
      {settleOpen && (
        <SettleAgainDialog jobId={jobId} consensusMin={job.llm_consensus_min ?? 2}
                           autocheck={job.llm_autocheck ?? false}
                           consensusWithOcr={job.llm_consensus_with_ocr ?? false}
                           onClose={() => setSettleOpen(false)} onSettled={refetch} onError={setError} />
      )}
      {maskOpen && (
        <MaskExportDialog jobId={jobId} canFuse={!!job.run_tile} onClose={() => setMaskOpen(false)}
                          onError={setError} />
      )}
      {llmStatus && (llmStatus.active || llmStatus.error > 0) && !llmDismissed && (
        <div data-testid="llm-progress"
             className="mb-4 flex flex-wrap items-center gap-3 rounded border border-line p-3 text-sm">
          <span className="font-medium">Language models</span>
          {/* A run over two pages of fifty reports 2/2, which reads as the whole dataset
              having been transcribed. The denominator says otherwise. */}
          <span data-testid="llm-progress-scope" className="text-xs text-ink-muted">
            of {llmStatus.pages} page{llmStatus.pages === 1 ? '' : 's'} in this dataset
          </span>
          {llmStatus.models.map((model) => (
            <span key={model.id} data-testid="llm-progress-model" data-label={model.label}
                  className="text-ink-muted">
              {model.label} {model.done}/{model.done + model.pending + model.running + model.error}
              {/* Finished is all the count says, so without this a page being read right
                  now looks exactly like one nothing is happening to. */}
              {model.running > 0 && (
                <span className="text-accent-ink">
                  {' '}· {model.running} being read
                </span>
              )}
              {model.error > 0 && (
                <span className="text-danger"> · {model.error} failed</span>
              )}
            </span>
          ))}
          {llmStatus.errors.map((failure) => (
            <span key={`${failure.label}-${failure.error}`} data-testid="llm-progress-error"
                  data-label={failure.label}
                  className="text-xs text-danger">{failure.error}</span>
          ))}
          {llmStatus.active && (
            <Button size="xs" data-testid="llm-cancel"
                    onClick={() => cancelLlmRead(jobId).then(pollLlm).catch((e: Error) => setError(e.message))}>
              Cancel what is not sent
            </Button>
          )}
          <button
            onClick={() => setLlmDismissed(true)}
            data-testid="llm-progress-dismiss"
            title="Hide this until the next run"
            aria-label="Dismiss"
            className="ml-auto rounded px-1 text-ink-subtle hover:text-ink"
          >
            ×
          </button>
        </div>
      )}
      {selected.size > 0 && !active && (
        <div className="mb-2 flex flex-wrap items-center gap-2 rounded-md border border-accent bg-accent-wash px-3 py-2 text-sm">
          <span className="font-medium text-accent-ink">{selected.size} selected</span>
          <button onClick={() => setSelected(new Set())} className={actionClass}>
            Clear
          </button>
          {canEdit && !isMap && selectedLive > 0 && (
            <button
              data-testid="bulk-llm-read"
              className={actionClass}
              onClick={() => {
                setLlmPages(selectedPages.map((p) => p.id))
                setLlmOpen(true)
              }}
            >
              Transcribe with LLMs
            </button>
          )}
          {canEdit && canOwn && !isMap && selectedLive > 0 && (
            <>
              {can('pipeline.lines') && (
                <button data-testid="bulk-run-lines" className={actionClass}
                        onClick={() => runOnSelection('lines')}
                        title="Detect the lines on these pages again">
                  Detect lines
                </button>
              )}
              {can('pipeline.ocr') && (
                <button data-testid="bulk-run-ocr" className={actionClass}
                        onClick={() => runOnSelection('ocr')}
                        title="Read the text of these pages again, leaving checked lines alone">
                  Re-read text
                </button>
              )}
            </>
          )}
          {canOwn && !isMap && selectedLive > 0 && (
            <button data-testid="bulk-test-pages" className={actionClass}
                    onClick={() => markTest(selectedPages.map((p) => p.id), !allTest)}>
              {allTest ? 'Unmark test pages' : 'Mark as test pages'}
            </button>
          )}
          {selectedLive > 0 && (
            <button onClick={bulkLayoutChecked} data-testid="bulk-layout-checked" className={actionClass}>
              {isMap
                ? (allChecked ? 'Mark unreviewed' : 'Mark reviewed')
                : (allChecked ? 'Mark layout incomplete' : 'Mark layout complete')}
            </button>
          )}
          {canEdit && selectedDeleted > 0 && (
            <button onClick={() => bulkDelete(false)} className={actionClass}>
              Restore {selectedDeleted}
            </button>
          )}
          {canEdit && selectedLive > 0 && (
            <button
              onClick={() => bulkDelete(true)}
              className="rounded border border-line-strong px-2 py-1 text-xs font-medium text-danger hover:border-danger"
            >
              Delete
            </button>
          )}
        </div>
      )}
      <div className="flex gap-4">
      <div className="min-w-0 flex-1">
      {(job.pages_live ?? 0) > 0 && (
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          {filters.map((f) => {
            const count = chipCounts[f.key] ?? 0
            const active = filter.key === f.key
            // An empty Deleted or No-layout chip is noise on the datasets that have
            // neither, but both have to stay put while one is the selected filter.
            if (count === 0 && !active && (f.key === 'deleted' || f.key === 'no-layout' || f.key === 'test-pages')) return null
            return (
              <button
                key={f.key}
                data-testid={`page-filter-${f.key}`}
                onClick={() => setFilter(f.key)}
                className={`rounded-full border px-2.5 py-0.5 text-xs ${
                  active
                    ? 'border-accent bg-accent-wash font-medium text-accent-ink'
                    : 'border-line text-ink-muted hover:border-line-strong'
                }`}
              >
                {f.label} · {count}
              </button>
            )
          })}
          <div className="relative ml-auto">
            <button
              data-testid="page-columns"
              {...menuTrigger(columnsOpen)}
              onClick={(e) => {
                e.stopPropagation()
                setColumnsOpen((v) => !v)
              }}
              className="rounded-full border border-line px-2.5 py-0.5 text-xs text-ink-subtle hover:text-ink"
            >
              Columns
            </button>
            {columnsOpen && (
              <div
                onClick={(e) => e.stopPropagation()}
                className={`absolute right-0 top-full z-20 mt-1 w-48 ${popoverChrome} p-1`}
              >
                {available.map((col) => (
                  <label
                    key={col.key}
                    className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs text-ink-muted hover:bg-accent-wash hover:text-ink"
                  >
                    <input
                      type="checkbox"
                      id={`page-col-${col.key}`}
                      checked={!hiddenColumns.includes(col.key)}
                      onChange={() => {
                        const next = hiddenColumns.includes(col.key)
                          ? hiddenColumns.filter((k) => k !== col.key)
                          : [...hiddenColumns, col.key]
                        setHiddenColumns(next)
                        saveHiddenColumns(next)
                      }}
                      className="accent-accent"
                    />
                    {col.label}
                  </label>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
      {pages.length === 0 ? (
        <p className="text-sm text-ink-subtle">No pages yet.</p>
      ) : (
        <div className={`overflow-hidden ${cardChrome}`}>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-ink-subtle">
                <th className="select-none px-3 py-2 font-medium">
                  <input
                    type="checkbox"
                    aria-label="Select every page shown"
                    checked={pages.length > 0 && selected.size === pages.length}
                    ref={(el) => {
                      if (el) el.indeterminate = selected.size > 0 && selected.size < pages.length
                    }}
                    onChange={(e) =>
                      setSelected(e.target.checked ? new Set(pages.map((p) => p.id)) : new Set())
                    }
                    className="cursor-pointer accent-accent"
                  />
                </th>
                <th className="px-3 py-2 font-medium">Image</th>
                {columns.map((col) => (
                  <th
                    key={col.key}
                    onClick={() => toggleSort(col.key)}
                    title={col.title}
                    aria-sort={sort.key === col.key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}
                    className={`cursor-pointer select-none px-3 py-2 font-medium ${
                      sort.key === col.key ? 'text-accent-ink' : ''
                    }`}
                  >
                    {col.label} {sort.key === col.key ? (sort.dir === 1 ? '↑' : '↓') : ''}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pages.map((page) => (
                <tr
                  key={page.id}
                  data-page-row={page.id}
                  onClick={() => navigate(pageHref(page))}
                  onMouseEnter={() => previewPage(page)}
                  style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 65px' }}
                  className={`cursor-pointer border-b border-line/60 last:border-b-0 hover:bg-raised ${
                    page.deleted ? 'opacity-50' : ''
                  } ${page.id === hoverId ? 'bg-accent-wash' : ''}`}
                >
                  <td className="select-none px-3 py-1">
                    <Check
                      aria-label={`Select ${page.filename}`}
                      checked={selected.has(page.id)}
                      onChange={() => undefined}
                      onClick={(e) => {
                        e.stopPropagation()
                        if (e.shiftKey) window.getSelection()?.removeAllRanges()
                        toggleRow(page, e.shiftKey)
                      }}
                      className="cursor-pointer"
                    />
                  </td>
                  <td className="px-3 py-1">
                    {/* A duplicate or an unreadable scan is never ingested, so it has no rendition. */}
                    {page.deleted || isUncounted(page) ? (
                      <div className="h-14 w-10 rounded-sm bg-raised" />
                    ) : page.status === 'pending' ? (
                      <div className="h-14 w-10 animate-pulse rounded-sm bg-raised" />
                    ) : (
                      <img
                        key={`${page.id}-${page.status}`}
                        src={renditionUrl(page.id, 'thumb', page.rotation)}
                        alt={page.filename}
                        width={thumbWidth(page)}
                        height={56}
                        loading="lazy"
                        className="h-14 w-auto rounded-sm bg-raised object-contain"
                      />
                    )}
                  </td>
                  {columns.map((col) => (
                    <td
                      key={col.key}
                      data-col={col.key}
                      className={col.key === 'filename' ? 'max-w-0 truncate px-3 py-1' : 'px-3 py-1'}
                    >
                      {renderCell(col.key, page)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {matched > pages.length && (
        <div className="mt-2 flex items-center justify-center gap-3 text-xs text-ink-subtle">
          <span data-testid="page-count">Showing {pages.length} of {matched}</span>
          <Button size="xs" data-testid="page-more" disabled={rowsLoading} onClick={showMore}>
            Show more
          </Button>
        </div>
      )}
      {upload && <div className="mt-3"><UploadProgress progress={upload} /></div>}
      {canOwn && !active && !upload && (
        <button
          data-testid="add-pages"
          disabled={!canAppend}
          onClick={() => fileInput.current?.click()}
          className="mt-3 w-full rounded-md border-2 border-dashed border-line-strong px-3 py-3 text-sm text-ink-muted hover:border-accent hover:text-accent-ink disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-line-strong disabled:hover:text-ink-muted"
        >
          + Add pages - drop scans anywhere or click to browse
          {isAdmin && (
            <span
              onClick={(e) => {
                e.stopPropagation()
                setAddOpen(true)
              }}
              className="ml-2 text-xs underline underline-offset-2 hover:text-accent-ink"
            >
              from server path
            </span>
          )}
        </button>
      )}
      {canOwn && !active && !upload && !isMap && (
        <label className="mt-1 flex cursor-pointer items-center justify-center gap-1.5 text-xs text-ink-muted">
          <input type="checkbox" data-testid="add-as-test" checked={addAsTest ?? job.new_pages_test ?? false}
                 onChange={(e) => setAddAsTest(e.target.checked)} className="cursor-pointer accent-accent" />
          Add as test pages
        </label>
      )}
      {canOwn && !active && ungrantedPhase && (
        <p data-testid="add-pages-locked" className="mt-1 text-center text-xs text-ink-muted">
          Adding pages runs {ungrantedPhase} on them, which you have not been granted.
        </p>
      )}
      <input
        ref={fileInput}
        type="file"
        multiple
        accept={isMap ? 'image/*' : 'image/*,application/pdf,.pdf,.txt,text/plain'}
        className="hidden"
        onChange={(e) => {
          if (e.target.files?.length) addFiles(e.target.files)
          e.target.value = ''
        }}
      />
      </div>
      <aside className="hidden w-[30rem] shrink-0 xl:block">
        <div className={`sticky top-6 overflow-hidden ${cardChrome} shadow-sm`}>
          {hoverId !== null ? (
            <div
              className="relative w-full"
              style={{ aspectRatio: hoverPage?.width && hoverPage?.height ? `${hoverPage.width} / ${hoverPage.height}` : '2 / 3' }}
            >
              <img src={renditionUrl(hoverId, 'screen', hoverPage?.rotation)} alt=""
                   className="block h-full w-full object-fill" />
              <CopyImageButton url={renditionUrl(hoverId, 'screen', hoverPage?.rotation)} onError={setError}
                               className="absolute right-1.5 top-1.5 z-10" />
              {preview && !isMap && (
                <svg viewBox="0 0 1 1" preserveAspectRatio="none" className="absolute inset-0 h-full w-full">
                  {preview.elements
                    .filter((e) => e.kind !== 'orphan')
                    .map((e) => (
                      <rect
                        key={e.id}
                        x={e.bbox[0]}
                        y={e.bbox[1]}
                        width={e.bbox[2] - e.bbox[0]}
                        height={e.bbox[3] - e.bbox[1]}
                        fill="transparent"
                        stroke={classColor(e.class_name)}
                        strokeWidth={1.25}
                        strokeDasharray={e.kind === 'container' ? '4 3' : undefined}
                        vectorEffect="non-scaling-stroke"
                      />
                    ))}
                </svg>
              )}
              {preview && isMap && (
                <svg viewBox="0 0 1 1" preserveAspectRatio="none" className="absolute inset-0 h-full w-full">
                  {(preview.regions ?? []).map((r) => {
                    // A traced line is an open path with nothing to fill.
                    const line = r.kind === 'polyline'
                    const color = regionColor(r)
                    const pts = (ring: typeof r.points) => ring.map((p) => `${p[0]},${p[1]}`).join('L')
                    return (
                      <path
                        key={r.id}
                        d={line
                          ? 'M' + pts(r.points)
                          : [r.points, ...r.holes].map((ring) => 'M' + pts(ring) + 'Z').join(' ')}
                        fillRule="evenodd"
                        fill={line ? 'none' : color}
                        fillOpacity={line ? undefined : 0.3}
                        stroke={color}
                        strokeWidth={line ? 2 : 1.25}
                        strokeLinejoin="round"
                        vectorEffect="non-scaling-stroke"
                      />
                    )
                  })}
                </svg>
              )}
            </div>
          ) : (
            <div className="flex h-72 items-center justify-center px-4 text-center text-sm text-ink-subtle">
              Nothing to preview yet
            </div>
          )}
        </div>
      </aside>
      </div>
    </div>
  )
}


function UnreadablePages({ pages }: { pages: UnreadablePage[] }) {
  const one = pages.length === 1
  return (
    <div data-testid="unreadable-pages" className="mt-2 text-sm text-danger">
      <p>
        {one ? 'One file' : `${pages.length} files`} could not be read as an image and {one ? 'was' : 'were'} left
        out - delete {one ? 'it' : 'them'} and upload a readable copy.
      </p>
      <ul className="ml-4 list-disc">
        {pages.map((page) => <li key={page.id}>{page.error}</li>)}
      </ul>
    </div>
  )
}


/** How much of the dataset is test data, and for its owner the switch and the dataset-wide
 *  marking. Test pages are never trained on, nor any page with the same scan. */
function TestDataControls({ testPages, pages, newPagesTest, canOwn, onSwitch, onMarkAll }: {
  testPages: number
  pages: number
  newPagesTest: boolean
  canOwn: boolean
  onSwitch: (on: boolean) => void
  onMarkAll: (test: boolean) => void
}) {
  const [open, setOpen] = useState(false)
  const state = testPages === 0 ? 'none' : testPages === pages && newPagesTest ? 'whole' : 'some'
  const summary = state === 'none' ? 'none' : state === 'whole' ? 'whole dataset' : `${testPages} of ${pages} pages`
  if (!canOwn) {
    return state !== 'none' && (
      <span data-testid="job-test-pages" className="text-xs text-ink-subtle" title={TEST_PAGE_MEANING}>
        Test data: {summary}
      </span>
    )
  }
  return (
    <>
      <Button size="xs" data-testid="job-test-pages" onClick={() => setOpen(true)} title={TEST_PAGE_MEANING}>
        Test data: {summary}
      </Button>
      {open && (
        <TestDataDialog
          state={state}
          testPages={testPages}
          onClose={() => setOpen(false)}
          onSave={(next) => {
            setOpen(false)
            if (next === 'whole') onMarkAll(true)
            else if (next === 'none') onMarkAll(false)
            else if (newPagesTest) onSwitch(false)
          }}
        />
      )}
    </>
  )
}

type TestDataState = 'none' | 'some' | 'whole'

function TestDataDialog({ state, testPages, onClose, onSave }: {
  state: TestDataState
  testPages: number
  onClose: () => void
  onSave: (next: TestDataState) => void
}) {
  const [choice, setChoice] = useState<TestDataState>(state)
  const choices: [TestDataState, string][] = [
    ['none', 'No test pages'],
    ...(state === 'some' ? [['some', `Keep the ${testPages} test page${testPages === 1 ? '' : 's'} marked now`] as [TestDataState, string]] : []),
    ['whole', 'The whole dataset, including pages added later'],
  ]
  return (
    <Modal title="Test data" onClose={onClose}>
      <p className="mb-3 text-sm text-ink-muted">
        Test pages are kept out of every training run, so a model can be scored on pages it
        never saw. Pages with the same scan as a test page are kept out of training too.
      </p>
      <fieldset className="mb-3 space-y-1.5" data-testid="test-data-choice">
        {choices.map(([value, label]) => (
          <label key={value} className="flex cursor-pointer items-center gap-2 text-sm text-ink">
            <input type="radio" name="test-data" value={value} checked={choice === value}
                   onChange={() => setChoice(value)} className="accent-accent" />
            {label}
          </label>
        ))}
      </fieldset>
      {choice === 'none' && testPages > 0 && (
        <p className="mb-3 text-sm text-warn" data-testid="test-data-unmark-warning">
          Training may then use the {testPages} page{testPages === 1 ? '' : 's'} marked now.
        </p>
      )}
      <p className="mb-4 text-xs text-ink-muted">
        Single pages: click a row's Test cell, select rows and choose Mark as test pages, or
        switch Test page in the page viewer.
      </p>
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className={modalBtn}>Cancel</button>
        <button onClick={() => onSave(choice)} disabled={choice === state} className={`${modalPrimaryBtn} disabled:opacity-40`}>
          Save
        </button>
      </div>
    </Modal>
  )
}
