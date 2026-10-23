import type { EvalSummary } from '../../api'
import { StatRow, StatTile } from '../ui/StatTile'
import { count, percent } from './format'

const CLASS_LABEL: Record<string, string> = {
  letters: 'letters', digits: 'digits', punctuation: 'punctuation', whitespace: 'whitespace', other: 'other',
}

/** The figures across the top: the error rates, bag-of-words precision and recall, where
 *  the edits went, and how each kind of character fared. */
export function Headline({ summary }: { summary: EvalSummary }) {
  const { headline: head } = summary
  const { edits } = head
  return (
    <div className="mb-6 space-y-2">
      <StatRow>
        <StatTile data-testid="headline-cer" label="CER" value={percent(head.cer)} note={`${count(head.chars)} chars`} />
        <StatTile data-testid="headline-wer" label="WER" value={percent(head.wer)} note={`${count(head.words)} words`} />
        <StatTile data-testid="headline-bow-wer" label="bag-of-words WER" value={percent(head.bow_wer)}
                  title="Word errors with word order ignored" />
        <StatTile data-testid="headline-bow-precision" label="bag-of-words precision" value={percent(head.bow_precision)}
                  title="Words read that are in the line's ground truth, order ignored" />
        <StatTile data-testid="headline-bow-recall" label="bag-of-words recall" value={percent(head.bow_recall)}
                  title="Ground-truth words that were read, order ignored" />
        <StatTile data-testid="headline-lines" label="lines" value={count(head.lines)} />
        <StatTile data-testid="headline-substitutions" label="substitutions" value={count(edits.substitutions)}
                  note={percent(edits.shares.substitutions, 0)} />
        <StatTile data-testid="headline-insertions" label="insertions" value={count(edits.insertions)}
                  note={percent(edits.shares.insertions, 0)} />
        <StatTile data-testid="headline-deletions" label="deletions" value={count(edits.deletions)}
                  note={percent(edits.shares.deletions, 0)} />
      </StatRow>
      <StatRow>
        {head.classes.map((c) => (
          <StatTile key={c.name} data-testid={`class-${c.name}`} label={`${CLASS_LABEL[c.name] ?? c.name} accuracy`}
                    value={percent(c.accuracy, 1)} note={`of ${count(c.total)}`} />
        ))}
        <StatTile data-testid="class-case" label="case errors" value={count(head.case_errors.count)}
                  note={`${percent(head.case_errors.share, 0)} of substitutions`} />
      </StatRow>
    </div>
  )
}
