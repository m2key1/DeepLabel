import { useEffect, useState } from 'react'
import {
  listConventionFlags, listModels, listUsableLlmModels, reocr, reocrPreview, setJobLlmSettings, setJobModels,
} from '../../api'
import { KeptOutModels, keptOut } from './DataUseSwitches'
import type {
  ConventionFlag, Job, LlmModel, ModelTask, OcrConvention, OcrDecode, RegistryModel, ReocrPreview,
} from '../../api'
import { conventionLabel } from '../conventionLabel'
import { ConventionFlags, flagsOn, toggledFlag } from './ConventionFlags'
import { Modal, modalBtn, modalPrimaryBtn } from '../Modal'
import { readerName } from '../viewer/readers'
import { DECODE_CHOICES } from './processing'

interface ModelPickerDialogProps {
  job: Job
  onClose: () => void
  onSaved: () => void
  onError: (message: string) => void
}

const TASKS: { task: ModelTask; label: string; field: 'model_layout_id' | 'model_lines_id' | 'model_ocr_id' }[] = [
  { task: 'layout', label: 'Layout detection', field: 'model_layout_id' },
  { task: 'lines', label: 'Line segmentation', field: 'model_lines_id' },
  { task: 'ocr', label: 'OCR', field: 'model_ocr_id' },
]

export function ModelPickerDialog({ job, onClose, onSaved, onError }: ModelPickerDialogProps) {
  const [models, setModels] = useState<RegistryModel[] | null>(null)
  const [picks, setPicks] = useState<Record<ModelTask, string>>({
    layout: job.model_layout_id === null ? '' : String(job.model_layout_id),
    lines: job.model_lines_id === null ? '' : String(job.model_lines_id),
    ocr: job.model_ocr_id === null ? '' : String(job.model_ocr_id),
  })
  const [decode, setDecode] = useState<OcrDecode>(job.ocr_decode ?? 'beam')
  const [convention, setConvention] = useState<OcrConvention>(job.ocr_convention ?? {})
  const [catalog, setCatalog] = useState<ConventionFlag[] | null>(null)
  // The models a page is read with are pinned here like the rest, rather than being
  // whatever the last run happened to tick.
  const [readers, setReaders] = useState<(LlmModel & { self_hosted: boolean })[] | null>(null)
  const keptInHouse = !job.data_use.external_llm
  const [readWith, setReadWith] = useState<number[]>(job.llm_model_ids ?? [])
  const [preview, setPreview] = useState<ReocrPreview | null>(null)
  const [applyStep, setApplyStep] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    // Archived ones too: a dataset pinned to one before it was archived still runs it.
    listModels(true)
      .then((r) => setModels(r.models))
      .catch((e: Error) => onError(e.message))
    reocrPreview(job.id)
      .then(setPreview)
      .catch(() => {})
    listConventionFlags()
      .then((r) => setCatalog(r.flags))
      .catch(() => setCatalog([]))
    // Absent on a deployment with the feature switched off, which is not an error here.
    listUsableLlmModels()
      .then((r) => setReaders(r.models))
      .catch(() => setReaders([]))
  }, [job.id, onError])

  const ocrModel = models?.find((m) => (picks.ocr === ''
    ? m.task === 'ocr' && m.is_default
    : m.id === Number(picks.ocr)))
  const flagLabel = (name: string) => conventionLabel(name, catalog)

  const ocrSettingsChanged = () =>
    decode !== (job.ocr_decode ?? 'beam') ||
    (picks.ocr === '' ? null : Number(picks.ocr)) !== job.model_ocr_id ||
    flagsOn(convention).join() !== flagsOn(job.ocr_convention ?? {}).join()

  const canApplyNow =
    (preview?.unchecked ?? 0) > 0 && job.status !== 'queued' && job.status !== 'running'

  const save = async () => {
    setBusy(true)
    try {
      const offerApply = ocrSettingsChanged() && canApplyNow
      await setJobModels(job.id, {
        layout: picks.layout === '' ? null : Number(picks.layout),
        lines: picks.lines === '' ? null : Number(picks.lines),
        ocr: picks.ocr === '' ? null : Number(picks.ocr),
      }, decode, convention)
      if (readers !== null) {
        const allowed = readWith.filter((id) => !readers.some((m) => m.id === id && keptOut(keptInHouse, m)))
        await setJobLlmSettings(job.id, { llm_model_ids: allowed })
      }
      if (offerApply) {
        setApplyStep(true)
        return
      }
      onClose()
      onSaved()
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const applyNow = async () => {
    setBusy(true)
    try {
      await reocr(job.id, 'unchecked')
      onClose()
      onSaved()
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const later = () => {
    onClose()
    onSaved()
  }

  const inputClass =
    'w-full rounded border border-line-strong bg-surface px-2 py-1.5 text-sm focus-visible:border-accent focus:outline-none'

  if (applyStep) {
    return (
      <Modal title={`Apply to "${job.name}" now?`} onClose={later}>
        <p data-testid="apply-summary" className="mb-2 text-sm text-ink">
          {preview!.unchecked} unchecked line{preview!.unchecked === 1 ? '' : 's'} will be re-read
          with the new OCR settings. {preview!.checked} checked line
          {preview!.checked === 1 ? '' : 's'} keep{preview!.checked === 1 ? 's' : ''} their text.
        </p>
        <p className="mb-4 text-xs text-ink-muted">
          Corrections on unchecked lines are kept too - only the raw OCR text is replaced.
          Choosing Later keeps everything as is; the new settings apply to future processing.
        </p>
        <div className="flex justify-end gap-2">
          <button onClick={later} className={modalBtn}>
            Later
          </button>
          <button disabled={busy} onClick={applyNow} className={modalPrimaryBtn}>
            {busy ? 'Queueing…' : 'Re-run OCR now'}
          </button>
        </div>
      </Modal>
    )
  }

  return (
    <Modal title={`Models for "${job.name}"`} onClose={onClose}>
      <p className="mb-3 text-xs text-ink-muted">
        Applies when pages are processed next; changing the OCR settings offers an immediate re-run.
      </p>
      {preview !== null && preview.authors.length > 0 && (
        <p data-testid="ocr-provenance" className="mb-3 text-xs text-ink-muted">
          Current text was read by{' '}
          {preview.authors.map((a) => `${readerName('ocr', a.author)} (${a.lines} lines)`).join(', ')}
          {preview.authors.length > 1 && ' - mixed provenance'}
        </p>
      )}
      {TASKS.map(({ task, label, field }) => (
        <div key={task} className="mb-3">
          <label className="mb-1 block text-sm font-medium text-ink" htmlFor={`pick-${task}`}>
            {label}
          </label>
          <select
            id={`pick-${task}`}
            value={picks[task]}
            onChange={(e) => setPicks((prev) => ({ ...prev, [task]: e.target.value }))}
            className={inputClass}
            data-testid={`model-pick-${task}`}
          >
            <option value="">Task default</option>
            {models
              ?.filter((m) => m.task === task && (!m.archived || m.id === Number(picks[task])))
              .map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                  {m.is_default ? ' (default)' : ''}
                  {m.archived ? ' (archived)' : ''}
                </option>
              ))}
          </select>
          {job[field] !== null && models !== null && !models.some((m) => m.id === job[field]) && (
            <p className="mt-1 text-xs text-warn">
              The previously picked model no longer exists; the task default is used.
            </p>
          )}
        </div>
      ))}
      <div className="mb-4">
        <label className="mb-1 block text-sm font-medium text-ink" htmlFor="pick-decode">
          OCR decoding
        </label>
        <select
          id="pick-decode"
          data-testid="pick-decode"
          value={decode}
          onChange={(e) => setDecode(e.target.value as OcrDecode)}
          className={inputClass}
        >
          {DECODE_CHOICES.map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
      </div>
      <ConventionFlags catalog={catalog} model={ocrModel} convention={convention}
                       onToggle={(name) => setConvention((held) => toggledFlag(held, name))}>
        {job.ocr_convention_read != null && (
          <p data-testid="convention-read" className="mt-1 text-xs text-ink-muted">
            Last read {job.ocr_convention_read.length === 0
              ? 'normalized'
              : `with ${job.ocr_convention_read.map(flagLabel).join(', ').toLowerCase()}`}.
          </p>
        )}
      </ConventionFlags>
      {readers !== null && readers.length > 0 && (
        <div className="mb-4" data-testid="pick-llm-models">
          <span className="mb-1 block text-sm font-medium text-ink">
            Language models
          </span>
          <p className="mb-1 text-xs text-ink-muted">
            Which models read this dataset's pages, here and from the page viewer. Reading is
            still started deliberately - this only says who does it.
          </p>
          <div className="space-y-1">
            {readers.filter((m) => !keptOut(keptInHouse, m)).map((model) => (
              <label key={model.id} data-testid="llm-model-pin" data-label={model.label}
                     className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={readWith.includes(model.id)}
                  onChange={() => setReadWith((held) => (held.includes(model.id)
                    ? held.filter((id) => id !== model.id)
                    : [...held, model.id]))}
                  className="cursor-pointer accent-accent"
                />
                <span className="min-w-0 truncate">{model.label}</span>
              </label>
            ))}
            <KeptOutModels names={readers.filter((m) => keptOut(keptInHouse, m)).map((m) => m.label)} />
          </div>
        </div>
      )}
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className={modalBtn}>
          Cancel
        </button>
        <button onClick={save} disabled={busy || models === null} className={modalPrimaryBtn}>
          Save
        </button>
      </div>
    </Modal>
  )
}
