import { describe, expect, it } from 'vitest'
import { sharedPrefix } from './sharedPrefix'

describe('sharedPrefix', () => {
  it('names a shelfmark series by the part every name shares, up to a separator', () => {
    expect(sharedPrefix(['AKB_VN-16-K-1-10', 'AKB_VN-16-K-1-132', 'AKB_VN-16-K-1-7']))
      .toBe('AKB_VN-16-K-1-')
  })

  it('stops before a separator that only some names have', () => {
    expect(sharedPrefix(['AKB_VN-16-K-1-10', 'AKB_VN-16-K-1-132', 'AKB_VN-16-K-1_7']))
      .toBe('AKB_VN-16-K-')
  })

  it('says nothing when the separator itself is where the names part', () => {
    expect(sharedPrefix(['Akte 1 Brief', 'Akte 2 Brief', 'Akte-3 Brief'])).toBe('')
  })

  it('says nothing for fewer than three names', () => {
    expect(sharedPrefix(['AKB_VN-16-K-1-10', 'AKB_VN-16-K-1-132'])).toBe('')
  })

  it('says nothing when the shared part is shorter than four characters', () => {
    expect(sharedPrefix(['AB-1', 'AB-2', 'AB-3'])).toBe('')
  })
})
