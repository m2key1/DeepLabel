/** What every name in a section starts with, when that is worth saying once instead of
 *  on every row. A shelfmark series - AKB_VN-16-K-1-10, AKB_VN-16-K-1-132 - is mostly its
 *  own prefix, and the part that tells two of them apart is what a reader is looking for.
 *  Cut back to the last separator every name shares, so the chip ends somewhere meaningful. */
export function sharedPrefix(names: string[]): string {
  if (names.length < 3) return ''
  let end = 0
  while (end < names[0].length && names.every((n) => n[end] === names[0][end])) end += 1
  const prefix = names[0].slice(0, end).match(/^.*[_\- ]/)?.[0] ?? ''
  return prefix.length >= 4 ? prefix : ''
}
