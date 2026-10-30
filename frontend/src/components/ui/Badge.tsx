import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react'
import { CaretIcon } from '../icons'

export type Tone = 'neutral' | 'accent' | 'ok' | 'warn' | 'danger' | 'test' | 'note'

/** The colour a chip's mark is drawn in. Neutral has none: a fact without a judgement. */
const MARK: Record<Tone, string> = {
  neutral: '',
  accent: 'bg-accent',
  ok: 'bg-ok',
  warn: 'bg-warn',
  danger: 'bg-danger',
  test: 'bg-test',
  note: 'bg-note',
}

const GLYPH: Record<Tone, string> = {
  neutral: 'text-ink-subtle',
  accent: 'text-accent',
  ok: 'text-ok',
  warn: 'text-warn',
  danger: 'text-danger',
  test: 'text-test',
  note: 'text-note',
}

/** Every chip in the app is this one hairline box, in one size and one face. What it means
 *  is carried by a small mark at its front, so a row of chips stays calm and the one that
 *  matters is found by its colour; only a failure is tinted. */
export function chipClass(tone: Tone = 'neutral'): string {
  return 'inline-flex h-[22px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded border px-2 text-xs font-medium ' +
    (tone === 'danger' ? 'border-danger/45 bg-danger/5 text-danger' : 'border-line-strong bg-surface text-ink-muted')
}

interface ChipParts {
  tone?: Tone
  /** A glyph in place of the plain mark, drawn in the tone's colour. */
  icon?: ReactNode
  /** A count or fraction after the label, in figures. */
  value?: ReactNode
  /** The chip opens something. */
  caret?: boolean
  children?: ReactNode
}

function ChipInside({ tone = 'neutral', icon, value, caret, children }: ChipParts) {
  return (
    <>
      {icon
        ? <span aria-hidden="true" className={`flex shrink-0 ${GLYPH[tone]}`}>{icon}</span>
        : MARK[tone] && <span aria-hidden="true" className={`size-[7px] shrink-0 rounded-[2px] ${MARK[tone]}`} />}
      {children}
      {/* Not laid out in a flex box, but read: "Test pages 2/3", not "Test pages2/3". */}
      {value !== undefined && <>{' '}<span className="font-mono text-[11px] tabular-nums text-ink">{value}</span></>}
      {caret && <span aria-hidden="true" className="-mr-0.5 flex text-ink-subtle"><CaretIcon /></span>}
    </>
  )
}

export function Badge({ tone, icon, value, caret, className = '', children, ...props }:
  ChipParts & HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className={`${chipClass(tone)} ${className}`.trim()} {...props}>
      <ChipInside tone={tone} icon={icon} value={value} caret={caret}>{children}</ChipInside>
    </span>
  )
}

/** A chip that does something when pressed: the same box, with a hover and a focus ring. */
export function ChipButton({ tone, icon, value, caret, className = '', children, type = 'button', ...props }:
  ChipParts & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type={type} className={`${chipClass(tone)} hover:border-ink-subtle hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${className}`.trim()}
            {...props}>
      <ChipInside tone={tone} icon={icon} value={value} caret={caret}>{children}</ChipInside>
    </button>
  )
}
