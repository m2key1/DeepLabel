import { fold } from './text'

const UMLAUT: Record<string, string> = { 'ä': 'ae', 'ö': 'oe', 'ü': 'ue', 'ß': 'ss' }

/** The form a search compares in: folded, lowercased, and with the German umlauts written
 *  out. A volume spells the same name Müller on one page and Mueller on the next, and
 *  somebody searching for either means both. */
export function searchForm(text: string): string {
  return fold(text).toLowerCase().replace(/[äöüß]/g, (c) => UMLAUT[c])
}

/** Damerau-Levenshtein - edits, plus the swapped pair of letters that is half of what a
 *  person mistypes - abandoned as soon as no finish can come in under `cap`.
 *
 *  The cap is what makes this affordable over a whole volume: a word whose length is
 *  already too far off is rejected without a table at all, and the rest give up within a
 *  row or two. */
function distance(a: string, b: string, cap: number): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1
  let beforeLast: number[] = []
  let last: number[] = []
  for (let j = 0; j <= b.length; j++) last[j] = j
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    let bestInRow = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let step = Math.min(last[j] + 1, row[j - 1] + 1, last[j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        step = Math.min(step, beforeLast[j - 2] + 1)
      }
      row[j] = step
      if (step < bestInRow) bestInRow = step
    }
    if (bestInRow > cap) return cap + 1
    beforeLast = last
    last = row
  }
  return last[b.length]
}

/** How far out a word of this length may be. One edit in four letters is already a
 *  different word as often as it is a misreading, so the allowance grows with the word
 *  rather than being a flat number that is too loose short and too tight long. */
const allowance = (word: string): number =>
  word.length <= 4 ? 1 : word.length <= 8 ? 2 : 3

/** How a query is meant. Fuzzy forgives a misspelling on either side; the exact two
 *  forgive nothing but say so plainly; a pattern is the user's own regular expression. */
export type SearchMode = 'fuzzy' | 'exact' | 'case' | 'regex'

export interface Hit {
  /** 1 where the line contains the query outright, otherwise how close the nearest
   *  spelling came. Exact readings therefore always sort above corrected ones. */
  score: number
  /** The words that answered, so they can be marked in the line they were found in. */
  words: string[]
}

/** A test that answers with the words its matches cover, so a phrase or a pattern that runs
 *  across several words marks all of them rather than only a word that holds it alone. */
function patternMatcher(pattern: RegExp): (text: string) => Hit | null {
  return (text: string): Hit | null => {
    const spans = [...text.matchAll(pattern)]
    if (spans.length === 0) return null
    const words = [...text.matchAll(/\S+/g)]
      .filter((word) => spans.some((span) => span[0] !== ''
        && span.index < word.index + word[0].length && span.index + span[0].length > word.index))
      .map((word) => word[0])
    return { score: 1, words }
  }
}

/** A test for one query, ready to run down a whole volume. Built once so the query is
 *  folded and measured once rather than per line. Null where there is nothing to look for.
 *
 *  Every term has to be answered somewhere in the line, and the weakest answer is the
 *  score: a line that has one of the two names asked for is not a hit for both. */
export function matcher(query: string, mode: SearchMode = 'fuzzy'):
((text: string) => Hit | null) | null {
  if (!query.trim()) return null

  if (mode === 'regex') {
    // A pattern half-typed is not a mistake to shout about, so an unfinished one simply
    // finds nothing until it is finished.
    try {
      return patternMatcher(new RegExp(query, 'gu'))
    } catch {
      return null
    }
  }

  if (mode === 'exact' || mode === 'case') {
    const literal = query.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return patternMatcher(new RegExp(literal, mode === 'case' ? 'gu' : 'giu'))
  }

  const terms = searchForm(query).split(' ').filter(Boolean)
  if (terms.length === 0) return null
  const whole = terms.join(' ')
  const caps = terms.map(allowance)

  return (text: string): Hit | null => {
    const haystack = searchForm(text)
    if (!haystack) return null
    if (haystack.includes(whole)) {
      const said = haystack.split(' ').filter((w) => terms.some((t) => w.includes(t)))
      return { score: 1, words: said }
    }
    const words = haystack.split(' ')
    const answers: string[] = []
    let weakest = 1
    for (let t = 0; t < terms.length; t++) {
      let best: { score: number; word: string } | null = null
      for (const word of words) {
        if (word.includes(terms[t])) {
          best = { score: 1, word }
          break
        }
        const apart = distance(terms[t], word, caps[t])
        if (apart > caps[t]) continue
        const score = 1 - apart / Math.max(terms[t].length, word.length)
        if (!best || score > best.score) best = { score, word }
      }
      if (!best) return null
      answers.push(best.word)
      weakest = Math.min(weakest, best.score)
    }
    return { score: weakest, words: answers }
  }
}
