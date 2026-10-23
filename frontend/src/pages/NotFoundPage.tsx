import type { ReactNode } from 'react'
import { Link, useLocation, useRouteError } from 'react-router-dom'
import { buttonClass } from '../components/ui/Button'
import { PageHeader } from '../components/ui/PageHeader'
import { pageShell } from '../components/ui/page'

function DeadEnd({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className={pageShell}>
      <PageHeader title={title}>{children}</PageHeader>
      <Link to="/" className={buttonClass({ variant: 'outline', size: 'md' })}>Back to the datasets</Link>
    </div>
  )
}

export function NotFoundPage() {
  const { pathname } = useLocation()
  return (
    <DeadEnd title="Page not found">
      Nothing lives at <span className="font-mono">{pathname}</span>. The link may be old, or the
      address mistyped.
    </DeadEnd>
  )
}

/** A page that failed to draw says so inside the app, with the way out still on screen. */
export function RouteError() {
  const error = useRouteError()
  const message = error instanceof Error ? error.message : String(error)
  return (
    <DeadEnd title="This page failed to load">
      {message}
    </DeadEnd>
  )
}
