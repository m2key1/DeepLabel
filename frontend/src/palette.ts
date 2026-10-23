import { VOCAB } from './settings'

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
// Everything a keyboard types without help, whatever the layout in front of the person.
const PLAIN = 128

/** The characters in these texts that no keyboard reaches, as they are read and inserted:
 *  a base with the marks that belong to it. Decomposed, because a corpus holds both forms
 *  of the same letter and they are one key - and it is the form the editor writes. */
export function beyondPlain(texts: (string | null | undefined)[]): string[] {
  const found = new Set<string>()
  for (const text of texts) {
    if (!text) continue
    for (const { segment } of segmenter.segment(text.normalize('NFD'))) {
      if ([...segment].some((c) => (c.codePointAt(0) ?? 0) >= PLAIN)) found.add(segment)
    }
  }
  return [...found]
}

// The grid shows precomposed letters, but text is stored decomposed (the server decomposes
// what is saved), so the order has to be matched in the form the palette holds.
const ORDER = VOCAB.map((c) => c.normalize('NFD'))
const KNOWN = new Set(ORDER)

/** The order the palette grid uses - the script groups, then whatever no group carries -
 *  so a palette that filled itself reads like one that was chosen. */
export function orderByGroups(chars: Iterable<string>): string[] {
  const held = new Set(chars)
  return [...ORDER.filter((c) => held.has(c)),
          ...[...held].filter((c) => !KNOWN.has(c)).sort()]
}

/** The form a chosen key is stored and compared in: the grid's precomposed letter, so a
 *  pasted decomposed one is the same key. The editor still writes it decomposed. */
export const paletteKey = (ch: string) => ch.normalize('NFC')

export function withKeys(keyboard: string[], chars: string[]): string[] {
  return [...new Set([...keyboard, ...chars].map(paletteKey))]
}

export function withoutKeys(keyboard: string[], chars: string[]): string[] {
  const removed = new Set(chars.map(paletteKey))
  return keyboard.filter((ch) => !removed.has(paletteKey(ch)))
}
