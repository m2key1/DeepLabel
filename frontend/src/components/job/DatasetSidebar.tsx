import { useState } from 'react'
import type { DragEvent, ReactNode } from 'react'
import { Link } from 'react-router-dom'

import type { Group, Job } from '../../api'
import { useAuth } from '../../auth'
import { formatRelative } from '../../util'
import { CaretIcon, LockIcon, PlusIcon } from '../icons'
import { groupSize, inListOrder, newDatasetIn, newDatasetTitle, takesNewDatasets, workspaceKind } from './groups'
import { DROP_LIT } from './datasetDrag'
import type { DraggedFolder, DropTarget, DropZone } from './datasetDrag'
import { ancestry, datasetsBelow, folderTree, itselfAndBelow } from './folders'
import type { FolderNode } from './folders'

const ChevronLeft = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor"
       strokeWidth="1.6" aria-hidden>
    <path d="M10 3 5 8l5 5" />
  </svg>
)

const ChevronRight = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor"
       strokeWidth="1.6" aria-hidden>
    <path d="M6 3l5 5-5 5" />
  </svg>
)

const DropHint = ({ text }: { text: string }) => (
  <span data-testid="drop-hint" className="w-full text-xs font-medium">{text}</span>
)

// Which workspaces and folders are unfolded is one person's view of the rail, so it stays in
// this browser rather than in the account's shared settings.
const UNFOLDED_KEY = 'deeplabel.rail-unfolded'

function loadUnfolded(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(UNFOLDED_KEY) ?? '[]') as string[])
  } catch {
    return new Set()
  }
}

function useUnfolded() {
  const [unfolded, setUnfolded] = useState(loadUnfolded)
  const toggle = (key: string) => setUnfolded((prev) => {
    const next = new Set(prev)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    try {
      localStorage.setItem(UNFOLDED_KEY, JSON.stringify([...next]))
    } catch {
      // A browser that keeps nothing still folds and unfolds, only not across visits.
    }
    return next
  })
  return { unfolded, toggle }
}

/** The disclosure beside a workspace or folder with folders in it; the same room is left
 *  empty beside one without, so names at one depth line up. */
const Disclosure = ({ name, open, onToggle }: { name: string; open: boolean; onToggle?: () => void }) => onToggle ? (
  <button aria-label={`${open ? 'Hide' : 'Show'} the folders of ${name}`} aria-expanded={open} onClick={onToggle}
          className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded text-ink-subtle hover:bg-raised hover:text-ink">
    <span className={`transition-transform ${open ? '' : '-rotate-90'}`}><CaretIcon /></span>
  </button>
) : <span aria-hidden className="size-5 shrink-0" />

/** A nav, deliberately not a section: the dataset list is made of sections, and a spec
 *  that looks for "the section about this group" must not find this one too. */
interface DatasetSidebarProps {
  groups: Group[]
  jobs: Job[]
  scope: string | null
  /** The folder picked in the workspace `scope` names, if one is. */
  folderScope: number | null
  needsReview: number
  /** Most recently worked on, newest first - what somebody is likely to want back. */
  recent: Job[]
  collapsed: boolean
  onCollapse: (collapsed: boolean) => void
  onScope: (groupId: string | null, folderId?: number) => void
  dropZone: (target: DropTarget) => DropZone
  folderSource: (dragged: DraggedFolder) => { draggable: boolean; onDragStart: (e: DragEvent) => void;
                                              onDragEnd: () => void }
  /** Whose list this is: the signed-in person, or the one an admin's lens shows. */
  viewer: string
}

const heading = 'px-2 pb-1 pt-4 text-[10px] font-semibold uppercase tracking-widest text-ink-subtle'

const item =
  'flex w-full items-center gap-2 rounded px-2 py-1 text-left text-ink-muted hover:bg-raised hover:text-ink'
const active = 'bg-accent-wash text-ink font-medium'

export function DatasetSidebar({ groups, jobs, scope, folderScope, needsReview, recent, collapsed,
                                 onCollapse, onScope, dropZone, folderSource, viewer }: DatasetSidebarProps) {
  const { user, isAdmin, canEdit } = useAuth()
  const { unfolded, toggle } = useUnfolded()
  const sharedWithYou = jobs.filter((j) => j.group_id === null).length
  const ordered = inListOrder(groups, viewer)
  const ownSandbox = ordered.filter((g) => workspaceKind(g, viewer) === 'own-sandbox')
  const workspaces = ordered.filter((g) => workspaceKind(g, viewer) === 'workspace')
  // Someone else's empty Sandbox holds nothing to look into.
  const otherSandboxes = ordered.filter((g) => workspaceKind(g, viewer) === 'other-sandbox' && groupSize(g, jobs) > 0)

  // The way down to a folder picked by link stays open, whatever was folded here.
  const picked = scope !== null && folderScope !== null
    ? groups.find((g) => String(g.id) === scope) : undefined
  const forcedOpen = new Set(picked ? [`g:${picked.id}`, ...ancestry(picked.folders ?? [], folderScope!)
    .filter((f) => f.id !== folderScope).map((f) => `f:${f.id}`)] : [])
  const isOpen = (key: string) => unfolded.has(key) || forcedOpen.has(key)

  const folderRows = (group: Group, nodes: FolderNode[]): ReactNode => nodes.map(({ folder, depth, children }) => {
    const key = `f:${folder.id}`
    const zone = dropZone({ groupId: group.id, folderId: folder.id, name: folder.name })
    const current = scope === String(group.id) && folderScope === folder.id
    const drag = group.can_manage
      ? folderSource({ folder, groupId: group.id, within: itselfAndBelow(group.folders ?? [], folder.id) }) : {}
    return (
      <div key={folder.id}>
        <div className="flex items-start gap-0.5" style={{ paddingLeft: `${(depth + 1) * 0.75}rem` }}>
          <Disclosure name={folder.name} open={isOpen(key)}
                      onToggle={children.length ? () => toggle(key) : undefined} />
          <button
            {...zone.props}
            {...drag}
            data-testid="rail-folder"
            title={folder.name}
            className={`${item} min-w-0 flex-wrap ${zone.lit ? DROP_LIT : current ? active : ''}`}
            aria-current={current}
            onClick={() => onScope(String(group.id), folder.id)}
          >
            <span className="min-w-0 flex-1 truncate">{folder.name}</span>
            <span className="font-mono text-xs tabular-nums text-ink-subtle">
              {datasetsBelow(jobs, group, folder.id).length}
            </span>
            {zone.hint && <DropHint text={zone.hint} />}
          </button>
        </div>
        {isOpen(key) && folderRows(group, children)}
      </div>
    )
  })

  const entry = (group: Group, label: ReactNode, disclosure = false) => {
    const zone = dropZone({ groupId: group.id, name: group.name })
    const key = `g:${group.id}`
    const tree = folderTree(group.folders ?? [])
    const current = scope === String(group.id) && folderScope === null
    return (
      <div key={group.id}>
        <div className="flex items-start gap-0.5">
          {disclosure && <Disclosure name={group.name} open={isOpen(key)}
                                     onToggle={tree.length ? () => toggle(key) : undefined} />}
          <button
            {...zone.props}
            className={`${item} min-w-0 flex-wrap ${zone.lit ? DROP_LIT : current ? active : ''}`}
            aria-current={current}
            onClick={() => onScope(String(group.id))}
          >
            {label}
            <span className="font-mono text-xs tabular-nums text-ink-subtle">{groupSize(group, jobs)}</span>
            {zone.hint && <DropHint text={zone.hint} />}
          </button>
          {canEdit && takesNewDatasets(group, user, isAdmin) && (
            <Link to={newDatasetIn(group)} data-testid="new-dataset-in" title={newDatasetTitle(group, user)}
                  aria-label={newDatasetTitle(group, user)}
                  className="mt-0.5 shrink-0 rounded p-1 text-ink-subtle hover:bg-raised hover:text-ink">
              <PlusIcon />
            </Link>
          )}
        </div>
        {disclosure && isOpen(key) && folderRows(group, tree)}
      </div>
    )
  }

  // Folded away, it keeps only the way back - the list is six hundred rows and the room
  // the rail takes is room they could have.
  if (collapsed) {
    return (
      <nav
        aria-label="Workspaces"
        data-testid="dataset-sidebar"
        data-collapsed=""
        className="flex shrink-0 flex-col border-r border-line py-3 pl-1 pr-1"
      >
        <button
          data-testid="sidebar-expand"
          title="Show the workspaces"
          aria-expanded={false}
          onClick={() => onCollapse(false)}
          className="rounded p-1.5 text-ink-subtle hover:bg-raised hover:text-ink"
        >
          <ChevronRight />
        </button>
      </nav>
    )
  }

  return (
    <nav
      aria-label="Workspaces"
      data-testid="dataset-sidebar"
      className="flex w-44 shrink-0 flex-col gap-1 overflow-auto border-r border-line py-3 pl-3 pr-2 text-sm sm:w-56"
    >
      <div className="mb-1 flex items-center justify-end">
        <button
          data-testid="sidebar-collapse"
          title="Hide the workspaces"
          aria-expanded
          onClick={() => onCollapse(true)}
          className="rounded p-1 text-ink-subtle hover:bg-raised hover:text-ink"
        >
          <ChevronLeft />
        </button>
      </div>
      <button
        className={`${item} ${scope === null ? active : ''}`}
        aria-current={scope === null}
        onClick={() => onScope(null)}
      >
        <span className="flex-1 truncate">All datasets</span>
        <span className="font-mono text-xs tabular-nums text-ink-subtle">{jobs.length}</span>
      </button>
      <button
        className={`${item} ${scope === 'review' ? active : ''}`}
        aria-current={scope === 'review'}
        onClick={() => onScope('review')}
      >
        <span className="flex-1 truncate">Needs review</span>
        <span className="font-mono text-xs tabular-nums text-ink-subtle">{needsReview}</span>
      </button>

      {recent.length > 0 && (
        <>
          <div className="px-2 pb-1 pt-4 text-[10px] font-semibold uppercase tracking-widest text-ink-subtle">
            Recent
          </div>
          {recent.map((job) => (
            <Link
              key={job.id}
              to={`/jobs/${job.id}`}
              data-testid="recent-dataset"
              title={job.name}
              className={item}
            >
              <span className="flex-1 truncate">{job.name}</span>
              <span className="font-mono text-[10px] tabular-nums text-ink-subtle">
                {formatRelative(job.last_activity!)}
              </span>
            </Link>
          ))}
        </>
      )}

      {ownSandbox.length > 0 && (
        <div className="pt-4">
          {ownSandbox.map((g) => entry(g, <span className="flex-1 truncate">Sandbox</span>))}
        </div>
      )}
      {workspaces.length > 0 && <div className={heading}>Workspaces</div>}
      {workspaces.map((g) => entry(g, <span className="flex-1 truncate" title={g.name}>{g.name}</span>, true))}
      {sharedWithYou > 0 && (
        <button
          className={`${item} mt-4 ${scope === 'ungrouped' ? active : ''}`}
          aria-current={scope === 'ungrouped'}
          onClick={() => onScope('ungrouped')}
        >
          <span className="flex-1 truncate">Shared with you</span>
          <span className="font-mono text-xs tabular-nums text-ink-subtle">{sharedWithYou}</span>
        </button>
      )}
      {otherSandboxes.length > 0 && (
        <>
          <div className={heading}>Other Sandboxes</div>
          {otherSandboxes.map((g) => entry(g, (
            <span className="flex min-w-0 flex-1 items-center gap-1.5" title={`${g.name}, private`}>
              <LockIcon />
              <span className="truncate">{g.sandbox_of}</span>
            </span>
          )))}
        </>
      )}
    </nav>
  )
}
