import { isTileTask } from '../../api'
import type { Job } from '../../api'
import { useAuth } from '../../auth'
import { DownloadIcon, InfoIcon, KebabIcon } from '../icons'
import { Button } from '../ui/Button'
import { useDropPlacement } from '../ui/dropPlacement'
import { menuTrigger } from '../ui/menu'
import { JobInfo } from './JobInfo'
import { ExportMenu } from './ExportMenu'
import { popoverChrome } from '../ui/Card'

export const menuItem =
  'block w-full px-2.5 py-1.5 text-left text-xs text-ink-muted hover:bg-accent-wash hover:text-accent-ink'

/** The info, download and actions cluster. One component so a row and a card offer the
 *  same things in the same words - and so the popovers stay inside whichever of the two
 *  is rendered, which is what lets them be found by way of the dataset they belong to. */
interface JobActionsProps {
  job: Job
  canManage: boolean
  openInfo: boolean
  openDownload: boolean
  openMenu: boolean
  preparing: boolean
  onToggleInfo: () => void
  onToggleDownload: () => void
  onToggleMenu: () => void
  onMasks: (fused: boolean) => void
  onRename: () => void
  onMove: () => void
  onShare: () => void
  onModels: () => void
  onProcessing: () => void
  onCancel: () => void
  onDelete: () => void
}

export function JobActions(p: JobActionsProps) {
  const { job } = p
  const { can } = useAuth()
  const active = job.status === 'queued' || job.status === 'running'
  const tiles = isTileTask(job.task)
  // A row near the foot of the list has no room beneath it, and most rows are.
  const info = useDropPlacement(p.openInfo)
  const download = useDropPlacement(p.openDownload)
  const menu = useDropPlacement(p.openMenu)

  // Both mask exports refuse a job with nothing reviewed, so the entry says so up front.
  // The list payload has no tiles_reviewed, but layout_checked_pages counts the same rows
  // for a map job (its pages are its tiles) and the server stays the real guard.
  const maskEntry = (fused: boolean, label: string, what: string) => {
    const reviewed = job.layout_checked_pages ?? 0
    return (
      <button
        disabled={!reviewed}
        title={reviewed ? what : 'Nothing to export yet - mark tiles reviewed in the tile editor first'}
        onClick={(e) => {
          e.stopPropagation()
          p.onMasks(fused)
        }}
        className={`${menuItem} disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-ink-muted`}
      >
        {label}
      </button>
    )
  }

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <div className="relative">
        <Button
          size="xs"
          title="Where this dataset came from and what it holds"
          data-testid="job-info-toggle"
          aria-label="Info"
          aria-expanded={p.openInfo}
          onClick={(e) => {
            e.stopPropagation()
            p.onToggleInfo()
          }}
        >
          <InfoIcon />
        </Button>
        {p.openInfo && (
          <div ref={info.ref} className={`${info.className} right-0 z-20`}>
            <JobInfo job={job} />
          </div>
        )}
      </div>
      <div className="relative">
        <Button
          size="xs"
          aria-label="Download"
          {...menuTrigger(p.openDownload)}
          title="Download this dataset"
          disabled={job.status !== 'done' || p.preparing}
          onClick={(e) => {
            e.stopPropagation()
            p.onToggleDownload()
          }}
        >
          {p.preparing ? 'Preparing…' : <DownloadIcon />}
        </Button>
        {p.openDownload && (
          <div
            ref={download.ref}
            className={`${download.className} right-0 z-10 overflow-hidden ${popoverChrome} ${
              tiles ? 'w-44' : 'w-max'
            }`}
          >
            {/* A map job has no text to export - json/md/txt would all come back empty,
                since a tile's annotations are regions, not elements and lines. Masks are
                the export it does have. */}
            {tiles ? (
              <>
                {maskEntry(false, 'Masks (zip)',
                           'Class-index mask PNGs + geometry JSON for reviewed tiles')}
                {/* Tiles uploaded ready-made have no source map to be put back into. */}
                {job.run_tile && maskEntry(true, 'Full maps (zip)',
                                           'One mask per source map, reviewed tiles stitched back into place')}
              </>
            ) : (
              <ExportMenu jobId={job.id} iiif={!!job.iiif_source} onPicked={() => p.onToggleDownload()} />
            )}
          </div>
        )}
      </div>
      {p.canManage && (
        <div className="relative">
          <Button
            size="xs"
            title="Dataset actions"
            data-testid="job-menu"
            {...menuTrigger(p.openMenu)}
            onClick={(e) => {
              e.stopPropagation()
              p.onToggleMenu()
            }}
          >
            <KebabIcon />
          </Button>
          {p.openMenu && (
            <div ref={menu.ref}
                 className={`${menu.className} right-0 z-10 w-40 overflow-hidden ${popoverChrome} py-1`}>
              <button onClick={p.onRename} className={menuItem}>Rename</button>
              <button onClick={p.onMove} className={menuItem}>Move to group…</button>
              <button onClick={p.onShare} className={menuItem}>Share…</button>
              <button onClick={p.onModels} className={menuItem}>Models…</button>
              {!active && (!tiles || job.run_tile) && (
                <button onClick={p.onProcessing} data-testid="processing-open" className={menuItem}>
                  Processing…
                </button>
              )}
              {active && <button onClick={p.onCancel} className={menuItem}>Cancel run</button>}
              {can('dataset.delete') && (
                <button onClick={p.onDelete} className={`${menuItem} text-danger hover:text-danger`}>
                  Delete
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
