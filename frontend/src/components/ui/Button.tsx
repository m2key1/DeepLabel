import type { ButtonHTMLAttributes } from 'react'

export type ButtonVariant = 'primary' | 'outline' | 'ghost' | 'danger'
export type ButtonSize = 'xs' | 'sm' | 'md' | 'icon'

const BASE =
  'inline-flex items-center justify-center gap-1.5 rounded font-medium ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ' +
  'disabled:pointer-events-none disabled:opacity-40'

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'border border-transparent bg-accent text-on-accent hover:brightness-110',
  outline: 'border border-line-strong text-ink-muted hover:border-accent hover:text-accent-ink',
  ghost: 'border border-transparent text-ink-muted hover:bg-raised hover:text-ink',
  danger: 'border border-line-strong text-danger hover:border-danger',
}

const SIZES: Record<ButtonSize, string> = {
  xs: 'px-2 py-1 text-xs',
  sm: 'px-2.5 py-1 text-sm',
  md: 'px-3 py-1.5 text-sm',
  icon: 'p-1.5',
}

interface ButtonStyle {
  variant?: ButtonVariant
  size?: ButtonSize
}

// For non-button elements (router Links, anchors) that should look like a button.
export function buttonClass({ variant = 'outline', size = 'sm' }: ButtonStyle = {}, extra = ''): string {
  return `${BASE} ${VARIANTS[variant]} ${SIZES[size]} ${extra}`.trim()
}

type ButtonProps = ButtonStyle & ButtonHTMLAttributes<HTMLButtonElement>

export function Button({ variant, size, className, type = 'button', ...props }: ButtonProps) {
  return <button type={type} className={buttonClass({ variant, size }, className ?? '')} {...props} />
}

const TOGGLE_ON = 'border-accent bg-accent-wash text-accent-ink'
const TOGGLE_OFF = 'border-line-strong text-ink-subtle hover:text-ink'

type ToggleProps = { on: boolean; size?: ButtonSize } & ButtonHTMLAttributes<HTMLButtonElement>

export function Toggle({ on, size = 'xs', className, type = 'button', ...props }: ToggleProps) {
  return (
    <button
      type={type}
      aria-pressed={on}
      className={`${BASE} border ${on ? TOGGLE_ON : TOGGLE_OFF} ${SIZES[size]} ${className ?? ''}`.trim()}
      {...props}
    />
  )
}
