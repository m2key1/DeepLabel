import type { HTMLAttributes, ReactNode } from 'react'
import { InfoIcon } from '../icons'

/** What a list leaves out and why, beneath it: a few names, then how many more. A list
 *  that silently drops entries leaves people looking for what they know is there. */
export function LeftOutNote({ reason, names, className = '', ...props }: {
  reason: ReactNode
  names: string[]
} & HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p className={`flex items-start gap-1.5 rounded border border-line bg-raised px-2 py-1.5 text-xs text-ink-muted ${className}`.trim()}
       {...props}>
      <span className="mt-px shrink-0 text-ink-subtle"><InfoIcon /></span>
      <span>
        Not offered, {reason}: <span className="text-ink">{names.slice(0, 3).join(', ')}</span>
        {names.length > 3 && ` and ${names.length - 3} more`}.
      </span>
    </p>
  )
}
