import { Link } from 'react-router-dom'
import type { EvalConfusion, EvalSummary } from '../../api'
import { EmptyState } from '../ui/EmptyState'
import { SubHeading } from '../ui/Section'
import { Table } from '../ui/Table'
import { LineDiff } from './LineDiff'
import { count, editorLink, visibleGlyph } from './format'

function Example({ confusion }: { confusion: EvalConfusion }) {
  const to = editorLink(confusion.example)
  const diff = <LineDiff ops={confusion.example.ops} />
  return to ? <Link to={to} className="hover:underline">{diff}</Link> : diff
}

const glyphCell = (char: string) => <span className="font-ocr text-base">{visibleGlyph(char)}</span>

function ConfusionTable({ title, testid, rows, columns }: {
  title: string
  testid: string
  rows: EvalConfusion[]
  columns: { key: string; label: string; cell: (row: EvalConfusion) => React.ReactNode }[]
}) {
  return (
    <div className="mb-6" data-testid={testid}>
      <SubHeading>{title}</SubHeading>
      {rows.length === 0 ? (
        <EmptyState>None.</EmptyState>
      ) : (
        <div className="overflow-x-auto">
          <Table
            caption={title}
            rows={rows}
            rowKey={(row) => `${row.ref}\u0000${row.hyp}`}
            rowProps={() => ({ 'data-testid': 'confusion-row' })}
            columns={[
              ...columns,
              { key: 'count', label: 'Times', align: 'right', width: '5rem', cell: (row) => count(row.count) },
              { key: 'example', label: 'Example', cell: (row) => <Example confusion={row} /> },
            ]}
          />
        </div>
      )}
    </div>
  )
}

/** Which characters the model reads as which, and what it adds and drops - the most
 *  frequent first, each with the first line it happened on. */
export function ConfusionsTab({ summary }: { summary: EvalSummary }) {
  const { substitutions, insertions, deletions } = summary.confusions
  return (
    <div data-testid="confusions-tab">
      <ConfusionTable title="Substitutions" testid="confusions-substitutions" rows={substitutions} columns={[
        { key: 'ref', label: 'Truth', cell: (row) => glyphCell(row.ref) },
        { key: 'hyp', label: 'Read as', cell: (row) => glyphCell(row.hyp) },
      ]} />
      <ConfusionTable title="Insertions" testid="confusions-insertions" rows={insertions} columns={[
        { key: 'hyp', label: 'Added', cell: (row) => glyphCell(row.hyp) },
      ]} />
      <ConfusionTable title="Deletions" testid="confusions-deletions" rows={deletions} columns={[
        { key: 'ref', label: 'Missed', cell: (row) => glyphCell(row.ref) },
      ]} />
    </div>
  )
}
