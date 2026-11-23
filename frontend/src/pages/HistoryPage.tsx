import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { getReviewQueue, listRuns, revertRun, runRevertPreview } from '../api'
import type { RunHistory, RunRecord, RunRevertPreview } from '../api'
import { Modal, modalBtn, modalDangerBtn } from '../components/Modal'
import { useCrumb } from '../components/NavBar'
import { DatasetViews } from '../components/job/DatasetViews'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { EmptyState } from '../components/ui/EmptyState'
import { pageShell } from '../components/ui/page'
import { reaches } from '../lib/roles'
import { formatDate, formatRunTime, isBusy, parseStamp, plural } from '../util'

const PHASE_LABEL: Record<string, string> = {
  ingest: 'Ingest', layout: 'Layout', lines: 'Lines', relines: 'Lines', ocr: 'OCR',
  reference: 'Reference cut', align: 'Alignment',
}

/** What started the run, in the words its menu used. */
function runTitle(run: RunRecord): string {
  if (run.reason === 'new') return 'First run'
  const [kind, phase] = (run.reason ?? '').split(':')
  if (kind === 'rerun') return `Re-run from ${phase === 'start' ? 'the start' : PHASE_LABEL[phase] ?? phase}`
  if (kind === 'page') return `${PHASE_LABEL[phase] ?? phase} on one page`
  return 'Run'
}

const changes = (counts: { lines: number; boxes: number }) =>
  [counts.lines && plural(counts.lines, 'line'), counts.boxes && plural(counts.boxes, 'box', 'boxes')]
    .filter(Boolean).join(' and ')

/** A dataset's runs, newest first: what each ran and changed, and the way back from one. */
export function HistoryPage() {
  const { id: jobId = '' } = useParams()
  const [history, setHistory] = useState<RunHistory | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reverting, setReverting] = useState<RunRecord | null>(null)
  const navigate = useNavigate()
  useCrumb(history ? `${history.job.name} · History` : 'History')

  /** Into Review over what the run changed and nobody has touched since. */
  const review = (run: RunRecord) => {
    getReviewQueue(jobId, 0.85, run.id).then((queue) => {
      if (queue.total === 0) setError('Everything that run changed has been worked on since.')
      else navigate(`/jobs/${jobId}/pages/${queue.lines[0].page_id}?review=0.85&run=${run.id}`)
    }).catch((e: Error) => setError(e.message))
  }

  const load = useCallback(() => {
    listRuns(jobId).then(setHistory).catch((e: Error) => setError(e.message))
  }, [jobId])
  useEffect(load, [load])

  if (error && !history) return <div className={pageShell}><p role="alert" className="text-sm text-danger">{error}</p></div>
  if (!history) return <div className={pageShell}><p className="text-sm text-ink-muted">Loading…</p></div>
  const canManage = reaches(history.job.my_role, 'manager')
  const busy = isBusy(history.job.status) || history.job.status === 'uploading'

  return (
    <div className={pageShell}>
      <header className="mb-4">
        <h1 className="font-serif text-xl font-semibold">
          <Link to={`/jobs/${jobId}`} className="hover:text-accent-ink">{history.job.name}</Link>
        </h1>
        <DatasetViews jobId={jobId} active="history" className="mt-2" />
      </header>
      <p className="mb-4 max-w-3xl text-sm text-ink-muted">
        Every time the dataset went through its steps. Reverting a run puts back what it replaced -
        lines and boxes as they stood before it - and leaves what you changed since.
      </p>
      {error && <p role="alert" className="mb-3 text-sm text-danger">{error}</p>}
      {history.runs.length === 0 ? (
        <EmptyState>No run has been recorded for this dataset yet.</EmptyState>
      ) : (
        <ol className="divide-y divide-line rounded-md border border-line" data-testid="run-list">
          {history.runs.map((run) => (
            <li key={run.id} data-testid="run" data-run={run.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
              <div className="min-w-0 basis-full sm:basis-0 sm:flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{runTitle(run)}</span>
                  {run.phases.length > 0 && (
                    <span className="text-xs text-ink-muted">
                      {[...new Set(run.phases.map((p) => PHASE_LABEL[p] ?? p))].join(' · ')}
                    </span>
                  )}
                  {run.status === 'error' && <Badge tone="danger">Failed</Badge>}
                  {run.status === 'cancelled' && <Badge tone="neutral">Cancelled</Badge>}
                  {(run.status === 'queued' || run.status === 'running') && <Badge tone="accent">Running</Badge>}
                  {run.reverted_at && <Badge tone="warn" data-testid="run-reverted">Reverted</Badge>}
                </div>
                <p className="mt-0.5 text-xs text-ink-muted">
                  {formatDate(run.queued_at)}
                  {run.started_by && <> · by {run.started_by}</>}
                  {run.started_at && run.finished_at && (
                    <> · took {formatRunTime((parseStamp(run.finished_at).getTime() - parseStamp(run.started_at).getTime()) / 1000)}</>
                  )}
                  {' · '}
                  <span data-testid="run-changed">{changes(run.changed) ? `changed ${changes(run.changed)}` : 'changed no line or box'}</span>
                  {run.reverted_at && <> · reverted by {run.reverted_by} {formatDate(run.reverted_at)}</>}
                </p>
              </div>
              {!run.reverted_at && changes(run.changed) && (
                <span className="flex items-center gap-3 text-sm">
                  <Link to={`/jobs/${jobId}?filter=run:${run.id}`} data-testid="run-pages"
                        className="text-accent-ink hover:underline">Its pages</Link>
                  <button type="button" data-testid="run-review" onClick={() => review(run)}
                          className="text-accent-ink hover:underline">Review its lines</button>
                </span>
              )}
              {canManage && run.revertable && (
                <Button size="sm" data-testid="run-revert-open" disabled={busy}
                        title={busy ? 'Wait until the dataset is through what it is doing' : undefined}
                        onClick={() => setReverting(run)}>
                  Revert…
                </Button>
              )}
            </li>
          ))}
        </ol>
      )}
      {reverting && (
        <RevertDialog jobId={jobId} run={reverting} onClose={() => setReverting(null)}
                      onDone={() => { setReverting(null); load() }} onError={setError} />
      )}
    </div>
  )
}

function RevertDialog({ jobId, run, onClose, onDone, onError }: {
  jobId: string; run: RunRecord; onClose: () => void; onDone: () => void; onError: (message: string) => void
}) {
  const [preview, setPreview] = useState<RunRevertPreview | null>(null)
  const [sending, setSending] = useState(false)
  useEffect(() => {
    runRevertPreview(jobId, run.id).then(setPreview).catch((e: Error) => { onError(e.message); onClose() })
  }, [jobId, run.id, onError, onClose])

  const revert = () => {
    setSending(true)
    revertRun(jobId, run.id).then(onDone).catch((e: Error) => { onError(e.message); onClose() })
  }
  const nothing = preview !== null && !changes(preview.restore) && !changes(preview.remove)

  return (
    <Modal title={`Revert "${runTitle(run)}"`} onClose={onClose}>
      {preview === null ? (
        <p className="mb-3 text-sm text-ink-muted">Checking what this puts back…</p>
      ) : (
        <div data-testid="run-revert-preview" className="mb-4 space-y-1.5 text-sm">
          {preview.refused ? (
            <p data-testid="run-revert-refused" className="text-danger">
              It cannot be reverted: {preview.refused}.
            </p>
          ) : nothing ? (
            <p>Nothing this run changed is left to put back.</p>
          ) : (
            <ul className="ml-4 list-disc space-y-1">
              {changes(preview.restore) && <li>{changes(preview.restore)} go back to how they stood before it</li>}
              {changes(preview.remove) && <li>{changes(preview.remove)} it made are taken off the pages</li>}
              {changes(preview.kept) && <li>{changes(preview.kept)} you edited since keep your edits</li>}
            </ul>
          )}
          {!preview.refused && !nothing && (
            <p className="text-ink-muted">The run and its reverting both stay in each line's history.</p>
          )}
        </div>
      )}
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className={modalBtn}>Cancel</button>
        <button onClick={revert} data-testid="run-revert-confirm" className={modalDangerBtn}
                disabled={preview === null || !!preview.refused || nothing || sending}>
          Revert
        </button>
      </div>
    </Modal>
  )
}
