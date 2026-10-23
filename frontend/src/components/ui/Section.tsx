import type { ReactNode } from 'react'

/** A block of a page under its own heading, with room for the controls that belong to
 *  that block rather than to the page. */
export function Section({ title, actions, description, className = '', children, ...props }: {
  title: ReactNode
  actions?: ReactNode
  description?: ReactNode
  className?: string
  children: ReactNode
} & React.HTMLAttributes<HTMLElement>) {
  return (
    <section className={`mb-8 ${className}`.trim()} {...props}>
      <div className="mb-2 flex items-center gap-2">
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        {actions}
      </div>
      {description && <p className="-mt-1 mb-2 max-w-3xl text-xs text-ink-subtle">{description}</p>}
      {children}
    </section>
  )
}

/** A heading inside a Section - the vocabulary groups in Settings, the per-task lists
 *  on the models page. */
export function SubHeading({ className = '', children }: { className?: string; children: ReactNode }) {
  return (
    <h3 className={`mb-1 text-xs font-semibold text-ink-muted ${className}`.trim()}>{children}</h3>
  )
}
