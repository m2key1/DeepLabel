import { useState } from 'react'
import type { LlmReadStatus } from '../../api'
import { CheckIcon } from '../icons'
import { Button } from '../ui/Button'

const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1) + (/[.!?]$/.test(text) ? '' : '.')

/** Where the dataset's language-model readings stand: a row per model with its progress,
 *  and a failed count that opens what went wrong - in words, with what the provider
 *  answered underneath for whoever has to look closer. */
export function LlmProgress({ status, onCancel, onRetry, onDismiss }: {
  status: LlmReadStatus
  onCancel: () => void
  onRetry: () => Promise<unknown>
  onDismiss: () => void
}) {
  const [open, setOpen] = useState<number | null>(null)
  const [retrying, setRetrying] = useState(false)

  return (
    <div data-testid="llm-progress" className="mb-4 rounded border border-line p-3 text-sm">
      <div className="mb-2 flex items-center gap-2">
        <span className="font-medium">Language models</span>
        {/* A run over two pages of fifty reports 2/2, which reads as the whole dataset
            having been transcribed. The denominator says otherwise. */}
        <span data-testid="llm-progress-scope" className="text-xs text-ink-muted">
          of {status.pages} page{status.pages === 1 ? '' : 's'} in this dataset
        </span>
        {status.active && (
          <Button size="xs" variant="ghost" data-testid="llm-cancel" onClick={onCancel} className="ml-auto">
            Cancel what is not sent
          </Button>
        )}
        <button onClick={onDismiss} data-testid="llm-progress-dismiss" title="Hide this until the next run"
                aria-label="Dismiss"
                className={`${status.active ? '' : 'ml-auto'} rounded px-1 text-ink-subtle hover:text-ink`}>
          ×
        </button>
      </div>
      <div className="space-y-1.5">
        {status.models.map((model) => {
          const total = model.done + model.pending + model.running + model.error
          const errors = status.errors.filter((e) => e.id === model.id)
          return (
            <div key={model.id} data-testid="llm-progress-model" data-label={model.label}>
              <div className="flex items-center gap-3 text-xs">
                <span className="w-48 truncate font-medium text-ink" title={model.label}>{model.label}</span>
                <span aria-hidden="true" className="h-1.5 w-28 shrink-0 overflow-hidden rounded-full bg-raised">
                  <span className="block h-full bg-accent" style={{ width: `${total ? (model.done / total) * 100 : 0}%` }} />
                </span>
                <span className="font-mono tabular-nums text-ink-muted">{model.done}/{total}</span>
                {/* Finished is all the count says, so without this a page being read right
                    now looks exactly like one nothing is happening to. */}
                {model.running > 0 && <span className="text-accent-ink">{model.running} being read</span>}
                {total > 0 && model.done === total && <span className="text-ok"><CheckIcon /></span>}
                {model.error > 0 && (
                  <button type="button" data-testid="llm-progress-failed" data-label={model.label}
                          aria-expanded={open === model.id} title={errors[0] ? sentence(errors[0].summary) : undefined}
                          onClick={() => setOpen(open === model.id ? null : model.id)}
                          className="rounded-full bg-danger/10 px-2 py-0.5 font-medium text-danger hover:bg-danger/20">
                    ✕ {model.error} failed
                  </button>
                )}
              </div>
              {open === model.id && (
                <div className="mt-1 ml-1 rounded border border-danger/30 bg-danger/5 px-2.5 py-1.5 text-xs">
                  {errors.map((failure) => (
                    <div key={failure.error} data-testid="llm-progress-error" data-label={failure.label} className="mb-1">
                      <span className="text-danger">{sentence(failure.summary)}</span>
                      {failure.c > 1 && <span className="text-ink-muted"> ({failure.c} pages)</span>}
                      {failure.detail && (
                        <span className="mt-0.5 block break-all font-mono text-[11px] text-ink-subtle">{failure.detail}</span>
                      )}
                    </div>
                  ))}
                  <Button size="xs" data-testid="llm-retry" disabled={retrying || status.active}
                          onClick={() => {
                            setRetrying(true)
                            onRetry().finally(() => setRetrying(false))
                          }}>
                    {retrying ? 'Asking again…' : 'Retry failed'}
                  </Button>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
