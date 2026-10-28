import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { cancelEvaluation, cancelJob, cancelTraining, getQueue } from '../api'
import type { PendingReocr, QueueEntry, QueueState } from '../api'
import { useAuth } from '../auth'
import { useCrumb } from '../components/NavBar'
import { Button } from '../components/ui/Button'
import { formatDate, formatRunTime, overallProgress, parseStamp } from '../util'
import { Badge } from '../components/ui/Badge'
import { EmptyState } from '../components/ui/EmptyState'
import { PageHeader } from '../components/ui/PageHeader'
import { Section } from '../components/ui/Section'
import { Table } from '../components/ui/Table'
import type { Column } from '../components/ui/Table'
import { pageShell } from '../components/ui/page'
import { QueueTimeline } from '../components/queue/QueueTimeline'
import { clock, placeCluster, placeLocal } from '../components/queue/timeline'

const KIND_LABEL: Record<QueueEntry['kind'], string> = {
  dataset: 'dataset',
  training: 'training',
  evaluation: 'eval',
}

function Bar({ fraction }: { fraction: number }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-raised">
      <div
        className="h-full bg-accent"
        style={{ width: `${Math.min(1, Math.max(0, fraction)) * 100}%` }}
      />
    </div>
  )
}

function ProgressCell({ entry, waiting }: { entry: QueueEntry; waiting: boolean }) {
  const label = 'text-[11px] text-ink-muted'
  if (waiting) {
    if (entry.kind === 'training' && entry.training?.target === 'slurm' && entry.status === 'queued') {
      return <span className={label}>submitting to cluster</span>
    }
    return <span className={label}>waiting</span>
  }
  if (entry.kind === 'dataset' && entry.job) {
    return (
      <div className="flex items-center gap-2">
        <div className="flex-1"><Bar fraction={overallProgress(entry.job.counters, entry.job)} /></div>
        <span className={`min-w-14 text-right ${label}`}>{entry.phase ?? entry.status}</span>
      </div>
    )
  }
  if (entry.kind === 'training' && entry.training) {
    const t = entry.training
    if (t.snapshot_progress) {
      const { done, total } = t.snapshot_progress
      return (
        <div className="flex items-center gap-2">
          <div className="flex-1"><Bar fraction={total ? done / total : 0} /></div>
          <span className={label}>
            cutting snapshot · {done.toLocaleString()}/{total.toLocaleString()} lines
          </span>
        </div>
      )
    }
    if (t.progress_last?.epoch !== undefined) {
      const parts = [`epoch ${t.progress_last.epoch}${t.epochs ? `/${t.epochs}` : ''}`]
      if (t.progress_last.loss !== undefined) parts.push(`loss ${t.progress_last.loss.toFixed(3)}`)
      if (t.progress_last.cer !== undefined) parts.push(`CER ${(t.progress_last.cer * 100).toFixed(2)}%`)
      return (
        <div className="flex items-center gap-2">
          {t.epochs ? <div className="flex-1"><Bar fraction={t.progress_last.epoch / t.epochs} /></div> : null}
          <span className={label}>{parts.join(' · ')}</span>
        </div>
      )
    }
    return <span className={label}>{entry.phase ?? entry.status}</span>
  }
  return <span className={label}>{entry.kind === 'evaluation' ? 'evaluating' : (entry.phase ?? entry.status)}</span>
}

/** Where a row opens: its dataset when the viewer may open it, a run's page, an
 *  evaluation's page - both of which everyone may read. */
function pageOf(entry: QueueEntry): string | null {
  if (entry.kind === 'training') return `/models/runs/${entry.id}`
  if (entry.kind === 'evaluation') return `/evaluations/${entry.id}`
  return entry.accessible ? `/jobs/${entry.id}` : null
}

const CANCEL: Record<QueueEntry['kind'], (id: QueueEntry['id']) => Promise<unknown>> = {
  dataset: (id) => cancelJob(String(id)),
  training: (id) => cancelTraining(Number(id)),
  evaluation: (id) => cancelEvaluation(Number(id)),
}

/** A queue is read down in order, so the columns are fixed and the position comes
 *  first - which is the one thing a row is looked up by. */
interface Waiting {
  entry: QueueEntry
  position: string
  waiting: boolean
  /** The page's clock, so every row's timer ticks from one interval. */
  now: number
  /** Set when the viewer may stop this row: its owner, or an admin. */
  onCancel?: () => void
  /** When it is expected to start, as a clock time; 'now' while it runs. */
  starts: string
  mine: boolean
}

/** How long a row has run, or waited: from when it left the queue, else from when it
 *  was queued. */
function TimeCell({ entry, waiting, now }: Waiting) {
  const since = !waiting && entry.started_at ? entry.started_at : entry.queued_at
  const seconds = (now - parseStamp(since).getTime()) / 1000
  return (
    <span data-testid="queue-row-time" title={`${waiting ? 'queued' : 'started'} ${formatDate(since)}`}
          className={`whitespace-nowrap font-mono text-xs tabular-nums ${waiting ? 'text-ink-subtle' : 'text-ink'}`}>
      {waiting ? `waiting ${formatRunTime(seconds)}` : formatRunTime(seconds)}
    </span>
  )
}

const QUEUE_COLUMNS: Column<Waiting>[] = [
  {
    key: 'position',
    label: '#',
    width: '2.5rem',
    cell: ({ position }) => (
      <span className={`block text-center text-xs ${
        position === '►' ? 'text-accent-ink' : 'text-ink-subtle'}`}>
        {position}
      </span>
    ),
  },
  {
    key: 'starts',
    label: 'Starts',
    cell: ({ starts, mine }) => (
      <span data-testid="queue-row-starts"
            className={`whitespace-nowrap font-mono text-xs tabular-nums ${mine ? 'font-semibold text-accent-ink' : 'text-ink-muted'}`}>
        {starts}
      </span>
    ),
  },
  {
    key: 'kind',
    label: 'Kind',
    cell: ({ entry }) => <Badge tone="neutral">{KIND_LABEL[entry.kind]}</Badge>,
  },
  {
    key: 'name',
    label: 'Name',
    cell: ({ entry, mine }) => {
      const to = pageOf(entry)
      const tone = mine ? 'text-accent-ink' : ''
      return to
        ? <Link to={to} data-testid="queue-row-link" className={`truncate font-medium hover:text-accent-ink ${tone}`}>{entry.name}</Link>
        : <span className={`truncate font-medium ${tone}`}>{entry.name}</span>
    },
  },
  {
    key: 'owner',
    label: 'Owner',
    cell: ({ entry }) => (
      <span className="truncate whitespace-nowrap text-xs text-ink-muted" title={formatDate(entry.created_at)}>
        {entry.owner}
      </span>
    ),
  },
  {
    key: 'time',
    label: 'Time',
    cell: (row) => <TimeCell {...row} />,
  },
  {
    key: 'progress',
    label: 'Progress',
    width: '35%',
    cell: ({ entry, waiting }) => <ProgressCell entry={entry} waiting={waiting} />,
  },
  {
    key: 'cancel',
    label: '',
    cell: ({ onCancel }) => onCancel && (
      <Button variant="ghost" size="xs" data-testid="queue-cancel" onClick={onCancel}>Cancel</Button>
    ),
  },
]

function QueueTable({ rows, caption }: { rows: Waiting[]; caption: string }) {
  return (
    <Table
      caption={caption}
      columns={QUEUE_COLUMNS}
      rows={rows}
      rowKey={({ entry }) => `${entry.kind}-${entry.id}`}
      rowProps={({ entry, mine }) => ({ 'data-testid': 'queue-row', 'data-kind': entry.kind, 'data-mine': mine || undefined })}
    />
  )
}

function PendingReocrRow({ pending }: { pending: PendingReocr }) {
  // The countdown ticks locally between polls; each poll resets the target, so it
  // never drifts more than one poll interval from the batcher's real schedule.
  const [target, setTarget] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    setTarget(pending.next_pass_in === null ? null : Date.now() + pending.next_pass_in * 1000)
  }, [pending])
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  const seconds = target === null ? null : Math.max(0, Math.ceil((target - now) / 1000))
  const lines = `${pending.lines} line${pending.lines === 1 ? '' : 's'}`
  const sets = `${pending.datasets.length} dataset${pending.datasets.length === 1 ? '' : 's'}`
  return (
    <div
      data-testid="queue-pending-reocr"
      title={pending.datasets.map((d) => `${d.name}: ${d.lines}`).join('\n')}
      className="px-3 py-2 text-[11px] text-ink-subtle"
    >
      {lines} flagged for re-read across {sets}
      {seconds !== null && <> · picked up in {seconds}s</>}
    </div>
  )
}

export function QueuePage() {
  useCrumb('Queue')
  const { isAdmin, user } = useAuth()
  const [queue, setQueue] = useState<QueueState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  const refresh = useCallback(() => getQueue()
    .then((next) => {
      setQueue(next)
      setError(null)
    })
    .catch((e: Error) => setError(`Could not read the queue: ${e.message}`)), [])

  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 3000)
    return () => clearInterval(t)
  }, [refresh])

  const failure = error && (
    <p role="alert" data-testid="queue-error" className="mb-3 text-sm text-danger">{error}</p>
  )
  if (!queue) {
    return failure ? <div className={pageShell}><PageHeader title="Queue" />{failure}</div> : null
  }
  const cancelOf = (entry: QueueEntry) => (isAdmin || entry.owner === user)
    ? () => { CANCEL[entry.kind](entry.id).then(refresh).catch((e: Error) => setError(e.message)) }
    : undefined
  const { running, queued } = queue.gpu
  const localBars = placeLocal(running, queued)
  const clusterBars = placeCluster(queue.cluster)
  const startOf = (i: number) => {
    const bar = localBars[i]
    if (bar.start === 0 && bar.entry.status !== 'queued') return 'now'
    return localBars.slice(0, i + 1).some((b) => b.unknown && b !== bar) ? `after ~${clock(bar.start, now)}` : `~${clock(bar.start, now)}`
  }
  const local: Waiting[] = localBars.map((bar, i) => ({
    entry: bar.entry, position: i === 0 && running ? '►' : String(running ? i : i + 1), waiting: bar.entry !== running,
    now, onCancel: cancelOf(bar.entry), starts: startOf(i), mine: bar.entry.owner === user,
  }))
  const cluster: Waiting[] = queue.cluster.map((entry) => ({
    entry,
    position: entry.status === 'queued' ? '◌' : '►',
    waiting: entry.status === 'queued',
    now,
    onCancel: cancelOf(entry),
    starts: entry.status === 'queued' ? 'when the cluster has room' : 'now',
    mine: entry.owner === user,
  }))
  const lanes = [
    ...(localBars.length ? [{ name: 'Local GPU', bars: localBars }] : []),
    ...(clusterBars.length ? [{ name: 'Cluster', bars: clusterBars }] : []),
  ]
  return (
    <div className={pageShell}>
      <PageHeader title="Queue">
        What the shared GPU is working on, in the order it will get to it.
      </PageHeader>
      {failure}
      {lanes.length > 0 && <QueueTimeline lanes={lanes} now={now} user={user} pageOf={pageOf} />}
      <Section title="Local GPU">
        {local.length === 0
          ? (
            <EmptyState>
              <span data-testid="queue-idle">The GPU is idle - nothing running.</span>
            </EmptyState>
          )
          : <QueueTable rows={local} caption="The local GPU queue" />}
        {queue.pending_reocr && <PendingReocrRow pending={queue.pending_reocr} />}
      </Section>
      {cluster.length > 0 && (
        <Section title="Cluster (SLURM)">
          <QueueTable rows={cluster} caption="The cluster queue" />
        </Section>
      )}
    </div>
  )
}
