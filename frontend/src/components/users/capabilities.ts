/** What each capability is called where a person reads it, and what it lets them do.
 *  The catalogue itself comes from the server, so a capability this build has never
 *  heard of still appears - under its own name, which is better than not at all. */
const LABELS: Record<string, { short: string; hint: string }> = {
  'pipeline.layout': { short: 'Layout', hint: 'Detect layout boxes, on a new dataset or again' },
  'pipeline.lines': { short: 'Lines', hint: 'Detect lines, on a new dataset or again' },
  'pipeline.ocr': { short: 'Read', hint: 'Read lines, on a new dataset or again' },
  'pipeline.discard': {
    short: 'Discard',
    hint: 'Take the answers that throw checked work away: clear checked readings, start pages clean, re-run past a sign-off',
  },
  'dataset.delete': { short: 'Delete', hint: 'Delete a whole dataset' },
  'models.manage': { short: 'Models', hint: 'Register, rename, retire and default a model' },
  'train.local': { short: 'Train locally', hint: 'Train on the shared local GPU' },
  'train.cluster': { short: 'Train cluster', hint: 'Submit trainings to the cluster' },
}

export const capabilityLabel = (cap: string) => LABELS[cap]?.short ?? cap
export const capabilityHint = (cap: string) => LABELS[cap]?.hint ?? cap
