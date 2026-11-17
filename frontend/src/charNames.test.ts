import { describe, expect, it } from 'vitest'
import { CHAR_NAMES, matchesSearch } from './charNames'
import { VOCAB } from './settings'

const found = (search: string) => VOCAB.filter((c) => matchesSearch(c, search))

describe('finding a character by name', () => {
  it('names every character the groups offer', () => {
    expect(VOCAB.filter((c) => !CHAR_NAMES[c])).toEqual([])
  })

  it('finds a character by the words of its name, each from its start', () => {
    expect(found('long s')).toEqual(['ẛ', 'ſ', 'ẜ'])
    expect(found('a macron')).toEqual(['Ā', 'ā'])
    expect(found('macr')).toHaveLength(found('macron').length)
    expect(found('macron')).toEqual(expect.arrayContaining(['Ā', 'Ē', 'Ī', 'Ō', 'Ū', 'ā', 'ē', 'ī', 'ō', 'ū']))
  })

  it('takes umlaut for the diaeresis Unicode names it', () => {
    const diaeresis = VOCAB.filter((c) => CHAR_NAMES[c].includes('diaeresis'))
    expect(diaeresis).toEqual(expect.arrayContaining(['ä', 'ö', 'ü', 'Ä', 'Ö', 'Ü']))
    expect(found('umlaut')).toEqual(diaeresis)
  })

  it('finds a character typed or pasted itself, composed or not', () => {
    expect(found('ä')).toEqual(['ä'])
    expect(found('ä')).toEqual(['ä'])
    expect(found(' § ')).toEqual(['§'])
  })

  it('finds nothing for a name no character has', () => {
    expect(found('yogh')).toEqual([])
  })
})
