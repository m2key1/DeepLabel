import type { EvalLineFilter } from '../../api'

const finite = (value: number) => (Number.isFinite(value) ? value : undefined)

/** The table's filter, kept in the URL so a link reopens the same view. CER bounds are
 *  stored as fractions; a bound that is not a number is no bound. */
export function readFilter(params: URLSearchParams): EvalLineFilter {
  const bound = (key: string) => (params.get(key) ? finite(Number(params.get(key))) : undefined)
  return { cer_min: bound('cer_min'), cer_max: bound('cer_max'),
           job_id: params.get('job') ?? undefined, q: params.get('q') ?? undefined }
}

/** A typed percentage as the fraction the URL keeps, or null for no bound. A decimal comma
 *  reads as a point. */
export function percentToFraction(text: string): string | null {
  const trimmed = text.trim().replace(',', '.')
  if (trimmed === '') return null
  const value = finite(Number(trimmed))
  return value === undefined ? null : String(value / 100)
}

/** A stored fraction as the percentage typed for it, without float noise (0.07 is "7"). */
export function fractionToPercent(fraction: number | undefined): string {
  return fraction === undefined ? '' : String(+(fraction * 100).toFixed(4))
}
