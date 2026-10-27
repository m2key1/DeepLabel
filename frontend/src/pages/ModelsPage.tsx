import { useCallback, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { cancelTraining, deleteTraining, listEvaluations, listModels, listTrainings, retryTraining } from '../api'
import type { Evaluation, ModelTask, RegistryModel, Training, TrainingTargets } from '../api'
import { useAuth } from '../auth'
import { useCrumb } from '../components/NavBar'
import { ClusterUnlock } from '../components/models/ClusterUnlock'
import { FamilyGraph, formatScore } from '../components/models/FamilyGraph'
import { buildFamilies } from '../components/models/families'
import type { Family } from '../components/models/families'
import { RunCompare } from '../components/models/RunCompare'
import { ActionMenu } from '../components/job/ActionMenu'
import { KebabIcon } from '../components/icons'
import { Button, buttonClass } from '../components/ui/Button'
import { Segmented } from '../components/ui/Segmented'
import { Tabs, panelId, tabId } from '../components/ui/Tabs'
import { formatDate } from '../util'
import { EmptyState } from '../components/ui/EmptyState'
import { PageHeader } from '../components/ui/PageHeader'
import { Badge, type Tone } from '../components/ui/Badge'
import { Section } from '../components/ui/Section'
import { Table } from '../components/ui/Table'
import { pageShell } from '../components/ui/page'
import { useAutoClear } from '../messages'
import { usePolling } from '../hooks/usePolling'
import { cardChrome } from '../components/ui/Card'

const TASKS: { task: ModelTask; title: string }[] = [
  { task: 'ocr', title: 'OCR' },
  { task: 'layout', title: 'Layout detection' },
  { task: 'lines', title: 'Line segmentation' },
]

type Tab = ModelTask | 'runs'

const TAB_KEY = 'models.tab'

const isTab = (value: string | null): value is Tab =>
  value === 'runs' || TASKS.some((t) => t.task === value)

function rememberedTab(): Tab {
  try {
    const kept = localStorage.getItem(TAB_KEY)
    if (isTab(kept)) return kept
  } catch {
    // storage blocked: start on OCR
  }
  return 'ocr'
}

const STATUS_TONE: Record<string, Tone> = {
  queued: 'warn',
  preparing: 'accent',
  running: 'accent',
  done: 'ok',
  error: 'danger',
  cancelled: 'neutral',
}

function rootLabel(family: Family): string {
  const { root } = family
  if (root.source === 'builtin') return 'shipped'
  if (root.source === 'backend') return 'its backend\'s own'
  if (root.source === 'imported') return 'imported'
  return 'trained from scratch'
}

function FamilyCard({ family, open, onToggle }: { family: Family; open: boolean; onToggle: () => void }) {
  const { lead } = family
  const versions = family.versions.filter((v) => v.state === 'model').length
  return (
    <div data-testid="model-family" data-root={family.root.id} className={`${cardChrome} overflow-hidden`}>
      <button type="button" data-testid="family-toggle" aria-expanded={open} onClick={onToggle}
              className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-left hover:bg-raised">
        <span aria-hidden className="w-3 text-ink-subtle">{open ? '▾' : '▸'}</span>
        <span data-testid="family-name" className="text-sm font-semibold text-ink">{family.name}</span>
        {family.holdsDefault && <Badge tone="accent">DEFAULT FAMILY</Badge>}
        <span className="text-xs text-ink-subtle">root: {family.root.name}, {rootLabel(family)}</span>
        <span className="ml-auto flex items-center gap-3 text-xs text-ink-muted">
          <span data-testid="family-lead">
            {lead.isDefault ? 'default' : 'best'} <span className="font-medium text-ink">{lead.name}</span>{' '}
            <span className="tabular-nums">{formatScore(lead.score)}</span>
          </span>
          <span data-testid="family-count">{versions === 1 ? '1 version' : `${versions} versions`}</span>
          <span className="tabular-nums text-ink-subtle">newest {formatDate(family.newest)}</span>
        </span>
      </button>
      {open && <div className="border-t border-line"><FamilyGraph family={family} /></div>}
    </div>
  )
}

const isFinished = (status: Training['status']) =>
  status === 'done' || status === 'error' || status === 'cancelled'

/** The three states worth filtering a list of runs by. "running" covers everything on
 *  its way - queued and preparing included - because what a person means by it is
 *  "not finished yet". */
const RUN_FILTERS: Record<string, (t: Training) => boolean> = {
  all: () => true,
  running: (t) => !isFinished(t.status),
  done: (t) => t.status === 'done',
  failed: (t) => t.status === 'error' || t.status === 'cancelled',
}

/** How many runs can be laid over each other before the charts stop being readable. */
const COMPARE_MAX = 3

export function ModelsPage() {
  useCrumb('Models')
  const { user, canEdit, isAdmin } = useAuth()
  const [models, setModels] = useState<RegistryModel[] | null>(null)
  const [trainings, setTrainings] = useState<Training[]>([])
  const [targets, setTargets] = useState<TrainingTargets>({ local: true, slurm: false })
  const [trainableTasks, setTrainableTasks] = useState<ModelTask[]>(['ocr'])
  const [error, setError] = useState<string | null>(null)
  useAutoClear(error, setError)
  const [evaluations, setEvaluations] = useState<Evaluation[]>([])
  const [params, setParams] = useSearchParams()
  const asked = params.get('tab')
  const [kept, setKept] = useState<Tab>(rememberedTab)
  const tab: Tab = isTab(asked) ? asked : kept
  const [hideArchived, setHideArchived] = useState(false)
  // Families by root id the person opened or closed; the default family starts open.
  const [toggled, setToggled] = useState<Map<number, boolean>>(new Map())
  const [archivedFamiliesOpen, setArchivedFamiliesOpen] = useState(false)
  // Reported by the poller, not by the presence of a session, so a cluster that needs
  // no unlocking never claims to be lost.
  const [clusterLost, setClusterLost] = useState(false)
  // Which runs the list is showing, and which of them are being laid over each other.
  const [runTask, setRunTask] = useState<ModelTask | 'all'>('all')
  const [runStatus, setRunStatus] = useState<'all' | 'running' | 'done' | 'failed'>('all')
  const [compare, setCompare] = useState<Set<number>>(new Set())
  const [comparing, setComparing] = useState(false)
  const [reconnecting, setReconnecting] = useState<number | null>(null)

  // Scheduler holds that waiting will not fix - shown amber. Priority/Resources
  // and friends are ordinary queueing.
  const stuckPending = (phase: string | null) =>
    !!phase && /PENDING \((?!Priority|Resources|Dependency|Prolog|None)/.test(phase)

  const refresh = useCallback(() => {
    listModels(true)
      .then((r) => setModels(r.models))
      .catch((e: Error) => setError(e.message))
    listTrainings()
      .then((r) => {
        setTrainings(r.trainings)
        setTargets(r.targets)
        setClusterLost(r.cluster?.reachable === false)
        setTrainableTasks(r.trainable_tasks ?? ['ocr'])
      })
      .catch(() => {})
    listEvaluations()
      .then((r) => setEvaluations(r.evaluations))
      .catch(() => {})
  }, [])

  usePolling(refresh, 5000)

  const selectTab = (next: Tab) => {
    setKept(next)
    setParams((prev) => {
      const following = new URLSearchParams(prev)
      following.set('tab', next)
      return following
    }, { replace: true })
    try {
      localStorage.setItem(TAB_KEY, next)
    } catch {
      // storage blocked: the choice lasts for this visit
    }
  }

  // Everyone sees every run; acting on one is the owner's or an admin's, which the
  // backend enforces - so the buttons that would 403 are not offered.
  const mine = (t: Training) => canEdit && (isAdmin || t.owner === user)
  const navigate = useNavigate()
  const shownRuns = trainings.filter(
    (t) => (runTask === 'all' || t.task === runTask) && RUN_FILTERS[runStatus](t))
  const modelById = new Map((models ?? []).map((m) => [m.id, m]))

  const canTrain = targets.local || targets.slurm

  return (
    <div className={pageShell}>
      <PageHeader
        title="Models"
        actions={<>
          <Link to="/models/evaluations" data-testid="evaluations-list" className={buttonClass()}>Evaluations</Link>
          <Link to="/augmentations" className={buttonClass()}>Augmentations</Link>
        </>}
      >
        One model per pipeline stage runs by default; datasets can pick specific ones. Trained models
        register here when their run finishes. Every model and run on this page is visible to
        everyone; only its owner or an admin can change it.
      </PageHeader>
      {error && <p className="mb-4 text-sm text-danger">{error}</p>}
      {canEdit && !canTrain && (
        <p className="mb-4 text-sm text-ink-muted">
          Training is granted per person - ask an admin for the local GPU, the cluster, or both.
        </p>
      )}
      <Tabs
        label="Model stages"
        className="mb-4"
        active={tab}
        onSelect={selectTab}
        items={[
          ...TASKS.map(({ task, title }) => ({
            id: task as Tab,
            label: `${title} ${models?.filter((m) => m.task === task && !m.archived).length ?? ''}`.trim(),
          })),
          { id: 'runs' as Tab, label: `Runs ${trainings.length}` },
        ]}
      />
      {tab !== 'runs' && (() => {
        const task = tab
        const families = buildFamilies((models ?? []).filter((m) => m.task === task), trainings, evaluations, hideArchived)
        const live = families.filter((f) => !f.archived)
        const retired = families.filter((f) => f.archived)
        const isOpen = (f: Family) => toggled.get(f.root.id) ?? f.holdsDefault
        const toggle = (f: Family) => setToggled((prev) => new Map(prev).set(f.root.id, !isOpen(f)))
        return (
          <div role="tabpanel" id={panelId(task)} aria-labelledby={tabId(task)} data-testid="task-section" data-task={task}>
            <div className="mb-2 flex flex-wrap items-center gap-3">
              <p className="text-xs text-ink-muted">
                Each family is a model and everything fine-tuned from it, best first. Open one to see its
                history, newest on top.
              </p>
              <label className="ml-auto flex cursor-pointer items-center gap-1.5 text-xs text-ink-muted">
                <input type="checkbox" data-testid="hide-archived" checked={hideArchived}
                       onChange={(e) => setHideArchived(e.target.checked)} className="cursor-pointer accent-accent" />
                hide archived
              </label>
              {canEdit &&
                (!canTrain ? (
                  <Button size="xs" disabled data-testid="train-model"
                          title="An admin has not granted you any hardware to train on">
                    Train model
                  </Button>
                ) : trainableTasks.includes(task) ? (
                  <Link to={`/models/train?task=${task}`} data-testid="train-model"
                        className={buttonClass({ variant: 'outline', size: 'xs' })}>
                    Train model
                  </Link>
                ) : (
                  <Button size="xs" disabled data-testid="train-model"
                          title="Training for this stage is coming soon">
                    Train model
                  </Button>
                ))}
            </div>
            <div className="space-y-2">
              {live.map((f) => <FamilyCard key={f.root.id} family={f} open={isOpen(f)} onToggle={() => toggle(f)} />)}
              {models !== null && families.length === 0 && <p className="text-xs text-ink-subtle">No models.</p>}
              {retired.length > 0 && (
                <div data-testid="archived-families" className="pt-2">
                  <button type="button" data-testid="archived-families-toggle" aria-expanded={archivedFamiliesOpen}
                          onClick={() => setArchivedFamiliesOpen(!archivedFamiliesOpen)}
                          className="text-xs text-ink-subtle hover:text-accent-ink">
                    {archivedFamiliesOpen ? '▾' : '▸'} Archived families {retired.length}
                  </button>
                  {archivedFamiliesOpen && (
                    <div className="mt-2 space-y-2 opacity-80">
                      {retired.map((f) => (
                        <FamilyCard key={f.root.id} family={f} open={toggled.get(f.root.id) ?? false}
                                    onToggle={() => setToggled((prev) => new Map(prev).set(f.root.id, !(prev.get(f.root.id) ?? false)))} />
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )
      })()}

      {tab === 'runs' && <Section
        role="tabpanel" id={panelId('runs')} aria-labelledby={tabId('runs')}
        title="Training runs"
        description="Everyone's runs, with dataset names you cannot open left redacted. Cancelling, retrying and deleting belong to the owner; any run can be reopened as a new one with Rerun."
      >
        {clusterLost && (
          <div data-testid="cluster-lost"
               className="mb-2 flex flex-wrap items-center gap-2 rounded border border-warn/40 bg-warn/10 px-3 py-2 text-xs">
            <span className="font-medium text-warn"
                  title="Cluster runs are untouched - their state stops updating until the connection is unlocked again">
              cluster session lost
            </span>
            {isAdmin && (
              <Button variant="ghost" size="xs" onClick={() => setReconnecting(reconnecting === 0 ? null : 0)}>
                Reconnect
              </Button>
            )}
            {reconnecting === 0 && (
              <div className="w-full pt-1">
                <ClusterUnlock
                  onStatus={(st) => {
                    if (!st.connected) return
                    setReconnecting(null)
                    setClusterLost(false)
                    refresh()
                  }}
                />
              </div>
            )}
          </div>
        )}
        <div className="mb-2 flex flex-wrap items-center gap-2" data-testid="run-filters">
          <Segmented
            value={runTask}
            onChange={setRunTask}
            options={[{ value: 'all' as const, label: 'all stages' },
                      ...TASKS.map(({ task }) => ({ value: task, label: task }))]}
          />
          <Segmented
            value={runStatus}
            onChange={setRunStatus}
            options={(['all', 'running', 'done', 'failed'] as const).map((value) => ({ value, label: value }))}
          />
          {compare.size > 0 && (
            <span className="ml-auto flex items-center gap-2">
              <span className="text-xs text-ink-muted">{compare.size} picked</span>
              <Button size="xs" data-testid="compare-runs" disabled={compare.size < 2}
                      title={compare.size < 2 ? 'Pick another run to lay it over this one' : ''}
                      onClick={() => setComparing(true)}>
                Compare
              </Button>
              <Button variant="ghost" size="xs" onClick={() => { setCompare(new Set()); setComparing(false) }}>
                Clear
              </Button>
            </span>
          )}
        </div>
        {comparing && compare.size >= 2 && (
          <RunCompare
            runs={trainings.filter((t) => compare.has(t.id))}
            onClose={() => setComparing(false)}
          />
        )}
        {shownRuns.length === 0
          ? <EmptyState>{trainings.length === 0
              ? 'No training runs yet. One started with Train model above appears here, and stays after it finishes.'
              : 'No runs of that stage in that state.'}</EmptyState>
          : (
            <Table
              caption="Training runs"
              fixed
              rows={shownRuns}
              rowKey={(t) => t.id}
              rowProps={() => ({ 'data-testid': 'training-row' })}
              columns={[
                {
                  key: 'pick',
                  label: '',
                  width: '2rem',
                  cell: (t) => (
                    <input
                      type="checkbox"
                      data-testid="compare-pick"
                      data-run={t.id}
                      checked={compare.has(t.id)}
                      disabled={!compare.has(t.id) && compare.size >= COMPARE_MAX}
                      title={!compare.has(t.id) && compare.size >= COMPARE_MAX
                        ? `${COMPARE_MAX} runs is as many as the charts stay readable with`
                        : 'Lay this run over the others picked'}
                      onChange={(e) => setCompare((prev) => {
                        const next = new Set(prev)
                        if (e.target.checked) next.add(t.id)
                        else next.delete(t.id)
                        return next
                      })}
                      className="cursor-pointer accent-accent disabled:cursor-default"
                    />
                  ),
                },
                {
                  key: 'name',
                  label: 'Run',
                  cell: (t) => (
                    <span className="block min-w-0">
                      <Link to={`/models/runs/${t.id}`} data-testid="training-open"
                            className="block truncate font-medium hover:text-accent-ink" title={t.name}>
                        {t.name}
                      </Link>
                      <span data-testid="run-meta" className="block truncate text-xs text-ink-subtle">
                        {[t.task, t.target === 'slurm' ? 'cluster' : 'local', t.owner === user ? 'you' : t.owner,
                          formatDate(t.created_at)].join(' · ')}
                      </span>
                    </span>
                  ),
                },
                {
                  key: 'status',
                  label: 'Status',
                  width: '13rem',
                  cell: (t) => (
                    <span className="flex flex-wrap items-center gap-1.5">
                      <Badge tone={STATUS_TONE[t.status] ?? 'neutral'} className="whitespace-nowrap">
                        {t.status}
                        {t.status === 'preparing' && t.snapshot_progress && (
                          <span data-testid="snapshot-progress" className="font-normal">
                            {' · '}snapshot {t.snapshot_progress.done.toLocaleString()} / {t.snapshot_progress.total.toLocaleString()}
                          </span>
                        )}
                        {!isFinished(t.status) && t.progress_last?.epoch !== undefined && (
                          <span className="font-normal">
                            {' · '}epoch {t.progress_last.epoch}{t.epochs ? `/${t.epochs}` : ''}
                          </span>
                        )}
                      </Badge>
                      {t.phase && !isFinished(t.status) && (
                        <span
                          className={`truncate text-xs ${stuckPending(t.phase) ? 'font-medium text-warn' : 'text-ink-subtle'}`}
                          title={stuckPending(t.phase)
                            ? 'Held by a scheduler limit - waiting will not start it'
                            : t.phase}
                        >
                          {t.phase}
                        </span>
                      )}
                    </span>
                  ),
                },
                {
                  key: 'result',
                  label: 'Result',
                  width: '28%',
                  cell: (t) => (
                    <span className="flex min-w-0 items-center gap-2 text-xs text-ink-muted">
                      {t.error ? (
                        <span className="truncate text-danger" title={t.error}>{t.error}</span>
                      ) : typeof t.progress_last?.cer === 'number' ? (
                        <span className="font-mono tabular-nums">cer {t.progress_last.cer.toFixed(4)}</span>
                      ) : t.model_id === null && '-'}
                      {t.model_id !== null && modelById.has(t.model_id) && (
                        <Link to={`/models/${t.model_id}`} data-testid="run-model"
                              title={modelById.get(t.model_id)!.name}
                              className="shrink-0 text-accent-ink hover:underline">
                          → {modelById.get(t.model_id)!.name === t.name ? 'model' : modelById.get(t.model_id)!.name}
                        </Link>
                      )}
                    </span>
                  ),
                },
                {
                  key: 'actions',
                  label: '',
                  align: 'right',
                  width: '3.5rem',
                  cell: (t) => (
                    <ActionMenu
                      testId="run-actions"
                      label={`Actions for ${t.name}`}
                      title="Rerun, retry, cancel or delete"
                      trigger={<KebabIcon />}
                      actions={[
                        ...(isFinished(t.status) && canEdit && trainableTasks.includes(t.task) ? [{
                          label: 'Rerun…', hint: "Open the training form on this run's settings",
                          testId: 'rerun-training', onSelect: () => navigate(`/models/train?task=${t.task}&from=${t.id}`),
                        }] : []),
                        ...(t.status === 'error' && mine(t) ? [{
                          label: 'Retry', hint: 'Submit it again on the snapshot it already cut',
                          testId: 'retry-training',
                          onSelect: () => retryTraining(t.id).then(refresh).catch((e: Error) => setError(e.message)),
                        }] : []),
                        ...(!isFinished(t.status) && mine(t) ? [{
                          label: 'Cancel', testId: 'cancel-training',
                          onSelect: () => cancelTraining(t.id).then(refresh).catch((e: Error) => setError(e.message)),
                        }] : []),
                        ...(isFinished(t.status) && mine(t) ? [{
                          label: 'Delete', hint: 'Frees its snapshot and checkpoint', testId: 'delete-training', danger: true,
                          onSelect: () => {
                            if (!window.confirm(`Delete training "${t.name}" and free its snapshot and checkpoint?`)) return
                            deleteTraining(t.id).then(refresh).catch((e: Error) => setError(e.message))
                          },
                        }] : []),
                      ]}
                    />
                  ),
                },
              ]}
            />
          )}
      </Section>}
    </div>
  )
}
