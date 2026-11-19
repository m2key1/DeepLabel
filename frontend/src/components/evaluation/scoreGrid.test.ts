import { describe, expect, it } from 'vitest'
import type { Evaluation, RegistryModel, Training } from '../../api'
import { VALIDATION, scoreGrid } from './scoreGrid'

const model = (id: number, over: Partial<RegistryModel> = {}): RegistryModel => ({
  id, task: 'ocr', name: `m${id}`, source: 'trained', checkpoint: `/m${id}.ckpt`, trained_from: null,
  metrics: null, notes: null, is_default: false, archived: false, lm_path: null, lm_dict_path: null,
  target_height: null, max_width: null, conventions: null, decoder: null, owner: null, files: [], family_name: null,
  layout_template_id: null, supersedes: null, runs_on: null, created_at: '2026-10-01 10:00:00', ...over,
})

const run = (id: number, modelId: number): Training => ({ id, model_id: modelId } as Training)

const evaluation = (id: number, modelId: number, cer: number, over: Partial<Evaluation> = {}): Evaluation => ({
  id, model_id: modelId, training_id: null, source: { jobs: ['j1'], test_pages: true }, decode: 'rescored',
  status: 'done', error: null, cer, wer: null, line_count: 10, owner: 'anna', created_at: '2026-10-20 10:00:00', ...over,
})

const base = model(1, { source: 'builtin' })
const tuned = model(2, { trained_from: 1 })

describe('the evaluations grid', () => {
  it('shows a model on its own run\'s validation lines against its base on the same lines', () => {
    const grid = scoreGrid([run(7, 2)], [
      evaluation(1, 2, 0.031, { source: { snapshot: 7 } }),
      evaluation(2, 1, 0.052, { source: { snapshot: 7 } }),
    ])
    expect(grid.cell(tuned, VALIDATION)).toEqual({ value: 0.031, to: '/evaluations/1', change: 0.031 - 0.052 })
    // The base has no run of its own, so no validation lines of its own either.
    expect(grid.cell(base, VALIDATION)).toBeNull()
    expect(grid.isScored(base)).toBe(false)
  })

  it('takes the mode Automatic reads with over the others, the newest of it first', () => {
    const grid = scoreGrid([], [
      evaluation(3, 1, 0.09, { decode: 'greedy' }),
      evaluation(2, 1, 0.04, { decode: 'rescored' }),
      evaluation(1, 1, 0.05, { decode: 'rescored' }),
      evaluation(4, 1, 0.01, { decode: 'rescored', status: 'running', cer: null }),
    ])
    expect(grid.cell(base, 'j1')).toEqual({ value: 0.04, to: '/evaluations/2', change: null })
  })

  it('fills each dataset of a multi-dataset score from its breakdown, opening on that dataset', () => {
    const grid = scoreGrid([], [evaluation(5, 1, 0.03, {
      source: { jobs: ['j1', 'j2'], test_pages: true },
      breakdown: [{ job_id: 'j1', name: 'One', cer: 0.02, wer: 0, lines: 5 },
                  { job_id: 'j2', name: 'Two', cer: 0.04, wer: 0, lines: 5 }],
    })])
    expect(grid.cell(base, 'j2')).toEqual({ value: 0.04, to: '/evaluations/5?job=j2', change: null })
    expect(grid.cell(base, 'j1')?.value).toBe(0.02)
  })

  it('keeps a dataset\'s test pages and all its pages apart', () => {
    const grid = scoreGrid([], [
      evaluation(1, 1, 0.02),
      evaluation(2, 1, 0.06, { source: { jobs: ['j1'] } }),
    ])
    expect(grid.cell(base, 'j1')?.value).toBe(0.02)
    expect(grid.cell(base, 'j1:all')?.value).toBe(0.06)
    expect(grid.columns([base])).toEqual([
      { key: 'j1', job: 'j1', allPages: false },
      { key: 'j1:all', job: 'j1', allPages: true },
    ])
  })

  it('scores a line model in F1, from its counts rather than a CER it has not got', () => {
    const lines = (f1: number) => ({ truth: 10, detected: 10, found: 9, missed: 1, merged: 0, split: 0, loose: 0, extra: 1,
                                     precision: 0.9, recall: 0.9, f1, iou: 0.8, height_ratio: 1.1 })
    const grid = scoreGrid([], [
      evaluation(1, 2, 0, { cer: null, decode: '', metrics: lines(0.9) }),
      evaluation(2, 1, 0, { cer: null, decode: '', metrics: lines(0.8) }),
    ])
    expect(grid.cell(tuned, 'j1')).toEqual({ value: 0.9, to: '/evaluations/1', change: 0.9 - 0.8 })
  })

  it('orders the columns the rows were scored in: validation first, then the most scored datasets', () => {
    const other = model(3)
    const grid = scoreGrid([run(7, 2)], [
      evaluation(1, 2, 0.03, { source: { snapshot: 7 } }),
      evaluation(2, 2, 0.03, { source: { jobs: ['a'], test_pages: true } }),
      evaluation(3, 2, 0.03, { source: { jobs: ['b'], test_pages: true } }),
      evaluation(4, 3, 0.03, { source: { jobs: ['b'], test_pages: true } }),
      evaluation(5, 1, 0.03, { source: { jobs: ['c'], test_pages: true } }),
    ])
    expect(grid.columns([tuned, other]).map((c) => c.key)).toEqual([VALIDATION, 'b', 'a'])
    expect(grid.columns([other]).map((c) => c.key)).toEqual(['b'])
  })
})
