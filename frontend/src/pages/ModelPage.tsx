import { useCallback, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  cancelEvaluation, getLayoutTemplates, getModelUsage, listConventionFlags, listEvaluations, listModels, listTrainings,
  patchModel, retryEvaluation,
} from '../api'
import type { ConventionFlag, Evaluation, LayoutTemplate, ModelUsage, RegistryModel, Training } from '../api'
import { conventionLabel } from '../components/conventionLabel'
import { useAuth } from '../auth'
import { useCrumb } from '../components/NavBar'
import { EditModelDialog } from '../components/models/EditModelDialog'
import { EvaluateDialog } from '../components/models/EvaluateDialog'
import { buildFamilies } from '../components/models/families'
import type { Family, Version } from '../components/models/families'
import { formatScore } from '../components/models/FamilyGraph'
import { ReportedMetrics } from '../components/models/ReportedMetrics'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { PageHeader } from '../components/ui/PageHeader'
import { Section } from '../components/ui/Section'
import { StatRow, StatTile } from '../components/ui/StatTile'
import { Table } from '../components/ui/Table'
import { pageShell } from '../components/ui/page'
import { usePolling } from '../hooks/usePolling'
import { useAutoClear } from '../messages'
import { formatDate, humanBytes } from '../util'
import { DECODE_CHOICES } from '../components/job/processing'

const STAGE: Record<string, string> = { layout: 'Layout detection', lines: 'Line segmentation', ocr: 'OCR' }

function Lineage({ family, version }: { family: Family; version: Version }) {
  const byKey = new Map(family.versions.map((v) => [v.key, v]))
  const chain: Version[] = []
  for (let at: Version | undefined = version; at; at = at.parentKey ? byKey.get(at.parentKey) : undefined) chain.unshift(at)
  const forks = family.versions.filter((v) => v.parentKey === version.key && v.model)
  return (
    <div data-testid="lineage" className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
      {chain.map((v, i) => (
        <span key={v.key} className="flex items-center gap-2">
          {i > 0 && <span aria-hidden className="text-ink-subtle">→</span>}
          {v.key === version.key
            ? <span data-testid="lineage-step" className="font-semibold text-ink">{v.name}</span>
            : <Link to={`/models/${v.model!.id}`} data-testid="lineage-step" className="text-accent-ink hover:underline">{v.name}</Link>}
          <span className="text-xs tabular-nums text-ink-subtle">{formatScore(v.score)}</span>
        </span>
      ))}
      {forks.length > 0 && (
        <span data-testid="lineage-forks" className="basis-full text-xs text-ink-muted">
          {forks.length === 1 ? '1 fine-tune' : `${forks.length} fine-tunes`} from it:{' '}
          {forks.map((f, i) => (
            <span key={f.key}>
              {i > 0 && ', '}
              <Link to={`/models/${f.model!.id}`} className="text-accent-ink hover:underline">{f.name}</Link>
              {' '}{formatScore(f.score)}{f.archived && ' (archived)'}
            </span>
          ))}
        </span>
      )}
    </div>
  )
}

function EvaluationLine({ ev, canRun, onRetry, onCancel }: {
  ev: Evaluation; canRun: boolean; onRetry: () => void; onCancel: () => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <span data-testid="eval-row" className="block text-xs text-ink-muted">
        {ev.status === 'done' && ev.cer !== null ? (
          <>
            <span className="font-medium text-ink">CER {ev.cer.toFixed(4)}</span>
            {ev.wer !== null && ` · WER ${ev.wer.toFixed(4)}`}
            {ev.line_count !== null && ` · ${ev.line_count} lines`}
          </>
        ) : (
          <span className={ev.status === 'error' ? 'text-danger' : ''}>{ev.status}{ev.error ? ` - ${ev.error}` : ''}</span>
        )}
        {` · ${ev.decode} · ${ev.source_label ?? ''} · ${formatDate(ev.created_at)}`}
        <Link to={`/evaluations/${ev.id}`} data-testid="evaluation-page" className="ml-2 text-ink-subtle hover:text-accent-ink">
          open
        </Link>
        {canRun && (ev.status === 'error' || ev.status === 'cancelled') && (
          <button data-testid="retry-evaluation" onClick={onRetry} className="ml-2 text-ink-subtle hover:text-accent-ink">
            retry
          </button>
        )}
        {canRun && (ev.status === 'queued' || ev.status === 'running') && (
          <button data-testid="cancel-evaluation" onClick={onCancel} className="ml-2 text-ink-subtle hover:text-danger">
            cancel
          </button>
        )}
        {(ev.breakdown?.length ?? 0) > 0 && (
          <button data-testid="breakdown-toggle" onClick={() => setOpen(!open)}
                  className="ml-2 text-ink-subtle hover:text-accent-ink">
            {open ? 'hide datasets' : 'per dataset'}
          </button>
        )}
      </span>
      {open && ev.breakdown?.map((row) => (
        <span key={row.job_id} data-testid="breakdown-row" className="block pl-4 text-xs text-ink-subtle">
          {row.name}: CER {row.cer.toFixed(4)} · WER {row.wer.toFixed(4)} · {row.lines} lines
        </span>
      ))}
    </div>
  )
}

function StoredFiles({ model }: { model: RegistryModel }) {
  const weights = model.files.find((f) => f.role === 'weights')
  if (!weights) {
    return (
      <Badge tone="warn" data-testid="model-files" data-roles=""
             title="Not in the weight store yet: python -m app.weights import-existing on the backend">
        not stored
      </Badge>
    )
  }
  return (
    <span data-testid="model-files" data-roles={model.files.map((f) => f.role).join(' ')}
          className="rounded-full bg-raised px-2 py-0.5 font-mono text-[10px] text-ink-muted">
      {weights.sha256.slice(0, 8)} · {humanBytes(weights.size)}
    </span>
  )
}

function ReadingOrder({ template }: { template: LayoutTemplate | undefined }) {
  if (!template) return <>worked out from each page - it belongs to no layout template</>
  const outside = template.outside_order === 'top_to_bottom'
    ? 'top to bottom outside containers, as the Schematismus pipeline does'
    : "by the page's leaves and columns outside containers"
  return <>the <Link to="/templates" className="text-accent-ink hover:underline">{template.name}</Link> template's: {outside}</>
}

const SOURCE_LABELS: Record<RegistryModel['source'], string> = {
  builtin: 'Shipped with DeepLabel',
  backend: 'Shipped with its backend',
  imported: 'Imported',
  trained: 'Trained',
}

export function ModelPage() {
  const { id } = useParams()
  const modelId = Number(id)
  const { user, canEdit, isAdmin, can } = useAuth()
  const managesModels = can('models.manage')
  const [models, setModels] = useState<RegistryModel[] | null>(null)
  const [trainings, setTrainings] = useState<Training[]>([])
  const [evaluations, setEvaluations] = useState<Evaluation[]>([])
  const [usage, setUsage] = useState<ModelUsage | null>(null)
  const [templates, setTemplates] = useState<LayoutTemplate[]>([])
  const [catalog, setCatalog] = useState<ConventionFlag[] | null>(null)
  const [editing, setEditing] = useState(false)
  const [evaluating, setEvaluating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useAutoClear(error, setError)

  const refresh = useCallback(() => {
    listModels(true).then((r) => setModels(r.models)).catch((e: Error) => setError(e.message))
    listTrainings().then((r) => setTrainings(r.trainings)).catch(() => {})
    listEvaluations().then((r) => setEvaluations(r.evaluations)).catch(() => {})
    getModelUsage(modelId).then(setUsage).catch(() => {})
    getLayoutTemplates().then(setTemplates).catch(() => {})
    listConventionFlags().then((r) => setCatalog(r.flags)).catch(() => {})
  }, [modelId])
  usePolling(refresh, 10000)

  const model = models?.find((m) => m.id === modelId) ?? null
  useCrumb(model?.name ?? 'Model')
  if (models === null) return <div className={pageShell}><p className="text-sm text-ink-muted">Loading…</p></div>
  if (!model) return <div className={pageShell}><p className="text-sm text-ink-muted">No model #{modelId}.</p></div>

  const family = buildFamilies(models.filter((m) => m.task === model.task), trainings, evaluations)
    .find((f) => f.versions.some((v) => v.key === `m${model.id}`))!
  const version = family.versions.find((v) => v.key === `m${model.id}`)!
  const run = version.run
  const own = model.owner === user
  const evals = evaluations.filter((ev) => ev.model_id === model.id)
  const base = model.trained_from !== null ? models.find((m) => m.id === model.trained_from) : undefined
  const older = model.supersedes !== null ? models.find((m) => m.id === model.supersedes) : undefined
  const newer = models.find((m) => m.supersedes === model.id && !m.archived)
  const baseOnSameTest = run && evaluations.find((ev) => ev.model_id === base?.id && ev.training_id === run.id
    && ev.source.jobs !== undefined && ev.status === 'done' && ev.decode === 'beam' && ev.cer !== null)
  const valid = evals.find((ev) => run && ev.source.snapshot === run.id && ev.status === 'done' && ev.decode === 'beam')

  const apply = (body: { is_default?: boolean; archived?: boolean }) =>
    patchModel(model.id, body).then(refresh).catch((e: Error) => setError(e.message))

  return (
    <div className={pageShell}>
      <nav className="mb-2 text-xs text-ink-subtle">
        <Link to="/models" className="hover:text-accent-ink">Models</Link>
        {' / '}{STAGE[model.task]} · {family.name} family
      </nav>
      <PageHeader
        title={<span className="flex items-center gap-2">{model.name}
          {model.is_default && <Badge tone="accent">★ DEFAULT</Badge>}
          {model.archived && <Badge>ARCHIVED</Badge>}
          <span data-testid="model-source" className="rounded-full bg-raised px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-ink-muted">
            {model.source}
          </span>
          <StoredFiles model={model} /></span>}
        actions={<>
          {canEdit && model.task === 'ocr' && !model.archived && (
            <Button size="xs" onClick={() => setEvaluating(true)}>Evaluate…</Button>
          )}
          {managesModels && !model.is_default && !model.archived && (
            <Button size="xs" onClick={() => apply({ is_default: true })}>Set default</Button>
          )}
          {(managesModels || own) && <Button size="xs" onClick={() => setEditing(true)}>Edit</Button>}
          {(managesModels || own) && !model.is_default && (
            <Button size="xs" data-testid="archive-model" onClick={() => apply({ archived: !model.archived })}>
              {model.archived ? 'Unarchive' : 'Archive'}
            </Button>
          )}
        </>}
      >
        {SOURCE_LABELS[model.source]}
        {' '}{formatDate(model.created_at)}
        {model.owner && <span data-testid="model-owner"> by {model.owner === user ? 'you' : model.owner}</span>}
        {run && <> · from run <Link to={`/models/runs/${run.id}`} data-testid="model-from-run"
                                    className="text-accent-ink hover:underline">{run.name}</Link></>}
      </PageHeader>
      {error && <p className="mb-4 text-sm text-danger">{error}</p>}

      <Section title="Lineage"><Lineage family={family} version={version} /></Section>

      <StatRow className="mb-8">
        <StatTile data-testid="model-score" label={version.score?.kind === 'test' ? 'Test CER · beam' : 'Score'}
                  value={formatScore(version.score)} />
        {valid?.cer != null && <StatTile label="Valid CER" value={`${(valid.cer * 100).toFixed(2)}%`} />}
        {baseOnSameTest && version.score?.kind === 'test' && base && (
          <StatTile data-testid="model-vs-base" label="vs its base"
                    value={`${((version.score.value - baseOnSameTest.cer!) * 100).toFixed(2)} pt`}
                    note={`${base.name} read ${(baseOnSameTest.cer! * 100).toFixed(2)}%`}
                    tone={version.score.value <= baseOnSameTest.cer! ? 'good' : 'bad'} />
        )}
        {usage && <StatTile data-testid="model-used-by" label="Used by" value={usage.datasets}
                            note={usage.datasets === 1 ? 'dataset reads with it' : 'datasets read with it'} />}
      </StatRow>

      <Section title="Reads with">
        <dl className="grid grid-cols-[10rem_1fr] gap-x-4 gap-y-1 text-sm">
          {model.task === 'ocr' && <>
            <dt className="text-ink-muted">Decodes</dt>
            <dd>{DECODE_CHOICES.map(([value]) => value).join(', ')} (beam by default)</dd>
            <dt className="text-ink-muted">Beam LM</dt>
            <dd>{model.lm_path ? model.lm_path.split('/').pop() : 'none - decodes by decoder rescoring'}</dd>
            <dt className="text-ink-muted">Input size</dt>
            <dd>{model.target_height ? `${model.target_height} px high, up to ${model.max_width} wide` : 'known once it has read a page'}</dd>
            <dt className="text-ink-muted">Conventions</dt>
            <dd data-testid="model-conventions">{model.conventions === null ? 'known once it has read a page'
              : model.conventions.length === 0 ? 'one convention only'
                : `knows ${model.conventions.length}: ${model.conventions.map((c) => conventionLabel(c, catalog).toLowerCase()).join(', ')}`}</dd>
          </>}
          {model.metrics && <>
            <dt className="text-ink-muted">Training reported</dt>
            <dd><ReportedMetrics metrics={model.metrics} info={run?.metric_info} /></dd>
          </>}
          {model.task === 'layout' && <>
            <dt className="text-ink-muted">Reading order</dt>
            <dd data-testid="model-reading-order"><ReadingOrder template={templates.find((t) => t.id === model.layout_template_id)} /></dd>
          </>}
          {(older || newer) && <>
            <dt className="text-ink-muted">Version</dt>
            <dd data-testid="model-versions">
              {older && <>New version of <Link to={`/models/${older.id}`} className="text-accent-ink hover:underline">{older.name}</Link></>}
              {older && newer && ' · '}
              {newer && <>Replaced by <Link to={`/models/${newer.id}`} className="text-accent-ink hover:underline">{newer.name}</Link></>}
            </dd>
          </>}
          <dt className="text-ink-muted">Runs on</dt>
          <dd data-testid="model-runs-on">{model.runs_on ? `model backend "${model.runs_on}"` : 'no configured model backend'}</dd>
          <dt className="text-ink-muted">Notes</dt>
          <dd data-testid="model-notes">{model.notes ?? <span className="text-ink-subtle">none</span>}</dd>
        </dl>
      </Section>

      <Section title="Evaluations">
        {evals.length === 0
          ? <p className="text-xs text-ink-subtle">Not evaluated yet.</p>
          : <div className="space-y-1">{evals.map((ev) => (
              <EvaluationLine key={ev.id} ev={ev} canRun={isAdmin || ev.owner === user}
                              onRetry={() => retryEvaluation(ev.id).then(refresh).catch((e: Error) => setError(e.message))}
                              onCancel={() => cancelEvaluation(ev.id).then(refresh).catch((e: Error) => setError(e.message))} />
            ))}</div>}
      </Section>

      <Section title="Stored files">
        {model.files.length === 0
          ? <p className="text-xs text-ink-subtle">
              Not in the weight store yet: python -m app.weights import-existing on the backend.
            </p>
          : <Table caption="Stored files" rows={model.files} rowKey={(f) => f.role}
                   rowProps={() => ({ 'data-testid': 'model-file-row' })}
                   columns={[
                     { key: 'role', label: 'Role', cell: (f) => f.role },
                     { key: 'file', label: 'File', cell: (f) => f.filename },
                     { key: 'size', label: 'Size', align: 'right', cell: (f) => humanBytes(f.size) },
                     { key: 'sha', label: 'SHA-256', cell: (f) => <span className="font-mono text-xs">{f.sha256}</span> },
                   ]} />}
      </Section>

      {run && (
        <Section title="Run">
          <p className="text-sm text-ink-muted">
            Trained by run <Link to={`/models/runs/${run.id}`} className="text-accent-ink hover:underline">{run.name}</Link>;
            its page has the datasets, split and every setting it ran with.
          </p>
        </Section>
      )}

      {evaluating && <EvaluateDialog model={model} onClose={() => setEvaluating(false)} onStarted={refresh} />}
      {editing && <EditModelDialog model={model} onClose={() => setEditing(false)} onSaved={refresh} onError={setError}
                                   familyName={managesModels && family.root.id === model.id ? model.family_name ?? '' : undefined}
                                   models={managesModels ? models : undefined} />}
    </div>
  )
}
