import { describe, expect, it } from 'vitest'
import { strengthOf, TOO_EASY } from './strength'

const CHECKED = { min_length: 8, strength_check: true, min_score: 3 }

describe('strengthOf', () => {
  it('says what a good password looks like before anything is typed', () => {
    expect(strengthOf('', null, CHECKED)).toEqual({
      level: 'empty', fill: 0, acceptable: false,
      message: 'Try three or four unrelated words.' })
  })

  it('asks for length first, whatever the score', () => {
    const s = strengthOf('abc', 4, CHECKED)
    expect([s.level, s.message, s.acceptable]).toEqual(['short', 'Too short - at least 8 characters.', false])
  })

  it('holds back a guessable password with the same sentence the server says', () => {
    expect(strengthOf('password1', 0, CHECKED)).toMatchObject({ level: 'weak', message: TOO_EASY, acceptable: false })
    expect(strengthOf('violet hinge', 2, CHECKED)).toMatchObject({ level: 'fair', message: TOO_EASY, acceptable: false })
  })

  it('lets through what reaches the policy\'s score, and calls 4 strong', () => {
    expect(strengthOf('violet hinge saddle', 3, CHECKED)).toMatchObject({ level: 'good', acceptable: true, message: 'Good.' })
    expect(strengthOf('violet hinge saddle parade', 4, CHECKED)).toMatchObject({ level: 'strong', fill: 1, acceptable: true })
  })

  it('waits for the scorer rather than guessing', () => {
    expect(strengthOf('violet hinge saddle', null, CHECKED).acceptable).toBe(false)
  })

  it('without a strength check, length is enough', () => {
    expect(strengthOf('aaaaaaaa', 0, { min_length: 8, strength_check: false, min_score: 0 }))
      .toMatchObject({ level: 'good', acceptable: true, message: 'Long enough.' })
  })
})

describe('strengthOf before the rules are known', () => {
  it('waits for them instead of assuming the fallback', () => {
    expect(strengthOf('password1', 0, null)).toMatchObject({ acceptable: false, message: 'Checking…' })
    expect(strengthOf('', null, null).message).toBe('Try three or four unrelated words.')
  })
})
