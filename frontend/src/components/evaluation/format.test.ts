import { describe, expect, it } from 'vitest'
import { share } from './format'

describe('share', () => {
  it('gives one decimal from one percent up and two below it', () => {
    expect(share(1234, 10000)).toBe('12.3%')
    expect(share(1, 100)).toBe('1.0%')
    expect(share(45, 10000)).toBe('0.45%')
  })

  it('never rounds a character that is there down to nothing', () => {
    expect(share(3, 100000)).toBe('<0.01%')
    expect(share(0, 100)).toBe('0%')
    expect(share(0, 0)).toBe('0%')
  })
})
