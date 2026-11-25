import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import {
  bulkMove, bulkPreview, bulkRedetect, bulkReocr, bulkRerun, cancelJob, changeFolder, createGroup, deleteGroup,
  deleteJob, downloadMaskSet, getNewerModels, getUserNames, isTileTask, listGroups, listJobs, renameGroup,
  setJobNote,
} from '../api'
import type { BulkAction, BulkOutcome, BulkPreview, Folder, Group, Job, NewerModelOffer } from '../api'
import { useAuth } from '../auth'
import { useSettings } from '../settings'
import { JobActions, menuItem } from '../components/job/JobActions'
import { DatasetSidebar } from '../components/job/DatasetSidebar'
import { useIsNarrow } from '../hooks/useMediaQuery'
import { DROP_LIT, useDatasetDrag } from '../components/job/datasetDrag'
import type { DropTarget } from '../components/job/datasetDrag'
import { FolderDialog } from '../components/job/FolderDialogs'
import type { FolderAction } from '../components/job/FolderDialogs'
import { ancestry, filedIn, flatten, folderTree, itselfAndBelow } from '../components/job/folders'
import type { FolderNode } from '../components/job/folders'
import { AccessStack, reachOf } from '../components/job/AccessStack'
import { COLUMNS, DEFAULT_COLUMNS, NAME_MIN, columnWidths, columnsForWidth, loadColumns,
  phasesOf, saveColumns }
  from '../components/job/columns'
import { MembersDialog } from '../components/job/MembersDialog'
import type { MembersTarget } from '../components/job/MembersDialog'
import { TransferDialog } from '../components/job/TransferDialog'
import type { TransferTarget } from '../components/job/TransferDialog'
import { MapSettingsDialog } from '../components/job/MapSettingsDialog'
import { NewerModelsDialog } from '../components/job/NewerModelsDialog'
import { GroupSettingsDialog } from '../components/job/GroupSettingsDialog'
import { MoveToGroupDialog } from '../components/job/MoveToGroupDialog'
import {
  groupSize, inListOrder, memberCount, newDatasetIn, newDatasetTitle, takesNewDatasets, workspaceKind,
} from '../components/job/groups'
import { sharedPrefix } from '../components/job/sharedPrefix'
import { PresenceAvatars } from '../components/presence/PresenceAvatars'
import { AppFooter } from '../components/AppFooter'
import { StatusBadge } from '../components/StatusBadge'
import { Button, GroupButton, buttonClass } from '../components/ui/Button'
import { Check } from '../components/ui/Field'
import { NoteTag } from '../components/NoteTag'
import { TestDataChip } from '../components/TestPage'
import { CaretIcon, CheckIcon, FilterIcon, FolderIcon, FolderPlusIcon, KebabIcon, LockIcon, PlusIcon }
  from '../components/icons'
import { ActionMenu } from '../components/job/ActionMenu'
import { useDropPlacement } from '../components/ui/dropPlacement'
import { menuTrigger, useDismiss } from '../components/ui/menu'
import { Modal } from '../components/Modal'
import { Badge, chipClass } from '../components/ui/Badge'
import type { Tone } from '../components/ui/Badge'
import { usePresence } from '../presence'
import { STATUS_TONE, compactCount, isBusy, overallProgress } from '../util'
import { useAutoClear } from '../messages'
import { usePolling } from '../hooks/usePolling'
import { reaches } from '../lib/roles'
import { cardChrome, popoverChrome } from '../components/ui/Card'

const RAIL_KEY = 'deeplabel.rail-collapsed'

const CARD_GRID = 'grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3'

/** What stands in for the list until the first response lands. The page used to render
 *  nothing at all while it waited, which reads as an empty account rather than as loading. */
function JobCardSkeletons() {
  return (
    <div className={CARD_GRID} data-testid="jobs-skeleton" aria-hidden>
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <div key={i}
             className={`flex animate-pulse flex-wrap items-center gap-x-3 gap-y-1 ${cardChrome} px-3 py-2`}>
          <div className="h-4 min-w-40 flex-1 rounded bg-raised" />
          <div className="h-1.5 flex-1 rounded-full bg-raised" />
        </div>
      ))}
    </div>
  )
}

// The stripe down a row's left edge says the same thing as its badge, from the one
// place both read - they had drifted, calling a queued job amber here and grey there.
const STATUS_ACCENT: Record<Tone, string> = {
  neutral: 'border-l-line-strong',
  accent: 'border-l-accent',
  ok: 'border-l-ok',
  warn: 'border-l-warn',
  danger: 'border-l-danger',
  test: 'border-l-test',
  note: 'border-l-note',
}

// Each stage progresses in its natural unit: layout review happens per page, text review
// per line. A map job runs neither line detection nor OCR, so its ocr bar was a
// permanently empty 0/0 pointing at a filter that matches no tile - it gets the review
// bar alone until these tasks grow an OCR phase of their own.
function AnnotationProgress({ job }: { job: Job }) {
  // Two bars, told apart by weight rather than by a word: layout is the preliminary pass
  // and reads muted, the text review is the one that matters and takes the accent. The
  // column heading says "Reviewed" for both; each bar's own title says which it is.
  const bar = (done: number, total: number, muted = false) => (
    <div className="h-1.5 min-w-4 flex-1 overflow-hidden rounded-full bg-raised">
      <div className={`h-full ${muted ? 'bg-line-strong' : 'bg-accent'}`}
           style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
    </div>
  )
  const tiles = isTileTask(job.task)
  const pages = job.pages_total ?? 0
  const lines = job.lines_total ?? 0
  const segment = 'flex min-w-0 flex-1 items-center gap-1.5 rounded px-0.5 hover:bg-raised'
  // A text dataset shows two of these side by side, and the column is 200px. The words
  // "layout" and "ocr" cost about sixty of them and say what the column heading already
  // says, so they go; a map dataset has one segment, room to spare, and no heading of its
  // own for what the single bar means, so it keeps its word.
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 text-[11px] text-ink-subtle">
      <Link
        to={`/jobs/${job.id}?filter=layout-unchecked`}
        title={`${job.layout_checked_pages ?? 0} of ${pages} ${tiles ? 'tiles' : 'pages'} reviewed`}
        data-testid="layout-progress-link"
        className={segment}
      >
        {/* Same pages.layout_checked column either way, but a map job's tiles have no
            layout to check - the flag means "reviewed" there, as the job page labels it. */}
        {tiles && <span className="shrink-0">reviewed</span>}
        {bar(job.layout_checked_pages ?? 0, pages, !tiles)}
        <span className="shrink-0 whitespace-nowrap text-right">
          {compactCount(job.layout_checked_pages ?? 0)}/{compactCount(pages)}
        </span>
      </Link>
      {!tiles && (
        <Link
          to={`/jobs/${job.id}?filter=unreviewed-lines`}
          title={`${job.lines_done ?? 0} of ${lines} lines reviewed`}
          data-testid="ocr-progress-link"
          className={segment}
        >
          {bar(job.lines_done ?? 0, lines)}
          <span className="shrink-0 whitespace-nowrap text-right">
            {compactCount(job.lines_done ?? 0)}/{compactCount(lines)}
          </span>
        </Link>
      )}
    </div>
  )
}

function RunningProgress({ job }: { job: Job }) {
  return (
    <div className="flex flex-1 items-center gap-2">
      <div className="h-1.5 min-w-4 flex-1 overflow-hidden rounded-full bg-raised">
        <div className="h-full bg-accent"
             style={{ width: `${overallProgress(job.counters, job) * 100}%` }} />
      </div>
      <span className="min-w-14 text-right text-[11px] text-ink-subtle">
        {job.phase ?? job.status}
      </span>
    </div>
  )
}

const nf = (n: number) => n.toLocaleString()
const fold = (s: string) =>
  s.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')

/** A section is a project, an owner, or the whole list. */
type SectionKey = number | string
type ListSection = { key: SectionKey; title: string; rows: Job[]; group?: Group }

type GroupBy = 'group' | 'owner' | 'none'
const GROUP_BYS: { key: GroupBy; label: string }[] = [
  { key: 'group', label: 'Group by workspace' },
  { key: 'owner', label: 'Group by owner' },
  { key: 'none', label: 'No grouping' },
]

type SortKey = 'name' | 'newest' | 'pages' | 'least'
const SORTS: { key: SortKey; label: string }[] = [
  { key: 'name', label: 'Name' },
  { key: 'newest', label: 'Newest first' },
  { key: 'pages', label: 'Most pages' },
  { key: 'least', label: 'Least reviewed' },
]

/** The preview's keys come from the per-dataset previews the backend already had, whose
 *  names are short for the dialog they were written for. */
const PREVIEW_LABEL: Record<string, string> = {
  lines: 'Lines waiting to be read',
  unchecked: 'Lines to read again',
  checked: 'Checked lines, left alone',
  corrected: 'Corrections discarded',
  layout_checked: 'Pages marked layout complete',
  elements_edited: 'Hand-edited boxes',
  elements: 'Boxes to re-detect in',
  pages: 'Pages',
  hand_edited: 'Hand-drawn lines replaced',
}

/** Which datasets a run leaves alone and why, once per reason: "job is already queued or
 *  running: Volume 3, Volume 7; no unchecked lines to re-read: Volume 9". */
function leftAloneReasons(blocked: BulkPreview['blocked']): string {
  const names = new Map<string, string[]>()
  for (const { name, reason } of blocked) names.set(reason, [...(names.get(reason) ?? []), name])
  return [...names].map(([reason, named]) => `${reason}: ${named.join(', ')}`).join('; ')
}

const BULK_LABEL: Record<BulkAction, string> = {
  reocr: 'Re-read OCR', rerun: 'Re-run', redetect: 'Re-detect lines',
}

/** What a run over a selection is called and where it starts from. Alignment is a re-run
 *  from its own phase - it re-matches transcriptions and keeps the OCR - so it is the same
 *  request with different words rather than a fourth endpoint. */
const RUNS: { key: BulkAction; phase?: string; label: string }[] = [
  { key: 'reocr', label: 'Re-read OCR…' },
  { key: 'rerun', phase: 'ocr', label: 'Re-run…' },
  { key: 'rerun', phase: 'align', label: 'Alignment…' },
  { key: 'redetect', label: 'Re-detect lines…' },
]

export function JobsPage() {
  const { user, isAdmin, canEdit, role } = useAuth()
  const { onJob } = usePresence()
  const navigate = useNavigate()
  const [jobs, setJobs] = useState<Job[] | null>(null)
  const [groups, setGroups] = useState<Group[]>([])
  const [groupsFailed, setGroupsFailed] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useAutoClear(error, setError)
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const [infoJob, setInfoJob] = useState<string | null>(null)
  // Folded sections live with the account, so a list tidied here opens tidy elsewhere -
  // and locally too, so a click folds at once rather than after a round trip.
  const { collapsedGroups, save: saveSettings } = useSettings()
  const [collapsed, setCollapsed] = useState<Set<SectionKey>>(
    () => new Set(collapsedGroups))
  const [creatingGroup, setCreatingGroup] = useState(false)
  const [groupDraft, setGroupDraft] = useState('')
  const [renamingGroup, setRenamingGroup] = useState<number | null>(null)
  const [moveJob, setMoveJob] = useState<Job | null>(null)
  const [mapSettingsJob, setMapSettingsJob] = useState<Job | null>(null)
  const [newerFor, setNewerFor] = useState<{ job: Job; offers: NewerModelOffer[] } | null>(null)
  const [membersOf, setMembersOf] = useState<MembersTarget | null>(null)
  const [transferOf, setTransferOf] = useState<TransferTarget | null>(null)
  const [settingsGroup, setSettingsGroup] = useState<Group | null>(null)
  const [folderAction, setFolderAction] = useState<FolderAction | null>(null)

  // What is on screen is in the address, so a filtered list can be sent to someone and
  // the back button walks back through it. Written with replace, because typing in the
  // search box should not fill the history with one entry per keystroke.
  const [params, setParams] = useSearchParams()
  const param = useCallback(
    (key: string, value: string | null, fallback: string) => {
      setParams((prev) => {
        const next = new URLSearchParams(prev)
        if (value === null || value === fallback) next.delete(key)
        else next.set(key, value)
        return next
      }, { replace: true })
    }, [setParams])

  // The search box keeps its own value so typing is not a render of 600 rows per
  // keystroke waiting on a history write; the address catches up once typing stops.
  const urlQuery = params.get('q') ?? ''
  const [query, setQueryNow] = useState(urlQuery)
  const queryWrite = useRef<number | undefined>(undefined)
  useEffect(() => {
    // Arriving by link or by the back button, the box takes what the address says.
    setQueryNow(urlQuery)
  }, [urlQuery])
  const setQuery = (value: string) => {
    setQueryNow(value)
    window.clearTimeout(queryWrite.current)
    queryWrite.current = window.setTimeout(() => param('q', value, ''), 250)
  }
  const onlyMine = params.get('mine') === '1'
  const needsReview = params.get('review') === '1'
  const onlyTest = params.get('test') === '1'
  const completeness = params.get('complete')
  const scope = params.get('group')
  const folderScope = scope !== null && params.get('folder') ? Number(params.get('folder')) : null
  const setScope = (value: string | null, folderId?: number) => setParams((prev) => {
    const next = new URLSearchParams(prev)
    if (value === null) next.delete('group')
    else next.set('group', value)
    if (folderId === undefined) next.delete('folder')
    else next.set('folder', String(folderId))
    return next
  }, { replace: true })
  const sort = (SORTS.some((o) => o.key === params.get('sort'))
    ? params.get('sort') : 'name') as SortKey
  const setSort = (value: SortKey) => param('sort', value, 'name')
  const groupBy = (GROUP_BYS.some((g) => g.key === params.get('by'))
    ? params.get('by') : 'group') as GroupBy
  const setGroupBy = (value: GroupBy) => param('by', value, 'group')
  const asUser = params.get('as') ?? ''
  const setAsUser = (value: string) => param('as', value, '')
  // What narrows the list goes; how it is laid out (view, sort, grouping) stays.
  const clearFilters = () => {
    window.clearTimeout(queryWrite.current)
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      for (const key of ['q', 'mine', 'review', 'test', 'complete', 'group', 'folder', 'as']) next.delete(key)
      return next
    }, { replace: true })
  }
  const view = params.get('view') === 'cards' ? 'cards' : 'table'
  const setView = (value: 'table' | 'cards') => param('view', value, 'table')
  const [columns, setColumns] = useState<string[]>(loadColumns)
  // Per browser, like the column picker: how much room one person gives the rail is not
  // everyone's business, and /api/settings is shared - see the note on collapsed groups.
  const narrow = useIsNarrow()
  const [drawer, setDrawer] = useState(false)
  const [railShut, setRailShutState] = useState(
    () => localStorage.getItem(RAIL_KEY) === '1')
  const setRailShut = (shut: boolean) => {
    setRailShutState(shut)
    try {
      localStorage.setItem(RAIL_KEY, shut ? '1' : '0')
    } catch {
      // A private window. It reopens expanded, which is the safe way round.
    }
  }
  const [people, setPeople] = useState<string[]>([])
  const [toolbarMenu, setToolbarMenu] = useState<'columns' | 'sort' | 'groupby' | 'filter' | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [pending, setPending] = useState<
    { action: BulkAction; phase?: string; ids: string[]; label: string
      preview: BulkPreview | null } | null>(null)
  const [groupMenu, setGroupMenu] = useState<SectionKey | null>(null)
  const [movePicker, setMovePicker] = useState(false)
  const [listWidth, setListWidth] = useState(0)
  const groupPlacement = useDropPlacement(groupMenu !== null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)

  const refresh = useCallback(() => {
    // An older backend may not send the group fields yet; degrade instead of crashing.
    listJobs()
      .then((rows) => {
        setJobs(rows.map((j) => ({ ...j, shared_with: j.shared_with ?? [], group_id: j.group_id ?? null })))
        // A dataset deleted elsewhere leaves the selection, or every bulk action 404s on it.
        const listed = new Set(rows.map((j) => j.id))
        setSelected((prev) => [...prev].every((id) => listed.has(id))
          ? prev : new Set([...prev].filter((id) => listed.has(id))))
      })
      .catch((e: Error) => setError(e.message))
    listGroups()
      .then((next) => {
        setGroups(next)
        setGroupsFailed(false)
      })
      .catch((e: Error) => {
        setGroupsFailed(true)
        setError(`Could not load the workspaces: ${e.message}`)
      })
  }, [])

  // A model changed by hand is offered the same way a new default is: the steps it ran
  // with the old one can be run again now.
  const offerNewer = (job: Job) => {
    refresh()
    getNewerModels(job.id)
      .then((r) => { if (r.offers.length) setNewerFor({ job, offers: r.offers }) })
      .catch(() => undefined)
  }

  usePolling(refresh, 5000)

  // The columns divide the width they are given, so the width has to be measured.
  useEffect(() => {
    const el = listRef.current
    if (!el) return
    const measure = () => setListWidth(el.clientWidth)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const [downloadMenu, setDownloadMenu] = useState<string | null>(null)
  // The job whose mask zip is being built. The menu is gone by then, so the trigger says so.
  const [preparing, setPreparing] = useState<string | null>(null)

  // A map job's masks come from an endpoint that can refuse (nothing reviewed yet), so this
  // fetches and saves the blob instead of linking - a link would replace the SPA with the
  // error page. Text exports stay plain anchors; they answer for any finished job.
  const downloadMasks = async (jobId: string, fused: boolean) => {
    setDownloadMenu(null)
    setPreparing(jobId)
    setError(null)
    try {
      await downloadMaskSet(jobId, fused)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setPreparing(null)
    }
  }

  useDismiss(
    openMenu !== null || downloadMenu !== null || infoJob !== null
      || toolbarMenu !== null || groupMenu !== null || movePicker,
    () => {
      setOpenMenu(null)
      setDownloadMenu(null)
      setInfoJob(null)
      setToolbarMenu(null)
      setGroupMenu(null)
      setMovePicker(false)
    },
  )

  // The lens: the list as one person sees it - what they reach by the same rules the
  // access column draws, and the groups the backend would list for them. Admins reach
  // everything, so asking about one answers nothing.
  const viewer = asUser || user
  const viewerIsAdmin = isAdmin && !asUser
  const reached = useMemo(() => {
    const all = jobs ?? []
    if (!asUser) return { jobs: all, groups }
    const lensJobs = all.filter((j) => reachOf(j, groups.find((g) => g.id === j.group_id))
      .some((r) => r.username === asUser))
    const lensGroups = groups.filter((g) => g.sandbox_of === asUser || g.shared_with.includes(asUser)
      || lensJobs.some((j) => j.group_id === g.id))
    return { jobs: lensJobs, groups: lensGroups }
  }, [jobs, groups, asUser])
  // A group's count is what its caller can see; through the lens that is the person
  // looked at, while group-wide actions keep counting what the admin would change.
  const sidebarGroups = useMemo(() => asUser
    ? reached.groups.map((g) => ({
      ...g, count: reached.jobs.filter((j) => j.group_id === g.id).length }))
    : groups, [reached, groups, asUser])

  const visible = useMemo(() => {
    let rows = reached.jobs
    if (scope === 'review') rows = rows.filter((j) => (j.lines_done ?? 0) < (j.lines_total ?? 0))
    else if (scope === 'ungrouped') rows = rows.filter((j) => j.group_id === null)
    else if (scope !== null) rows = rows.filter((j) => j.group_id === Number(scope))
    const scopedGroup = folderScope !== null ? groups.find((g) => g.id === Number(scope)) : undefined
    if (scopedGroup) {
      const within = itselfAndBelow(scopedGroup.folders ?? [], folderScope!)
      rows = rows.filter((j) => within.has(filedIn(j, scopedGroup) ?? -1))
    }
    if (onlyMine) rows = rows.filter((j) => j.owner === viewer)
    if (needsReview) rows = rows.filter((j) => (j.lines_done ?? 0) < (j.lines_total ?? 0))
    if (onlyTest) rows = rows.filter((j) => (j.test_pages ?? 0) > 0)
    if (completeness !== null) rows = rows.filter((j) => j.checked === (completeness === '1'))
    const terms = fold(query).split(/\s+/).filter(Boolean)
    if (terms.length) {
      const named = (j: Job) => fold(`${j.name} ${groups.find((g) => g.id === j.group_id)?.name ?? ''}`)
      rows = rows.filter((j) => terms.every((t) => named(j).includes(t)))
    }
    const by: Record<SortKey, (a: Job, b: Job) => number> = {
      name: (a, b) => a.name.localeCompare(b.name, 'de'),
      newest: (a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''),
      pages: (a, b) => (b.pages_total ?? 0) - (a.pages_total ?? 0),
      least: (a, b) =>
        (a.lines_total ? (a.lines_done ?? 0) / a.lines_total : 1) -
        (b.lines_total ? (b.lines_done ?? 0) / b.lines_total : 1),
    }
    return [...rows].sort(by[sort])
  }, [reached, groups, scope, folderScope, onlyMine, needsReview, onlyTest, completeness, query, sort, viewer])

  const narrowing = query.trim() !== '' || onlyMine || needsReview || onlyTest || completeness !== null
  const filtering = narrowing || scope !== null

  /** The list's sections, whatever it is divided by. A project section carries the group
   *  itself, because renaming, sharing and running belong to the group and not to the
   *  heading; an owner section has no such object and gets the plain header. */
  const sections = useMemo<{ key: number | string; title: string; rows: Job[]; group?: Group }[]>(() => {
    if (groupBy === 'none') return [{ key: 'all', title: '', rows: visible }]
    if (groupBy === 'owner') {
      const byOwner = new Map<string, Job[]>()
      for (const job of visible) byOwner.set(job.owner, [...(byOwner.get(job.owner) ?? []), job])
      return [...byOwner.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([owner, rows]) => ({ key: `owner:${owner}`, title: owner, rows }))
    }
    const byGroup = new Map<number | null, Job[]>()
    for (const job of visible) {
      const key = job.group_id ?? null
      byGroup.set(key, [...(byGroup.get(key) ?? []), job])
    }
    const placed: ListSection[] = inListOrder(reached.groups, viewer)
      .map((group) => ({ key: group.id as SectionKey, title: group.name,
                         rows: byGroup.get(group.id) ?? [], group }))
      .filter(({ rows, group }) =>
        rows.length > 0 || (!filtering && (group!.sandbox_of
          ? group!.sandbox_of === viewer
          : viewerIsAdmin || group!.shared_with.includes(viewer))))
    const others = placed.filter(({ group }) => workspaceKind(group!, viewer) === 'other-sandbox')
    const out = placed.filter((s) => !others.includes(s))
    // Datasets given to someone on their own come without their workspace, which they do not belong to.
    const loose = byGroup.get(null) ?? []
    if (loose.length > 0) out.push({ key: 'ungrouped', title: 'Shared with you', rows: loose })
    // A workspace the list could not load still holds its datasets, and they stay on screen.
    // Workspaces that are only slower to answer than the datasets are not called not loaded.
    const listed = new Set(reached.groups.map((g) => g.id))
    const unlisted = visible.filter((j) => j.group_id !== null && !listed.has(j.group_id))
    if (groupsFailed && unlisted.length > 0) {
      out.push({ key: 'unlisted', title: 'Workspaces not loaded', rows: unlisted })
    }
    return [...out, ...others]
  }, [visible, reached, groupBy, viewerIsAdmin, viewer, filtering, groupsFailed])

  const reviewCount = useMemo(
    () => reached.jobs.filter((j) => (j.lines_done ?? 0) < (j.lines_total ?? 0)).length,
    [reached])

  // The picked columns, minus the ones this window cannot hold. `listWidth` is the
  // table's own room, which is what decides whether a column fits - the rail folding is
  // as much a change to that as the window resizing.
  const shown = columnsForWidth(COLUMNS.filter((c) => columns.includes(c.key)), listWidth)
  const { widths, overflows } = columnWidths(shown, listWidth)

  // Folding is a casual click and saving rewrites the whole settings document, so a burst
  // of folding is written once when it stops rather than once per section.
  const savingFolds = useRef<number | undefined>(undefined)
  const toggleSection = (key: SectionKey) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      window.clearTimeout(savingFolds.current)
      savingFolds.current = window.setTimeout(
        () => void saveSettings(
          { collapsed_groups: [...next].filter(
            (k): k is number | 'ungrouped' | `folder:${number}` =>
              typeof k === 'number' || k === 'ungrouped' || /^folder:\d+$/.test(k)) }),
        400)
      return next
    })

  const onDelete = async (job: Job) => {
    if (!confirm(`Delete dataset "${job.name}" and all its data?`)) return
    try {
      await deleteJob(job.id)
      refresh()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const onCancel = async (job: Job) => {
    try {
      await cancelJob(job.id)
      refresh()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const submitGroup = async () => {
    const name = groupDraft.trim()
    setCreatingGroup(false)
    setGroupDraft('')
    if (!name) return
    try {
      await createGroup(name)
      refresh()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const saveGroupRename = async (group: Group) => {
    const name = groupDraft.trim()
    setRenamingGroup(null)
    setGroupDraft('')
    if (!name || name === group.name) return
    try {
      await renameGroup(group.id, name)
      refresh()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const onDeleteGroup = async (group: Group) => {
    setError(null)
    const held = group.count ?? 0
    if (held > 0) {
      const them = held === 1 ? 'it' : 'them'
      setError(`"${group.name}" still holds ${held} dataset${held === 1 ? '' : 's'}. `
        + `Only an empty workspace can be deleted: move ${them} out or delete ${them} first.`)
      return
    }
    if (!confirm(`Delete workspace "${group.name}"?`)) return
    try {
      await deleteGroup(group.id)
      refresh()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const toggleColumn = (key: string) => {
    setColumns((prev) => {
      const next = prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
      saveColumns(next)
      return next
    })
  }

  const toggleSelected = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const selectMany = (ids: string[]) =>
    setSelected((prev) => {
      const next = new Set(prev)
      const allOn = ids.every((id) => next.has(id))
      for (const id of ids) {
        if (allOn) next.delete(id)
        else next.add(id)
      }
      return next
    })

  // Running models is a Manager's: offered where the person manages at least one of the
  // datasets, and refused as a whole, naming the dataset, where they do not manage them all.
  const managesAny = (ids: Iterable<string>) => {
    const wanted = new Set(ids)
    return (jobs ?? []).some((j) => wanted.has(j.id) && reaches(j.my_role, 'manager'))
  }

  /** Everything a dataset can be asked to do, asked of a selection instead. The cost is
   *  looked up first so the confirmation says what it will actually run, not "are you
   *  sure": over 44 datasets the difference between 12,480 lines and none is the
   *  difference between a considered click and a gamble. */
  const askBulk = async (action: BulkAction, ids: string[], label: string, phase?: string) => {
    setOpenMenu(null)
    setGroupMenu(null)
    if (!ids.length) return
    setPending({ action, phase, ids, label, preview: null })
    try {
      const fromPhase = action === 'rerun' ? phase ?? 'ocr' : undefined
      setPending({ action, phase, ids, label, preview: await bulkPreview(ids, action, fromPhase) })
    } catch (e) {
      setPending(null)
      setError((e as Error).message)
    }
  }

  /** A bulk action changes what it may and names the rest, as "2 moved; 1 skipped: …". */
  const reportSkipped = (outcome: BulkOutcome, done: string) => {
    if (!outcome.skipped.length) return
    setError(`${outcome.changed.length} ${done}; ${outcome.skipped.length} skipped: ` +
             outcome.skipped.map((s) => `${s.name} (${s.reason})`).join(', '))
  }

  // Where datasets may be moved: a group the person belongs to - any, for an admin. Moving
  // opens a dataset to the group's members; the way back is to its creator's Sandbox.
  const moveTargets = groups.filter((g) => !g.sandbox_of && (isAdmin || g.shared_with.includes(user)))

  // Adding people is the workspace's Managers'; a Sandbox dataset's Members explains the move
  // instead. A dataset given to someone alone shows no workspace, so they have nothing to manage.
  const canManageMembers = (job: Job) => {
    const group = groups.find((g) => g.id === job.group_id)
    return !!group && (!!group.sandbox_of || group.can_manage)
  }

  // Handing over is the owner's or an admin's (#79), outside a Sandbox, and needs the list of
  // accounts to pick from, which admins and Managers read.
  const canPickPeople = isAdmin || role === 'manager'
  const canTransferJob = (job: Job) => {
    const group = groups.find((g) => g.id === job.group_id)
    return canPickPeople && (isAdmin || job.owner === user) && !!group && !group.sandbox_of
  }
  const canTransferGroup = (group: Group) => canPickPeople && (isAdmin || group.owner === user) && !group.sandbox_of

  /** The datasets in a run the caller does not manage. Any one of them refuses the whole
   *  request, so they are named before it is sent rather than skipped like a busy one. */
  const notYoursToRun = (ids: string[]): Job[] =>
    ids.map((id) => jobs?.find((j) => j.id === id))
      .filter((job): job is Job => job !== undefined && !reaches(job.my_role, 'manager'))
  const refusedBy = pending ? notYoursToRun(pending.ids) : []
  const leftAlone = pending?.preview?.blocked.filter((b) => !refusedBy.some((j) => j.id === b.id)) ?? []

  const runBulk = async () => {
    if (!pending) return
    const { action, ids, phase } = pending
    setPending(null)
    try {
      const run = action === 'reocr' ? bulkReocr(ids, 'unchecked')
        : action === 'rerun' ? bulkRerun(ids, phase ?? 'ocr')
        : bulkRedetect(ids)
      reportSkipped(await run, 'queued')
      setSelected(new Set())
      refresh()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  /** The bulk bar's Move to workspace... and a drag onto a workspace or a folder are one
   *  request with one report, so a drop is refused exactly as the menu would be. */
  const moveDatasets = async (ids: string[], groupId: number | null, folderId: number | null = null) => {
    setMovePicker(false)
    if (!confirmLeavingPeople(ids, groupId)) return
    try {
      reportSkipped(await bulkMove(ids, groupId, folderId), 'moved')
      setSelected((prev) => new Set([...prev].filter((id) => !ids.includes(id))))
      refresh()
    } catch (e) {
      setError((e as Error).message)
    }
  }
  const moveSelection = (groupId: number | null, folderId: number | null = null) =>
    moveDatasets([...selected], groupId, folderId)

  /** A Sandbox is private: a dataset moved into one is taken from the people given it on
   *  its own, so they are named before it happens. */
  const confirmLeavingPeople = (ids: string[], groupId: number | null): boolean => {
    const intoSandbox = groupId === null || !!groups.find((g) => g.id === groupId)?.sandbox_of
    const losing = ids.map((id) => jobs?.find((j) => j.id === id))
      .filter((j): j is Job => !!j && j.shared_with.length > 0 && reaches(j.my_role, 'manager'))
    if (!intoSandbox || losing.length === 0) return true
    return confirm(losing.length === 1
      ? `"${losing[0].name}" was given to ${losing[0].shared_with.join(', ')}. In a Sandbox it is private, `
        + 'so they lose it. Move it anyway?'
      : `${losing.length} of these datasets were given to people on their own. In a Sandbox they are private, `
        + 'so those people lose them. Move them anyway?')
  }
  const moveFolder = async (folder: Folder, target: DropTarget) => {
    try {
      await changeFolder(folder.id, { parent_id: target.folderId ?? null })
      refresh()
    } catch (e) {
      setError((e as Error).message)
    }
  }
  const { dragSource, folderSource, dropZone } = useDatasetDrag(
    selected, canEdit, (ids, target) => void moveDatasets(ids, target.groupId, target.folderId ?? null),
    (folder, target) => void moveFolder(folder, target))

  // A card's three buttons stop their click from reaching the page, which is what shuts
  // the others otherwise - so each one shuts the other two itself.
  const showCardPopover = (which: 'info' | 'download' | 'menu', jobId: string | null) => {
    setInfoJob(which === 'info' ? jobId : null)
    setDownloadMenu(which === 'download' ? jobId : null)
    setOpenMenu(which === 'menu' ? jobId : null)
  }

  const actionsFor = (job: Job) => ({
    job,
    canManage: reaches(job.my_role, 'manager'),
    openInfo: infoJob === job.id,
    openDownload: downloadMenu === job.id,
    openMenu: openMenu === job.id,
    preparing: preparing === job.id,
    onToggleInfo: () => showCardPopover('info', infoJob === job.id ? null : job.id),
    onToggleDownload: () => showCardPopover('download', downloadMenu === job.id ? null : job.id),
    onToggleMenu: () => showCardPopover('menu', openMenu === job.id ? null : job.id),
    onMasks: (fused: boolean) => void downloadMasks(job.id, fused),
    onMove: () => setMoveJob(job),
    onMembers: () => setMembersOf({ kind: 'dataset', job, group: groups.find((g) => g.id === job.group_id) }),
    canManageMembers: canManageMembers(job),
    onTransfer: () => setTransferOf({ kind: 'dataset', id: job.id, name: job.name, owner: job.owner }),
    canTransfer: canTransferJob(job),
    // A map dataset has only its name and tile size left to change; a text one, everything it was made with.
    onSettings: () => (isTileTask(job.task) ? setMapSettingsJob(job) : navigate(`/jobs/${job.id}/settings`)),
    onCancel: () => void onCancel(job),
    onDelete: () => void onDelete(job),
  })

  const nameCell = (job: Job, prefix = '') => (
      <Link to={`/jobs/${job.id}`} title={job.name}
            className="min-w-0 truncate font-medium hover:text-accent-ink">
        {prefix && job.name.startsWith(prefix)
          ? <><span className="font-mono text-xs font-normal text-ink-subtle">{prefix}</span>
              {job.name.slice(prefix.length)}</>
          : job.name}
      </Link>
    )

  const sharedLabel = (job: Job) =>
    job.shared_with.length > 0 && (
      // Worth seeing while scanning the list, unlike the rest of the provenance -
      // who it is shared with is one line down in the Info panel.
      <span title={`Shared with: ${job.shared_with.join(', ')}`}
            className="shrink-0 text-[11px] text-ink-subtle">
        shared with {job.shared_with.length}
      </span>
    )

  const testLabel = (job: Job) => {
    const test = job.test_pages ?? 0
    if (!test) return null
    return (
      test === job.pages_total
        ? <TestDataChip data-testid="test-pages-label">Test set</TestDataChip>
        : <TestDataChip data-testid="test-pages-label" value={`${compactCount(test)}/${compactCount(job.pages_total ?? 0)}`}>
            Test pages
          </TestDataChip>
    )
  }

  const completeLabel = (job: Job) => job.checked && (
    <Badge data-testid="complete-label" title="Marked complete: nothing more to do" tone="ok" icon={<CheckIcon />}>
      Complete
    </Badge>
  )

  const noteTag = (job: Job) => (
    <NoteTag note={job.note} title={job.name} canEdit={canEdit} compact onSave={async (text) => {
      const note = await setJobNote(job.id, text)
      setJobs((rows) => rows && rows.map((j) => (j.id === job.id ? { ...j, note } : j)))
      return note
    }} />
  )

  const cellFor = (job: Job, key: string) => {
    const active = isBusy(job.status)
    switch (key) {
      case 'phases':
        return (
          <span className="inline-flex overflow-hidden rounded border border-line">
            {phasesOf(job).map(({ key: phase, on }) => (
              <span key={phase}
                    title={`${phase} ${on ? 'runs' : 'is off'}`}
                    className={`border-r border-line px-1.5 font-mono text-[10px] leading-4 last:border-r-0 ${
                      on ? 'bg-accent-wash text-accent-ink' : 'text-ink-subtle'}`}>
                {phase}
              </span>
            ))}
          </span>
        )
      case 'pages': return <span className="font-mono text-xs tabular-nums">{nf(job.pages_total ?? 0)}</span>
      case 'lines': return <span className="font-mono text-xs tabular-nums">{nf(job.lines_total ?? 0)}</span>
      case 'unread': {
        const left = (job.lines_total ?? 0) - (job.lines_done ?? 0)
        return <span className="font-mono text-xs tabular-nums">{left ? nf(left) : '-'}</span>
      }
      case 'progress':
        return active ? <RunningProgress job={job} /> : <AnnotationProgress job={job} />
      case 'access':
        return <AccessStack job={job} group={groups.find((g) => g.id === job.group_id)} />
      case 'when':
        return (
          <span className="whitespace-nowrap font-mono text-xs tabular-nums text-ink-subtle">
            {(job.created_at ?? '').slice(0, 10)}
          </span>
        )
      default: return null
    }
  }

  const surface = (job: Job) => (selected.has(job.id) ? 'bg-accent-wash' : 'bg-surface')

  const selectBox = (job: Job) => (
    <Check
      id={`pick-${job.id}`}
      checked={selected.has(job.id)}
      onChange={() => toggleSelected(job.id)}
      aria-label={`Select ${job.name}`}
    />
  )

  const jobRow = (job: Job, prefix = '') => (
    // An explicit background: the name cell pins itself over the scrolled columns and
    // inherits this, and transparent they would show through it.
    <tr key={job.id} data-testid="job-card" data-status={job.status} {...dragSource(job.id)}
        className={`h-9 border-b border-line/60 border-l-4 ${surface(job)} hover:bg-ground ${
          STATUS_ACCENT[STATUS_TONE[job.status]]}`}>
      <td className="w-8 pl-2">{selectBox(job)}</td>
      <td className={`min-w-0 overflow-hidden px-2 ${
          overflows ? 'sticky left-0 z-10 bg-inherit' : ''}`}>
        <div className="flex min-w-0 items-center gap-2">
          {nameCell(job, prefix)}
          {completeLabel(job)}
          {testLabel(job)}
          {noteTag(job)}
          {sharedLabel(job)}
          <PresenceAvatars entries={onJob(job.id)} />
          {job.status !== 'done' && <StatusBadge status={job.status} />}
        </div>
      </td>
      {/* overflow-hidden as the header has: the table is fixed-layout, so a cell whose
          content outgrows its column - a progress bar beside six-figure line counts, an
          access stack of a dozen people - otherwise paints over its neighbour instead of
          being clipped by it. */}
      {shown.map((c) => (
        <td key={c.key} data-col={c.key}
            className={`overflow-hidden px-2 ${c.align === 'right' ? 'text-right' : ''}`}>
          {cellFor(job, c.key)}
        </td>
      ))}
      <td className="w-[116px] px-2">
        <JobActions {...actionsFor(job)} />
      </td>
    </tr>
  )

  const jobCard = (job: Job) => {
    const active = isBusy(job.status)
    return (
      <div key={job.id} data-testid="job-card" data-status={job.status} {...dragSource(job.id)}
           className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-line border-l-4 ${
             surface(job)} px-3 py-2 ${STATUS_ACCENT[STATUS_TONE[job.status]]}`}>
        <div className="flex min-w-40 flex-1 items-center gap-2">
          {selectBox(job)}
          {nameCell(job)}
          <span className="ml-auto flex shrink-0 items-center gap-2">
            {completeLabel(job)}
            {testLabel(job)}
            {noteTag(job)}
            {sharedLabel(job)}
            <PresenceAvatars entries={onJob(job.id)} />
            {job.status !== 'done' && <StatusBadge status={job.status} />}
          </span>
        </div>
        <div className="order-last flex w-full items-center gap-2">
          {active ? <RunningProgress job={job} /> : <AnnotationProgress job={job} />}
        </div>
        <JobActions {...actionsFor(job)} />
      </div>
    )
  }

  const tableHead = (
    <table className="w-full table-fixed border-collapse"
           style={overflows ? { width: overflows } : undefined}>
      <thead>
        <tr className="text-[10px] uppercase tracking-widest text-ink-subtle">
          <th className="w-8" />
          <th className={`px-2 py-1.5 text-left font-semibold ${
                overflows ? 'sticky left-0 z-10 bg-surface' : ''}`}
              style={overflows ? { width: NAME_MIN } : undefined}>Dataset</th>
          {shown.map((c, i) => (
            <th key={c.key} data-col={c.key} style={{ width: widths[i] }}
                className={`overflow-hidden px-2 py-1.5 font-semibold ${
                  c.align === 'right' ? 'text-right' : 'text-left'}`}>
              {c.label}
            </th>
          ))}
          <th className="w-[116px]" />
        </tr>
      </thead>
    </table>
  )

  // What somebody is likely to want back, from the activity the list already carries.
  useEffect(() => {
    // Only an admin is shown the lens, and only an admin may list the accounts.
    if (!isAdmin) return
    getUserNames().then((r) => setPeople(r.users.map((u) => u.username).sort())).catch(() => {})
  }, [isAdmin])

  const recent = useMemo(
    () => reached.jobs
      .filter((j) => j.last_activity)
      .sort((a, b) => (a.last_activity! < b.last_activity! ? 1 : -1))
      .slice(0, 5),
    [reached])

  const sectionRows = (rows: Job[], prefix = '') => (
    <table className="w-full table-fixed border-collapse"
           style={overflows ? { width: overflows } : undefined}>
      <colgroup>
        <col className="w-8" />
        <col style={overflows ? { width: NAME_MIN } : undefined} />
        {shown.map((c, i) => <col key={c.key} style={{ width: widths[i] }} />)}
        <col className="w-[116px]" />
      </colgroup>
      <tbody>{rows.map((job) => jobRow(job, prefix))}</tbody>
    </table>
  )

  const sectionHeader = (key: SectionKey, title: string, count: number, rows: Job[],
                         group?: Group, prefix = '') => {
    const canManage = group?.can_manage ?? false
    // Like Run…, settings go to each dataset in turn, and the ones not yours are named as refused.
    const canSettle = rows.length > 0 && managesAny(rows.map((j) => j.id))
    const zone = group ? dropZone({ groupId: group.id, name: group.name }) : null
    const ground = zone?.lit ? DROP_LIT : 'bg-raised'
    return (
      <div data-testid="section-header" {...zone?.props}
           className={`mb-1 flex items-center gap-2 border-b border-line px-2 py-1 ${ground}`}>
        {/* The group's name travels with the pinned dataset column, so a scrolled-right
            table still says which group these rows belong to. */}
        <div className={`flex items-center gap-2 ${
          overflows ? `sticky left-0 z-10 pr-2 ${zone?.lit ? 'bg-accent-wash' : 'bg-raised'}` : ''}`}>
          <button
            onClick={() => toggleSection(key)}
            aria-expanded={!collapsed.has(key)}
            className="flex items-center gap-1.5 font-serif text-sm font-semibold text-ink hover:text-accent-ink"
          >
            <span className={`inline-block transition-transform ${collapsed.has(key) ? '' : 'rotate-90'}`}>▸</span>
            {renamingGroup === group?.id ? null : title}
          </button>
          {group?.sandbox_of && (
            <span data-testid="sandbox-private" className={chipClass()}
                  title={group.sandbox_of === user ? 'Only you see it' : `Only ${group.sandbox_of} sees it, and admins`}>
              <LockIcon />
              Private
            </span>
          )}
          {prefix && (
            <span data-testid="shared-prefix" title={`Every name here starts with ${prefix}`}
                  className="rounded border border-dashed border-line px-1.5 font-mono text-[10px] text-ink-subtle">
              {prefix}
            </span>
          )}
          {group && renamingGroup === group.id && (
            <input
              autoFocus
              value={groupDraft}
              onChange={(e) => setGroupDraft(e.target.value)}
              onBlur={() => saveGroupRename(group)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveGroupRename(group)
                else if (e.key === 'Escape') setRenamingGroup(null)
              }}
              className="rounded border border-accent bg-ground px-1 py-0.5 text-sm font-semibold focus:outline-none"
            />
          )}
          <span className="whitespace-nowrap text-xs text-ink-subtle">
            {count} dataset{count === 1 ? '' : 's'}
          </span>
          {zone?.hint && (
            <span data-testid="drop-hint" className="whitespace-nowrap text-xs font-medium">
              {zone.hint}
            </span>
          )}
        </div>
        {group && (group.shared_with?.length ?? 0) > 0 && (canManage ? (
          <button data-testid="group-shared" title={`Members: ${group.shared_with.join(', ')}`}
                  onClick={() => setMembersOf({ kind: 'workspace', group })}
                  className="whitespace-nowrap text-xs text-ink-subtle hover:text-accent-ink hover:underline">
            {memberCount(group)}
          </button>
        ) : (
          <span data-testid="group-shared" title={`Members: ${group.shared_with.join(', ')}`}
                className="whitespace-nowrap text-xs text-ink-subtle">
            {memberCount(group)}
          </span>
        ))}
        <span className="ml-auto flex items-center gap-1">
          {group && canEdit && takesNewDatasets(group, user, isAdmin) && (
            <Link to={newDatasetIn(group)} data-testid="new-dataset-in" title={newDatasetTitle(group, user)}
                  aria-label={newDatasetTitle(group, user)} className={buttonClass({ variant: 'ghost', size: 'xs' })}>
              <PlusIcon />
            </Link>
          )}
          {rows.length > 0 && (
            <Button variant="ghost" size="xs" onClick={() => selectMany(rows.map((j) => j.id))}>
              Select all
            </Button>
          )}
          {rows.length > 0 && managesAny(rows.map((j) => j.id)) && (
            // The same actions a dataset offers, aimed at every dataset in this group.
            // It fills the same selection the checkboxes do, so there is one code path.
            <span className="relative">
              <Button variant="ghost" size="xs" data-testid="group-run"
                      {...menuTrigger(groupMenu === key)}
                      title={`Run over all ${rows.length} datasets in this workspace`}
                      onClick={(e) => {
                        e.stopPropagation()
                        setGroupMenu(groupMenu === key ? null : key)
                      }}>
                Run…
              </Button>
              {groupMenu === key && (
                <div ref={groupPlacement.ref}
                     className={`${groupPlacement.className} right-0 z-20 w-44 overflow-hidden ${popoverChrome} py-1`}>
                  {RUNS.map((r) => (
                    <button key={r.label} className={menuItem}
                            onClick={() => void askBulk(
                              r.key, rows.map((j) => j.id),
                              `${title} - all ${rows.length} datasets`, r.phase)}>
                      {r.label}
                    </button>
                  ))}
                </div>
              )}
            </span>
          )}
          {group && canManage && renamingGroup !== group.id && (
            <Button variant="ghost" size="xs" data-testid="folder-new" title={`New folder in ${group.name}`}
                    aria-label={`New folder in ${group.name}`}
                    onClick={() => setFolderAction({ kind: 'new', group, parent: null })}>
              <FolderPlusIcon />
            </Button>
          )}
          {group && renamingGroup !== group.id && (
            <>
              {canManage && (
                <Button variant="ghost" size="xs" data-testid="group-members"
                        onClick={() => setMembersOf({ kind: 'workspace', group })}>
                  Members…
                </Button>
              )}
              {canSettle && (
                <Button variant="ghost" size="xs" data-testid="group-settings"
                        onClick={() => setSettingsGroup(group)}>
                  Settings…
                </Button>
              )}
            </>
          )}
          {group && canManage && renamingGroup !== group.id && (
            <>
              <Button variant="ghost" size="xs" onClick={() => {
                setGroupDraft(group.name)
                setRenamingGroup(group.id)
              }}>
                Rename
              </Button>
              <Button variant="ghost" size="xs" onClick={() => onDeleteGroup(group)}>
                Delete
              </Button>
            </>
          )}
        </span>
      </div>
    )
  }

  // What narrows the list, each with the way to drop it again: shown as chips beside the
  // Filter button, so a filtered list never looks like the whole one.
  const activeFilters = [
    onlyMine && { key: 'mine', label: 'Only mine', clear: () => param('mine', '0', '0') },
    needsReview && { key: 'review', label: 'Needs review', clear: () => param('review', '0', '0') },
    onlyTest && { key: 'test', label: 'Has test data', clear: () => param('test', '0', '0') },
    completeness !== null && {
      key: 'complete', label: completeness === '1' ? 'Complete' : 'In progress',
      clear: () => param('complete', '', ''),
    },
    asUser !== '' && { key: 'as', label: `Visible to ${asUser}`, clear: () => setAsUser('') },
  ].filter((f): f is { key: string; label: string; clear: () => void } => !!f)

  const openToolbarMenu = (name: NonNullable<typeof toolbarMenu>) => (e: React.MouseEvent) => {
    e.stopPropagation()
    setToolbarMenu(toolbarMenu === name ? null : name)
  }
  const filterRow = 'flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs text-ink hover:bg-raised'
  const filterHeading = 'px-2 pb-0.5 pt-1.5 text-[10px] font-medium uppercase tracking-wide text-ink-subtle'
  const joined = 'flex shrink-0 divide-x divide-line-strong rounded border border-line-strong'

  const toolbar = (
    <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2">
      <input
        ref={searchRef}
        id="dataset-search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search datasets"
        aria-label="Search datasets"
        className="h-7 min-w-0 flex-1 rounded border border-line bg-ground px-2 text-xs focus:border-accent focus:outline-none sm:max-w-72"
      />
      <div className="relative">
        <Button size="xs" data-testid="filter-menu" {...menuTrigger(toolbarMenu === 'filter')}
                onClick={openToolbarMenu('filter')}
                className={activeFilters.length ? 'border-accent text-accent-ink' : ''}>
          <FilterIcon /> Filter
          {activeFilters.length > 0 && (
            <span className="rounded-full bg-accent px-1.5 text-[10px] font-semibold leading-4 text-on-accent">
              {activeFilters.length}
            </span>
          )}
          <CaretIcon />
        </Button>
        {toolbarMenu === 'filter' && (
          <div data-testid="filter-items" onClick={(e) => e.stopPropagation()}
               className={`absolute left-0 top-full z-20 mt-1 w-60 ${popoverChrome} p-1`}>
            <div className={filterHeading}>Who</div>
            <label className={filterRow}>
              <Check data-testid="filter-mine" checked={onlyMine}
                     onChange={() => param('mine', onlyMine ? '0' : '1', '0')} />
              Only mine
            </label>
            {isAdmin && (
              <label className={`${filterRow} cursor-default hover:bg-transparent`}>
                <span className="shrink-0">Visible to</span>
                <select data-testid="filter-as-user" value={asUser} onChange={(e) => setAsUser(e.target.value)}
                        className="min-w-0 flex-1 rounded border border-line bg-ground px-1 py-0.5 text-xs">
                  <option value="">anyone</option>
                  {people.map((name) => <option key={name} value={name}>{name}</option>)}
                </select>
              </label>
            )}
            <div className={filterHeading}>State</div>
            <div role="radiogroup" aria-label="State" className="flex gap-1 px-2 py-1">
              {([['', 'Any'], ['0', 'In progress'], ['1', 'Complete']] as const).map(([value, label]) => (
                <label key={label} className="flex cursor-pointer items-center gap-1 text-xs text-ink">
                  <input type="radio" name="filter-complete" data-testid={`filter-complete-${value || 'any'}`}
                         checked={(completeness ?? '') === value} className="accent-accent"
                         onChange={() => param('complete', value, '')} />
                  {label}
                </label>
              ))}
            </div>
            <label className={filterRow}>
              <Check data-testid="filter-review" checked={needsReview}
                     onChange={() => param('review', needsReview ? '0' : '1', '0')} />
              Needs review
            </label>
            <div className={filterHeading}>Data</div>
            <label className={filterRow}>
              <Check data-testid="filter-test" checked={onlyTest}
                     onChange={() => param('test', onlyTest ? '0' : '1', '0')} />
              Has test data
            </label>
          </div>
        )}
      </div>
      {activeFilters.map((f) => (
        <span key={f.key} data-testid="filter-chip" data-filter={f.key}
              className="inline-flex h-6 items-center gap-1 rounded-full bg-accent-wash pl-2.5 pr-1 text-xs font-medium text-accent-ink">
          {f.label}
          <button type="button" aria-label={`Remove filter: ${f.label}`} onClick={f.clear}
                  className="flex size-4 items-center justify-center rounded-full hover:bg-accent hover:text-on-accent">
            ×
          </button>
        </span>
      ))}
      <span className="ml-auto flex flex-wrap items-center justify-end gap-2">
        <span className="text-[11px] text-ink-subtle" data-testid="result-count">
          {visible.length} of {jobs?.length ?? 0}
        </span>
        <div role="group" aria-label="View" className={joined}>
          <div className="relative">
            <GroupButton data-testid="groupby-menu" {...menuTrigger(toolbarMenu === 'groupby')}
                         onClick={openToolbarMenu('groupby')} className="rounded-l">
              {GROUP_BYS.find((o) => o.key === groupBy)?.label} <CaretIcon />
            </GroupButton>
            {toolbarMenu === 'groupby' && (
              <div className={`absolute right-0 top-full z-20 mt-1 w-44 overflow-hidden ${popoverChrome} py-1`}>
                {GROUP_BYS.map((g) => (
                  <button key={g.key} className={menuItem} data-groupby={g.key}
                          onClick={() => { setGroupBy(g.key); setToolbarMenu(null) }}>
                    {g.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="relative">
            <GroupButton data-testid="sort-menu" {...menuTrigger(toolbarMenu === 'sort')}
                         onClick={openToolbarMenu('sort')}>
              Sort: {SORTS.find((o) => o.key === sort)?.label} <CaretIcon />
            </GroupButton>
            {toolbarMenu === 'sort' && (
              <div className={`absolute right-0 top-full z-20 mt-1 w-44 overflow-hidden ${popoverChrome} py-1`}>
                {SORTS.map((o) => (
                  <button key={o.key} className={menuItem}
                          onClick={() => { setSort(o.key); setToolbarMenu(null) }}>
                    {o.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="relative">
            <GroupButton data-testid="columns-menu" {...menuTrigger(toolbarMenu === 'columns')}
                         onClick={openToolbarMenu('columns')} className="rounded-r">
              Columns <CaretIcon />
            </GroupButton>
            {toolbarMenu === 'columns' && (
              <div className={`absolute right-0 top-full z-20 mt-1 w-52 ${popoverChrome} p-1`}
                   onClick={(e) => e.stopPropagation()}>
                {COLUMNS.map((c) => (
                  <label key={c.key}
                         className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs text-ink-muted hover:bg-accent-wash hover:text-ink">
                    <input type="checkbox" id={`col-${c.key}`} checked={columns.includes(c.key)}
                           onChange={() => toggleColumn(c.key)} className="accent-accent" />
                    {c.label}
                  </label>
                ))}
                <button className={`${menuItem} text-accent-ink`}
                        onClick={() => { setColumns(DEFAULT_COLUMNS); saveColumns(DEFAULT_COLUMNS) }}>
                  Reset to defaults
                </button>
              </div>
            )}
          </div>
        </div>
        {/* Apart from the menus, so a phone can set the two on a line of their own. */}
        <div role="group" aria-label="Layout" className={joined}>
          <GroupButton on={view === 'table'} aria-label="Table view" title="Table" onClick={() => setView('table')}
                       className="rounded-l">
            Rows
          </GroupButton>
          <GroupButton on={view === 'cards'} aria-label="Card view" title="Cards" onClick={() => setView('cards')}
                       className="rounded-r">
            Cards
          </GroupButton>
        </div>
        {reaches(role, 'manager') && (creatingGroup ? (
          <input
            autoFocus
            value={groupDraft}
            placeholder="Workspace name"
            onChange={(e) => setGroupDraft(e.target.value)}
            onBlur={submitGroup}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitGroup()
              else if (e.key === 'Escape') setCreatingGroup(false)
            }}
            className="h-7 rounded border border-accent bg-ground px-2 text-xs focus:outline-none"
          />
        ) : (
          <Button size="xs" onClick={() => { setGroupDraft(''); setCreatingGroup(true) }}>
            <span aria-hidden="true">+</span> New workspace
          </Button>
        ))}
      </span>
    </div>
  )

  const selectionBar = (
    <div className="absolute inset-x-0 top-0 z-20 flex min-h-full flex-wrap items-center gap-2 border-b border-line bg-surface px-4 py-2"
         data-testid="bulk-bar">
      <span className="font-mono text-xs tabular-nums">{selected.size} selected</span>
      {managesAny(selected) && RUNS.map((r) => (
        <Button key={r.label} size="xs"
                onClick={() => void askBulk(
                  r.key, [...selected], `${selected.size} selected datasets`, r.phase)}>
          {r.label}
        </Button>
      ))}
      <span className="relative">
        <Button size="xs" {...menuTrigger(movePicker)}
                onClick={(e) => { e.stopPropagation(); setMovePicker((v) => !v) }}>
          Move to workspace…
        </Button>
        {movePicker && (
          <div className={`absolute left-0 top-full z-20 mt-1 max-h-64 w-52 overflow-auto ${popoverChrome} py-1`}
               onClick={(e) => e.stopPropagation()}>
            {moveTargets.map((g) => (
              <Fragment key={g.id}>
                <button className={menuItem} onClick={() => void moveSelection(g.id)}>
                  {g.name}
                </button>
                {flatten(folderTree(g.folders ?? [])).map(({ folder, depth }) => (
                  <button key={folder.id} data-testid="move-folder" title={`${g.name}: ${folder.name}`}
                          className={`${menuItem} flex items-center gap-1.5`}
                          style={{ paddingLeft: `${0.75 + (depth + 1) * 0.75}rem` }}
                          onClick={() => void moveSelection(g.id, folder.id)}>
                    <span className="shrink-0 text-ink-subtle"><FolderIcon /></span>
                    <span className="truncate">{folder.name}</span>
                  </button>
                ))}
              </Fragment>
            ))}
            <div className="my-1 border-t border-line" />
            <button className={menuItem} title="Each dataset goes back to the Sandbox of the person who made it"
                    onClick={() => void moveSelection(null)}>
              Back to Sandbox
            </button>
          </div>
        )}
      </span>
      <Button variant="ghost" size="xs" onClick={() => {
        setSelected(new Set())
        requestAnimationFrame(() => searchRef.current?.focus())
      }}>Clear</Button>
    </div>
  )

  const rowsOf = (rows: Job[], prefix: string) => view === 'cards'
    ? <div className={`${CARD_GRID} px-2`}>{rows.map(jobCard)}</div>
    : sectionRows(rows, prefix)

  /** A folder inside a workspace's section: its own folders first, then its datasets. With a
   *  folder picked in the rail, only the way down to it and what is below it show; with a search
   *  or filter on, a folder with nothing matching below it is left out, the picked one aside. */
  const renderFolder = (group: Group, node: FolderNode, rowsIn: Map<number | null, Job[]>,
                        shown: Set<number> | null): React.ReactNode => {
    const { folder, depth, children } = node
    const below = flatten([node]).flatMap((n) => rowsIn.get(n.folder.id) ?? [])
    if (shown && !shown.has(folder.id)) return null
    if (narrowing && below.length === 0 && folder.id !== folderScope) return null
    const key: SectionKey = `folder:${folder.id}`
    const own = rowsIn.get(folder.id) ?? []
    const zone = dropZone({ groupId: group.id, folderId: folder.id, name: folder.name })
    const open = !collapsed.has(key)
    const prefix = sharedPrefix(own.map((j) => j.name))
    return (
      <section key={key} data-testid="folder-section" data-title={folder.name}
               style={{ marginLeft: depth ? '1rem' : '0.5rem' }}
               className="mt-2 border-l border-line pl-2">
        <div data-testid="folder-header" {...zone.props}
             className={`mb-1 flex flex-wrap items-center gap-2 rounded px-2 py-0.5 ${zone.lit ? DROP_LIT : ''}`}>
          <button onClick={() => toggleSection(key)} aria-expanded={open}
                  className="flex min-w-0 items-center gap-1.5 text-sm font-medium text-ink hover:text-accent-ink">
            <span aria-hidden className={`inline-block text-ink-subtle transition-transform ${open ? 'rotate-90' : ''}`}>▸</span>
            <span className="text-ink-subtle"><FolderIcon /></span>
            <span className="truncate">{folder.name}</span>
          </button>
          <span className="whitespace-nowrap text-xs text-ink-subtle">
            {below.length} dataset{below.length === 1 ? '' : 's'}
          </span>
          {zone.hint && <span data-testid="drop-hint" className="whitespace-nowrap text-xs font-medium">{zone.hint}</span>}
          <span className="ml-auto flex items-center gap-1">
            {below.length > 0 && (
              <Button variant="ghost" size="xs" onClick={() => selectMany(below.map((j) => j.id))}>Select all</Button>
            )}
            {group.can_manage && (
              <ActionMenu trigger={<KebabIcon />} testId="folder-menu" label={`Actions for ${folder.name}`}
                          title={`What to do with ${folder.name}`} actions={[
                { label: 'New folder', hint: `Inside ${folder.name}`, testId: 'folder-new',
                  onSelect: () => setFolderAction({ kind: 'new', group, parent: folder }) },
                { label: 'Rename…', testId: 'folder-rename',
                  onSelect: () => setFolderAction({ kind: 'rename', group, folder }) },
                { label: 'Move…', hint: `Into another folder of ${group.name}, or to its top`, testId: 'folder-move',
                  onSelect: () => setFolderAction({ kind: 'move', group, folder }) },
                { label: 'Delete…', hint: 'What it holds moves up a level', testId: 'folder-delete', danger: true,
                  onSelect: () => setFolderAction({ kind: 'delete', group, folder }) },
              ]} />
            )}
          </span>
        </div>
        {open && (
          <>
            {children.map((child) => renderFolder(group, child, rowsIn, shown))}
            {own.length > 0 && <div className="mt-1">{rowsOf(own, prefix)}</div>}
          </>
        )}
      </section>
    )
  }

  const renderSection = (
    key: SectionKey, title: string, rows: Job[], group?: Group,
  ) => {
    const tree = folderTree(group?.folders ?? [])
    const rowsIn = new Map<number | null, Job[]>()
    for (const job of rows) {
      const at = filedIn(job, group)
      rowsIn.set(at, [...(rowsIn.get(at) ?? []), job])
    }
    const top = tree.length ? rowsIn.get(null) ?? [] : rows
    const shown = group && folderScope !== null && scope === String(group.id)
      ? new Set([...itselfAndBelow(group.folders ?? [], folderScope),
                 ...ancestry(group.folders ?? [], folderScope).map((f) => f.id)])
      : null
    const prefix = sharedPrefix(top.map((j) => j.name))
    return (
    <section key={key} data-testid="list-section" data-title={title} className="mb-5">
      {sectionHeader(key, title, rows.length, rows, group, prefix)}
      {!collapsed.has(key) && (
        <>
          {group && tree.map((node) => renderFolder(group, node, rowsIn, shown))}
          {top.length > 0 && <div className={tree.length ? 'mt-2' : undefined}>{rowsOf(top, prefix)}</div>}
          {rows.length === 0 && tree.length === 0 && (
            <p className="px-2 text-xs text-ink-subtle">No datasets in this workspace.</p>
          )}
        </>
      )}
    </section>
    )
  }

  const sidebar = (collapsed: boolean, onCollapse: (shut: boolean) => void, picked?: () => void) => (
    <DatasetSidebar
      groups={sidebarGroups}
      jobs={reached.jobs}
      scope={scope}
      folderScope={folderScope}
      needsReview={reviewCount}
      recent={recent}
      collapsed={collapsed}
      onCollapse={onCollapse}
      onScope={(next, folderId) => { setScope(next, folderId); setSelected(new Set()); picked?.() }}
      dropZone={dropZone}
      folderSource={folderSource}
      viewer={viewer}
    />
  )

  return (
    <div className="flex h-full min-h-0">
      {/* Below a tablet's width, mouse or finger, the list keeps its width: the groups slide
          in over it and go again once one is picked. */}
      {!narrow ? sidebar(railShut, setRailShut) : drawer ? (
        <div className="fixed inset-0 z-40 flex">
          <div className="flex h-full bg-surface shadow-lg">{sidebar(false, () => setDrawer(false), () => setDrawer(false))}</div>
          <div aria-hidden="true" className="flex-1 bg-black/40" onClick={() => setDrawer(false)} />
        </div>
      ) : sidebar(true, (shut) => setDrawer(!shut))}
      <div className="flex min-w-0 flex-1 flex-col bg-surface">
        <div className="relative">
          <div className={selected.size > 0 ? 'invisible' : undefined}>{toolbar}</div>
          {selected.size > 0 && selectionBar}
        </div>
        {asUser !== '' && (
          <div data-testid="lens-strip"
               className="flex flex-wrap items-baseline gap-2 border-b border-line bg-accent-wash px-4 py-2 text-xs text-accent-ink">
            <span>
              Showing what <b className="font-semibold">{asUser}</b> reaches: owned, shared
              directly, or through a workspace. Admins reach everything, so this says nothing
              about them.
            </span>
            <button className="ml-auto underline underline-offset-2"
                    onClick={() => setAsUser('')}>
              Show all datasets
            </button>
          </div>
        )}
        <div data-testid="jobs-scroller" className="flex min-h-0 flex-1 flex-col overflow-auto">
          <div ref={listRef} className="flex-1 px-2 py-3">
            {error && <p role="alert" className="mb-3 px-2 text-sm text-danger">{error}</p>}
            {!jobs && <JobCardSkeletons />}
            {jobs && jobs.length === 0 && groups.length === 0 && (
              <p className="px-2 text-sm text-ink-subtle">No datasets yet.</p>
            )}
            {jobs && jobs.length > 0 && visible.length === 0 && (
              <p className="px-2 text-sm text-ink-subtle">
                No dataset matches.{' '}
                <button className="text-accent-ink underline underline-offset-2"
                        onClick={clearFilters}>
                  Clear the search and filters
                </button>{' '}
                to see the rest.
              </p>
            )}
            {jobs && view === 'table' && visible.length > 0 && tableHead}
            {sections.map(({ key, title, rows, group }, i) => (
              <Fragment key={key}>
                {group && workspaceKind(group, viewer) === 'other-sandbox'
                  && !(sections[i - 1]?.group && workspaceKind(sections[i - 1].group!, viewer) === 'other-sandbox') && (
                  <h2 data-testid="other-sandboxes" className="mb-2 mt-6 flex items-center gap-2 px-2 text-[10px] font-semibold uppercase tracking-widest text-ink-subtle">
                    <LockIcon /> Other people's Sandboxes
                  </h2>
                )}
                {renderSection(key, title, rows, group)}
              </Fragment>
            ))}
          </div>
          <AppFooter />
        </div>
      </div>
      {pending && (
        <Modal title={BULK_LABEL[pending.action]} onClose={() => setPending(null)}>
          <div data-testid="bulk-preview">
          <p className="text-sm text-ink-muted">{pending.label}</p>
          {!pending.preview ? (
            <p className="mt-3 text-sm text-ink-subtle">Counting…</p>
          ) : (
            <>
              <div className="mt-3 overflow-hidden rounded border border-line">
                <div className="flex justify-between border-b border-line px-3 py-1.5 text-sm">
                  <span className="text-ink-muted">Datasets</span>
                  <span data-testid="preview-datasets" className="font-mono tabular-nums">
                    {pending.preview.datasets}
                  </span>
                </div>
                {Object.entries(pending.preview.totals).map(([k, v]) => (
                  <div key={k} className="flex justify-between border-b border-line px-3 py-1.5 text-sm last:border-b-0">
                    <span className="text-ink-muted">{PREVIEW_LABEL[k] ?? k}</span>
                    <span data-testid={`preview-${k}`} className="font-mono tabular-nums">{nf(v)}</span>
                  </div>
                ))}
              </div>
              {refusedBy.length > 0 && (
                <p role="alert" data-testid="preview-refused" className="mt-2 text-xs text-danger">
                  Nothing will be re-run: only a Manager may re-run{' '}
                  {refusedBy.map((j) => j.name).join(', ')}.
                </p>
              )}
              {leftAlone.length > 0 && (
                <p data-testid="preview-blocked" className="mt-2 text-xs text-warn">
                  {leftAlone.length} will be left alone - {leftAloneReasons(leftAlone)}.
                </p>
              )}
              <p className="mt-2 text-xs text-ink-subtle">
                Lines a person has checked are never overwritten.
              </p>
            </>
          )}
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button size="sm" onClick={() => setPending(null)}>Cancel</Button>
            <Button size="sm" variant="primary" disabled={!pending.preview || refusedBy.length > 0}
                    onClick={() => void runBulk()}>
              {BULK_LABEL[pending.action]}
            </Button>
          </div>
        </Modal>
      )}
      {moveJob && (
        <MoveToGroupDialog
          job={moveJob}
          groups={groups}
          targets={moveTargets}
          user={user}
          onClose={() => setMoveJob(null)}
          onMoved={() => { setError(null); refresh() }}
          onError={setError}
        />
      )}
      {folderAction && (
        <FolderDialog action={folderAction}
                      datasetsIn={(folder) => reached.jobs.filter((j) => j.folder_id === folder.id).length}
                      onClose={() => setFolderAction(null)}
                      onDone={() => { setFolderAction(null); setError(null); refresh() }} />
      )}
      {newerFor && (
        <NewerModelsDialog jobId={newerFor.job.id} name={newerFor.job.name} offers={newerFor.offers}
                           onClose={() => setNewerFor(null)} onStarted={refresh} onError={setError} />
      )}
      {mapSettingsJob && (
        <MapSettingsDialog
          job={mapSettingsJob}
          onClose={() => setMapSettingsJob(null)}
          onSaved={() => offerNewer(mapSettingsJob)}
          onError={setError}
        />
      )}
      {settingsGroup && (
        <GroupSettingsDialog
          group={settingsGroup}
          count={groupSize(settingsGroup, jobs ?? [])}
          onClose={() => setSettingsGroup(null)}
          onDone={refresh}
          onError={setError}
        />
      )}
      {transferOf && (
        <TransferDialog target={transferOf} onClose={() => setTransferOf(null)}
                        onDone={() => { setTransferOf(null); refresh() }} />
      )}
      {membersOf && (
        <MembersDialog
          target={membersOf}
          onClose={() => setMembersOf(null)}
          onChanged={refresh}
          onMoveInstead={() => {
            if (membersOf.kind === 'dataset') setMoveJob(membersOf.job)
            setMembersOf(null)
          }}
          onTransfer={membersOf.kind === 'workspace' && canTransferGroup(membersOf.group) ? () => {
            const { group } = membersOf
            setMembersOf(null)
            setTransferOf({
              kind: 'workspace', id: group.id, name: group.name, owner: group.owner,
              owned: (jobs ?? []).filter((j) => j.group_id === group.id && j.owner === group.owner).length,
            })
          } : undefined}
        />
      )}
    </div>
  )
}
