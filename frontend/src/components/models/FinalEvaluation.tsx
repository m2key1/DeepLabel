import type { Evaluation, FinalEvaluation, TestEvaluation } from '../../api'
import { percent } from '../evaluation/format'
import { cardChrome } from '../ui/Card'

const LINE_COLUMNS = ['F1', 'precision', 'recall'] as const

/** The trained model's own reading of the validation pages, overall and per dataset, and
 *  for layout per class - what the per-dataset CER is to an OCR run. */
export function FinalEvaluationTable({ evaluation, datasets }: {
  evaluation: FinalEvaluation
  datasets: Record<string, string>
}) {
  if (evaluation.error) {
    return <p data-testid="final-evaluation-error" className="text-xs text-danger">{evaluation.error}</p>
  }
  const columns = evaluation.metric === 'mAP50' ? ['mAP50'] : [...LINE_COLUMNS]
  const rows = [
    { id: 'overall', label: 'all validation pages', scores: evaluation.overall },
    ...Object.entries(evaluation.by_dataset).map(([id, scores]) => ({ id, label: datasets[id] ?? id, scores })),
  ]
  const classes = Object.entries(evaluation.overall.by_class ?? {})
  return (
    <div className="space-y-3">
      <table data-testid="final-evaluation" className={`w-full ${cardChrome} text-xs`}>
        <thead className="text-left text-ink-subtle">
          <tr>
            <th className="p-2 font-normal">dataset</th>
            <th className="p-2 text-right font-normal">pages</th>
            <th className="p-2 text-right font-normal">{evaluation.metric === 'mAP50' ? 'boxes' : 'lines'}</th>
            {columns.map((c) => <th key={c} className="p-2 text-right font-normal">{c}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} data-dataset={row.id} className="border-t border-line">
              <td className={`p-2 ${row.id === 'overall' ? 'font-semibold text-ink' : 'text-ink'}`}>{row.label}</td>
              <td className="p-2 text-right font-mono tabular-nums">{row.scores.pages ?? '-'}</td>
              <td className="p-2 text-right font-mono tabular-nums">{row.scores.instances ?? '-'}</td>
              {columns.map((c) => (
                <td key={c} data-score={c} className="p-2 text-right font-mono tabular-nums text-ink">
                  {typeof row.scores[c] === 'number' ? percent(row.scores[c]) : '-'}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {classes.length > 0 && (
        <table data-testid="final-evaluation-classes" className={`w-full ${cardChrome} text-xs`}>
          <thead className="text-left text-ink-subtle">
            <tr>
              <th className="p-2 font-normal">class</th>
              <th className="p-2 text-right font-normal">boxes</th>
              <th className="p-2 text-right font-normal">AP50</th>
            </tr>
          </thead>
          <tbody>
            {classes.sort(([, a], [, b]) => b.instances - a.instances).map(([name, score]) => (
              <tr key={name} data-class={name} className="border-t border-line">
                <td className="p-2 text-ink">{name}</td>
                <td className="p-2 text-right font-mono tabular-nums">{score.instances}</td>
                <td className="p-2 text-right font-mono tabular-nums text-ink">{percent(score.AP50)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

/** An OCR run's test-set scores in the shape a layout or lines run reports them, so both
 *  are read off the same table: the stored per-dataset breakdown is its rows. */
export function ocrTestEvaluation(trained: Evaluation, base: Evaluation | null): TestEvaluation {
  const asScores = (ev: Evaluation): FinalEvaluation => ({
    metric: 'CER',
    overall: { CER: ev.cer ?? NaN, instances: ev.line_count ?? NaN },
    by_dataset: Object.fromEntries((ev.breakdown ?? []).map((row) => [row.job_id, { CER: row.cer, instances: row.lines }])),
  })
  return { trained: asScores(trained), base: base ? asScores(base) : undefined }
}

/** The test datasets read by the base model and by the trained one, side by side: whether
 *  the run helped, on pages it never saw. */
export function TestEvaluationTable({ evaluation, datasets }: {
  evaluation: TestEvaluation
  datasets: Record<string, string>
}) {
  const { trained, base } = evaluation
  if (trained.error) {
    return <p data-testid="test-evaluation-error" className="text-xs text-danger">{trained.error}</p>
  }
  const metric = trained.metric
  // An error rate improves by going down; every other metric here by going up.
  const better = (change: number) => (metric === 'CER' ? change <= 0 : change >= 0)
  // An OCR score counts lines, not pages.
  const byPage = metric !== 'CER'
  const baseScores = base && !base.error ? base : null
  const rows = [
    { id: 'overall', label: 'all test pages', scores: trained.overall, before: baseScores?.overall },
    ...Object.entries(trained.by_dataset).map(([id, scores]) => (
      { id, label: datasets[id] ?? id, scores, before: baseScores?.by_dataset[id] })),
  ]
  return (
    <div className="space-y-2">
      <table data-testid="test-evaluation" className={`w-full ${cardChrome} text-xs`}>
        <thead className="text-left text-ink-subtle">
          <tr>
            <th className="p-2 font-normal">dataset</th>
            {byPage && <th className="p-2 text-right font-normal">pages</th>}
            <th className="p-2 text-right font-normal">{metric === 'mAP50' ? 'boxes' : 'lines'}</th>
            <th className="p-2 text-right font-normal">base {metric}</th>
            <th className="p-2 text-right font-normal">trained {metric}</th>
            <th className="p-2 text-right font-normal">change</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const after = row.scores[metric]
            const before = row.before?.[metric]
            const change = typeof after === 'number' && typeof before === 'number' ? (after - before) * 100 : null
            return (
              <tr key={row.id} data-dataset={row.id} className="border-t border-line">
                <td className={`p-2 ${row.id === 'overall' ? 'font-semibold text-ink' : 'text-ink'}`}>{row.label}</td>
                {byPage && <td className="p-2 text-right font-mono tabular-nums">{row.scores.pages ?? '-'}</td>}
                <td className="p-2 text-right font-mono tabular-nums">{row.scores.instances ?? '-'}</td>
                <td data-score="base" className="p-2 text-right font-mono tabular-nums">{percent(before)}</td>
                <td data-score="trained" className="p-2 text-right font-mono tabular-nums text-ink">{percent(after)}</td>
                <td data-score="change"
                    className={`p-2 text-right font-mono tabular-nums ${change === null ? '' : better(change) ? 'text-ok' : 'text-danger'}`}>
                  {change === null ? '-' : `${change >= 0 ? '+' : ''}${change.toFixed(2)} pt`}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {base?.error && <p data-testid="test-evaluation-base-error" className="text-xs text-ink-subtle">
        The base model could not be scored: {base.error}</p>}
    </div>
  )
}
