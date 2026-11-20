import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'

import type { Group, Job } from '../../api'
import { useAuth } from '../../auth'
import { formatRelative } from '../../util'
import { LockIcon, PlusIcon } from '../icons'
import { groupSize, inListOrder, newDatasetIn, newDatasetTitle, takesNewDatasets, workspaceKind } from './groups'
import { DROP_LIT } from './datasetDrag'
import type { DropTarget, DropZone } from './datasetDrag'

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

/** A nav, deliberately not a section: the dataset list is made of sections, and a spec
 *  that looks for "the section about this group" must not find this one too. */
interface DatasetSidebarProps {
  groups: Group[]
  jobs: Job[]
  scope: string | null
  needsReview: number
  /** Most recently worked on, newest first - what somebody is likely to want back. */
  recent: Job[]
  collapsed: boolean
  onCollapse: (collapsed: boolean) => void
  onScope: (groupId: string | null) => void
  dropZone: (target: DropTarget) => DropZone
  /** Whose list this is: the signed-in person, or the one an admin's lens shows. */
  viewer: string
}

const heading = 'px-2 pb-1 pt-4 text-[10px] font-semibold uppercase tracking-widest text-ink-subtle'

const item =
  'flex w-full items-center gap-2 rounded px-2 py-1 text-left text-ink-muted hover:bg-raised hover:text-ink'
const active = 'bg-accent-wash text-ink font-medium'

export function DatasetSidebar({ groups, jobs, scope, needsReview, recent, collapsed,
                                 onCollapse, onScope, dropZone, viewer }: DatasetSidebarProps) {
  const { user, isAdmin, canEdit } = useAuth()
  const sharedWithYou = jobs.filter((j) => j.group_id === null).length
  const ordered = inListOrder(groups, viewer)
  const ownSandbox = ordered.filter((g) => workspaceKind(g, viewer) === 'own-sandbox')
  const workspaces = ordered.filter((g) => workspaceKind(g, viewer) === 'workspace')
  // Someone else's empty Sandbox holds nothing to look into.
  const otherSandboxes = ordered.filter((g) => workspaceKind(g, viewer) === 'other-sandbox' && groupSize(g, jobs) > 0)

  const entry = (group: Group, label: ReactNode) => {
    const zone = dropZone({ groupId: group.id, name: group.name })
    return (
      <div key={group.id} className="flex items-start gap-0.5">
        <button
          {...zone.props}
          className={`${item} flex-wrap ${zone.lit ? DROP_LIT : scope === String(group.id) ? active : ''}`}
          aria-current={scope === String(group.id)}
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
      {workspaces.map((g) => entry(g, <span className="flex-1 truncate" title={g.name}>{g.name}</span>))}
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
