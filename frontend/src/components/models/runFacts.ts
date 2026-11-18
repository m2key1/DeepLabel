import type { Evaluation, ProgressPoint, Training } from '../../api'

/** Which material an evaluation scored: its run's validation lines, or the datasets it was
 *  given, as one key. */
export function materialOf(ev: Evaluation): string {
  return ev.source.snapshot !== undefined ? 'valid' : (ev.source.jobs ?? []).join('+')
}

export function duration(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.round((seconds % 3600) / 60)
  return h > 0 ? `${h} h ${m} m` : `${m} m`
}

/** How long a run took, from its own timestamps; while it runs, from its progress points. */
export function runSeconds(run: Training, points: ProgressPoint[]): number | null {
  if (run.started_at && run.finished_at) {
    const at = (stamp: string) => Date.parse(`${stamp.replace(' ', 'T')}Z`)
    return (at(run.finished_at) - at(run.started_at)) / 1000
  }
  const stamps = points.map((p) => p.ts).filter((t): t is number => typeof t === 'number')
  return stamps.length > 1 ? Math.max(...stamps) - Math.min(...stamps) : null
}

/** The epoch the run's checkpoint came from: the best on its headline curve. */
export function bestEpoch(points: ProgressPoint[]): number | null {
  const best = points.reduce<ProgressPoint | null>(
    (b, p) => (typeof p.cer === 'number' && (b === null || p.cer < b.cer!) ? p : b), null)
  return best?.epoch ?? null
}
