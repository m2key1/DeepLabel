/** What a convention flag changes, as one word with the flag and without it. */
export function ConventionExample({ on, off }: { on: string; off: string }) {
  if (!on && !off) return null
  return (
    <span data-testid="convention-example" title="With the flag / without it"
          className="whitespace-nowrap font-ocr text-xs font-normal text-ink-muted">
      <span className="text-ink">{on || '-'}</span>
      <span className="px-1 text-ink-subtle">/</span>
      {off || '-'}
    </span>
  )
}
