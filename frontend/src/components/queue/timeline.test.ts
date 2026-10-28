import { describe, expect, it } from 'vitest'
import type { QueueEntry } from '../../api'
import { placeCluster, placeLocal, spanLabel, tickStep } from './timeline'

const entry = (id: number, seconds: number | null, over: Partial<QueueEntry> = {}): QueueEntry => ({
  kind: 'evaluation', id, name: `e${id}`, owner: 'dev', status: 'queued', phase: null,
  created_at: '2026-01-01 00:00:00', queued_at: '2026-01-01 00:00:00', started_at: null,
  eta: { seconds, basis: seconds === null ? 'unknown' : 'history' }, ...over,
})

describe('the queue timeline', () => {
  it('lays the local GPU end to end, the running item first', () => {
    const placed = placeLocal(entry(1, 60, { status: 'running' }), [entry(2, 120), entry(3, 30)])
    expect(placed.map((p) => [p.entry.id, p.start, p.end])).toEqual([[1, 0, 60], [2, 60, 180], [3, 180, 210]])
  })

  it('gives an item without an estimate the middle of the others, marked as a guess', () => {
    const placed = placeLocal(null, [entry(1, 60), entry(2, null), entry(3, 600)])
    expect(placed.map((p) => [p.end - p.start, p.unknown])).toEqual([[60, false], [600, true], [600, false]])
  })

  it('starts every cluster run now, side by side', () => {
    expect(placeCluster([entry(1, 3600), entry(2, 60)]).map((p) => [p.start, p.end])).toEqual([[0, 3600], [0, 60]])
  })

  it('labels the axis in at most six steps, in the unit that reads best', () => {
    expect(tickStep(1500)).toBe(300)
    expect(tickStep(150)).toBe(30)
    expect(tickStep(5 * 3600)).toBe(3600)
    expect([spanLabel(30), spanLabel(300), spanLabel(5400), spanLabel(2 * 86400)]).toEqual(['+30 s', '+5 min', '+1.5 h', '+2 d'])
  })
})
