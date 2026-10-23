import type { ConfBand, PageElement } from '../api'

export function confStroke(c: number | null): string {
  if (c === null) return '#9ca3af'
  if (c >= 0.85) return '#16a34a'
  if (c >= 0.7) return '#d97706'
  return '#dc2626'
}

export function elMinConf(el: PageElement): number | null {
  const vals = el.lines.map((l) => l.confidence).filter((c): c is number => c !== null)
  return vals.length ? Math.min(...vals) : null
}

const VIRIDIS: [number, number, number][] = [
  [68, 1, 84], [59, 82, 139], [33, 145, 140], [94, 201, 98], [253, 231, 37],
]

export function viridis(v: number): string {
  const t = Math.min(1, Math.max(0, v)) * (VIRIDIS.length - 1)
  const i = Math.min(VIRIDIS.length - 2, Math.floor(t))
  const f = t - i
  const rgb = VIRIDIS[i].map((c, k) => Math.round(c + f * (VIRIDIS[i + 1][k] - c)))
  return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`
}

function toBands(profile: ConfBand[] | number[]): ConfBand[] {
  if (profile.length === 0) return []
  if (typeof profile[0] === 'number') {
    const values = profile as number[]
    return values.map((c, i) => ({ x0: i / values.length, x1: (i + 1) / values.length, c }))
  }
  return profile as ConfBand[]
}

/** Merge neighbours until the band count fits, keeping the worst confidence of each group so
 *  a bad character can never be averaged out of the picture. */
function capBands(bands: ConfBand[], maxBands: number): ConfBand[] {
  if (bands.length <= maxBands) return bands
  const stride = Math.ceil(bands.length / maxBands)
  const merged: ConfBand[] = []
  for (let i = 0; i < bands.length; i += stride) {
    const group = bands.slice(i, i + stride)
    merged.push({
      x0: group[0].x0,
      x1: group[group.length - 1].x1,
      c: Math.min(...group.map((b) => b.c)),
    })
  }
  return merged
}

export function profileStops(
  profile: ConfBand[] | number[],
  maxStops = 64,
): { offset: number; color: string }[] {
  const bands = capBands(toBands(profile), Math.max(1, Math.floor(maxStops / 2)))
  if (!bands.length) return []
  const stops: { offset: number; color: string }[] = []
  for (const band of bands) {
    const color = viridis(band.c / 100)
    stops.push({ offset: band.x0, color })
    stops.push({ offset: band.x1, color })
  }
  stops[0].offset = 0
  stops[stops.length - 1].offset = 1
  return stops
}
