import { useState } from 'react'
import { setApiTokenModels } from '../api'
import type { ApiToken, RecognitionOffer } from '../api'
import { TASKS, readsSomething } from '../tokenModels'
import { Button, Toggle } from './ui/Button'
import { Segmented } from './ui/Segmented'

const SCOPES = [
  { value: 'all', label: 'All models', title: 'Every model, new ones included' },
  { value: 'chosen', label: 'Chosen models', title: 'Only the models ticked below - a new one once it is ticked' },
] as const

const deploymentDefaults = (offer: RecognitionOffer) =>
  [...offer.models.lines, ...offer.models.ocr].filter((m) => m.default).map((m) => m.id)

/** All models, or the ones ticked - starting from the deployment's own line and OCR models. */
export function ModelChooser({ offer, value, onChange }: {
  offer: RecognitionOffer
  value: number[] | null
  onChange: (models: number[] | null) => void
}) {
  const flip = (id: number) =>
    value && onChange(value.includes(id) ? value.filter((m) => m !== id) : [...value, id].sort((a, b) => a - b))
  return (
    <div data-testid="token-models" className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <span className="w-12 text-xs text-ink-muted">Models</span>
        <Segmented
          value={value === null ? 'all' : 'chosen'}
          options={[...SCOPES]}
          onChange={(scope) => onChange(scope === 'all' ? null : deploymentDefaults(offer))}
        />
      </div>
      {value !== null && TASKS.filter(({ task }) => offer.models[task].length > 0).map(({ task, label }) => (
        <div key={task} data-task={task} className="flex flex-wrap items-center gap-1.5">
          <span className="w-12 text-xs text-ink-muted">{label}</span>
          {offer.models[task].map((m) => (
            <Toggle key={m.id} on={value.includes(m.id)} onClick={() => flip(m.id)}>{m.name}</Toggle>
          ))}
        </div>
      ))}
      {!readsSomething(value, offer) && <p className="text-xs text-danger">Pick at least one OCR model.</p>}
    </div>
  )
}

/** A token's models changed after it was handed out, in a row of its own under the token's. */
export function TokenModelsEditor({ token, offer, columns, onSaved, onCancel }: {
  token: ApiToken
  offer: RecognitionOffer
  columns: number
  onSaved: () => void
  onCancel: () => void
}) {
  const [draft, setDraft] = useState(token.models)
  const [error, setError] = useState<string | null>(null)
  const save = () => setApiTokenModels(token.id, draft).then(onSaved).catch((e: Error) => setError(e.message))
  return (
    <tr className="border-b border-line bg-ground">
      <td colSpan={columns} data-testid="token-models-editor" className="whitespace-normal px-2 py-2.5">
        {/* Held in view while a narrow window scrolls the table beside it. */}
        <div className="sticky left-2 max-w-[calc(100vw-3rem)]">
          <ModelChooser offer={offer} value={draft} onChange={setDraft} />
          {error && <p className="mt-1 text-xs text-danger">{error}</p>}
          <div className="mt-2 flex gap-2">
            <Button variant="primary" size="sm" onClick={save} disabled={!readsSomething(draft, offer)}>Save</Button>
            <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
          </div>
        </div>
      </td>
    </tr>
  )
}
