import { describe, expect, it } from 'vitest'
import { matcher } from './fuzzy'

const words = (query: string, mode: 'fuzzy' | 'exact' | 'case' | 'regex', text: string) =>
  matcher(query, mode)!(text)?.words

describe('matcher marks what the query matched', () => {
  it('marks every word an exact phrase spans', () => {
    expect(words('Paragraph line 2', 'exact', 'Paragraph line 2')).toEqual(['Paragraph', 'line', '2'])
  })

  it('marks the words a phrase touches only partly, and none outside it', () => {
    expect(words('raph line', 'exact', 'Paragraph line 2')).toEqual(['Paragraph', 'line'])
  })

  it('ignores case in exact mode but not in case mode', () => {
    expect(words('PARAGRAPH LINE', 'exact', 'Paragraph line 2')).toEqual(['Paragraph', 'line'])
    expect(words('PARAGRAPH LINE', 'case', 'Paragraph line 2')).toBeUndefined()
    expect(words('Paragraph line', 'case', 'Paragraph line 2')).toEqual(['Paragraph', 'line'])
  })

  it('treats an exact query as text, not as a pattern', () => {
    expect(words('a.c', 'exact', 'abc a.c')).toEqual(['a.c'])
  })

  it('marks every word a pattern spans across', () => {
    expect(words('line \\d', 'regex', 'Paragraph line 2')).toEqual(['line', '2'])
  })

  it('marks every occurrence, not only the first', () => {
    expect(words('an', 'exact', 'an Anna banner')).toEqual(['an', 'Anna', 'banner'])
  })

  it('finds nothing in a line the query does not match', () => {
    expect(words('line 3', 'exact', 'Paragraph line 2')).toBeUndefined()
    expect(words('line \\d{2}', 'regex', 'Paragraph line 2')).toBeUndefined()
  })

  it('still marks the misspelt word a fuzzy query found', () => {
    expect(words('Mueller', 'fuzzy', 'Herr Müler zahlt')).toEqual(['mueler'])
  })
})
