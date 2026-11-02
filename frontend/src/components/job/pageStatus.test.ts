import { describe, expect, it } from 'vitest'
import { pageStatus } from './pageColumns'

type StatusOf = Parameters<typeof pageStatus>[1]

const job = (over: Partial<StatusOf> = {}): StatusOf =>
  ({ task: 'text', run_layout: true, status: 'done', phase: null, ...over })

describe('pageStatus', () => {
  it('names the furthest step a page went through', () => {
    expect(pageStatus('ingested', job())).toEqual({ label: 'Uploaded', failed: false })
    expect(pageStatus('layout_done', job())).toEqual({ label: 'Layout found', failed: false })
    expect(pageStatus('done', job())).toEqual({ label: 'Read', failed: false })
  })

  it('does not claim a layout was found when the dataset skips layout', () => {
    expect(pageStatus('layout_done', job({ run_layout: false, status: 'running', phase: 'lines' })))
      .toEqual({ label: 'Uploaded', failed: false })
  })

  it('marks pages that did not get past the step a run failed in', () => {
    const lines = job({ run_layout: false, status: 'error', phase: 'lines' })
    expect(pageStatus('layout_done', lines)).toEqual({ label: 'Lines failed', failed: true })
    expect(pageStatus('lines_done', lines)).toEqual({ label: 'Lines found', failed: false })
    expect(pageStatus('pending', job({ status: 'error', phase: 'ingest' })))
      .toEqual({ label: 'Upload failed', failed: true })
    expect(pageStatus('ingested', job({ status: 'error', phase: 'layout' })))
      .toEqual({ label: 'Layout failed', failed: true })
    expect(pageStatus('lines_done', job({ status: 'error', phase: 'ocr' })))
      .toEqual({ label: 'Reading failed', failed: true })
    expect(pageStatus('done', job({ status: 'error', phase: 'ocr' })))
      .toEqual({ label: 'Read', failed: false })
  })

  it('leaves duplicates, unreadable pages and map tiles as they are', () => {
    const failed = job({ status: 'error', phase: 'layout' })
    expect(pageStatus('duplicate', failed)).toEqual({ label: 'Duplicate', failed: false })
    expect(pageStatus('unreadable', failed)).toEqual({ label: 'Unreadable', failed: false })
    expect(pageStatus('done', job({ task: 'map_segmentation' }))).toEqual({ label: 'Processed', failed: false })
  })
})
