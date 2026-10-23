import { describe, expect, it } from 'vitest'
import { availableAxes, collectMetrics, compareRuns, groupReported, headlineKeys } from './metrics'
import type { ProgressPoint } from '../../api'

const run = (cer: number[], extra: Record<string, number>[] = []): ProgressPoint[] =>
  cer.map((value, i) => ({ epoch: i + 1, cer: value, ...(extra[i] ?? {}) }))

describe('collectMetrics', () => {
  it('charts a key the app has never heard of, split into group and leaf', () => {
    const point = { epoch: 1, 'train/grad_norm': 3 } as unknown as ProgressPoint
    const [metric] = collectMetrics([point], 'epoch')

    expect(metric.key).toBe('train/grad_norm')
    expect([metric.group, metric.leaf]).toEqual(['train', 'grad_norm'])
    expect(metric.series[0].samples).toEqual([{ x: 1, y: 3, epoch: 1, time: null, step: null }])
  })
})

describe('the x axes', () => {
  const stamped = [{ epoch: 1, cer: 0.5, ts: 100 }, { epoch: 2, cer: 0.3, ts: 160 }] as ProgressPoint[]

  it('offers step only with a reported step or steps per epoch, and time only with stamps', () => {
    expect(availableAxes(run([0.5]))).toEqual(['epoch'])
    expect(availableAxes(stamped, 4)).toEqual(['step', 'epoch', 'time'])
    expect(availableAxes([{ epoch: 1, step: 10, cer: 0.5 }] as ProgressPoint[])).toEqual(['step', 'epoch'])
  })

  it('puts each sample at its step, epoch and seconds since the first point', () => {
    const [cer] = collectMetrics(stamped, 'step', {}, 4)
    expect(cer.series[0].samples).toEqual([
      { x: 4, y: 0.5, epoch: 1, time: 0, step: 4 },
      { x: 8, y: 0.3, epoch: 2, time: 60, step: 8 },
    ])
    expect(collectMetrics(stamped, 'time')[0].series[0].samples.map((s) => s.x)).toEqual([0, 60])
  })

  it('takes a step the trainer reported over one derived, and never charts it', () => {
    const points = [{ epoch: 1, step: 37, cer: 0.5 }] as ProgressPoint[]
    const metrics = collectMetrics(points, 'step', {}, 4)
    expect(metrics.map((m) => m.key)).toEqual(['cer'])
    expect(metrics[0].series[0].samples[0].x).toBe(37)
  })
})

describe('comparing runs', () => {
  const runs = [
    { id: 7, label: 'Spanish letters', points: run([0.3, 0.2, 0.1]) },
    { id: 8, label: 'Zollbücher', points: run([0.4, 0.3]) },
  ]

  it('lays one line per run over the same chart', () => {
    const [cer] = compareRuns(runs, 'epoch')

    expect(cer.key).toBe('cer')
    expect(cer.series.map((s) => s.label)).toEqual(['Spanish letters', 'Zollbücher'])
    expect(cer.series[1].samples).toMatchObject([{ x: 1, y: 0.4 }, { x: 2, y: 0.3 }])
    // The units of a metric it knows are kept, whichever run it came from.
    expect(cer.format(0.0456)).toBe('4.56%')
  })

  it('gives a key only one run reported a chart of its own', () => {
    const mixed = [
      runs[0],
      { id: 9, label: 'Other trainer', points: run([0.5], [{ grad_norm: 2 }]) },
    ]

    const keys = compareRuns(mixed, 'epoch').map((m) => m.key)
    expect(keys).toEqual(['cer', 'grad_norm'])
    const grad = compareRuns(mixed, 'epoch').find((m) => m.key === 'grad_norm')!
    expect(grad.series.map((s) => s.label)).toEqual(['Other trainer'])
  })

  it('leaves the per-dataset chart out, being one line per dataset already', () => {
    const withDatasets = [{
      id: 7,
      label: 'Spanish letters',
      points: [{ epoch: 1, cer: 0.3, cer_by_dataset: { a: 0.2, b: 0.4 } }] as ProgressPoint[],
    }]

    expect(compareRuns(withDatasets, 'epoch').map((m) => m.key)).toEqual(['cer'])
  })

  it('is nothing at all when nothing is selected', () => {
    expect(compareRuns([], 'epoch')).toEqual([])
  })
})

describe('metrics a backend declares', () => {
  const info = [
    { key: 'val/segm_mAP_50', label: 'mask mAP50', unit: 'fraction', better: 'higher', headline: true },
    { key: 'train/loss', label: 'loss', unit: 'number', better: 'lower' },
    { key: 'val/AP/*', label: 'AP {}', unit: 'fraction', better: 'higher' },
    { key: 'train/*_[0-9]', detail: true },
  ] as const
  const points = [
    { epoch: 1, ts: 100, 'val/segm_mAP_50': 0.4, 'train/loss': 2, 'val/AP/Line': 0.5, 'train/loss_ce_0': 1 },
    { epoch: 2, ts: 160, 'val/segm_mAP_50': 0.6, 'train/loss': 1, 'val/AP/Line': 0.7, 'train/loss_ce_0': 0.5 },
  ] as unknown as ProgressPoint[]

  it('are named, formatted and read the way the backend says, headline first and detail last', () => {
    const metrics = collectMetrics(points, 'epoch', {}, null, { info: [...info], trainItems: 120 })

    expect(metrics.map((m) => [m.key, m.leaf, m.headline, m.detail])).toEqual([
      ['val/segm_mAP_50', 'mask mAP50', true, false],
      ['time/epoch_seconds', 'time per epoch', false, false],
      ['time/items_per_s', 'throughput', false, false],
      ['train/loss', 'loss', false, false],
      ['val/AP/Line', 'AP Line', false, false],
      ['train/loss_ce_0', 'loss_ce_0', false, true],
    ])
    const [headline] = metrics
    expect(headline.format(0.6)).toBe('60.00%')
    expect(headline.lowerIsBetter).toBe(false)
  })

  it('give a stamped run its time per epoch and items per second', () => {
    const metrics = collectMetrics(points, 'epoch', {}, null, { info: [...info], trainItems: 120 })
    const of = (key: string) => metrics.find((m) => m.key === key)!

    expect(of('time/epoch_seconds').series[0].samples.map((s) => s.y)).toEqual([60])
    expect(of('time/items_per_s').series[0].samples.map((s) => s.y)).toEqual([2])
    expect(of('time/items_per_s').format(2)).toBe('2/s')
  })

  it('pick the headline curves, else CER and loss', () => {
    expect(headlineKeys([...info])).toEqual(['val/segm_mAP_50', 'train/loss'])
    expect(headlineKeys(null)).toEqual(['cer', 'loss'])
  })
})

describe('groupReported', () => {
  const info = [
    { key: 'val/mAP_50', label: 'box mAP50', unit: 'fraction' as const, headline: true },
    { key: 'val/loss', label: 'validation loss', unit: 'number' as const },
    { key: 'val/ema_*', unit: 'fraction' as const, detail: true },
    { key: 'val/AP/*', label: 'AP {}', unit: 'fraction' as const },
  ]
  const layoutRun = {
    'val/mAP_50': 0.7179, 'val/loss': 9.0592, 'val/AP/Table': 0.7, 'val/AP/Column': 0, 'val/ema_mAP_50': 0.7082,
    'val/mAP_50_95': 0.6173, 'final/mAP50': 0.7115, resolution: 1560, num_queries: 500, val_metric: 0.6173,
    val_metric_name: 'mAP', higher_is_better: true, task: 'layout',
  }

  it('groups scores by what they measured, classes apart, settings and declared detail last', () => {
    const groups = groupReported(layoutRun, info)
    const shown = (title: string) => groups.find((g) => g.title === title)!.values.map((v) => [v.label, v.value])

    expect(groups.map((g) => g.title)).toEqual(['Validation', 'Final evaluation', 'AP per class', 'Settings', 'Detail'])
    expect(shown('Validation')).toEqual([['box mAP50', '71.79%'], ['mAP 50 95', '61.73%'], ['validation loss', '9.06']])
    expect(shown('Final evaluation')).toEqual([['mAP50', '71.15%']])
    expect(shown('AP per class')).toEqual([['Column', '0.00%'], ['Table', '70.00%']])
    expect(shown('Settings')).toEqual([['num queries', '500'], ['resolution', '1,560']])
    expect(shown('Detail')).toEqual([['ema mAP 50', '70.82%']])
  })

  it('shows val_metric under the name it stands for when it is the only score', () => {
    expect(groupReported({ val_metric: 0.42, val_metric_name: 'cer' }, null)).toEqual([{ title: 'Validation', values: [
      { key: 'val_metric', label: 'validation cer', value: '42.00%', headline: false }] }])
  })
})
