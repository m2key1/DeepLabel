import { describe, expect, it } from 'vitest'
import { appendRows, fetchWindow } from './pageWindow'

const ids = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => ({ id: from + i }))

/** A backend holding `total` rows that answers at most `cap` of them per request. */
function backend(total: number, cap: number) {
  const asked: [number, number][] = []
  const fetchSlice = async (offset: number, limit: number) => {
    asked.push([offset, limit])
    const rows = ids(offset, Math.min(total, offset + Math.min(limit, cap)))
    return { rows, matched: total, offset, limit }
  }
  return { asked, fetchSlice }
}

describe('fetchWindow', () => {
  it('walks a window larger than one request a screenful at a time', async () => {
    const { asked, fetchSlice } = backend(1200, 500)

    const answer = await fetchWindow(fetchSlice, 600, 200)

    expect(asked).toEqual([[0, 200], [200, 200], [400, 200]])
    expect(answer.rows.map((r) => r.id)).toEqual(ids(0, 600).map((r) => r.id))
    expect(answer.matched).toBe(1200)
  })

  it('stops at the last row the filter matched', async () => {
    const { asked, fetchSlice } = backend(450, 500)

    const answer = await fetchWindow(fetchSlice, 600, 200)

    expect(asked).toEqual([[0, 200], [200, 200], [400, 200]])
    expect(answer.rows).toHaveLength(450)
  })

  it('asks once for a window of one screenful', async () => {
    const { asked, fetchSlice } = backend(1200, 500)

    await fetchWindow(fetchSlice, 200, 200)

    expect(asked).toEqual([[0, 200]])
  })
})

describe('appendRows', () => {
  it('adds the next screenful without repeating a row an edit moved up into it', () => {
    expect(appendRows(ids(0, 3), ids(2, 5)).map((r) => r.id)).toEqual([0, 1, 2, 3, 4])
  })
})
