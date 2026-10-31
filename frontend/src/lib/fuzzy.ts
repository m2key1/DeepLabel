import { fold } from './text'

const UMLAUT: Record<string, string> = { 'ä': 'ae', 'ö': 'oe', 'ü': 'ue', 'ß': 'ss' }

/** The form a search compares in: folded, lowercased, and with the German umlauts written
 *  out - the backend's search_form, so a word it answered with can be found in the line it
 *  came from. A volume spells the same name Müller on one page and Mueller on the next. */
export function searchForm(text: string): string {
  return fold(text).toLowerCase().replace(/[äöüß]/g, (c) => UMLAUT[c])
}

/** How a query is meant. Fuzzy forgives a misspelling on either side; the exact two
 *  forgive nothing but say so plainly; a pattern is the user's own regular expression. */
export type SearchMode = 'fuzzy' | 'exact' | 'case' | 'regex'
