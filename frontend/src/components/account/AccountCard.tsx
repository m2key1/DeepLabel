import type { ComponentProps, FormEvent, ReactNode } from 'react'
import { cardChrome } from '../ui/Card'
import { Input } from '../ui/Field'

/** The page every account step is drawn on before anyone is in: signing in, signing up,
 *  setting a password, waiting for approval. A form when it takes one. */
export function AccountCard({ title, testid, onSubmit, footer, children }: {
  title: string
  testid: string
  onSubmit?: () => void
  footer?: ReactNode
  children: ReactNode
}) {
  const body = (
    <>
      <h2 className="text-base font-semibold text-ink">{title}</h2>
      {children}
    </>
  )
  const card = `${cardChrome} space-y-4 p-6`
  return (
    <main className="flex min-h-screen justify-center bg-ground px-4 pb-12 pt-[18vh]">
      <div className="w-full max-w-sm">
        <h1 className="mb-6 text-center font-serif text-2xl font-semibold text-ink">DeepLabel</h1>
        {onSubmit ? (
          <form data-testid={testid} className={card}
                onSubmit={(e: FormEvent) => { e.preventDefault(); onSubmit() }}>
            {body}
          </form>
        ) : (
          <div data-testid={testid} className={card}>{body}</div>
        )}
        {footer && <div className="mt-4 text-center text-xs text-ink-subtle">{footer}</div>}
      </div>
    </main>
  )
}

/** A labelled input across the card's width. */
export function AccountField({ label, ...input }: { label: string } & ComponentProps<typeof Input>) {
  return (
    <label className="block space-y-1">
      <span className="text-sm text-ink-muted">{label}</span>
      <Input size="md" className="w-full" {...input} />
    </label>
  )
}

export function AccountError({ message }: { message: string | null }) {
  if (!message) return null
  return <p data-testid="account-error" role="alert" className="text-sm text-danger">{message}</p>
}
