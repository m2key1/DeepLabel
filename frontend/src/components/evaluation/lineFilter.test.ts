import { describe, expect, it } from 'vitest'
import { fractionToPercent, percentToFraction, readFilter } from './lineFilter'

describe('percentToFraction', () => {
  it('reads a typed percentage as a fraction', () => {
    expect(percentToFraction('5')).toBe('0.05')
    expect(percentToFraction(' 12.5 ')).toBe('0.125')
  })

  it('reads a decimal comma as a point', () => {
    expect(percentToFraction('2,5')).toBe('0.025')
  })

  it('is no bound for an empty field or text that is not a number', () => {
    expect(percentToFraction('')).toBeNull()
    expect(percentToFraction('   ')).toBeNull()
    expect(percentToFraction('abc')).toBeNull()
    expect(percentToFraction('1,2,3')).toBeNull()
    expect(percentToFraction('Infinity')).toBeNull()
  })
})

describe('fractionToPercent', () => {
  it('shows a fraction as the percentage without float noise', () => {
    expect(fractionToPercent(0.07)).toBe('7')
    expect(fractionToPercent(0.0125)).toBe('1.25')
    expect(fractionToPercent(0)).toBe('0')
  })

  it('is empty when there is no bound', () => {
    expect(fractionToPercent(undefined)).toBe('')
  })
})

describe('readFilter', () => {
  it('reads the bounds, dataset and search from the URL', () => {
    expect(readFilter(new URLSearchParams('cer_min=0.05&cer_max=0.5&job=j1&q=line')))
      .toEqual({ cer_min: 0.05, cer_max: 0.5, job_id: 'j1', q: 'line' })
  })

  it('drops a bound that is not a number rather than sending NaN', () => {
    expect(readFilter(new URLSearchParams('cer_min=abc&cer_max=0.2')))
      .toEqual({ cer_min: undefined, cer_max: 0.2, job_id: undefined, q: undefined })
  })
})
