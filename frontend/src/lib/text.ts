/** The form two pieces of text are compared in - the same one agreement is settled by on
 *  the backend. Never what gets shown: an 'o' with a combining mark and a composed 'ö' are
 *  the same word, and treating them as different points at something nobody can see. */
export function fold(text: string): string {
  return text.normalize('NFC')
    .replace(/[\u2018\u2019\u201a]/g, "'")
    .replace(/[\u201c\u201d\u201e]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2212]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Text as it is put on screen: composed. It is stored decomposed, the way the model
 *  writes it, and a browser that takes a letter and its mark from two faces of the font
 *  (Firefox does) sets the mark beside the letter instead of over it. */
export function displayed(text: string): string {
  return text.normalize('NFC')
}

/** Whether two texts read the same on screen, which a decomposed and a composed spelling
 *  of one word do. Stricter than fold: a different quote mark is still a different text. */
export function sameText(a: string, b: string): boolean {
  return displayed(a) === displayed(b)
}

/** Edited text composed for the screen, and where the caret lands once it is. */
export function composedEdit(text: string, caret: number): { text: string; caret: number } {
  const composed = displayed(text)
  return { text: composed, caret: Math.min(displayed(text.slice(0, caret)).length, composed.length) }
}
