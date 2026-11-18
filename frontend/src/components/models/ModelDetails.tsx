import { useState } from 'react'
import { Link } from 'react-router-dom'
import type { ConventionFlag, Evaluation, LayoutTemplate, ModelUsage, OcrDecode, RegistryModel, Training } from '../../api'
import { conventionLabel } from '../conventionLabel'
import { DECODE_NAMES } from '../job/processing'
import { Badge } from '../ui/Badge'
import { Section } from '../ui/Section'
import { Table } from '../ui/Table'
import { formatDate, humanBytes } from '../../util'
import { formatScore } from './FamilyGraph'
import { ReportedMetrics } from './ReportedMetrics'
import { SOURCE_LABELS, automaticDecode, readsWithOwnDecoder } from './families'
import type { Family, Version } from './families'

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
        {` · ${DECODE_NAMES[ev.decode]} · ${ev.source_label ?? ''} · ${formatDate(ev.created_at)}`}
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
    return <Badge tone="warn" data-testid="model-files" data-roles="">not stored</Badge>
  }
  return (
    <span data-testid="model-files" data-roles={model.files.map((f) => f.role).join(' ')}
          className="rounded-full bg-raised px-2 py-0.5 font-mono text-[10px] text-ink-muted">
      {weights.sha256.slice(0, 8)} · {humanBytes(weights.size)}
    </span>
  )
}

/** The decodes a model reads with, by the names New job offers them under, marking the one a
 *  dataset on Automatic gets. */
function decodesOf(model: RegistryModel, models: RegistryModel[]): string {
  const offered: OcrDecode[] = [...(readsWithOwnDecoder(model, models) ? ['decoder' as const] : []),
                                'beam', 'rescored', 'greedy']
  const automatic = automaticDecode(model, models)
  return offered
    .map((mode) => (mode === automatic ? `${DECODE_NAMES[mode]} (what Automatic reads with)` : DECODE_NAMES[mode]))
    .join(', ')
}

function ReadingOrder({ template }: { template: LayoutTemplate | undefined }) {
  if (!template) return <>worked out from each page - it belongs to no layout template</>
  const outside = template.outside_order === 'top_to_bottom'
    ? 'top to bottom outside containers, as the Schematismus pipeline does'
    : "by the page's leaves and columns outside containers"
  return <>the <Link to="/templates" className="text-accent-ink hover:underline">{template.name}</Link> template's: {outside}</>
}

/** Everything else about a model: where it came from and what came of it, how it reads,
 *  every evaluation of it, and the files that hold it. */
export function ModelDetails({ model, models, family, version, run, evaluations, usage, templates, catalog,
                               canRun, onRetry, onCancel }: {
  model: RegistryModel
  models: RegistryModel[]
  family: Family
  version: Version
  run: Training | null
  evaluations: Evaluation[]
  usage: ModelUsage | null
  templates: LayoutTemplate[]
  catalog: ConventionFlag[] | null
  canRun: (ev: Evaluation) => boolean
  onRetry: (ev: Evaluation) => void
  onCancel: (ev: Evaluation) => void
}) {
  const older = model.supersedes !== null ? models.find((m) => m.id === model.supersedes) : undefined
  const newer = models.find((m) => m.supersedes === model.id && !m.archived)
  return (
    <div data-testid="model-details">
      <Section title="Lineage"><Lineage family={family} version={version} /></Section>

      <Section title="Reads with">
        <dl className="grid grid-cols-[10rem_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-ink-muted">Source</dt>
          <dd data-testid="model-source">{SOURCE_LABELS[model.source]}</dd>
          {model.task === 'ocr' && <>
            <dt className="text-ink-muted">Decodes</dt>
            <dd data-testid="model-decodes">{decodesOf(model, models)}</dd>
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
          {usage && <>
            <dt className="text-ink-muted">Used by</dt>
            <dd data-testid="model-used-by">{usage.datasets} dataset{usage.datasets === 1 ? '' : 's'} read with it</dd>
          </>}
        </dl>
      </Section>

      <Section title="Every evaluation">
        {evaluations.length === 0
          ? <p className="text-xs text-ink-subtle">Not evaluated yet.</p>
          : <div className="space-y-1">{evaluations.map((ev) => (
              <EvaluationLine key={ev.id} ev={ev} canRun={canRun(ev)}
                              onRetry={() => onRetry(ev)} onCancel={() => onCancel(ev)} />
            ))}</div>}
      </Section>

      <Section title="Stored files">
        <StoredFiles model={model} />
        {model.files.length === 0
          ? <p className="mt-2 text-xs text-ink-subtle">
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
    </div>
  )
}
