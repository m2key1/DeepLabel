import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react'
import { FlaskIcon } from './icons'
import { SwitchKnob } from './ui/SwitchKnob'

export const TEST_PAGE_MEANING = 'Test data - no training uses it, nor pages with the same scan'

/** Whether a page is test data, as a switch that says what being on means. `compact`
 *  leaves only the flask and the switch, for a table cell. */
export function TestPageSwitch({ on, compact = false, className = '', ...props }: {
  on: boolean
  compact?: boolean
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'role'>) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      title={TEST_PAGE_MEANING}
      {...props}
      className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium ${
        on ? 'border-test/40 bg-test-wash text-test' : 'border-line-strong text-ink-muted hover:text-ink'
      } ${className}`}
    >
      <FlaskIcon />
      {!compact && 'Test page'}
      <SwitchKnob on={on} onColor="bg-test" />
      {on && !compact && <span className="font-normal opacity-80">kept out of training</span>}
    </button>
  )
}

/** Test data shown to someone who cannot change it, or summed up for a dataset. */
export function TestDataChip({ children, className = '', ...props }: {
  children: ReactNode
} & HTMLAttributes<HTMLSpanElement>) {
  return (
    <span title={TEST_PAGE_MEANING} {...props}
          className={`inline-flex shrink-0 items-center gap-1 rounded-full bg-test-wash px-2 py-0.5 text-[11px] font-medium text-test ${className}`}>
      <FlaskIcon />
      {children}
    </span>
  )
}
