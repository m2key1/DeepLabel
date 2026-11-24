import { describe, expect, it } from 'vitest'
import { formatRanges, parseRanges } from './PagePicker'

describe('formatRanges', () => {
  it('joins runs of numbers into ranges', () => {
    expect(formatRanges([1, 2, 3, 5, 7, 8])).toBe('1-3, 5, 7-8')
  })

  it('writes nothing for no numbers', () => {
    expect(formatRanges([])).toBe('')
  })

  it('writes what parseRanges reads back', () => {
    expect([...parseRanges(formatRanges([2, 3, 4, 9]), 9)!]).toEqual([2, 3, 4, 9])
  })
})
