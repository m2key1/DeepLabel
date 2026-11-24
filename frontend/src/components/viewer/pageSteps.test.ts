import { describe, expect, it } from 'vitest'
import { stepPage } from './pageSteps'

// Page numbers 1-5: Lena has 1, 2 and 4, Ben has 3, nobody has 5.
const pages = ['lena', 'lena', 'ben', 'lena', null].map((assignee, idx) => ({ idx, assignee }))
const number = (page: { idx: number } | undefined) => (page ? page.idx + 1 : null)

describe('stepPage', () => {
  it('keeps to the pages handed to me, passing the others by', () => {
    expect([number(stepPage(pages, 1, 1, 'lena')), number(stepPage(pages, 3, -1, 'lena'))]).toEqual([4, 2])
  })

  it('goes nowhere past my last or before my first page', () => {
    expect([number(stepPage(pages, 3, 1, 'lena')), number(stepPage(pages, 0, -1, 'lena'))]).toEqual([null, null])
  })

  it('goes on to my next page from one of someone else\'s', () => {
    expect([number(stepPage(pages, 2, 1, 'lena')), number(stepPage(pages, 2, -1, 'lena'))]).toEqual([4, 2])
  })

  it('goes through every page for someone with none of them', () => {
    expect([number(stepPage(pages, 2, 1, 'rita')), number(stepPage(pages, 2, -1, 'rita')),
      number(stepPage(pages, 3, 1, null))]).toEqual([4, 2, 5])
  })
})
