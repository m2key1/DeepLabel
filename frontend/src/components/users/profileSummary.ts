import type { PersonProfile } from '../../api'
import { plural } from '../../util'

/** What a person has done, as sentences built only from what has happened: a figure that
 *  is still zero is left unsaid rather than reported. Null when there is nothing yet. */
export function profileSummary({ stats, recent_datasets }: PersonProfile): string[] | null {
  const sentences: string[] = []
  const work = [
    stats.lines_checked && `checked ${plural(stats.lines_checked, 'line')}`,
    stats.lines_corrected && `corrected ${plural(stats.lines_corrected, 'line')}`,
    stats.pages_signed_off && `signed off ${plural(stats.pages_signed_off, 'page')}`,
    stats.regions_drawn && `drew ${plural(stats.regions_drawn, 'region')}`,
  ].filter(Boolean) as string[]
  if (work.length) {
    const where = recent_datasets[0] ? `, most recently in ${recent_datasets[0].name}` : ''
    sentences.push(`${capital(list(work))}${where}.`)
  }
  if (stats.models_trained) {
    const best = stats.best_cer !== null ? `; the best reads at ${(stats.best_cer * 100).toFixed(2)}% CER` : ''
    sentences.push(`Trained ${plural(stats.models_trained, 'model')}${best}.`)
  } else if (stats.trainings.started) {
    sentences.push(`Started ${plural(stats.trainings.started, 'training run')}.`)
  }
  const owned = stats.datasets_owned && plural(stats.datasets_owned, 'dataset')
  const shared = stats.datasets_shared && `${stats.datasets_shared} shared with them`
  if (owned || shared) sentences.push(`${capital(list([owned ? `owns ${owned}` : '', shared || ''].filter(Boolean)))}.`)
  return sentences.length ? sentences : null
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

function list(items: string[]): string {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
}
