import type { ReactNode } from 'react'

export type NoteTone = 'ok' | 'bad'

/** What an action did, or why it would not. Carries its tone as an attribute so a
 *  failure cannot be mistaken for an outcome by anything reading the page. */
export function Note({ tone, testId, children }: {
  tone: NoteTone
  testId: string
  children: ReactNode
}) {
  return (
    <p
      data-testid={testId}
      data-tone={tone}
      role={tone === 'bad' ? 'alert' : undefined}
      className={`text-sm ${tone === 'bad' ? 'text-danger' : 'text-ink-muted'}`}
    >
      {children}
    </p>
  )
}
