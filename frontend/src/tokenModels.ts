import { useEffect, useState } from 'react'
import { getRecognitionOffer } from './api'
import type { ApiToken, RecognitionOffer } from './api'

type Task = keyof RecognitionOffer['models']

export const TASKS: { task: Task; label: string }[] = [
  { task: 'layout', label: 'Layout' },
  { task: 'lines', label: 'Lines' },
  { task: 'ocr', label: 'OCR' },
]

/** The models a recognition request can name, for whoever may recognize. */
export function useRecognitionOffer(enabled: boolean): RecognitionOffer | null {
  const [offer, setOffer] = useState<RecognitionOffer | null>(null)
  useEffect(() => {
    if (enabled) getRecognitionOffer().then(setOffer).catch(() => setOffer(null))
  }, [enabled])
  return offer
}

/** A token's models as its row shows them: every model, or the ones it is limited to. */
export function modelsLabel(token: ApiToken, offer: RecognitionOffer | null): string {
  if (token.scope !== 'recognize') return '-'
  if (token.models === null) return 'all'
  const names = new Map(TASKS.flatMap(({ task }) => offer?.models[task] ?? []).map((m) => [m.id, m.name]))
  return token.models.map((id) => names.get(id) ?? `#${id}`).join(', ')
}

/** A list reads nothing without an OCR model, so the auth service is not asked to keep one. */
export const readsSomething = (models: number[] | null, offer: RecognitionOffer) =>
  models === null || offer.models.ocr.some((m) => models.includes(m.id))
