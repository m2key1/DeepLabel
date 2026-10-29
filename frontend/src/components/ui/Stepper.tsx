import { CheckIcon } from '../icons'

export interface StepperItem<T extends string> {
  id: T
  label: string
  /** Not part of this run of the steps: shown, struck through, and not clickable. */
  skipped?: boolean
  done?: boolean
}

/** A row of numbered steps, the current one underlined. Any step that applies can be
 *  clicked to go back to it, or ahead to look. */
export function Stepper<T extends string>({ steps, current, onSelect }: {
  steps: StepperItem<T>[]
  current: T
  onSelect: (id: T) => void
}) {
  return (
    <ol className="mb-5 flex border-b border-line" aria-label="Steps">
      {steps.map((step, i) => {
        const on = step.id === current
        return (
          <li key={step.id} className="flex-1">
            <button
              type="button"
              data-testid={`wizard-step-${step.id}`}
              data-skipped={step.skipped || undefined}
              aria-current={on ? 'step' : undefined}
              disabled={step.skipped}
              onClick={() => onSelect(step.id)}
              title={step.skipped ? 'Nothing to choose here for this dataset' : undefined}
              className={`-mb-px flex w-full items-center gap-2 border-b-2 px-2 py-2 text-left text-sm ${
                on ? 'border-accent font-medium text-accent-ink'
                  : step.skipped ? 'border-transparent text-ink-subtle line-through opacity-50'
                    : 'border-transparent text-ink-muted hover:text-ink'}`}
            >
              <span className={`grid size-5 shrink-0 place-items-center rounded-full border text-[11px] ${
                on ? 'border-accent bg-accent text-on-accent'
                  : step.done && !step.skipped ? 'border-accent bg-accent-wash text-accent-ink'
                    : 'border-line-strong bg-surface'}`}>
                {step.done && !on && !step.skipped ? <CheckIcon /> : i + 1}
              </span>
              <span className="min-w-0 truncate">{step.label}</span>
            </button>
          </li>
        )
      })}
    </ol>
  )
}
