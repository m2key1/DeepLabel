import { useEffect, useState } from 'react'
import { listModels, listUsableLlmModels, setGroupJobs } from '../../api'
import type {
  Group, GroupJobsOutcome, GroupJobsPatch, LineMode, LlmModel, ModelTask, OcrDecode, RegistryModel,
} from '../../api'
import { Modal, modalBtn, modalPrimaryBtn } from '../Modal'
import { DECODE_CHOICES, LINE_MODE_CHOICES, NEEDS_LAYOUT, PHASE_CHOICES } from './processing'
import { controlClass } from '../ui/Field'

interface GroupSettingsDialogProps {
  group: Group
  count: number
  onClose: () => void
  onDone: () => void
  onError: (message: string) => void
}

const TASKS: { task: ModelTask; label: string; field: keyof GroupJobsPatch }[] = [
  { task: 'layout', label: 'Layout detection', field: 'model_layout_id' },
  { task: 'lines', label: 'Line segmentation', field: 'model_lines_id' },
  { task: 'ocr', label: 'OCR', field: 'model_ocr_id' },
]

/** The value that sends nothing. The datasets in a group need not agree on what they have
 *  now, so there is no current value to seed a control from - a setting is only written
 *  where it has been deliberately picked. */
const KEEP = 'keep'
const TASK_DEFAULT = 'default'

const inputClass = controlClass('md', 'w-full')

const section = 'mb-4 rounded border border-line p-3'

export function GroupSettingsDialog({ group, count, onClose, onDone, onError }:
                                    GroupSettingsDialogProps) {
  const [models, setModels] = useState<RegistryModel[] | null>(null)
  const [readers, setReaders] = useState<LlmModel[] | null>(null)
  const [picks, setPicks] = useState<Record<ModelTask, string>>({
    layout: KEEP, lines: KEEP, ocr: KEEP,
  })
  const [decode, setDecode] = useState<OcrDecode | typeof KEEP>(KEEP)
  const [pinReaders, setPinReaders] = useState(false)
  const [readWith, setReadWith] = useState<number[]>([])
  const [pinPhases, setPinPhases] = useState(false)
  const [layout, setLayout] = useState(true)
  const [lines, setLines] = useState(true)
  const [ocr, setOcr] = useState(true)
  const [lineMode, setLineMode] = useState<LineMode>('per_crop')
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<GroupJobsOutcome | null>(null)

  useEffect(() => {
    listModels().then((r) => setModels(r.models)).catch((e: Error) => onError(e.message))
    // Absent on a deployment with the feature switched off, which is not an error here.
    listUsableLlmModels().then((r) => setReaders(r.models)).catch(() => setReaders([]))
  }, [onError])

  const on = { layout, lines, ocr: lines && ocr }
  const effectiveMode: LineMode = layout ? lineMode : 'per_page'

  const patch = (): GroupJobsPatch => {
    const body: GroupJobsPatch = {}
    for (const { task, field } of TASKS) {
      if (picks[task] === KEEP) continue
      Object.assign(body, {
        [field]: picks[task] === TASK_DEFAULT ? null : Number(picks[task]),
      })
    }
    if (decode !== KEEP) body.ocr_decode = decode
    if (pinReaders) body.llm_model_ids = readWith
    if (pinPhases) {
      body.run_layout = layout
      body.run_lines = lines
      body.run_ocr = ocr
      body.line_mode = lineMode
    }
    return body
  }

  const body = patch()
  const nothingPicked = Object.keys(body).length === 0

  const save = async () => {
    setBusy(true)
    try {
      setOutcome(await setGroupJobs(group.id, body))
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (outcome) {
    return (
      <Modal title={`"${group.name}" updated`} onClose={() => { onClose(); onDone() }}>
        <p data-testid="group-settings-changed" className="mb-2 text-sm text-ink">
          {outcome.changed.length} dataset{outcome.changed.length === 1 ? '' : 's'} changed.
        </p>
        {outcome.skipped.length > 0 && (
          <ul data-testid="group-settings-skipped" className="mb-3 space-y-1">
            {outcome.skipped.map((job) => (
              <li key={job.id} data-testid="group-settings-skip" data-job={job.id}
                  className="text-xs text-warn">
                {job.name} - {job.reason}
              </li>
            ))}
          </ul>
        )}
        <div className="flex justify-end">
          <button data-testid="group-settings-done" className={modalPrimaryBtn}
                  onClick={() => { onClose(); onDone() }}>
            Done
          </button>
        </div>
      </Modal>
    )
  }

  return (
    <Modal title={`Settings for every dataset in "${group.name}"`} onClose={onClose}>
      <p className="mb-3 text-xs text-ink-muted">
        Applies to the {count} dataset{count === 1 ? '' : 's'} in this group that you can
        change. Only what you pick here is written - everything left on "Leave as it is"
        stays whatever each dataset already has. It takes effect when pages are processed
        next; nothing already detected or read is discarded.
      </p>
      <div className={section}>
        {TASKS.map(({ task, label }) => (
          <div key={task} className="mb-3 last:mb-0">
            <label className="mb-1 block text-sm font-medium text-ink"
                   htmlFor={`group-pick-${task}`}>
              {label}
            </label>
            <select
              id={`group-pick-${task}`}
              data-testid={`group-model-pick-${task}`}
              value={picks[task]}
              onChange={(e) => setPicks((prev) => ({ ...prev, [task]: e.target.value }))}
              className={inputClass}
            >
              <option value={KEEP}>Leave as it is</option>
              <option value={TASK_DEFAULT}>Task default</option>
              {models?.filter((m) => m.task === task && !m.archived).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}{m.is_default ? ' (default)' : ''}
                </option>
              ))}
            </select>
          </div>
        ))}
      </div>
      <div className={section}>
        <label className="mb-1 block text-sm font-medium text-ink"
               htmlFor="group-pick-decode">
          OCR decoding
        </label>
        <select
          id="group-pick-decode"
          data-testid="group-pick-decode"
          value={decode}
          onChange={(e) => setDecode(e.target.value as OcrDecode | typeof KEEP)}
          className={inputClass}
        >
          <option value={KEEP}>Leave as it is</option>
          {DECODE_CHOICES.map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
      </div>
      {readers !== null && readers.length > 0 && (
        <div className={section} data-testid="group-pick-llm-models">
          <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-ink">
            <input type="checkbox" checked={pinReaders} data-testid="group-set-llm-models"
                   onChange={(e) => setPinReaders(e.target.checked)}
                   className="cursor-pointer accent-accent" />
            Set which language models read these datasets
          </label>
          {pinReaders && (
            <div className="mt-2 space-y-1">
              {readers.map((model) => (
                <label key={model.id} data-testid="group-llm-model-pin" data-label={model.label}
                       className="flex cursor-pointer items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={readWith.includes(model.id)}
                    onChange={() => setReadWith((held) => (held.includes(model.id)
                      ? held.filter((id) => id !== model.id)
                      : [...held, model.id]))}
                    className="cursor-pointer accent-accent"
                  />
                  {model.label}
                </label>
              ))}
              {readWith.length === 0 && (
                <p className="text-xs text-warn">
                  None ticked means these datasets are read with no models at all.
                </p>
              )}
            </div>
          )}
        </div>
      )}
      <div className={section}>
        <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-ink">
          <input type="checkbox" checked={pinPhases} data-testid="group-set-processing"
                 onChange={(e) => setPinPhases(e.target.checked)}
                 className="cursor-pointer accent-accent" />
          Set which phases these datasets run
        </label>
        {pinPhases && (
          <>
            <div className="mt-2 space-y-1" data-testid="group-processing-phases">
              {PHASE_CHOICES.map(([key, label]) => {
                const setter = { layout: setLayout, lines: setLines, ocr: setOcr }[key]
                return (
                  <label key={key} data-testid="group-processing-phase" data-phase={key}
                         className={`flex items-center gap-2 text-sm ${
                           key === 'ocr' && !lines ? 'opacity-40' : 'cursor-pointer'}`}>
                    <input type="checkbox" checked={on[key]} disabled={key === 'ocr' && !lines}
                           onChange={(e) => setter(e.target.checked)}
                           className="cursor-pointer accent-accent" />
                    {label}
                  </label>
                )
              })}
            </div>
            {lines && (
              <div className="mt-2 flex gap-2" data-testid="group-processing-line-mode">
                {LINE_MODE_CHOICES.map(([value, label, hint]) => {
                  const disabled = value === 'per_crop' && !layout
                  return (
                    <button
                      key={value}
                      type="button"
                      disabled={disabled}
                      data-testid="group-line-mode-option"
                      data-mode={value}
                      aria-pressed={effectiveMode === value}
                      onClick={() => setLineMode(value)}
                      className={`flex-1 rounded border px-2 py-1.5 text-left text-sm ${
                        disabled
                          ? 'cursor-not-allowed border-line-strong opacity-40'
                          : effectiveMode === value
                            ? 'cursor-pointer border-accent bg-accent-wash'
                            : 'cursor-pointer border-line-strong'
                      }`}
                    >
                      <span className="block font-medium text-ink">{label}</span>
                      <span className="block text-xs text-ink-muted">
                        {disabled ? NEEDS_LAYOUT : hint}
                      </span>
                    </button>
                  )
                })}
              </div>
            )}
          </>
        )}
      </div>
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className={modalBtn}>Cancel</button>
        <button onClick={save} disabled={busy || nothingPicked} data-testid="group-settings-save"
                className={`${modalPrimaryBtn} disabled:opacity-40`}>
          {busy ? 'Applying…' : `Apply to ${count} dataset${count === 1 ? '' : 's'}`}
        </button>
      </div>
    </Modal>
  )
}
