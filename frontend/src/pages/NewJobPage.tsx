import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import {
  ALL_USES, PHASE_CAPABILITY, READING_ORDERS, READING_ORDER_LABEL, TILE_SIZE_MAX, TILE_SIZE_MIN, createJobFromIiif,
  createJobFromPath, iiifThumbnailUrl, ApiError, getEnabledTasks, getLayoutTemplates, getMapModels, importJob, isTileTask, listConventionFlags,
  checkJobName, listModels, listUsableLlmModels, reocr, reocrPreview, setDataUse as saveDataUse, setJobLlmSettings,
  setJobModels, setJobProcessing, setNewPagesTest, uploadJob,
} from '../api'
import type {
  ConventionFlag, DataUse, JobOptions, JobWithoutPages, LayoutShape, LlmModel, ReocrPreview, LayoutTemplate, LineMode, MapModel, MapRunner, ModelPicks, ModelTask, OcrConvention, OcrDecode,
  Phases, RegistryModel, Task,
} from '../api'
import { useAuth } from '../auth'
import { conventionLabel } from '../components/conventionLabel'
import { ConventionFlags, flagsOn, toggledFlag } from '../components/job/ConventionFlags'
import { DataUseSwitches, USES, dataUseSummary, keptOut } from '../components/job/DataUseSwitches'
import { DataUseEditor } from '../components/job/DataUseEditor'
import { LabelMapping } from '../components/job/LabelMapping'
import { AlignmentChoice, LayoutShapeChoice, LlmReaders } from '../components/job/SettingsSections'
import { IiifSource, NO_IIIF } from '../components/job/IiifSource'
import type { IiifChoice } from '../components/job/IiifSource'
import { PagePicker, useFileItems } from '../components/job/PagePicker'
import { LINE_MODE_CHOICES, NEEDS_LAYOUT, PHASE_CHOICES } from '../components/job/processing'
import { Stepper } from '../components/ui/Stepper'
import { SkippedSymlinks } from '../components/job/SkippedSymlinks'
import { useCrumb } from '../components/NavBar'
import { readerName } from '../components/viewer/readers'
import { humanBytes } from '../util'
import { UploadProgress, type UploadState } from '../components/ui/UploadProgress'
import { PageHeader } from '../components/ui/PageHeader'
import { pageShell } from '../components/ui/page'
import { useAutoClear } from '../messages'

type Mode = 'upload' | 'iiif' | 'path'
type Step = 'source' | 'pages' | 'run' | 'models' | 'review'

const STEP_LABEL: Record<Step, string> = {
  source: 'Source', pages: 'Pages', run: 'What to run', models: 'Models and conventions', review: 'Review',
}
const STEPS = Object.keys(STEP_LABEL) as Step[]
const NAME_CHECK_MS = 250
const DECODE_CARDS: [OcrDecode, string, string][] = [
  ['beam', 'With language model', "Beam search with the model's language model"],
  ['rescored', 'Best quality', 'Beam search reranked by the decoder head, no language model'],
  ['greedy', 'Fast', 'Raw greedy CTC output'],
]
const TASK_LABEL: Record<Task, string> = {
  text: 'Text extraction', map_segmentation: 'Map segmentation', map_lines: 'Line tracing (maps)',
}

interface SummaryRow {
  label: string
  value: string
  /** Where it was set; none for what can no longer be changed. */
  step?: Step
}

/** What the dataset will be, as chosen so far; each row leads back to the step it was set on. */
function NewJobSummary({ rows, onEdit, full = false }: {
  rows: SummaryRow[]
  onEdit: (step: Step) => void
  /** The Review step's own copy, which the steps beside it no longer need to repeat. */
  full?: boolean
}) {
  return (
    <div data-testid={full ? 'new-job-review' : 'new-job-summary'}
         className={full ? '' : 'rounded-lg border border-line bg-surface p-3'}>
      {!full && <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-subtle">So far</p>}
      <dl className={`grid grid-cols-[auto_minmax(0,1fr)_auto] gap-x-3 gap-y-1 ${full ? 'text-sm' : 'text-xs'}`}>
        {rows.map((row) => (
          <div key={row.label} className="contents" data-testid="summary-row" data-label={row.label}>
            <dt className="text-ink-subtle">{row.label}</dt>
            <dd className="min-w-0 break-words text-ink">{row.value}</dd>
            {/* On the Review step its own rows are set right above, so there is nothing to go to. */}
            {!row.step || (full && row.step === 'review') ? <span /> : (
              <button type="button" onClick={() => onEdit(row.step!)}
                      className="justify-self-end text-accent-ink hover:underline">edit</button>
            )}
          </div>
        ))}
      </dl>
    </div>
  )
}

const INGEST_EXTENSIONS = /\.(jpe?g|png|tiff?|bmp|webp|pdf|txt|zip)$/i
const IMAGE_EXTENSIONS = /\.(jpe?g|png|tiff?|bmp|webp)$/i
const EXPORT_ARCHIVE = /\.zip$/i
function toggled<K>(held: Set<K>, key: K): Set<K> {
  const next = new Set(held)
  if (!next.delete(key)) next.add(key)
  return next
}

const READING_OFF = 'OCR is off for this dataset, so nothing is matched or cut until its pages are read.'

/** A new dataset, step by step; or, given `edit`, the same steps for a dataset that
 *  exists: what it runs, its models and its data use, filled in as they stand. */
export function NewJobPage({ edit }: { edit?: JobWithoutPages } = {}) {
  const { isAdmin, canEdit, can } = useAuth()
  useCrumb(edit ? `${edit.name} · Settings` : 'New job')
  const navigate = useNavigate()
  const [name, setName] = useState(edit?.name ?? '')
  // Two datasets of one name cannot be told apart in any list, picker or export, so the
  // name is settled on the first step rather than found out at the last. The server holds
  // the rule, and knows of datasets this person cannot see.
  const [nameCheck, setNameCheck] = useState<{
    name: string; taken: boolean; jobId: string | null; holder: string | null
  } | null>(null)
  useEffect(() => {
    const asked = name.trim()
    if (asked === '' || edit) return
    let current = true
    const timer = setTimeout(() => {
      checkJobName(asked)
        .then((r) => { if (current) setNameCheck({ name: asked, taken: r.taken, jobId: r.job_id, holder: r.name }) })
        // Unanswered, the name goes on unchecked: creating applies the same rule.
        .catch(() => { if (current) setNameCheck({ name: asked, taken: false, jobId: null, holder: null }) })
    }, NAME_CHECK_MS)
    return () => { current = false; clearTimeout(timer) }
  }, [name])
  const nameChecked = !!edit || (nameCheck !== null && nameCheck.name === name.trim())
  const nameTaken = !edit && nameChecked && nameCheck?.taken ? nameCheck : null
  const [task, setTask] = useState<Task>(edit?.task ?? 'text')
  // null until the deployment's enabled set arrives; the picker renders nothing until then
  // rather than flashing options that may turn out to be unavailable.
  const [enabledTasks, setEnabledTasks] = useState<Task[] | null>(null)
  const [mode, setMode] = useState<Mode>('upload')
  const [files, setFiles] = useState<File[]>([])
  const [skipped, setSkipped] = useState(0)
  const [serverPath, setServerPath] = useState('')
  const [iiif, setIiif] = useState<IiifChoice>(NO_IIIF)
  const [iiifExcluded, setIiifExcluded] = useState<Set<string>>(new Set())
  const [lineMode, setLineMode] = useState<LineMode>((edit?.line_mode as LineMode | undefined) ?? 'per_page')
  const [structure, setStructure] = useState(edit?.reading_order || 'auto')
  const [shape, setShape] = useState<LayoutShape>(edit?.layout_shape ?? 'box')
  const [templates, setTemplates] = useState<LayoutTemplate[]>([])
  const [templateId, setTemplateId] = useState<number | null>(null)
  // A phase the person may not run starts off and stays off; the backend refuses it too.
  // Layout starts off as well.
  const granted = (key: keyof typeof PHASE_CAPABILITY) => can(PHASE_CAPABILITY[key])
  const [phases, setPhases] = useState<Phases>(() => (edit
    ? { layout: edit.run_layout, lines: edit.run_lines, ocr: edit.run_ocr, predict: edit.run_predict, tile: edit.run_tile }
    : { layout: false, lines: granted('lines'), ocr: granted('ocr'), predict: true, tile: false }))
  // Two registries, two states: mapModels are the mapseg checkpoints a map job predicts
  // with, models are the text pipeline's trained layout/lines/ocr models.
  const [mapModels, setMapModels] = useState<MapModel[] | null>(null)
  const [modelId, setModelId] = useState('')
  const [mapRunner, setMapRunner] = useState<MapRunner | null>(null)
  const [tileSizeDraft, setTileSizeDraft] = useState('512')
  const [skipBlank, setSkipBlank] = useState(true)
  const [lineWidth, setLineWidth] = useState(3)
  const [models, setModels] = useState<RegistryModel[]>([])
  const pickOf = (id: number | null | undefined) => (id == null ? '' : String(id))
  const [picks, setPicks] = useState<Record<ModelTask, string>>({
    layout: pickOf(edit?.model_layout_id), lines: pickOf(edit?.model_lines_id), ocr: pickOf(edit?.model_ocr_id),
  })
  const [ocrDecode, setOcrDecode] = useState<OcrDecode>(edit?.ocr_decode ?? 'rescored')
  const [gtAutocheck, setGtAutocheck] = useState(edit?.gt_autocheck ?? false)
  const [asTest, setAsTest] = useState(edit?.new_pages_test ?? false)
  const [gtOrdered, setGtOrdered] = useState(edit?.gt_ordered ?? false)
  const [gtFromPdf, setGtFromPdf] = useState(false)
  const [importReviewed, setImportReviewed] = useState(true)
  const [step, setStep] = useState<Step>(edit ? 'run' : 'source')
  const [excluded, setExcluded] = useState<Set<File>>(new Set())
  const [catalog, setCatalog] = useState<ConventionFlag[] | null>(null)
  const [convention, setConvention] = useState<OcrConvention>(edit?.ocr_convention ?? {})
  const [dataUse, setDataUse] = useState<DataUse>(edit?.data_use ?? ALL_USES)
  // What only a dataset that exists has: the language models that read it, and the lines
  // a change of OCR settings could read again.
  const [readers, setReaders] = useState<(LlmModel & { self_hosted: boolean })[] | null>(null)
  const [readWith, setReadWith] = useState<number[]>(edit?.llm_model_ids ?? [])
  const [reocrState, setReocrState] = useState<ReocrPreview | null>(null)
  const [rereadNow, setRereadNow] = useState(false)
  useEffect(() => {
    if (!edit) return
    listUsableLlmModels().then((r) => setReaders(r.models)).catch(() => setReaders([]))
    reocrPreview(edit.id).then(setReocrState).catch(() => {})
  }, [edit])
  const dataUseSection = useRef<HTMLElement>(null)
  const [toDataUse, setToDataUse] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<UploadState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [madeWithSkips, setMadeWithSkips] = useState<{ jobId: string; skipped: string[] } | null>(null)
  useAutoClear(error, setError)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    getEnabledTasks()
      .then((tasks) => {
        setEnabledTasks(tasks)
        // 'text' is the default but need not be on; land on the first task offered.
        setTask((current) => (tasks.includes(current) ? current : (tasks[0] ?? current)))
      })
      .catch(() => setEnabledTasks(null))
  }, [])

  const isMap = isTileTask(task)
  const isLines = task === 'map_lines'
  const acceptRe = isMap ? IMAGE_EXTENSIONS : INGEST_EXTENSIONS

  useEffect(() => {
    getMapModels()
      .then(({ models: m, runner }) => {
        setMapModels(m)
        setMapRunner(runner)
        if (m.length) setModelId((cur) => cur || m[0].id)
      })
      .catch(() => setMapModels([]))
  }, [])

  const selectedModel = mapModels?.find((m) => m.id === modelId) ?? null
  const runnerMissing = mapRunner !== null && !mapRunner.available
  // Predict is unavailable without the map runner, or when the chosen model's checkpoint
  // isn't on the server.
  const predictDisabled = isMap && (runnerMissing || (!!selectedModel && !selectedModel.checkpoint_available))
  const tileDisabled = isMap && runnerMissing
  const tileSize = Number(tileSizeDraft)
  const tileSizeValid = Number.isInteger(tileSize) && tileSize >= TILE_SIZE_MIN && tileSize <= TILE_SIZE_MAX

  const addFiles = (list: FileList | null) => {
    if (!list || list.length === 0) return
    // The accept attribute only filters the OS picker, so drag-drop needs its own gate.
    const all = Array.from(list)
    const added = all.filter((f) => acceptRe.test(f.name))
    setSkipped(all.length - added.length)
    if (added.length === 0) return
    setFiles((prev) => [...prev, ...added])
    const firstImage = added.find((f) => !/\.txt$/i.test(f.name))
    if (firstImage) setName((n) => (n.trim() === '' ? firstImage.name.replace(/\.[^.]+$/, '') : n))
  }

  // A dropped export archive takes over the form: it already contains pages,
  // line boxes and transcriptions, so nothing has to be recognized.
  const archive = files.find((f) => EXPORT_ARCHIVE.test(f.name)) ?? null

  // The backend's rule (ingest.partition_transcriptions): a .txt named like a page is that
  // page's transcription, and any other .txt is a corpus document. A PDF's pages are named
  // after it and their page number (book_p0002), so a .txt named after the PDF itself is
  // a document.
  const stem = (name: string) => name.replace(/\.[^.]+$/, '').toLowerCase()
  const imageStems = new Set(files.filter((f) => !/\.(txt|zip|pdf)$/i.test(f.name)).map((f) => stem(f.name)))
  const pdfStems = files.filter((f) => /\.pdf$/i.test(f.name)).map((f) => stem(f.name))
  const namesPage = (text: string) =>
    imageStems.has(text)
    || pdfStems.some((pdf) => text.startsWith(`${pdf}_p`) && /^\d{4}$/.test(text.slice(pdf.length + 2)))
  const texts = files.filter((f) => /\.txt$/i.test(f.name))
  const pairedCount = new Set(texts.map((f) => stem(f.name)).filter(namesPage)).size
  const corpusTexts = texts.filter((f) => !namesPage(stem(f.name)))
  const pdfCount = pdfStems.length
  const otherFiles = files.filter((f) => f !== archive).map((f) => f.name)

  useEffect(() => {
    // Archived ones too when editing: a dataset pinned to one before it was archived still runs it.
    listModels(!!edit)
      .then((r) => setModels(r.models))
      .catch(() => {})
    listConventionFlags()
      .then((r) => setCatalog(r.flags))
      .catch(() => setCatalog([]))
  }, [])

  useEffect(() => {
    getLayoutTemplates()
      .then((found) => {
        setTemplates(found)
        setTemplateId((current) => current ?? found.find((t) => t.is_default)?.id ?? null)
      })
      .catch(() => setTemplates([]))
  }, [])
  const template = templates.find((t) => t.id === templateId) ?? null

  const modelPicks: ModelPicks = {
    layout: picks.layout === '' ? null : Number(picks.layout),
    lines: picks.lines === '' ? null : Number(picks.lines),
    ocr: picks.ocr === '' ? null : Number(picks.ocr),
  }

  const togglePhase = (key: keyof Phases) =>
    setPhases((p) => {
      if (key === 'lines') {
        const lines = !p.lines
        return { ...p, lines, ocr: lines ? p.ocr : false } // OCR needs line segmentation
      }
      if (key === 'ocr') return p.lines ? { ...p, ocr: !p.ocr } : p
      if (key === 'predict') return { ...p, predict: !p.predict }
      if (key === 'tile') return { ...p, tile: !p.tile }
      return { ...p, layout: !p.layout }
    })

  // Per-crop segments inside layout elements, so it needs layout detection. Derived
  // rather than forced into state, so the choice comes back if layout is re-enabled.
  const effectiveLineMode: LineMode = phases.layout ? lineMode : 'per_page'
  const effectivePhases: Phases = {
    ...phases, predict: phases.predict && !predictDisabled, tile: phases.tile && !tileDisabled,
  }
  // Transcriptions and corpus documents are matched and cut inside the reading pass.
  const readingOff = !(phases.lines && phases.ocr)
  const pageWord = (n: number) => `page${n === 1 ? '' : 's'}`
  const pairingCount = pdfCount > 0
    ? `${pairedCount} ${pageWord(pairedCount)}`
    : `${pairedCount} of ${imageStems.size} ${pageWord(imageStems.size)}`

  // The scans themselves, which the Pages step shows; transcriptions travel with them.
  const pageFiles = useMemo(() => files.filter((f) => !/\.(txt|zip)$/i.test(f.name)), [files])
  const fileItems = useFileItems(pageFiles)
  const manifest = mode === 'iiif' ? iiif.manifest : null
  const canvasItems = useMemo(() => (iiif.manifest?.canvases ?? []).map((c, i) => ({
    key: c.canvas, name: `${i + 1} · ${c.label || 'untitled'}`, preview: iiifThumbnailUrl(c.thumbnail),
  })), [iiif.manifest])
  const canvasesKept = (manifest?.canvases ?? []).filter((c) => !iiifExcluded.has(c.canvas))
  const sentFiles = files.filter((f) => !excluded.has(f))
  const ocrModel = models.find((m) => (picks.ocr === '' ? m.task === 'ocr' && m.is_default : m.id === Number(picks.ocr)))

  const applies: Record<Step, boolean> = {
    source: !edit,
    pages: !edit && ((mode === 'upload' && !archive && pageFiles.length > 0) || manifest !== null),
    // An imported dataset is already segmented and transcribed: nothing is run on it.
    run: !archive,
    // A map job picks its model with what it runs.
    models: !archive && !isMap && (phases.layout || phases.lines),
    review: true,
  }
  const route = STEPS.filter((s) => applies[s])
  // A step that stops applying, say Pages once the files are removed, is left for the first.
  const stepGone = !applies[step]
  useEffect(() => {
    if (stepGone) setStep(edit ? 'run' : 'source')
  }, [stepGone, edit])
  const at = route.indexOf(step)
  const previous = at > 0 ? route[at - 1] : null
  const next = at >= 0 && at < route.length - 1 ? route[at + 1] : null

  const stepMissing: Record<Step, string | null> = {
    source: name.trim() === ''
      ? 'Add a job name'
      : nameTaken
        ? 'Choose a name no other dataset has'
        : !nameChecked
          ? 'Checking the name'
          : mode === 'upload' && !archive && imageStems.size === 0 && pdfCount === 0
        ? isMap
          ? 'Select at least one tile image'
          : 'Select at least one image or PDF'
        : mode === 'path' && serverPath.trim() === ''
          ? 'Enter an absolute server directory path'
          : mode === 'iiif' && manifest === null
            ? 'Load a IIIF manifest'
            : null,
    pages: !applies.pages
      ? null
      : manifest
        ? canvasesKept.length === 0
          ? 'Leave at least one page in'
          : canvasesKept.length > manifest.max_pages ? `Choose at most ${manifest.max_pages} pages` : null
        : pageFiles.every((f) => excluded.has(f)) ? 'Leave at least one page in' : null,
    run: applies.run && isMap && effectivePhases.tile && !tileSizeValid
      ? `Choose a tile size from ${TILE_SIZE_MIN} to ${TILE_SIZE_MAX} px`
      : null,
    models: null,
    review: null,
  }
  const missing = route.map((s) => stepMissing[s]).find((m) => m !== null) ?? null
  const canSubmit = missing === null && !busy && madeWithSkips === null

  const ran = (key: 'layout' | 'lines' | 'ocr') => (key === 'ocr' ? phases.lines && phases.ocr : phases[key])
  const modelName = (key: ModelTask) => picks[key] === ''
    ? 'default'
    : models.find((m) => m.id === Number(picks[key]))?.name ?? 'default'
  const summary: SummaryRow[] = [
    { label: 'Name', value: name.trim() || '-', step: edit ? undefined : 'source' },
    { label: 'Task', value: TASK_LABEL[task], step: edit ? undefined : 'source' },
    ...(edit ? [] : [{
      label: 'Source',
      value: mode === 'path'
        ? serverPath.trim() || '-'
        : mode === 'iiif'
          ? manifest ? `IIIF - ${manifest.label || manifest.url}` : '-'
          : archive ? `${archive.name}, imported as it is` : `${pageFiles.length} file${pageFiles.length === 1 ? '' : 's'}`,
      step: 'source' as Step,
    }]),
    ...(applies.pages ? [{
      label: 'Pages', step: 'pages' as Step,
      value: manifest
        ? `${canvasesKept.length} of ${manifest.canvases.length} included`
        : `${pageFiles.filter((f) => !excluded.has(f)).length} of ${pageFiles.length} included`,
    }] : []),
    ...(applies.run && !isMap ? [
      { label: 'Runs', step: 'run' as Step,
        value: PHASE_CHOICES.filter(([key]) => ran(key)).map(([, label]) => label).join(', ') || 'nothing yet' },
      ...(template && !edit ? [{ label: 'Layout', value: `${template.name} template`, step: 'run' as Step }] : []),
      ...(asTest ? [{ label: 'Test pages', value: edit ? 'pages added from now on' : 'yes, kept out of training',
                      step: 'run' as Step }] : []),
    ] : []),
    ...(applies.run && isMap ? [
      { label: 'Tiles', step: 'run' as Step,
        value: effectivePhases.tile ? `cut at ${tileSizeDraft} px` : 'uploaded as tiles' },
      { label: 'Pre-annotation', value: effectivePhases.predict ? (selectedModel?.label ?? 'on') : 'off', step: 'run' as Step },
    ] : []),
    ...(applies.models ? [
      { label: 'Models', step: 'models' as Step,
        value: (['layout', 'lines', 'ocr'] as const).filter(ran).map((key) => `${key} ${modelName(key)}`).join(', ') },
      ...(ran('ocr') ? [{
        label: 'Convention', step: 'models' as Step,
        value: flagsOn(convention).map((flag) => conventionLabel(flag, catalog).toLowerCase()).join(', ') || 'normalized',
      }] : []),
    ] : []),
    { label: 'Data use', value: dataUseSummary(dataUse), step: 'review' },
  ]

  // The side summary's Data use row leads to the switches, which sit on the Review step.
  const editRow = (target: Step) => {
    if (target === 'review') setToDataUse(true)
    setStep(target)
  }
  useEffect(() => {
    if (!toDataUse || step !== 'review') return
    dataUseSection.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    dataUseSection.current?.querySelector('input')?.focus({ preventScroll: true })
    setToDataUse(false)
  }, [toDataUse, step])

  const jobOptions = (): JobOptions => ({
    name: name.trim(), line_mode: effectiveLineMode, page_reading_order: structure, task,
    model_id: isMap ? modelId || null : null,
    run_layout: effectivePhases.layout, run_lines: effectivePhases.lines, run_ocr: effectivePhases.ocr,
    run_predict: effectivePhases.predict, run_tile: effectivePhases.tile, tile_size: tileSize,
    tile_skip_blank: skipBlank, line_width: lineWidth,
    model_layout_id: modelPicks.layout ?? null, model_lines_id: modelPicks.lines ?? null,
    model_ocr_id: modelPicks.ocr ?? null, ocr_decode: ocrDecode, gt_autocheck: gtAutocheck,
    gt_ordered: gtOrdered, gt_from_pdf: gtFromPdf, layout_template_id: isMap ? null : templateId,
    ocr_convention: ran('ocr') && !isMap ? convention : {},
    data_use: dataUse,
  })

  // The template of a dataset's layout model, where that reads top to bottom: then it, not
  // the structure, orders the pages - as long as the dataset runs its layout model.
  const orderSetBy = edit && phases.layout ? edit.reading_order_template ?? null : null
  const ocrSettingsChanged = !!edit && (ocrDecode !== edit.ocr_decode || modelPicks.ocr !== edit.model_ocr_id
    || flagsOn(convention).join() !== flagsOn(edit.ocr_convention ?? {}).join())
  const canReread = ocrSettingsChanged && (reocrState?.unchecked ?? 0) > 0
    && edit.status !== 'queued' && edit.status !== 'running'

  /** Each changed setting through the endpoint that owns it, and nothing unchanged: what a
   *  run uses cannot be changed while one is going, but data use can. */
  const saveSettings = async (job: JobWithoutPages) => {
    const processing = {
      ...(phases.layout !== job.run_layout && { run_layout: phases.layout }),
      ...(phases.lines !== job.run_lines && { run_lines: phases.lines }),
      ...(phases.ocr !== job.run_ocr && { run_ocr: phases.ocr }),
      ...(effectiveLineMode !== job.line_mode && { line_mode: effectiveLineMode }),
      ...(structure !== (job.reading_order || 'auto') && { reading_order: structure }),
      ...(shape !== (job.layout_shape ?? 'box') && { layout_shape: shape }),
      ...((job.counters.gt_total ?? 0) > 0 && (gtAutocheck !== job.gt_autocheck || gtOrdered !== job.gt_ordered)
        && { gt_autocheck: gtAutocheck, gt_ordered: gtOrdered }),
    }
    if (Object.keys(processing).length) await setJobProcessing(job.id, processing)
    const keptConvention = ran('ocr') ? convention : {}
    if (modelPicks.layout !== job.model_layout_id || modelPicks.lines !== job.model_lines_id
        || modelPicks.ocr !== job.model_ocr_id || ocrDecode !== job.ocr_decode
        || flagsOn(keptConvention).join() !== flagsOn(job.ocr_convention ?? {}).join()) {
      await setJobModels(job.id, modelPicks, ocrDecode, keptConvention)
    }
    if (readers !== null) {
      const allowed = readWith.filter((id) => !readers.some((m) => m.id === id && keptOut(!dataUse.external_llm, m)))
      if ([...allowed].sort().join() !== [...(job.llm_model_ids ?? [])].sort().join()) {
        await setJobLlmSettings(job.id, { llm_model_ids: allowed })
      }
    }
    if (asTest !== (job.new_pages_test ?? false)) await setNewPagesTest(job.id, asTest)
    if (USES.some(({ use }) => dataUse[use] !== job.data_use[use])) await saveDataUse(job.id, dataUse)
    if (canReread && rereadNow) await reocr(job.id, 'unchecked')
  }

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (step !== 'review') {
      if (stepMissing[step] === null && next) setStep(next)
      return
    }
    if (!canSubmit) return
    setError(null)
    setBusy(true)
    if (edit) {
      try {
        await saveSettings(edit)
        navigate(`/jobs/${edit.id}`)
      } catch (err) {
        setBusy(false)
        setError((err as Error).message)
      }
      return
    }
    try {
      let job_id: string
      const upload = async (sent: File[]) => {
        setProgress({ loaded: 0, total: sent.reduce((s, f) => s + f.size, 0) })
        return uploadJob(
          name.trim(),
          sent,
          effectiveLineMode,
          effectivePhases,
          task,
          (loaded, total) => setProgress({ loaded, total }),
          isMap ? modelId || null : null,
          tileSize,
          skipBlank,
          lineWidth,
          modelPicks,
          ocrDecode,
          gtAutocheck,
          gtOrdered,
          gtFromPdf,
          structure,
          isMap ? null : templateId,
          !isMap && asTest,
          ran('ocr') && !isMap ? convention : {},
          dataUse,
        )
      }
      if (archive) {
        setProgress({ loaded: 0, total: archive.size })
        try {
          job_id = (await importJob(name.trim(), archive, importReviewed,
                                    (loaded, total) => setProgress({ loaded, total }), dataUse)).job_id
        } catch (err) {
          // A zip of scans with nothing describing them is a set of pages: it goes up as
          // an upload and is read like any other.
          if (!(err instanceof ApiError && err.status === 422)) throw err
          job_id = (await upload([archive])).job_id
        }
      } else if (mode === 'upload') {
        job_id = (await upload(sentFiles)).job_id
      } else if (manifest) {
        job_id = (await createJobFromIiif(manifest.url, canvasesKept.map((c) => c.canvas), jobOptions())).job_id
      } else {
        const res = await createJobFromPath(serverPath.trim(), jobOptions())
        if (res.skipped_symlinks.length > 0) {
          setBusy(false)
          setMadeWithSkips({ jobId: res.job_id, skipped: res.skipped_symlinks })
          return
        }
        job_id = res.job_id
      }
      navigate(`/jobs/${job_id}`)
    } catch (err) {
      setBusy(false)
      setProgress(null)
      setError((err as Error).message)
    }
  }

  const tabClass = (m: Mode) =>
    `px-3 py-1.5 text-sm font-medium border-b-2 ${
      mode === m
        ? 'border-accent text-accent-ink'
        : 'border-transparent text-ink-muted hover:text-ink'
    }`

  const inputBase = 'w-full rounded border bg-surface px-2 py-1.5 text-sm focus:outline-none disabled:cursor-not-allowed disabled:opacity-50'
  const inputClass = `${inputBase} border-line-strong focus-visible:border-accent`
  const invalidInputClass = `${inputBase} border-danger`

  if (!canEdit) return <Navigate to={edit ? `/jobs/${edit.id}` : '/'} replace />

  return (
    <div className={pageShell}>
      {edit ? (
        <PageHeader title={`Settings of ${edit.name}`} actions={
          <Link to={`/jobs/${edit.id}`} className="text-sm text-accent-ink hover:underline">Back to the dataset</Link>
        }>
          The steps the dataset was created with, as it stands now. Changes apply from the next run;
          nothing already detected or read is discarded - Re-run in the Run menu redoes work.
        </PageHeader>
      ) : (
        <PageHeader title="New dataset">
          One step at a time; going back keeps everything chosen so far.
        </PageHeader>
      )}
      <Stepper steps={(edit ? route : STEPS).map((s) => ({
        id: s, label: STEP_LABEL[s], skipped: !applies[s], done: route.indexOf(s) < at,
      }))} current={step} onSelect={setStep} />
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
      <form onSubmit={onSubmit} className="space-y-4" data-testid="new-job-step" data-step={step}>
        {step === 'source' && (<>
            <div>
              <label htmlFor="job-name" className="mb-1 block text-sm font-medium text-ink">
                Job name
              </label>
              <input id="job-name" value={name} onChange={(e) => setName(e.target.value)}
                     aria-invalid={!!nameTaken} aria-describedby={nameTaken ? 'job-name-taken' : undefined}
                     className={nameTaken ? invalidInputClass : inputClass} />
              {nameTaken && (
                <p id="job-name-taken" data-testid="job-name-taken" className="mt-1 text-xs text-danger">
                  {nameTaken.jobId ? (<>
                    <Link to={`/jobs/${nameTaken.jobId}`} className="font-medium underline">{nameTaken.holder}</Link>
                    {' '}already exists. Choose another name, or open it to add these pages there.
                  </>) : (
                    <>A dataset called {nameTaken.name} already exists. Choose another name.</>
                  )}
                </p>
              )}
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-ink">
                Annotation task
              </label>
              <div className="grid grid-cols-3 gap-2">
                {(
                  [
                    ['text', 'Text extraction', 'Layout, line segmentation and OCR on page scans'],
                    ['map_segmentation', 'Map segmentation', 'Draw class polygons on map tiles, pre-cut or cut here'],
                    ['map_lines', 'Line tracing (maps)', 'Trace boundary lines on map tiles; masks export as stroked outlines'],
                  ] as [Task, string, string][]
                ).map(([value, label, hint]) => {
                  // Until /api/tasks answers, treat everything as available: the picker would
                  // otherwise flash fully greyed out on every load.
                  const offered = enabledTasks === null || enabledTasks.includes(value)
                  return (
                    <button
                      key={value}
                      type="button"
                      data-testid={`task-${value}`}
                      disabled={!offered}
                      data-offered={offered}
                      title={offered ? undefined : 'Not enabled on this deployment'}
                      onClick={() => {
                        setTask(value)
                        if (isTileTask(value) && mode === 'iiif') setMode('upload')
                        // A PDF picked for a text job must not linger when switching to map.
                        setFiles((prev) => prev.filter((f) => (isTileTask(value) ? IMAGE_EXTENSIONS : INGEST_EXTENSIONS).test(f.name)))
                      }}
                      className={`rounded border px-3 py-2 text-left text-sm ${
                        task === value
                          ? 'border-accent bg-accent-wash'
                          : 'border-line-strong'
                      } ${offered ? '' : 'cursor-not-allowed opacity-40'}`}
                    >
                      <span className="block font-medium text-ink">{label}</span>
                      <span className="block text-xs text-ink-muted">{hint}</span>
                    </button>
                  )
                })}
              </div>
            </div>
            <div className="border-b border-line">
              <button type="button" onClick={() => setMode('upload')} className={tabClass('upload')}>
                Upload files
              </button>
              {!isMap && (
                <button type="button" data-testid="source-iiif" onClick={() => setMode('iiif')} className={tabClass('iiif')}>
                  IIIF
                </button>
              )}
              {isAdmin && (
                <button type="button" onClick={() => setMode('path')} className={tabClass('path')}>
                  Server path
                </button>
              )}
            </div>
            {mode === 'upload' ? (
              <div>
                <div
                  onDragOver={(e) => {
                    e.preventDefault()
                    setDragging(true)
                  }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={(e) => {
                    e.preventDefault()
                    setDragging(false)
                    addFiles(e.dataTransfer.files)
                  }}
                  onClick={() => inputRef.current?.click()}
                  className={`cursor-pointer rounded-md border-2 border-dashed p-6 text-center text-sm ${
                    dragging
                      ? 'border-accent bg-accent-wash text-accent-ink'
                      : 'border-line-strong text-ink-muted'
                  }`}
                >
                  {isMap
                    ? effectivePhases.tile
                      ? 'Drop full map images (TIFF/PNG) here or click to select'
                      : 'Drop map tiles (PNG/JPG) here or click to select'
                    : 'Drop images or PDFs here or click to select'}
                  {!isMap && (
                    <p className="mt-1 text-xs">
                      Also accepted: page transcriptions as .txt named like their image, any other .txt as a
                      corpus document, a .zip of scans, or a transcribed dataset as a .zip - PAGE XML, ALTO,
                      hOCR or TEI with their scans (Transkribus, eScriptorium, Tesseract), or a DeepLabel export
                    </p>
                  )}
                  <input
                    ref={inputRef}
                    type="file"
                    multiple
                    accept={isMap ? 'image/*' : 'image/*,application/pdf,.pdf,.txt,text/plain,.zip,application/zip'}
                    className="hidden"
                    onChange={(e) => {
                      addFiles(e.target.files)
                      e.target.value = ''
                    }}
                  />
                </div>
                {skipped > 0 && (
                  <p className="mt-2 text-sm text-warn">
                    Ignored {skipped} file{skipped === 1 ? '' : 's'} that {skipped === 1 ? 'is' : 'are'} not{' '}
                    {isMap ? 'an image' : 'an image or PDF'}.
                  </p>
                )}
                {files.length > 0 && (
                  <ul className="mt-2 max-h-48 divide-y divide-line overflow-y-auto rounded border border-line text-sm">
                    {files.map((f, i) => (
                      <li key={`${f.name}-${i}`} className="flex items-center justify-between px-2 py-1">
                        <span className="truncate text-ink">{f.name}</span>
                        <span className="ml-2 flex shrink-0 items-center gap-2 text-ink-subtle">
                          {humanBytes(f.size)}
                          <button
                            type="button"
                            aria-label={`Remove ${f.name}`}
                            title="Remove"
                            onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
                            className="rounded px-1 leading-none text-ink-muted hover:bg-ground hover:text-danger"
                          >
                            ×
                          </button>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {archive && (
                  <div
                    data-testid="import-notice"
                    className="mt-2 rounded border border-accent bg-accent-wash p-2 text-sm text-accent-ink"
                  >
                    <p>
                      <span className="font-medium">Zip archive.</span> A transcribed export - PAGE XML,
                      ALTO, hOCR, TEI or DeepLabel - is taken over as it is: no recognition runs, so it is
                      ready to review at once. A zip of scans alone is read like any other upload.
                    </p>
                    {otherFiles.length > 0 && (
                      <p data-testid="import-ignored" className="mt-1 text-warn">
                        Only {archive.name} is imported; left out: {otherFiles.join(', ')}.
                      </p>
                    )}
                    <label className="mt-2 flex items-center gap-1.5">
                      <input
                        type="checkbox"
                        data-testid="import-reviewed"
                        checked={importReviewed}
                        onChange={(e) => setImportReviewed(e.target.checked)}
                      />
                      The transcriptions are final (mark every line as reviewed)
                    </label>
                  </div>
                )}
                {!archive && pairedCount > 0 && (
                  <div className="mt-2 rounded border border-ok/40 bg-ok/10 p-2 text-sm text-ok">
                    <p data-testid="gt-pairing">
                      {readingOff
                        ? `Transcriptions found for ${pairingCount} - kept with their pages, to be matched to the recognized lines once the pages are read.`
                        : `Transcriptions found for ${pairingCount} - after reading, each transcription line is matched to the best-fitting recognized line and filled in as its correction.`}
                    </p>
                    {!readingOff && (<>
                    <label className="mt-2 flex items-center gap-1.5">
                      <input
                        type="checkbox"
                        data-testid="gt-autocheck"
                        checked={gtAutocheck}
                        onChange={(e) => setGtAutocheck(e.target.checked)}
                      />
                      Mark near-exact matches as reviewed right away
                    </label>
                    {gtAutocheck && (
                      <label className="mt-1.5 ml-5 flex items-start gap-1.5">
                        <input
                          type="checkbox"
                          data-testid="gt-ordered"
                          checked={gtOrdered}
                          onChange={(e) => setGtOrdered(e.target.checked)}
                          className="mt-1"
                        />
                        <span>
                          The transcription lists every line, in reading order
                          <span className="mt-0.5 block text-xs text-ok/80">
                            Then a match that follows that order is reviewed too, however poorly the
                            page was read - otherwise only lines the model already reads correctly
                            would ever count, and the hard ones would never reach training.
                          </span>
                        </span>
                      </label>
                    )}
                    </>)}
                  </div>
                )}
                {!archive && !isMap && corpusTexts.length > 0 && (
                  <div data-testid="corpus-documents" className="mt-2 rounded border border-line bg-ground p-2 text-sm text-ink">
                    <p>
                      {corpusTexts.length} text file{corpusTexts.length === 1 ? ' is' : 's are'} named after no
                      image and {corpusTexts.length === 1 ? 'is' : 'are'} kept as{' '}
                      {corpusTexts.length === 1 ? 'a corpus document' : 'corpus documents'}: whole-document
                      transcriptions, cut onto the pages they cover {readingOff ? 'once the pages are read' : 'after reading'}.
                      A .txt named after a PDF is one of these; one named after one of its pages, like
                      book_p0002.txt, transcribes that page.
                    </p>
                    <p className="mt-1 truncate text-xs text-ink-muted">{corpusTexts.map((f) => f.name).join(', ')}</p>
                  </div>
                )}
                {!archive && !isMap && pdfCount > 0 && (
                  <div className="mt-2 rounded border border-line bg-ground p-2 text-sm text-ink">
                    <label className="flex items-start gap-1.5">
                      <input
                        type="checkbox"
                        data-testid="gt-from-pdf"
                        checked={gtFromPdf}
                        onChange={(e) => setGtFromPdf(e.target.checked)}
                        className="mt-1"
                      />
                      <span>
                        Take the transcription from the text layer of the{' '}
                        {pdfCount === 1 ? 'PDF' : `${pdfCount} PDFs`}
                        <span className="mt-0.5 block text-xs text-ink-muted">
                          For born-digital PDFs, whose text is the real thing. A scanned PDF&rsquo;s text
                          layer is another OCR system&rsquo;s output, so taking it as ground truth would
                          train on machine guesses.
                        </span>
                      </span>
                    </label>
                  </div>
                )}
                {!archive && !isMap && readingOff && (texts.length > 0 || pdfCount > 0) && (
                  <p data-testid="reading-off" className="mt-2 text-sm text-warn">{READING_OFF}</p>
                )}
              </div>
            ) : mode === 'iiif' ? (
              <IiifSource value={iiif} onChange={(next) => {
                if (next.manifest !== iiif.manifest) setIiifExcluded(new Set())
                setIiif(next)
              }} />
            ) : (
              <div>
                <label htmlFor="server-path" className="mb-1 block text-sm font-medium text-ink">
                  Server directory (absolute path)
                </label>
                <input
                  id="server-path"
                  value={serverPath}
                  onChange={(e) => setServerPath(e.target.value)}
                  placeholder="/data/scans/volume-1"
                  className={`${inputClass} font-mono`}
                />
                <p className="mt-1 text-xs text-ink-muted">
                  A .txt next to an image with the same name is used as that page&rsquo;s transcription; any
                  other .txt is kept as a corpus document.
                </p>
                {!isMap && readingOff && (
                  <p data-testid="reading-off" className="mt-2 text-sm text-warn">{READING_OFF}</p>
                )}
                {!readingOff && (
                <label className="mt-2 flex items-center gap-1.5 text-sm text-ink">
                  <input
                    type="checkbox"
                    checked={gtAutocheck}
                    onChange={(e) => setGtAutocheck(e.target.checked)}
                  />
                  Mark near-exact transcription matches as reviewed right away
                </label>
                )}
                {!readingOff && gtAutocheck && (
                  <label className="mt-1.5 ml-5 flex items-start gap-1.5 text-sm text-ink">
                    <input
                      type="checkbox"
                      data-testid="gt-ordered-path"
                      checked={gtOrdered}
                      onChange={(e) => setGtOrdered(e.target.checked)}
                      className="mt-1"
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
                {!isMap && (
                  <label className="mt-2 flex items-start gap-1.5 text-sm text-ink">
                    <input
                      type="checkbox"
                      data-testid="gt-from-pdf-path"
                      checked={gtFromPdf}
                      onChange={(e) => setGtFromPdf(e.target.checked)}
                      className="mt-1"
                    />
                    <span>
                      Take the transcription from the text layer of ingested PDFs
                      <span className="mt-0.5 block text-xs text-ink-muted">
                        For born-digital PDFs only - a scanned PDF&rsquo;s text layer is another OCR
                        system&rsquo;s output, not ground truth.
                      </span>
                    </span>
                  </label>
                )}
              </div>
            )}
        </>)}
        {step === 'pages' && (manifest ? (
          <PagePicker items={canvasItems} excluded={iiifExcluded} unit="page" onExclude={setIiifExcluded}
                      onToggle={(key) => setIiifExcluded((held) => toggled(held, key))}
                      note="Thumbnails come from the archive's image server; the full images are downloaded when the dataset starts." />
        ) : (
          <PagePicker items={fileItems} excluded={excluded} onExclude={setExcluded}
                      onToggle={(file) => setExcluded((held) => toggled(held, file))}
                      note={pageFiles.some((f) => /\.pdf$/i.test(f.name))
                        ? "A PDF's pages are split once it is uploaded, so it is taken whole here." : undefined} />
        ))}
        {step === 'run' && (<>
            {!isMap && (
            /* An imported dataset is already segmented and transcribed, so every
               recognition choice below would be meaningless for it. */
            <div>
              <label className="mb-1 block text-sm font-medium text-ink">
                Pipeline phases
              </label>
              <div className="space-y-2">
                {PHASE_CHOICES.map(([key, label, hint]) => {
                  const locked = !granted(key)
                  const disabled = locked || (key === 'ocr' && !phases.lines)
                  const checked = key === 'ocr' ? phases.lines && phases.ocr : phases[key]
                  return (
                    <label
                      key={key}
                      data-testid="phase-choice"
                      data-phase={key}
                      className={`flex items-start gap-2.5 rounded border px-3 py-2 text-left text-sm ${
                        disabled
                          ? 'cursor-not-allowed border-line-strong opacity-40'
                          : checked
                            ? 'cursor-pointer border-accent bg-accent-wash'
                            : 'cursor-pointer border-line-strong'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={disabled}
                        onChange={() => togglePhase(key)}
                        className="mt-0.5"
                      />
                      <span>
                        <span className="block font-medium text-ink">{label}</span>
                        {locked ? (
                          <span data-testid={`phase-locked-${key}`} className="block text-xs text-ink-muted">
                            You have not been granted {label} - an admin can grant it on the Admin page.
                          </span>
                        ) : (
                          <span className="block text-xs text-ink-muted">{hint}</span>
                        )}
                      </span>
                    </label>
                  )
                })}
              </div>
            </div>
            )}
            {isMap && (
            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-sm font-medium text-ink">
                  Pre-processing
                </label>
                <label
                  className={`flex items-start gap-2.5 rounded border px-3 py-2 text-left text-sm ${
                    tileDisabled
                      ? 'cursor-not-allowed border-line-strong opacity-40'
                      : phases.tile
                        ? 'cursor-pointer border-accent bg-accent-wash'
                        : 'cursor-pointer border-line-strong'
                  }`}
                >
                  <input
                    type="checkbox"
                    data-testid="map-phase-tile"
                    checked={effectivePhases.tile}
                    disabled={tileDisabled}
                    onChange={() => togglePhase('tile')}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="block font-medium text-ink">Process map images into tiles</span>
                    <span className="block text-xs text-ink-muted" data-testid="map-phase-tile-hint">
                      {tileDisabled
                        ? mapRunner?.reason
                        : 'Cut each uploaded full-map scan into square tiles before ingest; images smaller than the tile size become one white-padded tile'}
                    </span>
                  </span>
                </label>
                {effectivePhases.tile && (
                  <div className="ml-6 mt-2 space-y-2">
                    <label className="flex items-center gap-2 text-sm text-ink">
                      Tile size
                      <input
                        type="number"
                        data-testid="tile-size"
                        min={TILE_SIZE_MIN} max={TILE_SIZE_MAX} step={1}
                        value={tileSizeDraft}
                        onChange={(e) => setTileSizeDraft(e.target.value)}
                        aria-invalid={!tileSizeValid}
                        className="w-24 rounded border border-line-strong bg-surface px-2 py-1 text-sm focus-visible:border-accent focus:outline-none"
                      />
                      px
                    </label>
                    <p className="text-xs text-ink-subtle">
                      {TILE_SIZE_MIN} to {TILE_SIZE_MAX} px square.
                      {selectedModel && ` The model reads each tile at full resolution, ${selectedModel.input_size} px at a time.`}
                    </p>
                    <label className="flex items-start gap-1.5 text-sm text-ink">
                      <input type="checkbox" checked={skipBlank} onChange={(e) => setSkipBlank(e.target.checked)} className="mt-0.5" />
                      <span>
                        Skip near-blank tiles
                        <span className="block text-xs text-ink-muted">
                          Drop tiles that are ≥97% flat paper or scan border
                        </span>
                      </span>
                    </label>
                  </div>
                )}
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-ink">
                  Map type / model
                </label>
                {mapModels === null ? (
                  <p className="text-xs text-ink-subtle">Loading models…</p>
                ) : mapModels.length === 0 ? (
                  <p className="text-xs text-ink-muted">
                    No model registry configured - the job uses the default class set; pre-annotation
                    falls back to the server checkpoint.
                  </p>
                ) : (
                  <>
                    <select
                      value={modelId}
                      onChange={(e) => setModelId(e.target.value)}
                      className="w-full rounded border border-line-strong bg-surface px-2 py-1.5 text-sm focus-visible:border-accent focus:outline-none"
                    >
                      {mapModels.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.label}{m.checkpoint_available ? '' : ' (checkpoint missing)'}
                        </option>
                      ))}
                    </select>
                    <p className="mt-1 text-xs text-ink-subtle">
                      {isLines
                        ? 'Supplies the checkpoint to pre-annotate with. Traced lines all share one class, "edge lines" - add more in the palette if you need to tell them apart.'
                        : 'Seeds the tile class vocabulary (editable per job afterwards).'}
                    </p>
                  </>
                )}
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-ink">
                  Pipeline phases
                </label>
                <label
                  className={`flex items-start gap-2.5 rounded border px-3 py-2 text-left text-sm ${
                    predictDisabled
                      ? 'cursor-not-allowed border-line-strong opacity-40'
                      : phases.predict
                        ? 'cursor-pointer border-accent bg-accent-wash'
                        : 'cursor-pointer border-line-strong'
                  }`}
                >
                  <input
                    type="checkbox"
                    data-testid="map-phase-predict"
                    checked={effectivePhases.predict}
                    disabled={predictDisabled}
                    onChange={() => togglePhase('predict')}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="block font-medium text-ink">Model pre-annotation</span>
                    <span className="block text-xs text-ink-muted" data-testid="map-phase-predict-hint">
                      {runnerMissing
                        ? mapRunner?.reason
                        : predictDisabled
                        ? 'The selected model has no checkpoint available on the server.'
                        : isLines
                          ? 'Run the pre-trained segmentation model over every tile and reduce each detected class surface to its outline, seeding editable lines'
                          : 'Run the pre-trained segmentation model over every tile to seed editable polygons'}
                    </span>
                  </span>
                </label>
              </div>
              {isLines && (
                <div>
                  <label htmlFor="line-width" className="mb-1 block text-sm font-medium text-ink">
                    Line width (export)
                  </label>
                  <input
                    id="line-width"
                    type="number" min={1} max={25} step={1} value={lineWidth}
                    onChange={(e) => setLineWidth(Math.min(25, Math.max(1, Number(e.target.value) || 1)))}
                    className="w-24 rounded border border-line-strong bg-surface px-2 py-1.5 text-sm focus-visible:border-accent focus:outline-none"
                  />
                  <p className="mt-1 text-xs text-ink-subtle">
                    Stroke width in pixels traced lines are rasterized with in the exported masks.
                    Changeable later; the sidecar always keeps the exact coordinates.
                  </p>
                </div>
              )}
            </div>
            )}
            {!isMap && phases.lines && !archive && (
              <div>
                <label className="mb-1 block text-sm font-medium text-ink">
                  Line detection
                </label>
                <div className="flex gap-2">
                  {LINE_MODE_CHOICES.map(([value, label, hint]) => {
                    const disabled = value === 'per_crop' && !phases.layout
                    return (
                      <button
                        key={value}
                        type="button"
                        disabled={disabled}
                        aria-pressed={effectiveLineMode === value}
                        data-testid="line-mode-option"
                        data-mode={value}
                        onClick={() => setLineMode(value)}
                        title={disabled ? NEEDS_LAYOUT : hint}
                        className={`flex-1 rounded border px-3 py-2 text-left text-sm ${
                          disabled
                            ? 'cursor-not-allowed border-line-strong opacity-40'
                            : effectiveLineMode === value
                              ? 'border-accent bg-accent-wash'
                              : 'border-line-strong'
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
              </div>
            )}
            {edit && !isMap && (<>
              <LayoutShapeChoice value={shape} saved={edit.layout_shape ?? 'box'} onChange={setShape} />
              {phases.layout && <LabelMapping jobId={edit.id} canEdit onError={setError} />}
              {(edit.counters.gt_total ?? 0) > 0 && (
                <AlignmentChoice autocheck={gtAutocheck} ordered={gtOrdered}
                                 onAutocheck={setGtAutocheck} onOrdered={setGtOrdered} />
              )}
            </>)}
            {!edit && !isMap && !archive && templates.length > 0 && (
              <div>
                <div className="mb-1 flex items-baseline justify-between gap-2">
                  <label className="block text-sm font-medium text-ink" htmlFor="layout-template">
                    Layout classes
                  </label>
                  <Link to="/templates" className="text-xs text-accent-ink hover:underline">Manage templates</Link>
                </div>
                <p className="mb-1.5 text-xs text-ink-muted">
                  The template the dataset's layout classes are copied from. They can be changed on the
                  dataset afterwards; changing the template later leaves this dataset as it is.
                </p>
                <select
                  id="layout-template"
                  data-testid="layout-template-choice"
                  value={templateId ?? ''}
                  onChange={(e) => setTemplateId(Number(e.target.value))}
                  className={inputClass}
                >
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>{t.name}{t.is_default ? ' (default)' : ''}</option>
                  ))}
                </select>
                {template && (
                  <p className="mt-1 text-xs text-ink-subtle" data-testid="layout-template-summary">
                    {template.classes.filter((c) => c.role === 'content').map((c) => c.name).join(', ')}
                    {template.classes.some((c) => c.role === 'container') && (
                      <> · containers: {template.classes.filter((c) => c.role === 'container').map((c) => c.name).join(', ')}</>
                    )}
                  </p>
                )}
              </div>
            )}
            {!isMap && phases.lines && !archive && (
              <div>
                <label className="mb-1 block text-sm font-medium text-ink" htmlFor="page-structure">
                  Page structure
                </label>
                <p className="mb-1.5 text-xs text-ink-muted">
                  What the lines of a page with no layout boxes are read in. Sorted by height
                  alone, two columns come out interleaved; saying how the volume is set puts
                  them in order. Changeable afterwards.
                </p>
                {orderSetBy && (
                  <p className="mb-1.5 text-xs text-ink-muted" data-testid="reading-order-set-by">
                    {`Set by the ${orderSetBy} template of this dataset's layout model: pages read top to bottom, as the Schematismus pipeline does.`}
                  </p>
                )}
                <select
                  id="page-structure"
                  data-testid="reading-order-choice"
                  disabled={!!orderSetBy}
                  value={structure}
                  onChange={(e) => setStructure(e.target.value)}
                  className={inputClass}
                >
                  {READING_ORDERS.map((value) => (
                    <option key={value} value={value}>{READING_ORDER_LABEL[value]}</option>
                  ))}
                </select>
              </div>
            )}
            {mode === 'upload' && !archive && !isMap && (
              <label className="flex items-start gap-1.5 text-sm text-ink">
                <input type="checkbox" data-testid="as-test" checked={asTest}
                       onChange={(e) => setAsTest(e.target.checked)} className="mt-1" />
                <span>
                  {edit ? 'Add new pages as test pages' : 'Add as test pages'}
                  <span className="block text-xs text-ink-muted">
                    {edit
                      ? 'Pages added from now on arrive as test data that no training uses. Pages already here keep their mark.'
                      : 'Test data that no training uses - for scoring models on. Pages added later follow.'}
                  </span>
                </span>
              </label>
            )}
        </>)}
        {step === 'models' && (<>
            {edit && reocrState !== null && reocrState.authors.length > 0 && (
              <p data-testid="ocr-provenance" className="text-xs text-ink-muted">
                Current text was read by{' '}
                {reocrState.authors.map((a) => `${readerName('ocr', a.author)} (${a.lines} lines)`).join(', ')}
                {reocrState.authors.length > 1 && ' - mixed provenance'}
              </p>
            )}
            {/* Text-pipeline models only; a map job picks its mapseg model above. */}
            {!isMap && (
            <div>
              <label className="mb-1 block text-sm font-medium text-ink">Models</label>
              <div className="flex flex-wrap gap-2">
                {(
                  [
                    ['layout', 'Layout', phases.layout],
                    ['lines', 'Lines', phases.lines],
                    ['ocr', 'OCR', phases.lines && phases.ocr],
                  ] as [ModelTask, string, boolean][]
                ).map(([task, label, enabled]) => (
                  <div key={task} className={`min-w-40 flex-1 ${enabled ? '' : 'opacity-40'}`}>
                    <label className="mb-0.5 block text-xs text-ink-muted" htmlFor={`new-model-${task}`}>
                      {label}
                    </label>
                    <select
                      id={`new-model-${task}`}
                      data-testid={`new-model-${task}`}
                      disabled={!enabled}
                      value={picks[task]}
                      onChange={(e) => setPicks((prev) => ({ ...prev, [task]: e.target.value }))}
                      className={inputClass}
                    >
                      <option value="">Default</option>
                      {models
                        .filter((m) => m.task === task && (!m.archived || m.id === Number(picks[task])))
                        .map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name}
                            {m.is_default ? ' (default)' : ''}
                            {m.archived ? ' (archived)' : ''}
                          </option>
                        ))}
                    </select>
                  </div>
                ))}
              </div>
            </div>
            )}
            {!isMap && phases.lines && phases.ocr && !archive && (
              <div>
                <label className="mb-1 block text-sm font-medium text-ink">
                  OCR decoding
                </label>
                <div className="flex gap-2">
                  {DECODE_CARDS.map(([value, label, hint]) => (
                    <button
                      key={value}
                      type="button"
                      data-testid={`ocr-decode-${value}`}
                      aria-pressed={ocrDecode === value}
                      onClick={() => setOcrDecode(value)}
                      className={`flex-1 rounded border px-3 py-2 text-left text-sm ${
                        ocrDecode === value
                          ? 'border-accent bg-accent-wash'
                          : 'border-line-strong'
                      }`}
                    >
                      <span className="block font-medium text-ink">{label}</span>
                      <span className="block text-xs text-ink-muted">{hint}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          {phases.lines && phases.ocr && (
            <ConventionFlags catalog={catalog} model={ocrModel} convention={convention}
                             onToggle={(flag) => setConvention((held) => toggledFlag(held, flag))}>
              {edit?.ocr_convention_read != null && (
                <p data-testid="convention-read" className="mt-1 text-xs text-ink-muted">
                  Last read {edit.ocr_convention_read.length === 0
                    ? 'normalized'
                    : `with ${edit.ocr_convention_read.map((flag) => conventionLabel(flag, catalog)).join(', ').toLowerCase()}`}.
                </p>
              )}
            </ConventionFlags>
          )}
          {edit && readers !== null && readers.length > 0 && (
            <LlmReaders readers={readers} chosen={readWith} keptInHouse={!dataUse.external_llm} onChange={setReadWith} />
          )}
        </>)}
        {step === 'review' && (<>
          <section ref={dataUseSection} data-testid="new-job-data-use" className="rounded-md border border-line bg-surface px-4 py-3">
            <h2 className="text-sm font-semibold text-ink">Data use</h2>
            <p className="text-xs text-ink-muted">
              {edit
                ? "What this dataset's pages and lines may be used for. It applies to everyone, you included."
                : "What this dataset's pages and lines may be used for. It applies to everyone, you included, and can be changed later in the dataset's settings."}
            </p>
            {edit
              ? <DataUseEditor jobId={edit.id} value={dataUse} onChange={setDataUse} />
              : <DataUseSwitches value={dataUse} onChange={setDataUse} />}
          </section>
          {canReread && (
            <label data-testid="settings-reread" className="flex items-start gap-2 rounded-md border border-line bg-surface px-4 py-3 text-sm text-ink">
              <input type="checkbox" checked={rereadNow} onChange={(e) => setRereadNow(e.target.checked)}
                     className="mt-1 cursor-pointer accent-accent" />
              <span>
                Re-read the {reocrState!.unchecked} unchecked line{reocrState!.unchecked === 1 ? '' : 's'} with the new
                OCR settings once saved
                <span className="block text-xs text-ink-muted">
                  {reocrState!.checked} checked line{reocrState!.checked === 1 ? '' : 's'} keep their text, and corrections
                  on unchecked lines are kept too - only the raw OCR text is replaced. Left off, the new settings apply to
                  future reading.
                </span>
              </span>
            </label>
          )}
          <NewJobSummary rows={summary} onEdit={setStep} full />
        </>)}
        {progress && <UploadProgress progress={progress} />}
        {error && <p className="text-sm text-danger">{error}</p>}
        {madeWithSkips && (
          <div className="space-y-2">
            <SkippedSymlinks paths={madeWithSkips.skipped} />
            <button
              type="button"
              onClick={() => navigate(`/jobs/${madeWithSkips.jobId}`)}
              className="rounded bg-accent px-4 py-1.5 text-sm font-medium text-on-accent hover:brightness-110"
            >
              Open the dataset
            </button>
          </div>
        )}
        <div className="flex items-center justify-between gap-3 border-t border-line pt-4">
          {previous ? (
            <button type="button" data-testid="wizard-back" onClick={() => setStep(previous)}
                    className="rounded border border-line-strong px-4 py-1.5 text-sm text-ink-muted hover:text-ink">
              Back
            </button>
          ) : <span />}
          <div className="text-right">
            {step === 'review' ? (
              <button
                type="submit"
                disabled={!canSubmit}
                className="rounded bg-accent px-4 py-1.5 text-sm font-medium text-on-accent hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {edit ? (busy ? 'Saving…' : 'Save settings') : busy ? 'Creating…' : archive ? 'Import dataset' : 'Create job'}
              </button>
            ) : (
              <button type="submit" data-testid="wizard-next" disabled={stepMissing[step] !== null}
                      className="rounded bg-accent px-4 py-1.5 text-sm font-medium text-on-accent hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40">
                Next: {next ? STEP_LABEL[next] : ''}
              </button>
            )}
            {(step === 'review' ? missing : stepMissing[step]) && !busy && (
              <p data-testid="wizard-missing" className="mt-1.5 text-xs text-warn">{step === 'review' ? missing : stepMissing[step]}</p>
            )}
          </div>
        </div>
      </form>
      {step !== 'review' && (
        <aside className="hidden lg:block">
          <NewJobSummary rows={summary} onEdit={editRow} />
        </aside>
      )}
      </div>
    </div>
  )
}
