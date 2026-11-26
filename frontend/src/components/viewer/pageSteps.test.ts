import { describe, expect, it } from 'vitest'
import { stepPage } from './pageSteps'

// Page numbers 1-5: Lena has 1, 2 and 4, Ben has 3, nobody has 5.
const handed = ['lena', 'lena', 'ben', 'lena', null]
const pagesOf = (me: string | null) => handed.map((assignee, idx) => ({ idx, assignee, mine: assignee === me }))
const number = (page: { idx: number } | undefined) => (page ? page.idx + 1 : null)

describe('stepPage', () => {
  it('keeps to the pages handed to me, passing the others by', () => {
    const pages = pagesOf('lena')
    expect([number(stepPage(pages, 1, 1)), number(stepPage(pages, 3, -1))]).toEqual([4, 2])
  })

  it('goes nowhere past my last or before my first page', () => {
    const pages = pagesOf('lena')
    expect([number(stepPage(pages, 3, 1)), number(stepPage(pages, 0, -1))]).toEqual([null, null])
  })

  it('goes on to my next page from one of someone else\'s', () => {
    const pages = pagesOf('lena')
    expect([number(stepPage(pages, 2, 1)), number(stepPage(pages, 2, -1))]).toEqual([4, 2])
  })

  it('goes through every page for someone with none of them', () => {
    const pages = pagesOf('rita')
    expect([number(stepPage(pages, 2, 1)), number(stepPage(pages, 2, -1)),
      number(stepPage(pagesOf(null), 3, 1))]).toEqual([4, 2, 5])
  })
})

describe('stepPage for a second keyer', () => {
  // Anna keys pages 1 and 3 first, Ben second; Ben keys page 2 alone. The table names the first keyer.
  const keyed = [
    { idx: 0, assignee: 'anna', mine: true }, { idx: 1, assignee: 'ben', mine: true },
    { idx: 2, assignee: 'anna', mine: true }, { idx: 3, assignee: null, mine: false },
  ]

  it('keeps to every page I key, second or not', () => {
    expect([number(stepPage(keyed, 1, 1)), number(stepPage(keyed, 1, -1)),
      number(stepPage(keyed, 2, 1))]).toEqual([3, 1, null])
  })
})
