import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, type Preflight } from '../../api'
import { failedPreflight, nextStep, pollPreflight } from './usePreflight'

const preflight = (status: Preflight['status']): Preflight =>
  ({ id: 7, status, error: null, created_at: '', result: null, datasets: {} })

describe('pollPreflight', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('polls while the pre-flight runs and hands over the settled one once', async () => {
    const load = vi.fn()
      .mockResolvedValueOnce(preflight('running'))
      .mockResolvedValueOnce(preflight('running'))
      .mockResolvedValueOnce(preflight('done'))
    const settled = vi.fn()
    pollPreflight(load, settled, 100)
    await vi.advanceTimersByTimeAsync(0)
    expect([load.mock.calls.length, settled.mock.calls.length]).toEqual([1, 0])
    await vi.advanceTimersByTimeAsync(100)
    expect([load.mock.calls.length, settled.mock.calls.length]).toEqual([2, 0])
    await vi.advanceTimersByTimeAsync(100)
    expect(settled.mock.calls).toEqual([[preflight('done')]])
    await vi.advanceTimersByTimeAsync(1000)
    expect(load).toHaveBeenCalledTimes(3)
  })

  it('settles a failed request as an error and stops polling', async () => {
    const load = vi.fn()
      .mockResolvedValueOnce(preflight('running'))
      .mockRejectedValueOnce(new Error('GET /api/trainings/3/preflight failed: 500'))
    const settled = vi.fn()
    pollPreflight(load, settled, 100)
    await vi.advanceTimersByTimeAsync(100)
    expect(settled.mock.calls).toEqual([[failedPreflight(new Error('GET /api/trainings/3/preflight failed: 500'))]])
    await vi.advanceTimersByTimeAsync(1000)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('keeps asking after a failed request when told to retry, waiting longer each time', async () => {
    const load = vi.fn()
      .mockRejectedValueOnce(new Error('GET /api/trainings/3/preflight failed: 502'))
      .mockRejectedValueOnce(new Error('GET /api/trainings/3/preflight failed: 502'))
      .mockResolvedValueOnce(preflight('done'))
    const settled = vi.fn()
    pollPreflight(load, settled, 100, { retry: true })
    await vi.advanceTimersByTimeAsync(0)
    expect([load.mock.calls.length, settled.mock.calls.length]).toEqual([1, 0])
    await vi.advanceTimersByTimeAsync(200)
    expect([load.mock.calls.length, settled.mock.calls.length]).toEqual([2, 0])
    await vi.advanceTimersByTimeAsync(399)
    expect(load).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(settled.mock.calls).toEqual([[preflight('done')]])
  })

  it('settles a refusal at once even when told to retry, since asking again cannot change it', async () => {
    const refused = new ApiError('training 3 not found', 404, undefined)
    const load = vi.fn().mockRejectedValue(refused)
    const settled = vi.fn()
    pollPreflight(load, settled, 100, { retry: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(settled.mock.calls).toEqual([[failedPreflight(refused)]])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('stops at once when cancelled, and never reports what arrives after', async () => {
    const load = vi.fn().mockResolvedValue(preflight('running'))
    const settled = vi.fn()
    const cancel = pollPreflight(load, settled, 100)
    await vi.advanceTimersByTimeAsync(100)
    cancel()
    load.mockResolvedValue(preflight('done'))
    await vi.advanceTimersByTimeAsync(1000)
    expect(load).toHaveBeenCalledTimes(2)
    expect(settled).not.toHaveBeenCalled()
  })
})

describe('nextStep', () => {
  it('starts a review for settings it has not seen', () => {
    expect(nextStep(null, 'a')).toBe('start')
    expect(nextStep({ key: 'a', id: 7, preflight: preflight('done') }, 'b')).toBe('start')
  })

  it('keeps a settled review of the same settings', () => {
    expect(nextStep({ key: 'a', id: 7, preflight: preflight('done') }, 'a')).toBe('keep')
  })

  it('picks up a review of the same settings still being computed', () => {
    expect(nextStep({ key: 'a', id: 7, preflight: null }, 'a')).toBe('resume')
  })

  it('retries a failed review, and one that never got an id', () => {
    expect(nextStep({ key: 'a', id: 7, preflight: preflight('error') }, 'a')).toBe('start')
    expect(nextStep({ key: 'a', id: null, preflight: null }, 'a')).toBe('start')
  })
})

describe('failedPreflight', () => {
  it('tells settings the server refused from a review that could not be had', () => {
    const refused = new ApiError('the selected datasets contain no checked material for this task', 400, undefined)
    expect(failedPreflight(refused)).toMatchObject({
      status: 'error', error: 'the selected datasets contain no checked material for this task', failure: 'refused' })
    expect(failedPreflight(new ApiError('bad gateway', 502, undefined)).failure).toBe('request')
    expect(failedPreflight(new TypeError('Failed to fetch')).failure).toBe('request')
  })
})
