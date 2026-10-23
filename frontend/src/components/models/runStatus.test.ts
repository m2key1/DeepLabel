import { describe, expect, it } from 'vitest'
import { languageModelLabel } from './runStatus'

describe('languageModelLabel', () => {
  it('is no when the run builds none', () => {
    expect(languageModelLabel({ build_lm: false, lm_build: null, status: 'done' })).toBe('no')
  })

  it('says how the build ended once it did', () => {
    expect(languageModelLabel({ build_lm: true, lm_build: 'built', status: 'done' })).toBe('built')
    expect(languageModelLabel({ build_lm: true, lm_build: 'failed', status: 'done' })).toBe('failed')
  })

  it('is building while the run goes on, and not built when it ended without one', () => {
    expect(languageModelLabel({ build_lm: true, lm_build: null, status: 'running' })).toBe('building')
    expect(languageModelLabel({ build_lm: true, lm_build: null, status: 'queued' })).toBe('building')
    expect(languageModelLabel({ build_lm: true, lm_build: null, status: 'error' })).toBe('not built')
    expect(languageModelLabel({ build_lm: true, lm_build: null, status: 'cancelled' })).toBe('not built')
  })
})
