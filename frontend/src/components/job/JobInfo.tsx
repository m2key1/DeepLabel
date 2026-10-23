import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { datasetInfo, isTileTask } from '../../api'
import type { DatasetInfo, Job } from '../../api'
import { formatDate, formatRelative, humanBytes, plural } from '../../util'
import { popoverChrome } from '../ui/Card'

// The job directory's own layout, named the way a user would describe it. An
// unrecognised directory keeps its own name rather than being hidden.
const AREA_LABELS: Record<string, string> = {
  uploads: 'uploads',
  pages: 'extracted pages',
  renditions: 'page images',
  crops: 'line crops',
  other: 'other',
}

function Row({ field, label, children }: { field: string; label: string; children: ReactNode }) {
  return (
    <div className="flex gap-2" data-testid="info-row" data-field={field}>
      <dt className="w-20 shrink-0 text-ink-muted">{label}</dt>
      <dd className="min-w-0 flex-1 break-words text-ink">{children}</dd>
    </div>
  )
}

function Details({ job, info }: { job: Job; info: DatasetInfo }) {
  const tiles = isTileTask(job.task)
  const models = Object.entries(info.models).filter(([, name]) => name)
  const areas = Object.entries(info.disk).sort(([, a], [, b]) => b - a)
  const uploaded = [
    info.documents > 0 && plural(info.documents, 'document'),
    info.images > 0 && plural(info.images, 'image'),
  ].filter(Boolean).join(' · ')
  return (
    <dl className="flex flex-col gap-1">
      <Row field="uploaded" label="Uploaded">
        {formatDate(info.created_at)} · {formatRelative(info.created_at)}
      </Row>
      <Row field="owner" label="By">{info.owner}</Row>
      <Row field="group" label="Project">{info.group ?? 'Ungrouped'}</Row>
      {info.shared_with.length > 0 && (
        <Row field="shared" label="Shared">{info.shared_with.join(', ')}</Row>
      )}
      <Row field="pages" label={tiles ? 'Tiles' : 'Pages'}>
        {plural(info.pages, tiles ? 'tile' : 'page')}
        {info.pages_duplicate > 0 && ` · ${info.pages_duplicate} duplicate${info.pages_duplicate === 1 ? '' : 's'} not counted`}
        {info.pages_deleted > 0 && ` · ${info.pages_deleted} deleted`}
      </Row>
      <Row field="sources" label="From">
        {tiles ? plural(info.maps, 'map') : uploaded || 'nothing yet'}
      </Row>
      {tiles ? (
        <Row field="regions" label="Regions">
          {plural(info.regions, 'region')}
        </Row>
      ) : (
        <Row field="lines" label="Lines">
          {plural(info.lines, 'line')} · {info.lines_checked} reviewed
        </Row>
      )}
      {!tiles && <Row field="elements" label="Elements">{plural(info.elements, 'element')}</Row>}
      {!tiles && info.transcriptions > 0 && (
        <Row field="transcriptions" label="Ground truth">
          {plural(info.transcriptions, 'page')} uploaded with a transcription
          {(job.counters.gt_total ?? 0) > 0 && (
            <span data-testid="gt-coverage" className="block text-ink-muted">
              {job.counters.gt_matched ?? 0}/{job.counters.gt_total} lines matched a recognized line
            </span>
          )}
        </Row>
      )}
      {models.length > 0 && (
        <Row field="models" label="Models">
          {models.map(([task, name]) => `${task}: ${name}`).join(' · ')}
        </Row>
      )}
      <Row field="editors" label="Edited by">
        {info.editors.length === 0
          ? 'nobody yet'
          : info.editors.map((e) => `${e.author} (${e.edits})`).join(' · ')}
      </Row>
      <Row field="size" label="Size">
        <span data-testid="info-size">{humanBytes(info.disk_bytes)}</span>
        {areas.length > 0 && (
          <ul className="mt-0.5 text-ink-muted">
            {areas.map(([area, bytes]) => (
              <li key={area} data-testid="info-area" data-area={area}>
                {AREA_LABELS[area] ?? area} {humanBytes(bytes)}
              </li>
            ))}
          </ul>
        )}
      </Row>
    </dl>
  )
}

/** What a dataset is made of, fetched when the panel opens rather than carried in the
 *  list payload - the disk breakdown walks the job directory. */
export function JobInfo({ job }: { job: Job }) {
  const [info, setInfo] = useState<DatasetInfo | null>(null)
  // Not self-clearing: the panel has nothing else to show, and an empty popover
  // says less than the failure does.
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setInfo(null)
    setError(null)
    datasetInfo(job.id).then(setInfo).catch((e: Error) => setError(e.message))
  }, [job.id])

  return (
    <div
      data-testid="job-info"
      onClick={(e) => e.stopPropagation()}
      className={`w-72 ${popoverChrome} p-3 text-xs`}
    >
      {error && <p className="text-danger">{error}</p>}
      {!info && !error && <p className="text-ink-muted">Loading…</p>}
      {info && <Details job={job} info={info} />}
    </div>
  )
}
