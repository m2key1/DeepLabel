import { useEffect, useState } from 'react'
import {
  READING_ORDERS, READING_ORDER_LABEL, TILE_SIZE_MAX, TILE_SIZE_MIN, getJob, isTileTask, setJobProcessing,
} from '../../api'
import type { Job, LayoutShape, LineMode } from '../../api'
import { Select } from '../ui/Field'
import { Modal, modalBtn, modalPrimaryBtn } from '../Modal'
import { LAYOUT_SHAPE_CHOICES, LINE_MODE_CHOICES, NEEDS_LAYOUT, PHASE_CHOICES } from './processing'
import { LabelMapping } from './LabelMapping'

interface ProcessingDialogProps {
  job: Job
  onClose: () => void
  onSaved: () => void
  onError: (message: string) => void
}

const card = (chosen: boolean, disabled: boolean) =>
  `rounded border px-3 py-2 text-left text-sm ${
    disabled
      ? 'cursor-not-allowed border-line-strong opacity-40'
      : chosen
        ? 'cursor-pointer border-accent bg-accent-wash'
        : 'cursor-pointer border-line-strong'
  }`

export function ProcessingDialog(props: ProcessingDialogProps) {
  return isTileTask(props.job.task) ? <TileProcessing {...props} /> : <TextProcessing {...props} />
}

/** The size a map dataset cuts its maps into, for the maps added from now on. */
function TileProcessing({ job, onClose, onSaved, onError }: ProcessingDialogProps) {
  const [draft, setDraft] = useState(String(job.tile_size))
  const [busy, setBusy] = useState(false)
  const size = Number(draft)
  const valid = Number.isInteger(size) && size >= TILE_SIZE_MIN && size <= TILE_SIZE_MAX

  const save = async () => {
    setBusy(true)
    try {
      await setJobProcessing(job.id, { tile_size: size })
      onClose()
      onSaved()
    } catch (e) {
      onError((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <Modal title="How this dataset is processed" onClose={onClose}>
      <p className="mb-3 text-sm text-ink-muted">
        The tile size applies to the maps added from now on. Tiles already cut keep their size
        and their annotations.
      </p>
      <label className="mb-1 flex items-center gap-2 text-sm font-medium text-ink">
        Tile size
        <input
          type="number"
          data-testid="processing-tile-size"
          min={TILE_SIZE_MIN} max={TILE_SIZE_MAX} step={1}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          aria-invalid={!valid}
          className="w-24 rounded border border-line-strong bg-surface px-2 py-1 text-sm font-normal focus-visible:border-accent focus:outline-none"
        />
        px
      </label>
      <p className="mb-3 text-xs text-ink-subtle">{TILE_SIZE_MIN} to {TILE_SIZE_MAX} px square.</p>
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className={modalBtn}>Cancel</button>
        <button onClick={save} disabled={busy || !valid} data-testid="processing-save"
                className={modalPrimaryBtn}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </Modal>
  )
}

/** Which phases this dataset runs, and where its lines are looked for. Both were settled
 *  when it was created, so a dataset could never be moved between per-crop and per-page
 *  once its first run had happened. */
function TextProcessing({ job, onClose, onSaved, onError }: ProcessingDialogProps) {
  const [layout, setLayout] = useState(job.run_layout)
  const [lines, setLines] = useState(job.run_lines)
  const [ocr, setOcr] = useState(job.run_ocr)
  const [lineMode, setLineMode] = useState<LineMode>((job.line_mode as LineMode) || 'per_crop')
  const [structure, setStructure] = useState(job.reading_order || 'auto')
  // The template of its layout model, where that reads top to bottom: then it, not the
  // structure, orders the pages - as long as the dataset runs its layout model.
  const [orderTemplate, setOrderTemplate] = useState<string | null>(null)
  useEffect(() => {
    getJob(job.id, { pages: false }).then((detail) => setOrderTemplate(detail.reading_order_template ?? null))
      .catch(() => {})
  }, [job.id])
  const setBy = layout ? orderTemplate : null
  const [shape, setShape] = useState<LayoutShape>(job.layout_shape ?? 'box')
  const [gtAutocheck, setGtAutocheck] = useState(job.gt_autocheck)
  const [gtOrdered, setGtOrdered] = useState(job.gt_ordered)
  const hasTranscriptions = (job.counters.gt_total ?? 0) > 0
  const [busy, setBusy] = useState(false)

  // The server settles the combinations that cannot run; showing the same conclusion here
  // means the dialog never promises something the save would quietly change.
  const on = { layout, lines, ocr: lines && ocr }
  const effectiveMode: LineMode = layout ? lineMode : 'per_page'

  const save = async () => {
    setBusy(true)
    try {
      await setJobProcessing(job.id, {
        run_layout: layout, run_lines: lines, run_ocr: ocr, line_mode: lineMode,
        reading_order: structure,
        ...(shape !== (job.layout_shape ?? 'box') && { layout_shape: shape }),
        ...(hasTranscriptions && { gt_autocheck: gtAutocheck, gt_ordered: gtOrdered }),
      })
      onClose()
      onSaved()
    } catch (e) {
      onError((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <Modal title="How this dataset is processed" onClose={onClose}>
      <p className="mb-3 text-sm text-ink-muted">
        These settings apply from the next run onwards. Nothing already detected or read is
        discarded - open the dataset and use Re-run, or a page's own menu, to redo work
        under the new settings. The page structure is the exception: it re-sorts the
        lines of the pages already detected as soon as it is saved.
      </p>
      <div className="mb-3 space-y-2" data-testid="processing-phases">
        {PHASE_CHOICES.map(([key, label, hint]) => {
          const disabled = key === 'ocr' && !lines
          const setter = { layout: setLayout, lines: setLines, ocr: setOcr }[key]
          return (
            <label key={key} data-testid="processing-phase" data-phase={key}
                   className={`flex items-start gap-2.5 ${card(on[key], disabled)}`}>
              <input
                type="checkbox"
                checked={on[key]}
                disabled={disabled}
                onChange={(e) => setter(e.target.checked)}
                className="mt-0.5 cursor-pointer accent-accent"
              />
              <span>
                <span className="block font-medium text-ink">{label}</span>
                <span className="block text-xs text-ink-muted">
                  {disabled ? 'Needs line segmentation' : hint}
                </span>
              </span>
            </label>
          )
        })}
      </div>
      {lines && (
        <div className="mb-3" data-testid="processing-line-mode">
          <span className="mb-1 block text-sm font-medium text-ink">
            Line detection
          </span>
          <div className="flex gap-2">
            {LINE_MODE_CHOICES.map(([value, label, hint]) => {
              const disabled = value === 'per_crop' && !layout
              return (
                <button
                  key={value}
                  type="button"
                  disabled={disabled}
                  data-testid="processing-line-mode-option"
                  data-mode={value}
                  aria-pressed={effectiveMode === value}
                  onClick={() => setLineMode(value)}
                  className={`flex-1 ${card(effectiveMode === value, disabled)}`}
                >
                  <span className="block font-medium text-ink">{label}</span>
                  <span className="block text-xs text-ink-muted">
                    {disabled ? NEEDS_LAYOUT : hint}
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      )}
      {layout && <LabelMapping jobId={job.id} canEdit onError={onError} />}
      <div className="mb-3" data-testid="processing-layout-shape">
        <span className="mb-1 block text-sm font-medium text-ink">Layout elements</span>
        <div className="flex gap-2">
          {LAYOUT_SHAPE_CHOICES.map(([value, label, hint]) => (
            <button key={value} type="button" data-testid="processing-layout-shape-option" data-shape={value}
                    aria-pressed={shape === value} onClick={() => setShape(value)}
                    className={`flex-1 ${card(shape === value, false)}`}>
              <span className="block font-medium text-ink">{label}</span>
              <span className="block text-xs text-ink-muted">{hint}</span>
            </button>
          ))}
        </div>
        {shape !== (job.layout_shape ?? 'box') && (
          <p className="mt-1.5 text-xs text-ink-muted" data-testid="processing-layout-shape-note">
            {shape === 'polygon'
              ? 'Saving turns every box into its four corners, applied at once.'
              : 'Saving shows every element as its bounding box; the outlines are kept for switching back.'}
          </p>
        )}
      </div>
      {lines && (
        <div className="mb-3" data-testid="processing-reading-order">
          <span className="mb-1 block text-sm font-medium text-ink">Page structure</span>
          <p className="mb-1.5 text-xs text-ink-muted">
            What the lines of a page with no layout boxes are read in. Two columns sorted by
            height alone come out interleaved; saying how the volume is set puts them right,
            here and on every page already detected.
          </p>
          {setBy && (
            <p className="mb-1.5 text-xs text-ink-muted" data-testid="reading-order-set-by">
              {`Set by the ${setBy} template of this dataset's layout model: pages read top to bottom, as the Schematismus pipeline does.`}
            </p>
          )}
          <Select value={structure} onChange={(e) => setStructure(e.target.value)}
                  disabled={!!setBy} data-testid="reading-order-choice">
            {READING_ORDERS.map((value) => (
              <option key={value} value={value}>{READING_ORDER_LABEL[value]}</option>
            ))}
          </Select>
        </div>
      )}
      {hasTranscriptions && (
        <div className="mb-3" data-testid="processing-alignment">
          <span className="mb-1 block text-sm font-medium text-ink">Transcription matching</span>
          <p className="mb-1.5 text-xs text-ink-muted">
            Re-run Alignment from the dataset menu to match the transcriptions again under
            these settings. Lines already checked stay checked.
          </p>
          <label className="flex items-center gap-1.5 text-sm text-ink">
            <input
              type="checkbox"
              data-testid="processing-gt-autocheck"
              checked={gtAutocheck}
              onChange={(e) => setGtAutocheck(e.target.checked)}
              className="cursor-pointer accent-accent"
            />
            Mark near-exact matches as reviewed right away
          </label>
          {gtAutocheck && (
            <label className="mt-1.5 ml-5 flex items-start gap-1.5 text-sm text-ink">
              <input
                type="checkbox"
                data-testid="processing-gt-ordered"
                checked={gtOrdered}
                onChange={(e) => setGtOrdered(e.target.checked)}
                className="mt-1 cursor-pointer accent-accent"
              />
              <span>
                The transcription lists every line, in reading order
                <span className="mt-0.5 block text-xs text-ink-muted">
                  Then a match that follows that order is reviewed too, however poorly the page
                  was read.
                </span>
              </span>
            </label>
          )}
        </div>
      )}
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className={modalBtn}>Cancel</button>
        <button onClick={save} disabled={busy} data-testid="processing-save"
                className={modalPrimaryBtn}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </Modal>
  )
}
