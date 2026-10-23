import type { ReactNode } from 'react'

/** What a list says when it has nothing in it. Always a sentence about this list rather
 *  than "No data", and with the action that would fill it where there is one. */
export function EmptyState({ children, action, className = '' }: {
  children: ReactNode
  action?: ReactNode
  className?: string
}) {
  return (
    <div
      data-testid="empty-state"
      className={`rounded-md border border-dashed border-line px-3 py-6 text-center ${className}`.trim()}
    >
      <p className="text-sm text-ink-subtle">{children}</p>
      {action && <div className="mt-2 flex justify-center">{action}</div>}
    </div>
  )
}
