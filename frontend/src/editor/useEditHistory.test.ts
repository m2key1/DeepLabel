import { describe, expect, it } from 'vitest'
import { spanOf } from './useEditHistory'

describe('spanOf', () => {
  it('covers every span a gesture made, so one undo takes the whole gesture back', () => {
    expect(spanOf({ from: 4, to: 6 }, { from: 6, to: 9 }, { from: 9, to: 11 })).toEqual({ from: 4, to: 11 })
  })

  it('is nothing at all when no write answered with a span', () => {
    // A backend older than the revert endpoint sends none. The edit still happened; it
    // just cannot be taken back, which is not a reason to take the editor down.
    expect(spanOf(undefined, undefined)).toBeUndefined()
    expect(spanOf()).toBeUndefined()
  })

  it('covers the writes that did answer and ignores the rest', () => {
    expect(spanOf(undefined, { from: 2, to: 5 }, undefined)).toEqual({ from: 2, to: 5 })
  })
})
