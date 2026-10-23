import { Badge } from '../ui/Badge'

/** Who wrote a page's ground truth. A person's transcription is a record; everything
 *  else is some machine's reading of the same page, and the two must never look alike. */
const SOURCES: Record<string, { label: string; title: string; machine: boolean }> = {
  sidecar: {
    label: 'transcribed by hand',
    title: 'A transcription uploaded beside the scan',
    machine: false,
  },
  pdf: {
    label: "from the document's text layer",
    title: 'Extracted from the PDF this page came out of, not read by a person',
    machine: true,
  },
  llm: {
    label: 'read by a model',
    title: 'A diplomatic reading against the corpus span - machine-made, so nothing '
      + 'checks it off',
    machine: true,
  },
}

/** Nothing is drawn for a page with no ground truth, which is what a null source means
 *  here - the listing carries the source rather than the text. */
export function GtSource({ source }: { source: string | null }) {
  if (source === null) return null
  const known = SOURCES[source] ?? SOURCES.sidecar
  return (
    <Badge
      tone={known.machine ? 'warn' : 'ok'}
      data-testid="gt-source"
      data-source={source}
      title={known.title}
    >
      {known.label}
    </Badge>
  )
}
