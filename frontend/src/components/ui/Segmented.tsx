import type { ReactNode } from 'react'

interface SegmentedProps<T extends string> {
  value: T
  options: { value: T; label: ReactNode; title?: string }[]
  onChange: (value: T) => void
  className?: string
}

export function Segmented<T extends string>({ value, options, onChange, className = '' }: SegmentedProps<T>) {
  return (
    <div className={`flex overflow-hidden rounded border border-line-strong ${className}`.trim()}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          aria-pressed={value === o.value}
          title={o.title}
          className={`px-2 py-1 text-xs font-medium focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent ${
            value === o.value
              ? 'bg-accent-wash text-accent-ink'
              : 'text-ink-subtle hover:bg-raised hover:text-ink'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
