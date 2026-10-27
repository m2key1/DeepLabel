import type { JobDetail, JobWithoutPages } from '../../api'
import { isTileTask } from '../../api'

/** Everything this reads. The page list is not part of it, so a dataset fetched
 *  without one is still enough to say where the pipeline got to. */
type Phased = JobDetail | JobWithoutPages

interface Phase {
  key: string
  label: string
  done: number
  total: number
  /** Not run for this dataset at all, as opposed to run and finished. */
  skipped: boolean
}

function textPhases(job: Phased): Phase[] {
  const c = job.counters
  return [
    { key: 'ingest', label: 'Ingest', done: c.pages_ingested ?? 0, total: c.pages_total ?? 0,
      skipped: false },
    { key: 'layout', label: 'Layout', done: c.pages_layout_done ?? 0, total: c.pages_total ?? 0,
      skipped: !job.run_layout },
    { key: 'lines', label: 'Lines', done: c.elements_lines_done ?? 0, total: c.elements_total ?? 0,
      skipped: !job.run_lines },
    { key: 'ocr', label: 'OCR', done: c.lines_ocr_done ?? 0, total: c.lines_total ?? 0,
      skipped: !job.run_ocr },
  ]
}

function tilePhases(job: Phased): Phase[] {
  const c = job.counters
  // Duplicates are ingested but never predicted, annotated or reviewed.
  const tiles = job.tiles_total ?? 0
  return [
    ...(job.run_tile
      ? [{ key: 'tile', label: 'Tiled', done: c.maps_tiled ?? 0, total: c.maps_total ?? 0,
           skipped: false }]
      : []),
    { key: 'ingest', label: 'Ingested', done: c.pages_ingested ?? 0, total: c.pages_total ?? 0,
      skipped: false },
    ...(job.run_predict
      ? [{ key: 'predict', label: 'Predicted', done: c.pages_predicted ?? 0, total: tiles,
           skipped: false }]
      : []),
    { key: 'annotated', label: 'Annotated', done: job.tiles_annotated ?? 0, total: tiles,
      skipped: false },
    { key: 'reviewed', label: 'Reviewed', done: job.tiles_reviewed ?? 0, total: tiles,
      skipped: false },
  ]
}

type StepState = 'done' | 'running' | 'waiting' | 'skipped'

const STEP_LOOK: Record<StepState, string> = {
  done: 'text-ink-muted',
  running: 'bg-accent-wash text-accent-ink',
  waiting: 'text-ink-muted',
  skipped: 'text-ink-subtle',
}

function StepMark({ state }: { state: StepState }) {
  if (state === 'done') {
    return (
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"
           strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="text-ok">
        <path d="M5 12.5l4.5 4.5L19 7" />
      </svg>
    )
  }
  if (state === 'running') return <span aria-hidden="true" className="size-2 animate-pulse rounded-full bg-accent" />
  return <span aria-hidden="true"
               className={`size-2 rounded-full border ${state === 'skipped' ? 'border-dashed border-ink-subtle' : 'border-ink-muted'}`} />
}

/** The pipeline as one joined row of steps: a check once a step is through, a pulsing dot
 *  and a bar while it works, and a dashed ring for a step this dataset does not run. */
export function PhaseStrip({ job }: { job: Phased }) {
  const phases = isTileTask(job.task) ? tilePhases(job) : textPhases(job)
  return (
    <div data-testid="phase-strip" role="list" aria-label="Pipeline"
         className="inline-flex max-w-full flex-wrap divide-x divide-line overflow-hidden rounded-full border border-line text-[11px]">
      {phases.map((p) => {
        const state: StepState = p.skipped ? 'skipped'
          : job.phase === p.key && job.status === 'running' ? 'running'
          : p.total > 0 && p.done >= p.total ? 'done' : 'waiting'
        return (
          <span key={p.key} role="listitem" data-phase={p.key} data-state={state}
                className={`flex items-center gap-1.5 px-2.5 py-0.5 ${STEP_LOOK[state]}`}>
            <StepMark state={state} />
            <span className="font-medium">{p.label}</span>
            {state === 'skipped' ? (
              <span className="italic">skipped</span>
            ) : (
              <>
                {state === 'running' && (
                  <span className="h-1 w-12 overflow-hidden rounded-full bg-surface">
                    <span className="block h-full bg-accent"
                          style={{ width: `${p.total ? (p.done / p.total) * 100 : 0}%` }} />
                  </span>
                )}
                <span className="font-mono tabular-nums">{p.done}/{p.total}</span>
              </>
            )}
          </span>
        )
      })}
    </div>
  )
}
