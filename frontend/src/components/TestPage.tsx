import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react'
import { FlaskIcon } from './icons'
import { Badge, chipClass } from './ui/Badge'
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
      className={`${chipClass()} hover:border-ink-subtle hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${className}`}
    >
      <span aria-hidden="true" className={`flex ${on ? 'text-test' : 'text-ink-subtle'}`}><FlaskIcon /></span>
      {!compact && 'Test page'}
      <SwitchKnob on={on} onColor="bg-test" />
      {on && !compact && <span className="font-normal text-ink-subtle">kept out of training</span>}
    </button>
  )
}

/** Test data shown to someone who cannot change it, or summed up for a dataset. */
export function TestDataChip({ children, value, ...props }: {
  children: ReactNode
  value?: ReactNode
} & HTMLAttributes<HTMLSpanElement>) {
  return <Badge tone="test" icon={<FlaskIcon />} value={value} title={TEST_PAGE_MEANING} {...props}>{children}</Badge>
}
