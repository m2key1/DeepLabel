import { useEffect, useState } from 'react'
import {
  PHASE_CAPABILITY, getLlmReadPreview, getPageLlmReadings, getPageRunCosts, type LlmReadPreview,
  type LlmReadingsOnFile, type PagePhase, type PageRunCosts,
} from '../../api'
import { useAuth } from '../../auth'
import { CaretIcon, PlayIcon } from '../icons'
import { Button } from '../ui/Button'
import { popoverChrome } from '../ui/Card'
import { menuTrigger, useDismiss } from '../ui/menu'
import { plural } from '../../util'

const menuItem =
  'block w-full px-2.5 py-1.5 text-left text-xs hover:bg-raised disabled:opacity-40 ' +
  'disabled:hover:bg-transparent'

/** What each phase would replace, said before it is queued. Detection is destructive by
 *  nature - it cannot know which of the boxes it is about to draw is the one you fixed -
 *  so the number goes on the button rather than in a dialog after the fact. */
function describe(phase: PagePhase, costs: PageRunCosts): string {
  if (phase === 'layout') {
    const { elements, lines } = costs.layout
    if (elements === 0) return lines === 0 ? 'nothing detected here yet' : `replaces ${plural(lines, 'line')}`
    return `replaces ${plural(elements, 'box', 'boxes')} and ${plural(lines, 'line')}`
  }
  if (phase === 'lines') {
    return costs.lines.lines === 0
      ? 'no lines here yet'
      : `replaces ${plural(costs.lines.lines, 'line')}`
  }
  const { unchecked, checked } = costs.ocr
  if (unchecked === 0) return checked > 0 ? 'every line is checked' : 'no lines to read'
  return checked > 0
    ? `re-reads ${unchecked}, leaves ${checked} checked`
    : `re-reads ${plural(unchecked, 'line')}`
}

const RUNNABLE: PagePhase[] = ['layout', 'lines', 'ocr']

const LABELS: Record<PagePhase, string> = {
  layout: 'Layout detection',
  lines: 'Line detection',
  ocr: 'OCR',
}

/** What sending this one page to the language models would cost, in the same voice as the
 *  phases above it. Nothing to ask is a state of its own: the same page under the same
 *  wording is never paid for twice, here or on the dataset page - but the entry still opens,
 *  because picking a different model is exactly what to do about that. */
function describeRead(models: number[], preview: LlmReadPreview | null): string {
  if (models.length === 0) return 'pick the models to read this page with'
  if (!preview) return 'reading…'
  if (preview.calls === 0) return 'already read - pick another model, or change the prompt'
  return `${preview.models.filter((m) => m.calls > 0).map((m) => m.label).join(', ')}`
    + ` - ${plural(preview.calls, 'call')}`
}

interface RunMenuProps {
  pageId: number
  jobId: string
  /** The models this dataset reads with. The entry opens whether or not there are any -
   *  choosing them is what the dialog behind it is for. */
  llmModelIds: number[]
  onReadPage: () => void
  /** Offered once the page has readings to remove. */
  onRemoveReadings: () => void
  busy: boolean
  onRun: (phase: PagePhase) => void
  onError: (message: string) => void
}

export function RunMenu({
  pageId, jobId, llmModelIds, busy, onRun, onReadPage, onRemoveReadings, onError,
}: RunMenuProps) {
  const { can } = useAuth()
  const [open, setOpen] = useState(false)
  const [costs, setCosts] = useState<PageRunCosts | null>(null)
  const [reading, setReading] = useState<LlmReadPreview | null>(null)
  const [onFile, setOnFile] = useState<LlmReadingsOnFile[]>([])
  const models = llmModelIds.join(',')

  useEffect(() => {
    if (!open) return
    // Read when the menu opens: what a phase would replace changes with every edit made
    // since the page loaded, so the last opening's numbers are not offered meanwhile.
    let live = true
    setCosts(null)
    getPageRunCosts(pageId)
      .then((next) => { if (live) setCosts(next) })
      .catch((e: Error) => { if (live) onError(e.message) })
    return () => { live = false }
  }, [open, pageId, onError])

  useEffect(() => {
    if (!open || !models) return
    let live = true
    setReading(null)
    getLlmReadPreview(jobId, models.split(',').map(Number), [pageId])
      .then((next) => { if (live) setReading(next) })
      .catch((e: Error) => { if (live) onError(e.message) })
    return () => { live = false }
  }, [open, jobId, pageId, models, onError])

  useEffect(() => {
    if (!open) return
    let live = true
    setOnFile([])
    getPageLlmReadings(pageId)
      .then((next) => { if (live) setOnFile(next.models) })
      .catch(() => undefined)
    return () => { live = false }
  }, [open, pageId])

  useDismiss(open, () => setOpen(false))
  const readings = onFile.reduce((sum, m) => sum + m.readings, 0)

  const corrections = costs?.lines.corrections ?? 0

  return (
    <div className="relative">
      <Button
        size="xs"
        disabled={busy}
        data-testid="run-menu"
        {...menuTrigger(open)}
        title="Run layout detection, line detection or OCR on this page"
        onClick={(e) => {
          e.stopPropagation()
          setOpen(!open)
        }}
      >
        {busy ? 'Running…' : <><PlayIcon /> Run <CaretIcon /></>}
      </Button>
      {open && (
        <div
          onClick={(e) => e.stopPropagation()}
          data-testid="run-menu-items"
          className={`absolute right-0 top-full z-30 mt-1 w-60 overflow-hidden ${popoverChrome} py-1`}
        >
          {RUNNABLE.filter((phase) => can(PHASE_CAPABILITY[phase])).map((phase) => (
            <button
              key={phase}
              data-testid="run-phase"
              data-phase={phase}
              disabled={!costs}
              onClick={() => {
                setOpen(false)
                onRun(phase)
              }}
              className={menuItem}
            >
              <span className="font-medium">{LABELS[phase]}</span>
              <span className="block text-[11px] text-ink-muted">
                {costs ? describe(phase, costs) : 'reading…'}
              </span>
            </button>
          ))}
          <button
            data-testid="run-llm-read"
            onClick={() => {
              setOpen(false)
              onReadPage()
            }}
            className={`${menuItem} border-t border-line`}
          >
            <span className="font-medium">Language models…</span>
            <span className="block text-[11px] text-ink-muted">
              {describeRead(llmModelIds, reading)}
            </span>
          </button>
          {readings > 0 && (
            <button
              data-testid="run-llm-remove"
              onClick={() => {
                setOpen(false)
                onRemoveReadings()
              }}
              className={`${menuItem} text-danger`}
            >
              <span className="font-medium">Remove readings…</span>
              <span className="block text-[11px] text-ink-muted">
                {plural(readings, 'reading')} by {plural(onFile.length, 'model')} on this page
              </span>
            </button>
          )}
          {corrections > 0 && (
            <p className="border-t border-line px-2.5 py-1 text-[11px] text-ink-muted">
              {plural(corrections, 'correction')} kept and re-attached afterwards.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
