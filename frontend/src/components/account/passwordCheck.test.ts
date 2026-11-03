import { describe, expect, it } from 'vitest'
import { newPasswordProblem } from './passwordCheck'

describe('newPasswordProblem', () => {
  it('waits until both are typed, then says only when they differ', () => {
    expect(newPasswordProblem({ password: 'abc', repeat: '' })).toBeNull()
    expect(newPasswordProblem({ password: 'abc', repeat: 'abc' })).toBeNull()
    expect(newPasswordProblem({ password: 'abc', repeat: 'abd' })).toBe('The two passwords differ.')
  })
})
