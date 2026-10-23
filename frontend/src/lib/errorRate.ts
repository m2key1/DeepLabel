export interface ErrorRates {
  cer: number
  wer: number
  lines: number
}

export interface Reading {
  reference: string
  hypothesis: string
}

function distance(a: ArrayLike<string>, b: ArrayLike<string>): number {
  if (a.length < b.length) [a, b] = [b, a]
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    for (let j = 0; j < b.length; j++) {
      current.push(Math.min(previous[j + 1] + 1, current[j] + 1,
                            previous[j] + (a[i - 1] === b[j] ? 0 : 1)))
    }
    previous = current
  }
  return previous[b.length]
}

const words = (text: string) => text.split(/\s+/).filter(Boolean)

/** Summed edit distances over summed reference length, which is what an evaluation run
 *  reports (backend/runner/scoring.py) - averaging per-line rates would let a two-letter
 *  line weigh as much as a whole paragraph and give a different number for the same work. */
export function errorRates(readings: Reading[]): ErrorRates | null {
  let charDist = 0
  let charLen = 0
  let wordDist = 0
  let wordLen = 0
  for (const { reference, hypothesis } of readings) {
    charDist += distance([...reference], [...hypothesis])
    charLen += [...reference].length
    const ref = words(reference)
    wordDist += distance(ref, words(hypothesis))
    wordLen += ref.length
  }
  if (!charLen) return null
  return { cer: charDist / charLen, wer: wordLen ? wordDist / wordLen : 0, lines: readings.length }
}

export const percent = (rate: number) => `${(rate * 100).toFixed(2)}%`
