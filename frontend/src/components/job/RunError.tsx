import { useState } from 'react'
import { popoverChrome } from '../ui/Card'
import { useDismiss } from '../ui/menu'

/** Why a run failed, as the pipeline strip and the page table both show it. */
export function RunErrorCard({ title, error, className = '' }: { title: string; error: string; className?: string }) {
  return (
    <div data-testid="phase-error" role="dialog" aria-label="Why the run failed"
         onClick={(e) => e.stopPropagation()}
         className={`absolute z-20 mt-1.5 w-[28rem] max-w-[calc(100vw-2rem)] ${popoverChrome} p-3 ${className}`}>
      <p className="text-xs font-medium text-danger">{title}</p>
      <p className="mt-1 break-words font-mono text-xs text-ink">{error}</p>
      <p className="mt-2 text-xs text-ink-muted">Fix the cause, then start it again from Run.</p>
    </div>
  )
}

/** A page's status where the run stopped before the page got through: red, with the
 *  run's error on hover and one click away. */
export function FailedPageStatus({ label, error }: { label: string; error: string | null }) {
  const [open, setOpen] = useState(false)
  useDismiss(open, () => setOpen(false))
  return (
    <span className="relative">
      <button type="button" data-testid="page-status-failed" aria-expanded={open}
              title={error ? `${label}: ${error}` : label}
              onClick={(e) => { e.stopPropagation(); setOpen(!open) }}
              className="rounded font-medium text-danger hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger">
        {label}
      </button>
      {open && error && <RunErrorCard title={label} error={error} className="left-0 top-full" />}
    </span>
  )
}
