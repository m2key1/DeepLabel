import type { EvalSummary } from '../../api'
import { SubHeading } from '../ui/Section'
import { Table } from '../ui/Table'
import { Bar } from './Bar'
import { count, percent, visibleGlyph } from './format'

const codepoint = (char: string) =>
  [...char].map((c) => `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`).join(' ')

/** Every glyph's error rate beside how often it occurs, and the test material's
 *  characters against what the model was trained on. */
export function CharactersTab({ summary }: { summary: EvalSummary }) {
  const peak = Math.max(...summary.characters.map((c) => c.total), 1)
  const testPeak = Math.max(...summary.frequency.map((c) => c.test_share), 0)
  const trainPeak = Math.max(...summary.frequency.map((c) => c.train_share ?? 0), 0)
  return (
    <div data-testid="characters-tab">
      <div className="mb-6 overflow-x-auto">
        <SubHeading>Error rate per glyph</SubHeading>
        <Table
          caption="Error rate per glyph"
          rows={summary.characters}
          rowKey={(row) => row.char}
          rowProps={(row) => ({ 'data-testid': 'glyph-row', 'data-char': codepoint(row.char) } as React.HTMLAttributes<HTMLTableRowElement>)}
          columns={[
            { key: 'char', label: 'Glyph', cell: (row) => <span className="font-ocr text-base">{visibleGlyph(row.char)}</span> },
            { key: 'cp', label: 'Codepoint', cell: (row) => <span className="font-mono text-[11px] text-ink-muted">{codepoint(row.char)}</span> },
            { key: 'class', label: 'Class', cell: (row) => <span className="text-xs text-ink-muted">{row.class}</span> },
            { key: 'total', label: 'In truth', width: '22%', cell: (row) => <Bar value={row.total} peak={peak} label={count(row.total)} /> },
            { key: 'errors', label: 'Errors', align: 'right', cell: (row) => count(row.errors) },
            { key: 'rate', label: 'Error rate', align: 'right', cell: (row) => percent(row.rate, 1) },
            { key: 'inserted', label: 'Inserted', align: 'right', cell: (row) => count(row.inserted) },
          ]}
        />
      </div>
      <div className="overflow-x-auto" data-testid="frequency">
        <SubHeading>Frequency against the training data</SubHeading>
        {!summary.train_known && (
          <p className="mb-1 text-xs text-ink-subtle" data-testid="train-unknown">
            The model was not trained here, or its run kept no pre-flight, so the training data's characters are not known.
          </p>
        )}
        <Table
          caption="Character frequency, test against training"
          rows={summary.frequency}
          rowKey={(row) => row.char}
          rowProps={() => ({ 'data-testid': 'frequency-row' })}
          columns={[
            { key: 'char', label: 'Glyph', cell: (row) => <span className="font-ocr text-base">{visibleGlyph(row.char)}</span> },
            { key: 'test', label: 'Test share', width: '30%', cell: (row) => (
              <Bar value={row.test_share} peak={testPeak} label={percent(row.test_share)} />) },
            { key: 'train', label: 'Training share', width: '30%', cell: (row) => row.train_share === null ? '-' : (
              <Bar value={row.train_share} peak={trainPeak} label={percent(row.train_share)} />) },
            { key: 'note', label: '', cell: (row) => row.train === 0 && row.test > 0
              ? <span className="text-xs text-warn">never trained on</span> : null },
          ]}
        />
      </div>
    </div>
  )
}
