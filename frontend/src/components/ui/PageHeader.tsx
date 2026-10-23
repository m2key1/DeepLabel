import type { ReactNode } from 'react'

/** The top of an ordinary page: title on the left, controls on the right, and the
 *  sentence that says what the page is for underneath. Seven pages had written this
 *  three different ways, with three different gaps under it. */
export function PageHeader({ title, actions, children }: {
  title: ReactNode
  actions?: ReactNode
  /** The lede. One or two sentences, not a paragraph. */
  children?: ReactNode
}) {
  return (
    <header className={children ? 'mb-4' : 'mb-6'}>
      <div className="flex items-center justify-between gap-3">
        <h1 className="font-serif text-xl font-semibold">{title}</h1>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {children && <p className="mt-1 max-w-3xl text-sm text-ink-muted">{children}</p>}
    </header>
  )
}
