import { Link } from 'react-router-dom'
import type { EvalScores, EvalSummary } from '../../api'
import { SubHeading } from '../ui/Section'
import { Table } from '../ui/Table'
import type { Column } from '../ui/Table'
import { Bar } from './Bar'
import { count, percent } from './format'

const PAGES_SHOWN = 25

function scoreColumns<T extends EvalScores>(peak: number): Column<T>[] {
  return [
    { key: 'lines', label: 'Lines', align: 'right', width: '6rem', cell: (row) => count(row.lines) },
    { key: 'cer', label: 'CER', width: '35%', cell: (row) => <Bar value={row.cer} peak={peak} label={percent(row.cer)} /> },
  ]
}

const peakOf = (rows: EvalScores[]) => Math.max(...rows.map((r) => r.cer), 0)

/** Where the errors sit - by line length, dataset and page - and whether the model's
 *  confidence means what it says. */
export function ContextTab({ summary }: { summary: EvalSummary }) {
  const pages = summary.by_page.slice(0, PAGES_SHOWN)
  return (
    <div data-testid="context-tab" className="space-y-6">
      <div className="overflow-x-auto" data-testid="by-length">
        <SubHeading>CER by line length (characters)</SubHeading>
        <Table caption="CER by line length" rows={summary.by_length} rowKey={(r) => r.bucket}
               rowProps={() => ({ 'data-testid': 'length-row' })}
               columns={[{ key: 'bucket', label: 'Length', cell: (r) => r.bucket }, ...scoreColumns(peakOf(summary.by_length))]} />
      </div>
      <div className="overflow-x-auto" data-testid="by-dataset">
        <SubHeading>CER by dataset</SubHeading>
        <Table caption="CER by dataset" rows={summary.by_dataset} rowKey={(r) => r.key}
               rowProps={() => ({ 'data-testid': 'dataset-row' })}
               columns={[{ key: 'name', label: 'Dataset', cell: (r) => <Link to={`/jobs/${r.key}`} className="hover:underline">{r.name}</Link> },
                         ...scoreColumns(peakOf(summary.by_dataset))]} />
      </div>
      <div className="overflow-x-auto" data-testid="by-page">
        <SubHeading>CER by page, worst {pages.length < summary.by_page.length ? `${pages.length} of ${summary.by_page.length}` : 'first'}</SubHeading>
        <Table caption="CER by page" rows={pages} rowKey={(r) => r.key}
               rowProps={() => ({ 'data-testid': 'page-row' })}
               columns={[{ key: 'page', label: 'Page', cell: (r) => r.job_id
                 ? <Link to={`/jobs/${r.job_id}/pages/${r.key}`} className="hover:underline">{r.filename ?? `page ${r.key}`}</Link>
                 : (r.filename ?? `page ${r.key}`) },
                         ...scoreColumns(peakOf(pages))]} />
      </div>
      <div className="overflow-x-auto" data-testid="calibration">
        <SubHeading>Confidence against correctness</SubHeading>
        <Table caption="Confidence against correctness" rows={summary.calibration} rowKey={(r) => r.bin}
               rowProps={(r) => ({ 'data-testid': 'calibration-row', 'data-bin': String(r.bin) } as React.HTMLAttributes<HTMLTableRowElement>)}
               columns={[
                 { key: 'bin', label: 'Confidence', cell: (r) => `${percent(r.bin, 0)}-${percent(Math.min(1, r.bin + 0.1), 0)}` },
                 { key: 'mean', label: 'Mean', align: 'right', cell: (r) => percent(r.mean_confidence, 1) },
                 { key: 'lines', label: 'Lines', align: 'right', cell: (r) => count(r.lines) },
                 { key: 'exact', label: 'Read exactly', width: '30%', cell: (r) => (
                   <Bar value={r.exact_share} peak={1} label={percent(r.exact_share, 1)} />) },
                 { key: 'cer', label: 'CER', align: 'right', cell: (r) => percent(r.cer) },
               ]} />
      </div>
    </div>
  )
}
