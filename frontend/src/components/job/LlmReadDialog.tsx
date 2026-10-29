import { useCallback, useEffect, useState, type ReactNode } from 'react'
import {
  getLlmPrompt, getLlmReadPreview, listUsableLlmModels, setJobLlmSettings, startLlmRead,
  type LlmModel, type LlmReadPreview,
} from '../../api'
import { Modal, modalBtn, modalPrimaryBtn } from '../Modal'
import { LlmReferences } from '../llm/LlmReferences'
import { VisibilityBadge } from '../llm/VisibilityBadge'
import { Button } from '../ui/Button'
import { Input, Textarea } from '../ui/Field'
import { Hint } from '../ui/Hint'


const SEEN_HINT =
  'Every page is sent with this wording and these pictures. What a dataset carries of its '
  + 'own is used in place of yours, for this dataset alone.'
const OWNER_ONLY = "Only the dataset's owner can change this."
const AGREE_HINT =
  'Readings are compared after normalising Unicode, whitespace, quotes and dashes, and '
  + 'models are counted rather than answers. A line that enough of them read the same way is '
  + 'filled in - never over a correction or a check of yours. Marking those lines reviewed '
  + 'records them as settled by models, so a training run can leave them out. Deep OCR is '
  + 'left out of the count by default: on a dataset you are training it on, letting it '
  + 'confirm its own targets approves exactly the mistakes it already makes. Counting it in '
  + 'is for a dataset read with a checkpoint that has nothing to do with what you are '
  + 'training, and it only ever votes on a line a model has read too.'

function Section({ title, hint, summary, open, onToggle, testId, children }: {
  title: string
  hint: string
  summary?: ReactNode
  open?: boolean
  onToggle?: () => void
  testId: string
  children: ReactNode
}) {
  const collapsible = onToggle !== undefined
  return (
    <section className="mb-3 rounded border border-line">
      <div className="flex items-center gap-1 pr-1.5">
        {collapsible ? (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            data-testid={testId}
            className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left"
          >
            <span aria-hidden className="text-xs text-ink-subtle">
              {open ? '▾' : '▸'}
            </span>
            <span className="text-sm font-medium">{title}</span>
            <span className="ml-auto truncate text-xs text-ink-muted">
              {summary}
            </span>
          </button>
        ) : (
          <span data-testid={testId} className="flex-1 px-2 py-1.5 text-sm font-medium">
            {title}
          </span>
        )}
        <Hint about={title} text={hint} />
      </div>
      {(!collapsible || open) && (
        <div className="border-t border-line px-2 py-2">{children}</div>
      )}
    </section>
  )
}

interface LlmReadDialogProps {
  jobId: string
  /** Pages ticked in the table. Absent reads the dataset. */
  pageIds?: number[]
  /** How many pages the dataset holds, for the offer to read all of them instead. */
  pageCount?: number
  selected: number[]
  consensusMin: number
  autocheck: boolean
  /** Whether Deep OCR's own reading counts towards the agreement above. */
  consensusWithOcr: boolean
  /** The dataset's own wording, which replaces the models'. Empty uses theirs. */
  prompt: string
  /** Owner or admin. What settles a line, and whether that checks it off, is theirs alone
   *  to decide - the backend refuses those two settings to anyone else. */
  canOwn: boolean
  /** The owner keeps the pages from LLM providers outside the house: only models on a
   *  connection an admin marked self-hosted may read them. */
  keptInHouse: boolean
  onClose: () => void
  /** What the run actually took on - nothing queued is a real outcome, not a failure. */
  onStarted: (outcome: { queued: number; reused: number }) => void
  onError: (message: string) => void
}

export function LlmReadDialog({
  jobId, pageIds, pageCount, selected, consensusMin, autocheck, consensusWithOcr, prompt,
  canOwn, keptInHouse, onClose, onStarted, onError,
}: LlmReadDialogProps) {
  const [models, setModels] = useState<(LlmModel & { shared: boolean; self_hosted: boolean })[]>([])
  const [chosen, setChosen] = useState<number[]>(selected)
  const [preview, setPreview] = useState<LlmReadPreview | null>(null)
  const [minAgree, setMinAgree] = useState(consensusMin)
  const [autoCheck, setAutoCheck] = useState(autocheck)
  const [withOcr, setWithOcr] = useState(consensusWithOcr)
  const [ownPrompt, setOwnPrompt] = useState(prompt)
  // Whether the wording was changed here. What this dialog was handed is the dataset as
  // the page last read it, which may predate the prompt saved by the previous read - and
  // sending that back would erase the wording rather than leave it alone.
  const [promptEdited, setPromptEdited] = useState(false)
  const [editingPrompt, setEditingPrompt] = useState(false)
  const [inherited, setInherited] = useState('')
  const [refresh, setRefresh] = useState(false)
  const [busy, setBusy] = useState(false)
  // Open on arrival when this dataset has wording of its own: what departs from the usual
  // is worth seeing without a click, and the summary line covers the rest.
  const [showSeen, setShowSeen] = useState(() => Boolean(prompt.trim()))
  const [pictures, setPictures] = useState({ count: 0, inherited: false })
  // A selection is an offer, not a cage: it can be dropped here without closing the dialog
  // and clearing the table's ticks.
  const [scope, setScope] = useState<number[] | undefined>(pageIds)

  useEffect(() => {
    listUsableLlmModels().then((r) => {
      setModels(r.models)
      if (keptInHouse) setChosen((held) => held.filter((id) => r.models.some((m) => m.id === id && m.self_hosted)))
    }).catch((e: Error) => onError(e.message))
    // What a model with no wording of its own is asked: the personal default, else the
    // shipped one. The editor starts from what is in force, so replacing it means editing
    // the rules rather than losing them.
    getLlmPrompt().then((r) => setInherited(r.prompt || r.default)).catch(() => undefined)
    // onError is stable enough for a dialog that lives as long as one decision.
  }, [onError])

  const scopeKey = scope?.join(',')
  useEffect(() => {
    const pages = scopeKey === undefined
      ? undefined
      : scopeKey.split(',').filter(Boolean).map(Number)
    let live = true
    getLlmReadPreview(jobId, chosen, pages)
      .then((next) => { if (live) setPreview(next) })
      .catch((e: Error) => { if (live) onError(e.message) })
    return () => { live = false }
  }, [jobId, chosen, scopeKey, onError])

  const toggle = (id: number) =>
    setChosen((current) => (current.includes(id) ? current.filter((c) => c !== id) : [...current, id]))

  // Kept identical when nothing changed, so the reference list reporting itself cannot
  // loop the dialog back through a render.
  const onPictures = useCallback((summary: { count: number; inherited: boolean }) => {
    setPictures((held) =>
      held.count === summary.count && held.inherited === summary.inherited ? held : summary)
  }, [])

  const start = async () => {
    setBusy(true)
    try {
      // Only what was changed here is written back. Some of these are the owner's to set,
      // and an assignee who left them alone is reading, not changing the dataset.
      const changed = {
        ...(minAgree !== consensusMin ? { llm_consensus_min: minAgree } : {}),
        ...(autoCheck !== autocheck ? { llm_autocheck: autoCheck } : {}),
        ...(withOcr !== consensusWithOcr ? { llm_consensus_with_ocr: withOcr } : {}),
        ...(promptEdited ? { llm_prompt: ownPrompt } : {}),
      }
      if (Object.keys(changed).length > 0) await setJobLlmSettings(jobId, changed)
      const outcome = await startLlmRead(jobId, chosen, refresh, scope)
      onClose()
      onStarted(outcome)
    } catch (e) {
      onError((e as Error).message)
      setBusy(false)
    }
  }

  // What each picked model would be asked without this dataset's wording. The editor starts
  // from it when they agree; when they differ there is no one wording "used anyway", so it
  // starts from the usual one and says that the dataset's will replace them all.
  const inForce = [...new Set(models.filter((m) => chosen.includes(m.id))
    .map((m) => m.prompt.trim() || inherited))]
  const seed = inForce.length === 1 ? inForce[0] : inherited
  const usual = inForce.every((wording) => wording === inherited)

  const reused = preview?.models.reduce((sum, m) => sum + m.reused, 0) ?? 0
  const seenSummary = [
    ownPrompt.trim() ? 'its own prompt'
      : usual ? 'your usual prompt'
        : inForce.length === 1 ? "the model's own prompt" : `${inForce.length} different prompts`,
    pictures.count === 0
      ? 'the page only'
      : `${pictures.count} image${pictures.count === 1 ? '' : 's'}${pictures.inherited ? ' of yours' : ''}`,
  ].join(' · ')

  const ownerTitle = canOwn ? undefined : OWNER_ONLY
  const ownerLabel = `flex items-center gap-2 ${canOwn ? 'cursor-pointer' : 'cursor-not-allowed'}`
  const ownerBox = `accent-accent ${canOwn ? 'cursor-pointer' : 'cursor-not-allowed'}`

  return (
    <Modal title="Transcribe the pages with language models" onClose={onClose}>
      {models.length === 0 ? (
        <p className="mb-3 text-sm text-ink-muted" data-testid="llm-none-configured">
          No models set up. Add an endpoint under Settings.
        </p>
      ) : (
        <div className="mb-3 space-y-1" data-testid="llm-model-picker">
          {keptInHouse && (
            <p data-testid="llm-kept-in-house" className="text-xs text-ink-muted">
              This dataset's owner keeps its pages from external providers: only self-hosted models can read it.
            </p>
          )}
          {models.map((model) => (
            <label key={model.id} data-testid="llm-pick" data-label={model.label}
                   data-kept-out={keptInHouse && !model.self_hosted}
                   title={keptInHouse && !model.self_hosted
                     ? "This dataset's owner keeps its pages from providers an admin hasn't marked self-hosted" : undefined}
                   className={`flex items-center gap-2 text-sm ${
                     keptInHouse && !model.self_hosted ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}>
              <input
                type="checkbox"
                checked={chosen.includes(model.id)}
                disabled={keptInHouse && !model.self_hosted}
                onChange={() => toggle(model.id)}
                className="cursor-pointer accent-accent"
              />
              <span className="min-w-0 truncate">{model.label}</span>
              {/* The provider's own id, when the label is not already it. */}
              {model.model !== model.label && (
                <code className="min-w-0 truncate text-xs text-ink-muted">
                  {model.model}
                </code>
              )}
              <VisibilityBadge shared={model.shared} className="ml-auto shrink-0" />
            </label>
          ))}
        </div>
      )}

      {/* Always said, not only when pages are ticked: what a run is about to cover is the
          one thing a person needs to read before paying for it. */}
      <p data-testid="llm-scope" className="mb-3 text-sm text-ink-muted">
        {scope ? (
          <>
            Transcribing {scope.length} selected page{scope.length === 1 ? '' : 's'}
            {pageCount ? ` of ${pageCount}` : ''}.{' '}
            <button data-testid="llm-scope-all" onClick={() => setScope(undefined)}
                    className="text-accent-ink underline hover:no-underline">
              Transcribe the whole dataset instead
            </button>
          </>
        ) : (
          <>
            Transcribing {pageCount ? `all ${pageCount} pages` : 'every page'} of this dataset.
            Tick pages in the table to transcribe only those.
          </>
        )}
      </p>

      <Section title="What they see" hint={SEEN_HINT} summary={seenSummary} testId="llm-what-they-see"
               open={showSeen} onToggle={() => setShowSeen((v) => !v)}>
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <span className="text-sm">Prompt</span>
          <Button size="xs" onClick={() => setEditingPrompt(!editingPrompt)}
                  data-testid="dataset-prompt-edit">
            {editingPrompt ? 'Done' : ownPrompt.trim() ? 'Edit' : 'Give it its own'}
          </Button>
          {ownPrompt.trim() && !editingPrompt && (
            <Button size="xs" variant="ghost"
                    onClick={() => { setOwnPrompt(''); setPromptEdited(true) }}
                    data-testid="dataset-prompt-clear">
              Use the usual one
            </Button>
          )}
        </div>
        {editingPrompt && !ownPrompt.trim() && inForce.length > 1 && (
          <p data-testid="dataset-prompt-divergent" className="mb-2 text-xs text-ink-muted">
            The picked models are asked in {inForce.length} different wordings. This starts
            from your usual one, and whatever is saved here replaces all of them.
          </p>
        )}
        {editingPrompt && (
          <Textarea
            value={ownPrompt || seed}
            onChange={(e) => { setOwnPrompt(e.target.value); setPromptEdited(true) }}
            rows={16}
            aria-label="Prompt for this dataset"
            data-testid="dataset-prompt"
            placeholder="Replaces the usual wording entirely"
            className="mb-2 w-full font-mono text-xs"
          />
        )}
        <LlmReferences jobId={jobId} canEdit label="Images" onError={onError} onSummary={onPictures} />
      </Section>

      <Section title="When they agree" hint={AGREE_HINT} testId="llm-when-they-agree">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-ink-muted">
          <label className="flex items-center gap-2">
            <Input
              type="number"
              min={1}
              max={10}
              value={minAgree}
              onChange={(e) => setMinAgree(Number(e.target.value))}
              disabled={!canOwn}
              title={ownerTitle}
              aria-label="Models that must agree"
              data-testid="llm-consensus-min"
              className="w-14"
            />
            must agree
          </label>
          <label className={ownerLabel} title={ownerTitle}>
            <input
              type="checkbox"
              checked={withOcr}
              onChange={(e) => setWithOcr(e.target.checked)}
              disabled={!canOwn}
              title={ownerTitle}
              data-testid="llm-consensus-with-ocr"
              className={ownerBox}
            />
            Count Deep OCR as one of them
          </label>
          <label className={ownerLabel} title={ownerTitle}>
            <input
              type="checkbox"
              checked={autoCheck}
              onChange={(e) => setAutoCheck(e.target.checked)}
              disabled={!canOwn}
              title={ownerTitle}
              data-testid="llm-autocheck"
              className={ownerBox}
            />
            Mark settled lines reviewed
          </label>
        </div>
      </Section>

      {preview && preview.stale_prompt > 0 && (
        <label className="mb-3 flex items-start gap-2 text-sm text-warn">
          <input
            type="checkbox"
            checked={refresh}
            onChange={(e) => setRefresh(e.target.checked)}
            data-testid="llm-refresh"
            className="mt-0.5 cursor-pointer accent-accent"
          />
          <span data-testid="llm-stale-prompt">
            {preview.stale_pages} page{preview.stale_pages === 1 ? '' : 's'} read with a
            different prompt. Read again ({preview.stale_prompt} call
            {preview.stale_prompt === 1 ? '' : 's'}).
          </span>
        </label>
      )}

      <div className="mt-4 flex items-center justify-between gap-3 border-t border-line pt-3">
        <span data-testid="llm-cost" className="min-w-0 text-xs text-ink-muted">
          {preview && `${preview.calls} call${preview.calls === 1 ? '' : 's'} over ${preview.pages} `
            + `page${preview.pages === 1 ? '' : 's'}`
            + `${reused > 0 ? `, ${reused} already read and free` : ''}.`}
        </span>
        <div className="flex shrink-0 gap-2">
          <button onClick={onClose} className={modalBtn}>Cancel</button>
          <button onClick={start} disabled={busy || chosen.length === 0} data-testid="llm-start"
                  className={modalPrimaryBtn}>
            {busy ? 'Starting…' : 'Transcribe'}
          </button>
        </div>
      </div>
    </Modal>
  )
}
