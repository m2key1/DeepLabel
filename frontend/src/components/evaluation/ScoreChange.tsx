/** A score's change against the model it was trained from, in percentage points; nothing
 *  when it is too small to matter. */
export function ScoreChange({ change }: { change: number | null }) {
  if (change === null || Math.abs(change) < 0.0005) return null
  return (
    <span data-testid="score-change" className={`ml-2 ${change < 0 ? 'text-ok' : 'text-danger'}`}>
      {change < 0 ? '▼' : '▲'} {(Math.abs(change) * 100).toFixed(2)}
    </span>
  )
}
