import { describe, expect, it } from 'vitest'
import { withKeys, withoutKeys } from './palette'

const COMPOSED = 'ä'
const DECOMPOSED = 'ä'

describe('the palette keys a character by its composed form', () => {
  it('adds a pasted decomposed letter as the key the grid already holds', () => {
    expect(withKeys(['x', COMPOSED], [DECOMPOSED, 'y'])).toEqual(['x', COMPOSED, 'y'])
  })

  it('stores a new decomposed letter composed, as the grid would', () => {
    expect(withKeys([], [DECOMPOSED])).toEqual([COMPOSED])
  })

  it('removes a key whichever form it was stored in', () => {
    expect(withoutKeys(['x', DECOMPOSED, 'y'], [COMPOSED])).toEqual(['x', 'y'])
  })
})
