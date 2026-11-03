import { displayed } from '../../lib/text'

export const percent = (value: number | null | undefined, digits = 2) =>
  value === null || value === undefined ? '-' : `${(value * 100).toFixed(digits)}%`

export const count = (n: number) => n.toLocaleString()

/** A part of a whole as a percentage, precise enough that a rare part never shows as none. */
export function share(part: number, whole: number): string {
  if (part === 0 || whole === 0) return '0%'
  const pct = (part / whole) * 100
  if (pct < 0.01) return '<0.01%'
  return `${pct.toFixed(pct < 1 ? 2 : 1)}%`
}

/** Where a scored line lives in the page editor, selected on arrival. */
export function editorLink(line: { line_id: number; job_id: string | null; page_id: number | null }): string | null {
  return line.job_id && line.page_id !== null ? `/jobs/${line.job_id}/pages/${line.page_id}?line=${line.line_id}` : null
}

/** A character the eye would otherwise miss, drawn so it can be seen. */
export function visibleGlyph(char: string): string {
  if (char === ' ') return '␣'
  if (char === '\t') return '⇥'
  return displayed(char)
}
