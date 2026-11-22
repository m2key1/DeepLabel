import { useState } from 'react'
import { CaretIcon } from '../icons'

/** The stretch of a document the corpus cut put on this page, folded to its source until
 *  opened. One no line of the page anchored is only what the pages around it left over,
 *  which is where a cut goes wrong quietly, so it says so. */
export function PageReference({ reference }: { reference: { document: string; text: string; anchors: number } }) {
  const [open, setOpen] = useState(false)
  const anchored = reference.anchors > 0
  return (
    <div data-testid="page-reference" data-anchored={anchored}
         className={`mb-2 rounded border p-1.5 ${anchored ? 'border-line' : 'border-warn'}`}>
      <button type="button" data-testid="page-reference-toggle" aria-expanded={open} onClick={() => setOpen(!open)}
              className={`flex w-full items-center gap-1 text-left text-xs font-medium ${anchored ? 'text-ink-muted' : 'text-warn'}`}>
        <span className={open ? '' : '-rotate-90'}><CaretIcon /></span>
        <span className="min-w-0 truncate">
          From {reference.document}{anchored ? '' : ' - no line of this page matched it'}
        </span>
      </button>
      {open && (
        <p data-testid="page-reference-text"
           className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap text-sm text-ink">
          {reference.text}
        </p>
      )}
    </div>
  )
}
