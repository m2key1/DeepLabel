import { describe, expect, it } from 'vitest'
import type { PreflightResult, Training } from '../../api'
import { runChecks } from './runChecks'

const run = (over: Partial<Training> = {}) => ({
  task: 'ocr', status: 'done', error: null, batch_fallback: null, resumes: 0, metric_info: null, ...over,
}) as Training

const curve = (cers: number[]) => cers.map((cer, i) => ({ epoch: i + 1, cer }))
const ids = (input: Parameters<typeof runChecks>[0]) => runChecks(input).map((c) => c.id)
const quiet = { preflight: null, likelyErrors: null }

describe('How it went', () => {
  it('says nothing about a run that kept getting better', () => {
    expect(runChecks({ run: run(), points: curve([0.5, 0.3, 0.1]), ...quiet })).toEqual([])
  })

  it('flags a run whose best epoch came early and that ended worse, as training 51 did', () => {
    const cers = [0.0222, 0.0235, 0.0248, ...Array(56).fill(0.0315), 0.0318]
    const [check] = runChecks({ run: run(), points: curve(cers), ...quiet })
    expect(check).toMatchObject({ id: 'best-early', text: 'Best after epoch 1 of 60, worse after',
                                  show: { tab: 'training' } })
  })

  it('tells a running run whose validation has not improved for ten epochs that it can stop at its best', () => {
    const cers = [0.0222, ...Array(10).fill(0.03)]
    expect(runChecks({ run: run({ status: 'running' }), points: curve(cers), ...quiet })).toEqual([{
      id: 'stalled', tone: 'warn', text: 'Validation has not improved since epoch 1',
      show: { tab: 'training', label: 'See the curve' }, keep: 1 }])
  })

  it('does not stall a running run nine epochs past its best, nor a finished one', () => {
    expect(ids({ run: run({ status: 'running' }), points: curve([0.0222, ...Array(9).fill(0.03)]), ...quiet })).toEqual(['best-early'])
    expect(ids({ run: run(), points: curve([0.0222, ...Array(10).fill(0.03)]), ...quiet })).toEqual(['best-early'])
  })

  it('lets a late best or a flat tail pass', () => {
    expect(ids({ run: run(), points: curve([0.3, 0.2, 0.25, 0.21]), ...quiet })).toEqual([])
    expect(ids({ run: run(), points: curve([0.2, 0.205, 0.205, 0.205]), ...quiet })).toEqual([])
  })

  it('reads a page task by the metric its trainer marked headline, higher being better', () => {
    const layout = run({ task: 'layout', metric_info: [{ key: 'map50', headline: true, better: 'higher' }] as Training['metric_info'] })
    const points = [0.6, 0.5, 0.45, 0.4].map((map50, i) => ({ epoch: i + 1, map50 }))
    expect(ids({ run: layout, points, ...quiet })).toEqual(['best-early'])
  })

  it('names the failure, the memory fallback and the restarts', () => {
    const checks = runChecks({
      run: run({ status: 'error', error: 'CUDA out of memory', resumes: 2,
                 batch_fallback: { asked: { batch_size: 8 }, trained: { batch_size: 2, grad_accum_steps: 4 } } as Training['batch_fallback'] }),
      points: [], ...quiet })
    expect(checks.map((c) => c.text)).toEqual([
      'Failed: CUDA out of memory',
      'Ran out of GPU memory at batch 8; trained at 2 × 4',
      "Resumed 2 times after the cluster's time limit",
    ])
  })

  it('counts the pre-flight warnings, not its notes', () => {
    const preflight = { findings: [{ code: 'a', level: 'warn', message: '' }, { code: 'b', level: 'info', message: '' },
                                   { code: 'c', level: 'warn', message: '' }] } as PreflightResult
    expect(runChecks({ run: run(), points: [], preflight, likelyErrors: null })[0])
      .toMatchObject({ id: 'preflight', text: '2 pre-flight warnings about the material', show: { tab: 'data' } })
  })

  it('counts the lines that read nothing like their truth on the material shown', () => {
    const [check] = runChecks({ run: run(), points: [], preflight: null,
                                likelyErrors: { count: 212, of: 26013, material: 'validation lines' } })
    expect(check).toMatchObject({
      id: 'likely-errors', show: { tab: 'lines' },
      text: '212 lines (0.8 %) of the validation lines read nothing like their truth: likely transcription errors',
    })
    expect(ids({ run: run(), points: [], preflight: null, likelyErrors: { count: 0, of: 10, material: 'x' } })).toEqual([])
  })
})
