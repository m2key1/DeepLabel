import { useEffect, useRef, useState } from 'react'
import { listUsableLlmModels, type ApiError, type LlmModel } from '../../api'
import {
  cancelGroundTruthRead, getGroundTruthPreview, getGroundTruthStatus, startGroundTruthRead,
  type GroundTruthPreview, type GroundTruthStatus,
} from '../../lib/corpusApi'
import { VisibilityBadge } from '../llm/VisibilityBadge'
import { Button } from '../ui/Button'
import { EmptyState } from '../ui/EmptyState'
import { Check, CheckField } from '../ui/Field'
import { Section } from '../ui/Section'
import { Note, type NoteTone } from './Note'

const POLL_MS = 1200
const MAX_BACKOFF_MS = 30_000

const HINT = 'Each page is asked with its own span, and the answer becomes its ground '
  + 'truth. Being machine-made, nothing checks it off.'

function transcribedNote(preview: GroundTruthPreview | null, included: boolean): string {
  if (preview === null || preview.transcribed === 0) return ''
  const one = preview.transcribed === 1
  return `${preview.transcribed} page${one ? '' : 's'} ${one ? 'carries' : 'carry'} a person's `
    + `transcription and ${one ? 'is' : 'are'} ${included ? 'read for comparison' : 'skipped'}.`
}

function costOf(preview: GroundTruthPreview | null): string {
  if (preview === null) return ''
  const reused = preview.models.reduce((sum, model) => sum + model.reused, 0)
  return `${preview.calls} call${preview.calls === 1 ? '' : 's'} over ${preview.pages} `
    + `placed page${preview.pages === 1 ? '' : 's'}`
    + `${reused > 0 ? `, ${reused} already read and free` : ''}.`
}

export function DiplomaticRead({ jobId, selected, revision, onChanged }: {
  jobId: string
  selected: number[]
  /** Changes whenever the page around this is reloaded. A cut moves which pages carry a
   *  span, so both the bill and the tally are about to be answering for the wrong set. */
  revision: number
  /** Called once a run settles, so the pages' new ground truth can be reloaded. */
  onChanged: () => void
}) {
  const [models, setModels] = useState<(LlmModel & { shared: boolean })[]>([])
  const [chosen, setChosen] = useState<number[]>(selected)
  const [preview, setPreview] = useState<GroundTruthPreview | null>(null)
  const [status, setStatus] = useState<GroundTruthStatus | null>(null)
  const [refresh, setRefresh] = useState(false)
  const [includeTranscribed, setIncludeTranscribed] = useState(false)
  const [note, setNote] = useState<{ tone: NoteTone; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  // Bumped whenever a run is started or cancelled, to wake the poll immediately.
  const [watch, setWatch] = useState(0)
  const running = useRef(false)

  useEffect(() => {
    listUsableLlmModels()
      .then((r) => setModels(r.models))
      .catch((error: ApiError) => setNote({ tone: 'bad', text: error.message }))
  }, [])

  const chosenKey = chosen.join(',')
  useEffect(() => {
    const ids = chosenKey.split(',').filter(Boolean).map(Number)
    let live = true
    getGroundTruthPreview(jobId, ids, includeTranscribed)
      .then((next) => { if (live) setPreview(next) })
      .catch(() => { if (live) setPreview(null) })
    return () => { live = false }
  }, [jobId, chosenKey, includeTranscribed, watch, revision])

  useEffect(() => {
    let stopped = false
    let timer = 0
    let failures = 0
    let answered = false
    const again = (delay = POLL_MS) => {
      if (!stopped) timer = window.setTimeout(() => void poll(), delay)
    }
    const poll = async () => {
      try {
        const next = await getGroundTruthStatus(jobId)
        if (stopped) return
        failures = 0
        answered = true
        setStatus(next)
        if (next.pending + next.running > 0) {
          running.current = true
          again()
        } else if (running.current) {
          // The last answer has landed: the pages now carry ground truth they did not
          // before, and the reference listing beside this is showing the old sources.
          running.current = false
          onChanged()
        }
      } catch {
        // A transient failure must not silence a run in flight, nor turn an idle panel
        // into a request every second for as long as the server is down. Until one look
        // has got through, nobody knows whether a run is in flight.
        if (stopped || (answered && !running.current)) return
        failures += 1
        again(Math.min(POLL_MS * 2 ** failures, MAX_BACKOFF_MS))
      }
    }
    void poll()
    return () => {
      stopped = true
      window.clearTimeout(timer)
    }
  }, [jobId, watch, revision, onChanged])

  const toggle = (id: number) =>
    setChosen((ids) => (ids.includes(id) ? ids.filter((held) => held !== id) : [...ids, id]))

  const start = async () => {
    setBusy(true)
    try {
      const outcome = await startGroundTruthRead(jobId, chosen, refresh, undefined,
                                                 includeTranscribed)
      running.current ||= outcome.queued > 0
      setNote({
        tone: 'ok',
        text: `${outcome.queued} reading${outcome.queued === 1 ? '' : 's'} queued over `
          + `${outcome.pages} page${outcome.pages === 1 ? '' : 's'}`
          + `${outcome.reused > 0 ? `, ${outcome.reused} reused` : ''}`
          + `${outcome.skipped > 0 ? `, ${outcome.skipped} transcribed by hand skipped` : ''}.`,
      })
      setWatch((n) => n + 1)
    } catch (error) {
      setNote({ tone: 'bad', text: (error as ApiError).message })
    }
    setBusy(false)
  }

  const cancel = async () => {
    setBusy(true)
    try {
      const { cancelled } = await cancelGroundTruthRead(jobId)
      setNote({
        tone: 'ok',
        text: `${cancelled} reading${cancelled === 1 ? '' : 's'} dropped. Anything already `
          + 'in flight is paid for and is left to finish.',
      })
      setWatch((n) => n + 1)
    } catch (error) {
      setNote({ tone: 'bad', text: (error as ApiError).message })
    }
    setBusy(false)
  }

  const active = status !== null && status.pending + status.running > 0

  return (
    <Section
      data-testid="diplomatic-read"
      title="Read the pages against their span"
      description={HINT}
      actions={
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="ghost"
            disabled={busy || !active}
            data-testid="gt-cancel"
            onClick={() => void cancel()}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={busy || chosen.length === 0}
            data-testid="gt-start"
            onClick={() => void start()}
          >
            {busy ? 'Starting…' : 'Read the pages'}
          </Button>
        </div>
      }
    >
      {models.length === 0 ? (
        <div data-testid="gt-no-models" className="mb-2">
          <EmptyState>No language models set up. Add an endpoint under Settings.</EmptyState>
        </div>
      ) : (
        <div className="mb-2 space-y-1" data-testid="gt-model-picker">
          {models.map((model) => (
            <label
              key={model.id}
              data-testid="gt-pick"
              data-label={model.label}
              className="flex cursor-pointer items-center gap-2 text-sm"
            >
              <Check
                checked={chosen.includes(model.id)}
                onChange={() => toggle(model.id)}
                className="cursor-pointer"
              />
              <span className="min-w-0 truncate">{model.label}</span>
              <VisibilityBadge shared={model.shared} className="ml-auto shrink-0" />
            </label>
          ))}
        </div>
      )}

      <div className="mb-2 space-y-1">
        <CheckField
          label="Read every page again, including the ones already read under the same wording and span"
          checked={refresh}
          onChange={setRefresh}
          data-testid="gt-refresh"
        />
        <CheckField
          label="Read the pages that carry a person's transcription too, to compare against it"
          checked={includeTranscribed}
          onChange={setIncludeTranscribed}
          data-testid="gt-include-transcribed"
        />
      </div>

      <p data-testid="gt-cost" className="text-xs text-ink-subtle">{costOf(preview)}</p>
      {preview !== null && preview.transcribed > 0 && (
        <p data-testid="gt-transcribed" className="text-xs text-ink-subtle">
          {transcribedNote(preview, includeTranscribed)}
        </p>
      )}

      {status && (
        <p data-testid="gt-status" className="mt-2 text-sm text-ink-muted">
          {status.done} done · {status.pending} pending · {status.running} running ·{' '}
          {status.error} failed, over {status.pages} placed page
          {status.pages === 1 ? '' : 's'}.
        </p>
      )}

      {status && status.errors.length > 0 && (
        <ul className="mt-1 space-y-px">
          {status.errors.map((failure) => (
            <li
              key={`${failure.page_id}-${failure.label}`}
              data-testid="gt-failure"
              data-page-id={failure.page_id}
              className="text-xs text-danger"
            >
              page {failure.page_id} · {failure.label}: {failure.error}
            </li>
          ))}
        </ul>
      )}

      {note && <div className="mt-2"><Note tone={note.tone} testId="gt-note">{note.text}</Note></div>}
    </Section>
  )
}
