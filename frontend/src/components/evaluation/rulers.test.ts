import { describe, expect, it } from 'vitest'
import type { Evaluation } from '../../api'
import { buildRulers, scaleMax } from './rulers'

const ev = (id: number, modelId: number, label: string, cer: number | null, over: Partial<Evaluation> = {}): Evaluation => ({
  id, model_id: modelId, training_id: null, source: { jobs: ['j'] }, source_label: label, decode: 'beam',
  status: 'done', error: null, cer, wer: null, line_count: 10, owner: 'dev',
  created_at: `2026-10-${String(id).padStart(2, '0')} 10:00:00`, ...over,
})

describe('the evaluation rulers', () => {
  it('gives each dataset a ruler and each model one mark, best first', () => {
    const rulers = buildRulers([
      ev(1, 1, 'Zollbuecher', 0.09), ev(2, 2, 'Zollbuecher', 0.03), ev(3, 1, 'Belvedere', 0.05),
    ])
    expect(rulers.map((r) => [r.label, r.marks.map((m) => m.modelId)])).toEqual([
      ['Belvedere', [1]], ['Zollbuecher', [2, 1]]])
  })

  it('draws beam and keeps the other decodes on the mark', () => {
    const [ruler] = buildRulers([
      ev(1, 1, 'Zollbuecher', 0.04, { decode: 'greedy' }), ev(2, 1, 'Zollbuecher', 0.03),
      ev(3, 1, 'Zollbuecher', 0.035, { decode: 'rescored' }),
    ])
    expect(ruler.marks).toHaveLength(1)
    expect(ruler.marks[0].shown.decode).toBe('beam')
    expect(ruler.marks[0].decodes.map((d) => d.decode)).toEqual(['beam', 'rescored', 'greedy'])
  })

  it('says what has not been scored instead of drawing it', () => {
    const [ruler] = buildRulers([ev(1, 1, 'Run', null, { status: 'queued' }), ev(2, 1, 'Run', null, { status: 'error' })])
    expect(ruler.marks).toEqual([])
    expect(ruler.waiting.map((w) => w.status)).toEqual(['queued', 'error'])
  })

  it('puts test pages first and validation splits last, whatever is newest', () => {
    const rulers = buildRulers([
      ev(3, 1, 'valid split of Run', 0.01, { source: { snapshot: 7 } }),
      ev(2, 1, 'Zollbuecher', 0.03),
      ev(1, 1, 'test pages of Zollbuecher', 0.04, { source: { jobs: ['j'], test_pages: true } }),
    ])
    expect(rulers.map((r) => [r.label, r.kind])).toEqual([
      ['test pages of Zollbuecher', 'test'], ['Zollbuecher', 'checked'], ['valid split of Run', 'validation']])
  })

  it('ends the scale at the next round CER above the worst mark', () => {
    expect(scaleMax(buildRulers([ev(1, 1, 'A', 0.032), ev(2, 2, 'A', 0.0948)]))).toBe(0.1)
    expect(scaleMax(buildRulers([ev(1, 1, 'A', 0.012)]))).toBe(0.02)
  })
})
