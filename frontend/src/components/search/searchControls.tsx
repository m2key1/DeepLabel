import { searchForm } from '../../lib/fuzzy'
import type { SearchMode } from '../../lib/fuzzy'

const MARK = 'rounded-sm bg-warn/25'

export const SEARCH_MODES: { value: SearchMode; label: string; title: string }[] = [
  { value: 'fuzzy', label: 'Fuzzy', title: 'Near spellings count - Schmidt finds Schmitt' },
  { value: 'exact', label: 'Exact', title: 'This text exactly, in any case' },
  { value: 'case', label: 'Aa', title: 'This text exactly, matching case' },
  { value: 'regex', label: '.*', title: 'A regular expression' },
]

/** The line's text with the words that answered the search marked. Matching is done on the
 *  folded form, so what is marked is found by folding each word the same way rather than by
 *  looking for the query in the text - which would miss the very spellings it matched. */
export function marked(text: string, words: string[], testId: string) {
  if (words.length === 0) return text
  const wanted = new Set(words)
  return text.split(/(\s+)/).map((part, i) =>
    wanted.has(part) || wanted.has(searchForm(part))
      ? <span key={i} data-testid={testId} className={MARK}>{part}</span>
      : part)
}
