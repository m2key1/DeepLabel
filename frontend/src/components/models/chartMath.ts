export interface XY {
  x: number
  y: number
}

export type Domain = [number, number]

/** TensorBoard's smoothing: an exponential moving average debiased by the weight the
 *  zero start carries, so the first value is the first reading rather than a fraction of it. */
export function debiasedEma(ys: number[], weight: number): number[] {
  if (weight <= 0) return [...ys]
  let last = 0
  let seen = 0
  return ys.map((y) => {
    if (!Number.isFinite(y)) return y
    last = last * weight + (1 - weight) * y
    seen += 1
    return last / (1 - weight ** seen)
  })
}

/** The index of the x closest to `x` in an ascending list; the earlier one on a tie. */
export function nearestIndex(xs: number[], x: number): number {
  if (xs.length === 0) return -1
  let lo = 0
  let hi = xs.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (xs[mid] <= x) lo = mid
    else hi = mid
  }
  return Math.abs(xs[hi] - x) < Math.abs(xs[lo] - x) ? hi : lo
}

/** The part of a domain between two fractions along its axis, dragged in either direction. */
export function zoomDomain(domain: Domain, from: number, to: number, log = false): Domain {
  const [a, b] = [Math.min(from, to), Math.max(from, to)]
  if (log) {
    const [l0, l1] = [Math.log10(domain[0]), Math.log10(domain[1])]
    return [10 ** (l0 + a * (l1 - l0)), 10 ** (l0 + b * (l1 - l0))]
  }
  return [domain[0] + a * (domain[1] - domain[0]), domain[0] + b * (domain[1] - domain[0])]
}

/** The domain slid by a fraction of its own span - in log space on a log axis - so a drag
 *  across a quarter of the plot moves the view by a quarter of what it shows. */
export function panDomain(domain: Domain, by: number, log = false): Domain {
  if (log) {
    const [l0, l1] = [Math.log10(domain[0]), Math.log10(domain[1])]
    const shift = by * (l1 - l0)
    return [10 ** (l0 + shift), 10 ** (l1 + shift)]
  }
  const shift = by * (domain[1] - domain[0])
  return [domain[0] + shift, domain[1] + shift]
}

function niceStep(raw: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  const ratio = raw / magnitude
  const nice = ratio >= 7.5 ? 10 : ratio >= 3.5 ? 5 : ratio >= 1.5 ? 2 : 1
  return nice * magnitude
}

function rounded(value: number, step: number): number {
  const decimals = Math.max(0, -Math.floor(Math.log10(step)) + 1)
  return Number(value.toFixed(decimals))
}

/** Round values inside [lo, hi], about `count` of them. */
export function niceTicks(lo: number, hi: number, count: number): number[] {
  if (!(hi > lo)) return Number.isFinite(lo) ? [lo] : []
  const step = niceStep((hi - lo) / count)
  const ticks: number[] = []
  for (let i = Math.ceil(lo / step - 1e-9); i * step <= hi + step * 1e-9; i++) ticks.push(rounded(i * step, step))
  return ticks
}

/** Powers of ten inside a positive range, or 1-2-5 steps when fewer than two powers fit. */
export function logTicks(lo: number, hi: number): number[] {
  if (!(lo > 0) || !(hi > lo)) return []
  const from = Math.floor(Math.log10(lo))
  const to = Math.ceil(Math.log10(hi))
  const inside = (v: number) => v >= lo * (1 - 1e-9) && v <= hi * (1 + 1e-9)
  const powers: number[] = []
  for (let e = from; e <= to; e++) powers.push(rounded(10 ** e, 10 ** e))
  const decades = powers.filter(inside)
  if (decades.length >= 2) return decades
  const steps: number[] = []
  for (let e = from; e <= to; e++) {
    for (const m of [1, 2, 5]) steps.push(rounded(m * 10 ** e, 10 ** e))
  }
  return steps.filter(inside)
}

/** What a log axis can draw, and how many readings it had to leave out. */
export function splitPositive<T extends XY>(samples: T[]): { kept: T[]; dropped: number } {
  const kept = samples.filter((s) => s.y > 0)
  return { kept, dropped: samples.length - kept.length }
}

/** The range between two quantiles, linearly interpolated - the y range with outliers ignored. */
export function quantileRange(values: number[], lo: number, hi: number): Domain {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  const at = (q: number) => {
    const pos = q * (sorted.length - 1)
    const base = Math.floor(pos)
    const next = sorted[Math.min(base + 1, sorted.length - 1)]
    return sorted[base] + (pos - base) * (next - sorted[base])
  }
  return [at(lo), at(hi)]
}

export interface Bucket {
  /** The x of the last sample in the column, where its line point is drawn. */
  x: number
  lo: number
  hi: number
  last: number
}

/** A series longer than the chart is wide, folded into one min-max band per column with
 *  the last reading as the line - what can be seen at that width, without dropping a peak. */
export function bucketize(samples: XY[], domain: Domain, columns: number): Bucket[] {
  const [x0, x1] = domain
  const span = x1 - x0 || 1
  const buckets: (Bucket | undefined)[] = []
  for (const s of samples) {
    if (s.x < x0 || s.x > x1 || !Number.isFinite(s.y)) continue
    const column = Math.min(columns - 1, Math.floor(((s.x - x0) / span) * columns))
    const b = buckets[column]
    if (b) {
      b.x = s.x
      b.lo = Math.min(b.lo, s.y)
      b.hi = Math.max(b.hi, s.y)
      b.last = s.y
    } else {
      buckets[column] = { x: s.x, lo: s.y, hi: s.y, last: s.y }
    }
  }
  return buckets.filter((b): b is Bucket => b !== undefined)
}
