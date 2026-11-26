/** Where Next and Previous go in the viewer (#137): through the pages handed to me when I have
 *  any, else through every page - the nearest after or before the open one, which need not be
 *  one of them itself. `pages` is in page order; `mine` is the server's word that a page is
 *  handed to me, as its only keyer or one of two (#162). */
export function stepPage<P extends { idx: number; mine?: boolean }>(
  pages: P[], openIdx: number, delta: 1 | -1,
): P | undefined {
  const mine = pages.filter((page) => page.mine)
  const steps = mine.length > 0 ? mine : pages
  return delta === 1 ? steps.find((page) => page.idx > openIdx) : steps.findLast((page) => page.idx < openIdx)
}
