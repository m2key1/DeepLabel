/** A score's change against the model it was trained from, in percentage points, coloured
 *  by whether it is a gain; nothing when it is too small to matter. */
export function ScoreChange({ change, higherIsBetter = false }: { change: number | null; higherIsBetter?: boolean }) {
  if (change === null || Math.abs(change) < 0.0005) return null
  const gain = higherIsBetter ? change > 0 : change < 0
  return (
    <span data-testid="score-change" className={`ml-2 ${gain ? 'text-ok' : 'text-danger'}`}>
      {change < 0 ? '▼' : '▲'} {(Math.abs(change) * 100).toFixed(2)}
    </span>
  )
}
