import { useEffect, useRef, useState } from 'react'
import type { ApiError } from '../../api'
import { getGroundTruthWording, saveCorpusSettings } from '../../lib/corpusApi'
import { Button } from '../ui/Button'
import { Input, Textarea } from '../ui/Field'
import { Section } from '../ui/Section'
import { Note, type NoteTone } from './Note'

const PLACEHOLDER = 'Empty keeps the shipped wording, which already carries {{reference}}. '
  + 'Anything typed here replaces it entirely for this dataset.'

export function CorpusPrompt({ jobId, prompt, overlap, onSaved }: {
  jobId: string
  prompt: string
  overlap: number
  onSaved: () => void
}) {
  const [wording, setWording] = useState(prompt)
  const [slack, setSlack] = useState(String(overlap))
  const [note, setNote] = useState<{ tone: NoteTone; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [shipped, setShipped] = useState('')
  // What the editor was last filled from. Without this every reload of the page around it
  // - a cut, an upload - would throw away half-typed wording.
  const seeded = useRef({ prompt, overlap })

  useEffect(() => {
    if (seeded.current.prompt === prompt && seeded.current.overlap === overlap) return
    seeded.current = { prompt, overlap }
    setWording(prompt)
    setSlack(String(overlap))
  }, [prompt, overlap])

  useEffect(() => {
    getGroundTruthWording(jobId).then((held) => setShipped(held.default)).catch(() => setShipped(''))
  }, [jobId])

  const save = async () => {
    setBusy(true)
    try {
      const saved = await saveCorpusSettings(jobId, {
        gt_prompt: wording,
        reference_overlap: Number(slack),
      })
      seeded.current = { prompt: saved.gt_prompt, overlap: saved.reference_overlap }
      setWording(saved.gt_prompt)
      setSlack(String(saved.reference_overlap))
      setNote({
        tone: 'ok',
        text: `Saved. Spans take ${saved.reference_overlap} corpus line`
          + `${saved.reference_overlap === 1 ? '' : 's'} of slack at each end from the next cut.`,
      })
      onSaved()
    } catch (error) {
      setNote({ tone: 'bad', text: (error as ApiError).message })
    }
    setBusy(false)
  }

  return (
    <Section
      data-testid="corpus-settings"
      title="How the pages are asked"
      actions={
        <Button
          variant="primary"
          disabled={busy}
          data-testid="corpus-settings-save"
          onClick={() => void save()}
          className="ml-auto"
        >
          {busy ? 'Saving…' : 'Save'}
        </Button>
      }
    >
      <div className="mb-1 flex items-center gap-2">
        <label className="text-sm" htmlFor="gt-prompt">Wording</label>
        <Button
          variant="ghost"
          size="xs"
          disabled={!shipped || wording === shipped}
          data-testid="gt-prompt-shipped"
          title="Fill the editor with the wording an empty one asks with, to adapt it"
          onClick={() => setWording(shipped)}
          className="ml-auto"
        >
          Start from the shipped wording
        </Button>
      </div>
      <p className="mb-1 text-xs text-ink-subtle">
        The page's own corpus span replaces <code className="font-ocr">{'{{reference}}'}</code>{' '}
        before each call, so one wording asks every page a different question.
      </p>
      <Textarea
        id="gt-prompt"
        value={wording}
        onChange={(e) => setWording(e.target.value)}
        rows={12}
        placeholder={PLACEHOLDER}
        data-testid="gt-prompt"
        className="mb-3 w-full font-ocr text-xs"
      />

      <label className="flex items-center gap-2 text-sm">
        <Input
          type="number"
          min={0}
          max={20}
          value={slack}
          onChange={(e) => setSlack(e.target.value)}
          aria-label="Corpus lines of overlap"
          data-testid="reference-overlap"
          className="w-16"
        />
        corpus lines of overlap at each end of a span
      </label>
      <p className="mt-1 text-xs text-ink-subtle">
        Slack absorbs the error in a cut. A model that can see the page loses nothing to a
        span reaching into its neighbour, while a short span loses lines for good.
      </p>

      {note && <div className="mt-2"><Note tone={note.tone} testId="settings-note">{note.text}</Note></div>}
    </Section>
  )
}
