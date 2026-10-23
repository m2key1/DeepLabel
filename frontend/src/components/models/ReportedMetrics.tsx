import type { MetricInfo } from '../../api'
import { DETAIL_GROUP, groupReported } from './metrics'
import type { ReportedGroup } from './metrics'

function Values({ group }: { group: ReportedGroup }) {
  return (
    <dl className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-x-6 gap-y-0.5 text-xs">
      {group.values.map((v) => (
        <div key={v.key} data-testid={`model-metric-${v.key}`} title={v.key}
             className="flex items-baseline justify-between gap-3 border-b border-line py-0.5">
          <dt className={v.headline ? 'font-semibold text-ink' : 'text-ink-muted'}>{v.label}</dt>
          <dd className={`font-mono tabular-nums ${v.headline ? 'font-semibold text-ink' : 'text-ink'}`}>{v.value}</dd>
        </div>
      ))}
    </dl>
  )
}

/** What a run reported at its end, in labelled groups rather than one run-on line; what its
 *  backend declared as detail stays folded. */
export function ReportedMetrics({ metrics, info }: { metrics: Record<string, unknown>; info: MetricInfo[] | null | undefined }) {
  return (
    <div data-testid="model-metrics" className="space-y-3">
      {groupReported(metrics, info).map((group) => group.title === DETAIL_GROUP
        ? (
          <details key={group.title} data-group={group.title}>
            <summary className="cursor-pointer text-xs font-semibold text-ink-muted">
              {group.title} <span className="font-normal text-ink-subtle">· {group.values.length}</span>
            </summary>
            <div className="mt-1"><Values group={group} /></div>
          </details>
        )
        : (
          <div key={group.title} data-group={group.title}>
            <h3 className="mb-1 text-xs font-semibold text-ink-muted">{group.title}</h3>
            <Values group={group} />
          </div>
        ))}
    </div>
  )
}
