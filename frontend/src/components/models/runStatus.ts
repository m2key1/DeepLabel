import type { Training } from '../../api'

export const isFinished = (status: Training['status']) =>
  status === 'done' || status === 'error' || status === 'cancelled'

/** How many epochs the run trains for: as set, else its model's default; null when unknown. */
export const epochTotal = (run: Pick<Training, 'epochs' | 'default_epochs'>) =>
  run.epochs ?? run.default_epochs

/** Whether the run builds a language model and, if so, how far that got. */
export function languageModelLabel(run: Pick<Training, 'build_lm' | 'lm_build' | 'status'>): string {
  if (!run.build_lm) return 'no'
  return run.lm_build ?? (isFinished(run.status) ? 'not built' : 'building')
}
