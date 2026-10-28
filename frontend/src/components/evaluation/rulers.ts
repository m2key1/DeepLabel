import type { Evaluation } from '../../api'

const DECODE_ORDER = ['beam', 'rescored', 'greedy'] as const

/** One model's scores on one dataset: the dot is its best decode on file (beam first),
 *  and the other decodes come along for the card. */
export interface ModelMark {
  modelId: number
  shown: Evaluation
  decodes: Evaluation[]
}

/** What a ruler measures on: test pages no training saw, a dataset's checked lines, or
 *  the validation split that picked a run's checkpoint and so reads optimistic. */
export type RulerKind = 'test' | 'checked' | 'validation'

const KIND_ORDER: RulerKind[] = ['test', 'checked', 'validation']

export function kindOf(ev: Evaluation): RulerKind {
  if (ev.source.snapshot !== undefined) return 'validation'
  return ev.source.test_pages ? 'test' : 'checked'
}

export interface Ruler {
  label: string
  kind: RulerKind
  marks: ModelMark[]
  /** Not scored yet or failed, said on the line instead of drawn on it. */
  waiting: Evaluation[]
  newest: string
}

/** The evaluations as rulers: one per thing scored on, newest first, each with one mark
 *  per model at its CER. */
export function buildRulers(evaluations: Evaluation[]): Ruler[] {
  const bySource = new Map<string, Evaluation[]>()
  for (const ev of evaluations) {
    const label = ev.source_label ?? 'datasets'
    bySource.set(label, [...(bySource.get(label) ?? []), ev])
  }
  return [...bySource.entries()].map(([label, evs]) => {
    const scored = evs.filter((ev) => ev.status === 'done' && ev.cer !== null)
    const byModel = new Map<number, Evaluation[]>()
    for (const ev of scored) byModel.set(ev.model_id, [...(byModel.get(ev.model_id) ?? []), ev])
    const marks = [...byModel.entries()].map(([modelId, decodes]) => {
      const ordered = [...decodes].sort((a, b) =>
        DECODE_ORDER.indexOf(a.decode) - DECODE_ORDER.indexOf(b.decode) || b.created_at.localeCompare(a.created_at))
      return { modelId, shown: ordered[0], decodes: ordered }
    }).sort((a, b) => a.shown.cer! - b.shown.cer!)
    return {
      label,
      kind: kindOf(evs[0]),
      marks,
      waiting: evs.filter((ev) => ev.status !== 'done'),
      newest: evs.map((ev) => ev.created_at).sort().at(-1) ?? '',
    }
  }).sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || b.newest.localeCompare(a.newest))
}

const NICE = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1]

/** The scale's right end: the next round CER above the worst mark. */
export function scaleMax(rulers: Ruler[]): number {
  const worst = Math.max(0, ...rulers.flatMap((r) => r.marks.map((m) => m.shown.cer!)))
  return NICE.find((n) => worst <= n * 0.95) ?? 1
}
