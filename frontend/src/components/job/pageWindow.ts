interface Slice<T> {
  rows: T[]
  matched: number
}

/** The next screenful under the rows already shown. Screenfuls are asked for by offset, so
 *  an edit between two requests shifts the rows across the boundary: one pushed down into
 *  the next screenful comes back a second time and is dropped here, while one that left
 *  the filter pulls its successor up past the boundary, and that row stays missing until
 *  the table is reloaded. */
export function appendRows<T extends { id: number }>(shown: T[], more: T[]): T[] {
  const seen = new Set(shown.map((row) => row.id))
  return [...shown, ...more.filter((row) => !seen.has(row.id))]
}

/** The first `count` rows of one filter and order, asked for a screenful at a time - the
 *  backend answers a few hundred rows per request at most, and a table walked deeper than
 *  that still has to be reloaded whole after an edit. */
export async function fetchWindow<T extends { id: number }, S extends Slice<T>>(
  fetchSlice: (offset: number, limit: number) => Promise<S>, count: number, screenful: number,
): Promise<S> {
  let answer = await fetchSlice(0, Math.min(screenful, count))
  let rows = answer.rows
  while (rows.length < count && rows.length < answer.matched) {
    answer = await fetchSlice(rows.length, Math.min(screenful, count - rows.length))
    const grown = appendRows(rows, answer.rows)
    if (grown.length === rows.length) break
    rows = grown
  }
  return { ...answer, rows }
}
