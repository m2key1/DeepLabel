import { Link } from 'react-router-dom'

import type { Group, Job } from '../../api'
import { formatRelative } from '../../util'
import { groupSize } from './groups'
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
  /** Datasets are being dragged, so Ungrouped is offered even while nothing is in it. */
  dragging: boolean
  dropZone: (target: DropTarget) => DropZone
}

const item =
  'flex w-full items-center gap-2 rounded px-2 py-1 text-left text-ink-muted hover:bg-raised hover:text-ink'
const active = 'bg-accent-wash text-ink font-medium'

export function DatasetSidebar({ groups, jobs, scope, needsReview, recent, collapsed,
                                 onCollapse, onScope, dragging, dropZone }: DatasetSidebarProps) {
  const ungrouped = jobs.filter((j) => j.group_id === null).length
  const ungroupedZone = dropZone({ groupId: null })

  // Folded away, it keeps only the way back - the list is six hundred rows and the room
  // the rail takes is room they could have.
  if (collapsed) {
    return (
      <nav
        aria-label="Dataset groups"
        data-testid="dataset-sidebar"
        data-collapsed=""
        className="flex shrink-0 flex-col border-r border-line py-3 pl-1 pr-1"
      >
        <button
          data-testid="sidebar-expand"
          title="Show the groups"
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
      aria-label="Dataset groups"
      data-testid="dataset-sidebar"
      className="flex w-44 shrink-0 flex-col gap-1 overflow-auto border-r border-line py-3 pl-3 pr-2 text-sm sm:w-56"
    >
      <div className="mb-1 flex items-center justify-end">
        <button
          data-testid="sidebar-collapse"
          title="Hide the groups"
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

      <div className="px-2 pb-1 pt-4 text-[10px] font-semibold uppercase tracking-widest text-ink-subtle">
        Groups
      </div>
      {groups.map((group) => {
        const zone = dropZone({ groupId: group.id, name: group.name })
        return (
          <button
            key={group.id}
            {...zone.props}
            className={`${item} flex-wrap ${zone.lit ? DROP_LIT : scope === String(group.id) ? active : ''}`}
            aria-current={scope === String(group.id)}
            onClick={() => onScope(String(group.id))}
          >
            <span className="flex-1 truncate" title={group.name}>{group.name}</span>
            <span className="font-mono text-xs tabular-nums text-ink-subtle">
              {groupSize(group, jobs)}
            </span>
            {zone.hint && <DropHint text={zone.hint} />}
          </button>
        )
      })}
      {(ungrouped > 0 || dragging) && (
        <button
          {...ungroupedZone.props}
          className={`${item} flex-wrap ${
            ungroupedZone.lit ? DROP_LIT : scope === 'ungrouped' ? active : ''}`}
          aria-current={scope === 'ungrouped'}
          onClick={() => onScope('ungrouped')}
        >
          <span className="flex-1 truncate">Ungrouped</span>
          <span className="font-mono text-xs tabular-nums text-ink-subtle">{ungrouped}</span>
          {ungroupedZone.hint && <DropHint text={ungroupedZone.hint} />}
        </button>
      )}
    </nav>
  )
}
