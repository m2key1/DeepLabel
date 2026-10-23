import { displayed, fold } from '../../lib/text'

export interface Piece {
  text: string
  changed: boolean
}

/** Words as they are compared and shown. Composed first, so that an index into the folded
 *  form is an index into the form on screen - which is what lets a difference be pointed at
 *  by character rather than by word. */
const words = (text: string) => displayed(text).trim().split(/\s+/).filter(Boolean)


/** The reading to hold the others against where nothing has been settled yet: the one most
 *  of them gave, so the odd reader out is what lights up rather than everybody at once. */
export function commonest(texts: string[]): string {
  const votes = new Map<string, { text: string; count: number }>()
  for (const text of texts) {
    const group = votes.get(fold(text)) ?? { text, count: 0 }
    group.count += 1
    votes.set(fold(text), group)
  }
  const [best] = [...votes.values()].sort((a, b) => b.count - a.count || a.text.localeCompare(b.text))
  return best?.text ?? ''
}

/** Where two spellings of one word part. The head and tail they share are trimmed away, so
 *  a reading that differs in a letter points at the letter instead of lighting up the whole
 *  word - which is the difference between seeing 'Paragraf' and seeing the 'f'.
 *
 *  A word that only drops characters has nothing of its own left to mark, so all of it is:
 *  an absence cannot be underlined in text that does not contain it. */
function within(mine: string, theirs: string): Piece[] {
  const a = fold(theirs)
  const b = fold(mine)
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  const room = Math.min(a.length, b.length) - head
  while (tail < room && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++

  const changed = mine.slice(head, b.length - tail)
  if (!changed) return [{ text: mine, changed: true }]
  return [
    ...(head ? [{ text: mine.slice(0, head), changed: false }] : []),
    { text: changed, changed: true },
    ...(tail ? [{ text: mine.slice(b.length - tail), changed: false }] : []),
  ]
}

type Step =
  | { kind: 'shared'; word: string }
  | { kind: 'mine'; word: string }
  | { kind: 'theirs'; word: string }

/** One reading marked up against another: every word this reader says, with the ones the
 *  baseline does not have marked, down to the characters that differ where the two are
 *  spellings of the same word.
 *
 *  Only ever this reader's own words. A word it left out is absent, not struck through in
 *  the middle of the line it did not write. */
export function diffWords(baseline: string, reading: string): Piece[] {
  const a = words(baseline)
  const b = words(reading)
  const theirs = a.map(fold)
  const mine = b.map(fold)
  const shared: number[][] = Array.from({ length: a.length + 1 },
                                        () => new Array(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      shared[i][j] = theirs[i] === mine[j]
        ? shared[i + 1][j + 1] + 1
        : Math.max(shared[i + 1][j], shared[i][j + 1])
    }
  }

  const steps: Step[] = []
  let i = 0
  let j = 0
  while (j < b.length) {
    if (i < a.length && theirs[i] === mine[j]) {
      steps.push({ kind: 'shared', word: b[j] })
      i++
      j++
    } else if (i < a.length && shared[i + 1][j] >= shared[i][j + 1]) {
      steps.push({ kind: 'theirs', word: a[i] })
      i++
    } else {
      steps.push({ kind: 'mine', word: b[j] })
      j++
    }
  }

  const pieces: Piece[] = []
  const push = (piece: Piece) => {
    const last = pieces[pieces.length - 1]
    if (last && last.changed === piece.changed) last.text += piece.text
    else pieces.push({ ...piece })
  }
  const space = () => {
    if (pieces.length) push({ text: ' ', changed: false })
  }

  for (let at = 0; at < steps.length;) {
    if (steps[at].kind === 'shared') {
      space()
      push({ text: steps[at].word, changed: false })
      at++
      continue
    }
    // A run of words neither reader shares. Pairing them off in order is what says that
    // one word was spelled differently rather than dropped and another put in its place.
    let end = at
    while (end < steps.length && steps[end].kind !== 'shared') end++
    const dropped = steps.slice(at, end).filter((s) => s.kind === 'theirs').map((s) => s.word)
    const added = steps.slice(at, end).filter((s) => s.kind === 'mine').map((s) => s.word)
    added.forEach((word, n) => {
      space()
      const against = dropped[n]
      for (const piece of against ? within(word, against) : [{ text: word, changed: true }]) {
        push(piece)
      }
    })
    at = end
  }
  return pieces
}
