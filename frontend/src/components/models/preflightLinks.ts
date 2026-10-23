import type { PreflightJoint, PreflightMetric } from '../../api'

/** How many of the lines in one bar of `from` each bar of `to` holds. The pre-flight
 *  stores each pair of distributions once, so the other order reads its column. */
export function linkedCounts(
  joint: PreflightJoint | null | undefined, from: PreflightMetric, bin: number, to: PreflightMetric,
): number[] | null {
  const direct = joint?.[from]?.[to]
  if (direct) return direct[bin] ?? null
  const reverse = joint?.[to]?.[from]
  return reverse ? reverse.map((row) => row[bin] ?? 0) : null
}
