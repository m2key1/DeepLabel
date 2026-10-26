import { useId, useState, type ReactNode } from 'react'
import { CaretIcon } from '../icons'
import { Button } from '../ui/Button'
import { popoverChrome } from '../ui/Card'
import { menuTrigger, useDismiss } from '../ui/menu'

export interface MenuAction {
  label: string
  hint?: string
  testId?: string
  /** Work an edit left waiting: listed first and counted on the button. */
  pending?: number
  danger?: boolean
  onSelect: () => void
}

/** A toolbar button that opens a list of actions, each with a line saying what it does.
 *  Pending work shows as an amber count on the button, so a closed menu still says that
 *  something waits. */
export function ActionMenu({ trigger, caret = false, label, testId, title, actions }: {
  trigger: ReactNode
  caret?: boolean
  /** The button's accessible name, when its face is only an icon. */
  label?: string
  testId: string
  title: string
  actions: MenuAction[]
}) {
  const [open, setOpen] = useState(false)
  const id = useId()
  useDismiss(open, () => setOpen(false))
  if (!actions.length) return null
  const waiting = actions.reduce((sum, action) => sum + (action.pending ?? 0), 0)
  const ordered = [...actions.filter((a) => a.pending), ...actions.filter((a) => !a.pending)]

  return (
    <div className="relative">
      <Button size="xs" data-testid={testId} aria-label={label} title={title} {...menuTrigger(open)}
              onClick={(e) => {
                e.stopPropagation()
                setOpen(!open)
              }}>
        {trigger}
        {waiting > 0 && (
          <span data-testid={`${testId}-pending`}
                className="rounded-full bg-warn px-1.5 text-[10px] font-semibold leading-4 text-surface">
            {waiting}
          </span>
        )}
        {caret && <CaretIcon />}
      </Button>
      {open && (
        <div data-testid={`${testId}-items`} onClick={(e) => e.stopPropagation()}
             className={`absolute right-0 top-full z-30 mt-1 w-64 overflow-hidden py-1 ${popoverChrome}`}>
          {ordered.map((action, i) => (
            <button
              key={action.label}
              type="button"
              data-testid={action.testId}
              aria-label={action.label}
              aria-describedby={action.hint ? `${id}-${i}` : undefined}
              onClick={() => {
                setOpen(false)
                action.onSelect()
              }}
              className={`block w-full px-2.5 py-1.5 text-left text-xs hover:bg-raised ${
                action.danger ? 'text-danger' : 'text-ink'} ${
                i > 0 && !action.pending && ordered[i - 1].pending ? 'border-t border-line' : ''} ${
                action.danger && i > 0 ? 'border-t border-line' : ''}`}
            >
              <span className="flex items-center gap-1.5 font-medium">
                {!!action.pending && <span aria-hidden="true" className="size-1.5 rounded-full bg-warn" />}
                {action.label}
              </span>
              {action.hint && <span id={`${id}-${i}`} className="block text-[11px] font-normal text-ink-muted">{action.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
