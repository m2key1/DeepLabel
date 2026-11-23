import { describe, expect, it } from 'vitest'
import type { MetricInfo, ProgressPoint } from '../../api'
import { bestOn, headlineMetric, keptMetric } from './runFacts'

// What the layout trainer declares (#151): box mAP50 is the headline it is judged by, but
// its EMA copy's mAP50-95 picks the checkpoint it keeps.
const LAYOUT: MetricInfo[] = [
  { key: 'val/mAP_50', label: 'box mAP50', unit: 'fraction', better: 'higher', headline: true },
  { key: 'val/loss', label: 'validation loss', unit: 'number', better: 'lower' },
  { key: 'val/ema_mAP_50_95', label: 'EMA box mAP50-95', unit: 'fraction', better: 'higher', detail: true, selects: true },
]
// Run 56's shape: the headline peaks late, the picking metric early.
const LAYOUT_POINTS = [
  { epoch: 1, 'val/mAP_50': 0.41, 'val/ema_mAP_50_95': 0.30, 'val/loss': 0.9 },
  { epoch: 1, 'train/lr': 0.001 },
  { epoch: 2, 'val/mAP_50': 0.62, 'val/ema_mAP_50_95': 0.54, 'val/loss': 1.2 },
  { epoch: 3, 'val/mAP_50': 0.73, 'val/ema_mAP_50_95': 0.51, 'val/loss': 0.5 },
] as unknown as ProgressPoint[]

describe("a run's best and kept epochs", () => {
  it('reads the best on the headline its trainer declares, in its direction', () => {
    expect(headlineMetric(LAYOUT)).toEqual({ key: 'val/mAP_50', label: 'box mAP50', higherIsBetter: true })
    expect(bestOn(LAYOUT_POINTS, headlineMetric(LAYOUT))).toEqual({ epoch: 3, value: 0.73 })
  })

  it('keeps the epoch the metric that picks the checkpoint was best at', () => {
    expect(keptMetric(LAYOUT).key).toBe('val/ema_mAP_50_95')
    expect(bestOn(LAYOUT_POINTS, keptMetric(LAYOUT))).toEqual({ epoch: 2, value: 0.54 })
  })

  it('takes the headline as what picks the checkpoint when no metric says it does', () => {
    const declared = LAYOUT.map(({ selects: _, ...metric }) => metric)
    expect(bestOn(LAYOUT_POINTS, keptMetric(declared))).toEqual({ epoch: 3, value: 0.73 })
  })

  it('is the lowest CER for a trainer that declares nothing', () => {
    const points: ProgressPoint[] = [{ epoch: 1, cer: 0.2 }, { epoch: 2, cer: 0.08 }, { epoch: 3, cer: 0.11 }]
    expect(headlineMetric(null)).toEqual({ key: 'cer', label: 'CER', higherIsBetter: false })
    expect(bestOn(points, keptMetric(null))).toEqual({ epoch: 2, value: 0.08 })
  })

  it('is unknown before the metric is first reported', () => {
    expect(bestOn([{ epoch: 1, loss: 2.3 }], keptMetric(LAYOUT))).toBeNull()
  })
})
