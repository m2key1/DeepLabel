import { useState } from 'react'
import { declineNewerModels, runNewerModels } from '../../api'
import type { ModelTask, NewerModelOffer } from '../../api'
import { useAuth } from '../../auth'
import { plural } from '../../util'
import { Modal, modalBtn, modalPrimaryBtn } from '../Modal'

const STEP: Record<ModelTask, string> = { layout: 'Layout', lines: 'Lines', ocr: 'OCR' }
const ORDER: ModelTask[] = ['layout', 'lines', 'ocr']
const CAPABILITY: Record<ModelTask, string> = {
  layout: 'pipeline.layout', lines: 'pipeline.lines', ocr: 'pipeline.ocr',
}

/** What running the step again would do, said before it is ticked. */
function effect(offer: NewerModelOffer): { text: string; replaces: boolean } {
  if (offer.task === 'ocr') {
    const kept = offer.checked ? `; ${plural(offer.checked, 'checked line')} stay as they are` : ''
    return { text: `Re-reads ${plural(offer.unchecked ?? 0, 'unchecked line')}${kept}.`, replaces: false }
  }
  const corrections = offer.corrected
    ? ` Their ${plural(offer.corrected, 'correction')} are kept and offered on the new lines.` : ''
  if (offer.task === 'lines') {
    return { text: `Replaces ${plural(offer.lines ?? 0, 'line')} on every page.${corrections}`, replaces: true }
  }
  const signOff = offer.layout_checked
    ? ` ${plural(offer.layout_checked, 'page')} marked layout complete lose that mark.` : ''
  return {
    text: `Replaces ${plural(offer.boxes ?? 0, 'box', 'boxes')} and the ${plural(offer.lines ?? 0, 'line')} in them.${corrections}${signOff}`,
    replaces: true,
  }
}

/** Asks the dataset's owner whether to run steps again whose model has been superseded:
 *  one row per step, old model to new, and what running it would cost. */
export function NewerModelsDialog({ jobId, name, offers, onClose, onStarted, onError }: {
  jobId: string
  name: string
  offers: NewerModelOffer[]
  onClose: () => void
  onStarted: () => void
  onError: (message: string) => void
}) {
  const { can } = useAuth()
  const rows = ORDER.flatMap((task) => offers.filter((o) => o.task === task))
  const blocked = (offer: NewerModelOffer) => !can(CAPABILITY[offer.task]) ? 'You may not run this step.'
    : offer.task === 'layout' && offer.layout_checked && !can('pipeline.discard')
      ? 'Pages are marked layout complete, and you may not discard checked work.' : null
  // Re-reading leaves checked lines alone, so it is the one step ticked for you.
  const [ticked, setTicked] = useState<Set<ModelTask>>(
    () => new Set(rows.filter((o) => o.task === 'ocr' && !blocked(o)).map((o) => o.task)))
  const [busy, setBusy] = useState(false)
  const firstTicked = ORDER.find((task) => ticked.has(task))

  const toggle = (task: ModelTask) => setTicked((prev) => {
    const next = new Set(prev)
    if (next.has(task)) next.delete(task)
    else next.add(task)
    return next
  })

  const act = async (call: () => Promise<unknown>, after: () => void) => {
    setBusy(true)
    try {
      await call()
      onClose()
      after()
    } catch (e) {
      onError((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <Modal title={`Newer models for ${name}`} width="lg" onClose={onClose}>
      <p className="mb-3 text-sm text-ink-muted">
        Some steps of this dataset were run with a model that has since been replaced. Tick the
        ones to run again with the newer model.
      </p>
      <div className="mb-3 space-y-2" data-testid="newer-models">
        {rows.map((offer) => {
          const { text, replaces } = effect(offer)
          const reason = blocked(offer)
          const runsAnyway = !ticked.has(offer.task) && firstTicked !== undefined
            && ORDER.indexOf(firstTicked) < ORDER.indexOf(offer.task)
          const on = ticked.has(offer.task)
          return (
            <label key={offer.task} data-testid="newer-model" data-task={offer.task}
                   className={`flex gap-3 rounded-md border p-3 ${reason ? 'opacity-60' : 'cursor-pointer'} ${
                     on ? 'border-accent bg-accent-wash/40' : 'border-line hover:border-line-strong'}`}>
              <input type="checkbox" checked={on} disabled={!!reason} onChange={() => toggle(offer.task)}
                     aria-label={`Run ${STEP[offer.task]} with ${offer.to.name}`}
                     className="mt-0.5 size-4 shrink-0 accent-accent" />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-sm font-semibold text-ink">{STEP[offer.task]}</span>
                  <span className="text-xs text-ink-muted">
                    <span data-testid="newer-model-from">{offer.from.name}</span>
                    <span aria-hidden="true" className="mx-1.5">→</span>
                    <span className="sr-only"> to </span>
                    <span data-testid="newer-model-to" className="font-medium text-accent-ink">{offer.to.name}</span>
                  </span>
                </span>
                <span data-testid="newer-model-effect"
                      className={`mt-0.5 block text-xs ${replaces ? 'text-warn' : 'text-ink-muted'}`}>
                  {text}
                </span>
                {reason && <span className="mt-0.5 block text-xs text-ink-subtle">{reason}</span>}
                {runsAnyway && !reason && (
                  <span className="mt-0.5 block text-xs text-ink-subtle">
                    Runs again after {STEP[firstTicked!].toLowerCase()} either way; tick it to use {offer.to.name}.
                  </span>
                )}
              </span>
            </label>
          )
        })}
      </div>
      <p className="mb-4 text-xs text-ink-muted">
        The dataset switches to the ticked models. Not now asks again only when an even newer model appears.
      </p>
      <div className="flex justify-end gap-2">
        <button disabled={busy} className={modalBtn} data-testid="newer-models-decline"
                onClick={() => act(() => declineNewerModels(jobId), () => undefined)}>
          Not now
        </button>
        <button disabled={busy || ticked.size === 0} data-testid="newer-models-run"
                className={`${modalPrimaryBtn} disabled:opacity-40`}
                onClick={() => act(() => runNewerModels(jobId, [...ticked]), onStarted)}>
          {busy ? 'Starting…' : 'Switch and run'}
        </button>
      </div>
    </Modal>
  )
}
