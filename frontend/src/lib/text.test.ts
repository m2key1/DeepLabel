import { describe, expect, it } from 'vitest'
import { composedEdit, displayed, sameText } from './text'

const STORED = 'Pucic\u{301} Medo, Gf. 825'

describe('displayed', () => {
  it('composes a stored letter and its mark into the one character on screen', () => {
    expect(displayed(STORED)).toBe('Puci\u{107} Medo, Gf. 825')
  })

  it('leaves a mark with no composed form after its letter', () => {
    expect(displayed('q\u{301}')).toBe('q\u{301}')
  })
})

describe('sameText', () => {
  it('holds a decomposed and a composed spelling to be the same words', () => {
    expect(sameText(STORED, 'Puci\u{107} Medo, Gf. 825')).toBe(true)
  })

  it('still tells a different quote mark apart, unlike fold', () => {
    expect(sameText('\u{201e}ja\u{201c}', '"ja"')).toBe(false)
  })
})

describe('composedEdit', () => {
  it('puts the caret straight after a mark inserted into composed text', () => {
    expect(composedEdit('Pucic\u{301} Medo', 6)).toEqual({ text: 'Puci\u{107} Medo', caret: 5 })
  })

  it('keeps the caret where it was when nothing composes', () => {
    expect(composedEdit('Puci\u{107} Medo', 7)).toEqual({ text: 'Puci\u{107} Medo', caret: 7 })
  })

  it('counts every composition before the caret, not only the last', () => {
    expect(composedEdit('a\u{308}o\u{308}u\u{308} x', 7)).toEqual({ text: '\u{e4}\u{f6}\u{fc} x', caret: 4 })
  })
})
