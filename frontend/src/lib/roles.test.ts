import { describe, expect, it } from 'vitest'
import { reaches } from './roles'

describe('reaches', () => {
  it('lets each role do what the ones below it may, and no more', () => {
    expect(reaches('reviewer', 'annotator')).toBe(true)
    expect(reaches('reviewer', 'reviewer')).toBe(true)
    expect(reaches('reviewer', 'manager')).toBe(false)
    expect(reaches('admin', 'manager')).toBe(true)
    expect(reaches('viewer', 'annotator')).toBe(false)
  })

  it('refuses a role it does not know yet', () => {
    expect(reaches(undefined, 'viewer')).toBe(false)
  })
})
