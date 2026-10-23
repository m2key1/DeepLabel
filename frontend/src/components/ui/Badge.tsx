import type { ReactNode } from 'react'

export type Tone = 'neutral' | 'accent' | 'ok' | 'warn' | 'danger'

/** A wash behind, its own ink in front, and a border in between. Written per tone rather
 *  than composed from one string so each stays legible on its own line. */
const TONES: Record<Tone, string> = {
  neutral: 'border-line bg-raised text-ink-muted',
  accent: 'border-accent/40 bg-accent-wash text-accent-ink',
  ok: 'border-ok/40 bg-ok/10 text-ok',
  warn: 'border-warn/40 bg-warn/10 text-warn',
  danger: 'border-danger/40 bg-danger/10 text-danger',
}

/** `soft` is the label on its own - a word about a thing, in the reading face. `chip` is
 *  the one that sits in a row beside the pipeline chips, and matches them: mono, tighter,
 *  the same height, so a row carries one kind of chip rather than two. */
export type BadgeVariant = 'soft' | 'chip'

const SHAPE: Record<BadgeVariant, string> = {
  soft: 'rounded border px-1.5 py-0.5 text-xs font-medium',
  chip: 'rounded border px-1.5 font-mono text-[10px] leading-4',
}

export function Badge({ tone = 'neutral', variant = 'soft', className = '', children, ...props }: {
  tone?: Tone
  variant?: BadgeVariant
  className?: string
  children: ReactNode
} & React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={`inline-block ${SHAPE[variant]} ${TONES[tone]} ${className}`.trim()}
      {...props}
    >
      {children}
    </span>
  )
}
