import { describe, expect, it } from 'vitest'
import type { PreflightJoint } from '../../api'
import { linkedCounts } from './preflightLinks'

// Five lines 16-24 px high (bar 2): three 256-512 px wide (bar 3), two 512-1024 (bar 4);
// three 96-128 px high (bar 7), all 256-512 wide.
const joint: PreflightJoint = {
  height: {
    width: [
      [0, 0, 0, 0, 0], [0, 0, 0, 0, 0], [0, 0, 0, 3, 2], [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0], [0, 0, 0, 3, 0],
    ],
  },
}

describe('linkedCounts', () => {
  it('reads a row of the pair stored in that order', () => {
    expect(linkedCounts(joint, 'height', 2, 'width')).toEqual([0, 0, 0, 3, 2])
    expect(linkedCounts(joint, 'height', 7, 'width')).toEqual([0, 0, 0, 3, 0])
  })

  it('reads a column of the pair stored the other way round', () => {
    expect(linkedCounts(joint, 'width', 3, 'height')).toEqual([0, 0, 3, 0, 0, 0, 0, 3])
    expect(linkedCounts(joint, 'width', 4, 'height')).toEqual([0, 0, 2, 0, 0, 0, 0, 0])
  })

  it('has nothing to say for a pair it never stored, or a pre-flight stored before links', () => {
    expect(linkedCounts(joint, 'height', 2, 'aspect')).toBeNull()
    expect(linkedCounts(undefined, 'height', 2, 'width')).toBeNull()
    expect(linkedCounts(null, 'height', 2, 'width')).toBeNull()
    expect(linkedCounts(joint, 'height', 2, 'height')).toBeNull()
  })
})
