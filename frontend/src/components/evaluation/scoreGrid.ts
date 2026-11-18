import type { Evaluation, RegistryModel, Training } from '../../api'
import { headlineScore } from '../models/families'

/** The column of each model's own run's validation lines. */
export const VALIDATION = 'valid'

/** A dataset scored on all its checked lines rather than its test pages. */
const ALL_PAGES = ':all'

export interface GridColumn {
  key: string
  /** The dataset a column holds, or null for the validation lines. */
  job: string | null
  allPages: boolean
}

export interface GridCell {
  cer: number
  to: string
  /** Against the model it was trained from on the same lines, when that one was scored there. */
  change: number | null
}

/** Where an evaluation's score is filed: the run whose validation lines it read, or each
 *  dataset it read - a multi-dataset score lands in each from its breakdown. */
function placesOf(ev: Evaluation): string[] {
  if (ev.source.snapshot !== undefined) return [`run:${ev.source.snapshot}`]
  return (ev.source.jobs ?? []).map((job) => (ev.source.test_pages ? job : job + ALL_PAGES))
}

const columnOf = (key: string): GridColumn => (key === VALIDATION
  ? { key, job: null, allPages: false }
  : { key, job: key.replace(ALL_PAGES, ''), allPages: key.endsWith(ALL_PAGES) })

/** Every model against everything it was scored on: one score per cell, in the mode
 *  Automatic reads with, beside its change against the model it was trained from. */
export function scoreGrid(trainings: Training[], evaluations: Evaluation[]) {
  const runOf = new Map(trainings.filter((t) => t.model_id !== null).map((t) => [t.model_id!, t.id]))
  const filed = new Map<string, Evaluation[]>()
  for (const ev of evaluations) {
    if (ev.status !== 'done' || ev.cer === null) continue
    for (const place of placesOf(ev)) {
      const key = `${ev.model_id}@${place}`
      filed.set(key, [...(filed.get(key) ?? []), ev])
    }
  }

  const placeOf = (modelId: number, column: string): string | null =>
    column !== VALIDATION ? column : runOf.has(modelId) ? `run:${runOf.get(modelId)}` : null

  const scoreAt = (modelId: number, place: string) => {
    const ev = headlineScore(filed.get(`${modelId}@${place}`) ?? [])
    if (!ev) return null
    const job = place.startsWith('run:') || (ev.source.jobs?.length ?? 0) < 2 ? null : place.replace(ALL_PAGES, '')
    const cer = job ? ev.breakdown?.find((row) => row.job_id === job)?.cer : ev.cer!
    return cer === undefined ? null : { cer, to: `/evaluations/${ev.id}${job ? `?job=${job}` : ''}` }
  }

  const cell = (model: RegistryModel, column: string): GridCell | null => {
    const place = placeOf(model.id, column)
    const shown = place ? scoreAt(model.id, place) : null
    if (!place || !shown) return null
    const against = model.trained_from !== null ? scoreAt(model.trained_from, place) : null
    return { ...shown, change: against ? shown.cer - against.cer : null }
  }

  const columnsOf = (model: RegistryModel): string[] => {
    const own = placeOf(model.id, VALIDATION)
    return [...new Set([...filed.keys()]
      .filter((key) => key.startsWith(`${model.id}@`))
      .map((key) => key.slice(key.indexOf('@') + 1))
      .flatMap((place) => (place === own ? [VALIDATION] : place.startsWith('run:') ? [] : [place])))]
      .filter((column) => cell(model, column) !== null)
  }

  /** The columns the given rows were scored in: the validation lines first, then the
   *  datasets most of them were scored on. */
  const columns = (rows: RegistryModel[]): GridColumn[] => {
    const scored = new Map<string, number>()
    for (const model of rows) for (const column of columnsOf(model)) scored.set(column, (scored.get(column) ?? 0) + 1)
    return [...scored.entries()]
      .sort(([a, na], [b, nb]) => (a === VALIDATION ? -1 : b === VALIDATION ? 1 : nb - na || a.localeCompare(b)))
      .map(([key]) => columnOf(key))
  }

  return { cell, columns, isScored: (model: RegistryModel) => columnsOf(model).length > 0 }
}
