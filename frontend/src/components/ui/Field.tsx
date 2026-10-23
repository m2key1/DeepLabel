import type { ComponentPropsWithRef, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react'

/** The chrome every control in the app shares. Width is deliberately not part of it:
 *  a control that states its own width cannot be narrowed by a caller without two
 *  utilities fighting over the same property, and the loser is decided by Tailwind's
 *  output order rather than by the call site. So every caller says how wide. */
const CONTROL =
  'rounded border border-line-strong bg-surface text-ink ' +
  'placeholder:text-ink-subtle ' +
  'focus-visible:border-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent ' +
  'disabled:cursor-not-allowed disabled:opacity-40'

export type ControlSize = 'xs' | 'sm' | 'md'

const SIZES: Record<ControlSize, string> = {
  xs: 'px-1.5 py-0.5 text-xs',
  sm: 'px-2 py-1 text-sm',
  md: 'px-2 py-1.5 text-sm',
}

export function controlClass(size: ControlSize = 'sm', extra = ''): string {
  return `${CONTROL} ${SIZES[size]} ${extra}`.trim()
}

type InputProps = { size?: ControlSize } & Omit<ComponentPropsWithRef<'input'>, 'size'>

export function Input({ size, className, ...props }: InputProps) {
  return <input className={controlClass(size, className ?? '')} {...props} />
}

// `size` is a native attribute on both input and select (a character count, a row
// count), so ours replaces it rather than intersecting with it.
type SelectProps = { size?: ControlSize } & Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'>

export function Select({ size, className, ...props }: SelectProps) {
  return <select className={controlClass(size, className ?? '')} {...props} />
}

type TextareaProps = { size?: ControlSize } & TextareaHTMLAttributes<HTMLTextAreaElement>

export function Textarea({ size, className, ...props }: TextareaProps) {
  return <textarea className={controlClass(size, className ?? '')} {...props} />
}

/** A checkbox or radio, which take their colour from the accent rather than the
 *  browser's own blue. */
export function Check({ className, type = 'checkbox', ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input type={type} className={`accent-accent ${className ?? ''}`.trim()} {...props} />
}

/** A checkbox with its label and its explanation on the right, all three one click
 *  target. Written out at four call sites before this, each slightly differently. */
export function CheckField({ label, help, checked, onChange, disabled, ...props }: {
  label: ReactNode
  help?: ReactNode
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'checked' | 'type'>) {
  return (
    <label className={`flex items-start gap-2 text-sm ${disabled ? 'opacity-40' : 'cursor-pointer'}`}>
      <Check
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5"
        {...props}
      />
      <span className="min-w-0">
        <span className="text-ink">{label}</span>
        {help && <span className="block text-xs text-ink-subtle">{help}</span>}
      </span>
    </label>
  )
}
