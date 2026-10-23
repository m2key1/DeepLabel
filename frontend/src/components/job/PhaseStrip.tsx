import type { JobDetail, JobWithoutPages } from '../../api'
import { isTileTask } from '../../api'

/** Where the pipeline has got to, on one line.
 *
 *  It used to be four labelled bars across the full width, which spent sixty pixels saying
 *  everything was finished - which it is, for every dataset that is not running. A phase
 *  that is done says so in a word; one that is working keeps its bar, because that is the
 *  only time the proportion matters. */
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

export function PhaseStrip({ job }: { job: Phased }) {
  const phases = isTileTask(job.task) ? tilePhases(job) : textPhases(job)
  return (
    <div data-testid="phase-strip"
         className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-ink-subtle">
      {phases.map((p) => {
        const running = job.phase === p.key && job.status === 'running'
        const finished = !p.skipped && p.total > 0 && p.done >= p.total
        return (
          <span key={p.key} data-phase={p.key}
                className={`flex items-center gap-1.5 ${p.skipped ? 'opacity-40' : ''}`}>
            <span className={running ? 'font-medium text-accent-ink' : ''}>{p.label}</span>
            {p.skipped ? (
              <span>not run</span>
            ) : (
              <>
                {/* The bar is only worth the pixels while the proportion is changing. A
                    finished phase keeps its numbers, which is what says it finished. */}
                {(running || !finished) && (
                  <span className="h-1 w-16 overflow-hidden rounded-full bg-raised">
                    <span className="block h-full bg-accent"
                          style={{ width: `${p.total ? (p.done / p.total) * 100 : 0}%` }} />
                  </span>
                )}
                <span className={`font-mono tabular-nums ${finished ? 'text-ok' : ''}`}>
                  {p.done}/{p.total}
                </span>
              </>
            )}
          </span>
        )
      })}
    </div>
  )
}
