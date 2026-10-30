import { Fragment, useEffect, useMemo, useState } from 'react'
import { useAuth } from '../../auth'
import {
  createTraining, getTrainingOptions, LINE_SHAPES, listAugmentPipelines, listGroups, listJobs, trainingPreview,
} from '../../api'
import type {
  AugmentPipeline, AugmentSpec, ClusterSession, Group, Job, LineShape, ModelTask, RegistryModel,
  LeftOut, SplitStrategy, Training, TrainingOptions, TrainingTargets, Tunable, TunableValue,
} from '../../api'
import { modalBtn, modalPrimaryBtn } from '../Modal'
import { DatasetPicker, datasetSections } from './DatasetPicker'
import { LeftOutNote } from '../ui/LeftOutNote'
import { Button } from '../ui/Button'
import { Hint } from '../ui/Hint'
import { AugmentOverlay } from './AugmentOverlay'
import { EMPTY_STACK, isEmptyStack } from '../augment/pipeline'
import { ClusterUnlock } from './ClusterUnlock'
import { useAutoClear } from '../../messages'
import { Textarea, controlClass } from '../ui/Field'
import { fieldValue, tunedValues } from './tunables'
import { PreflightPanel } from './PreflightReport'
import { usePreflight } from './usePreflight'
import type { PreflightRequest } from './usePreflight'

interface TrainFormProps {
  task: ModelTask
  models: RegistryModel[]
  targets: TrainingTargets
  gpuTypes: Record<string, number>
  // The run this one starts from: every field opens on what it was submitted with, so
  // trying it again on different hardware costs two clicks instead of retyping thirty knobs.
  from?: Training
  // Names a model of this task already carries, or an unfinished run is training under.
  takenNames: string[]
  onClose: () => void
  onStarted: () => void
}

const TASK_UNIT: Record<ModelTask, string> = {
  layout: 'layout-complete pages',
  lines: 'line-verified pages',
  ocr: 'checked lines',
}

const GPU_LABELS: Record<string, string> = {
  h200: 'H200',
  rtx6000bb: 'RTX 6000 Pro',
  l40s: 'L40S',
}

const inputClass = controlClass('md', 'w-full')
const labelClass = 'mb-1 block text-xs font-medium text-ink-muted'

// Knobs the dialog lays out by hand (the top row and the early-stop pair) rather than
// in their manifest group.
const HAND_RENDERED = new Set(['learning_rate', 'patience'])

const VAL_PERCENTS = ['5', '10', '15', '20', '30']
const LEFT_OUT_DEBOUNCE_MS = 300

/** The placeholder a blank field shows: the value the trainer will use, when declared. */
function formatDefault(value: TunableValue | null | undefined): string {
  if (value === null || value === undefined) return 'model default'
  if (typeof value === 'boolean') return value ? 'on' : 'off'
  return String(value)
}

/** A name no model and no unfinished run of this task holds yet. */
function freeName(base: string, taken: string[]): string {
  const stem = base.replace(/ rerun(?: \d+)?$/i, '')
  const used = new Set(taken.map((n) => n.trim().toLowerCase()))
  let candidate = `${stem} rerun`
  for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = `${stem} rerun ${n}`
  return candidate
}

/** The knobs a run was tuned with, as the fields hold them. The two the dialog lays out
 *  by hand keep their own state. */
function restoredKnobs(from: Training | undefined): Record<string, string> {
  const values: Record<string, string> = {}
  for (const [key, value] of Object.entries(from?.hyperparams ?? {})) {
    if (HAND_RENDERED.has(key)) continue
    values[key] = fieldValue(value)
  }
  return values
}

/** What the run actually trained with rather than what the pipeline it was named after
 *  says today: the stack was frozen at submit, and the rerun is only comparable if it
 *  stays frozen. The pipeline is named again only while its steps are still identical. */
function restoredAugmentation(from: Training, pipelines: AugmentPipeline[]):
    { choice: string; stack: AugmentSpec | null } {
  if (from.augmentation === null) return { choice: 'builtin', stack: null }
  const unchanged = pipelines.find(
    (p) => p.name === from.augmentation_name &&
      JSON.stringify(p.spec) === JSON.stringify(from.augmentation))
  if (unchanged) return { choice: String(unchanged.id), stack: null }
  return isEmptyStack(from.augmentation) ? { choice: 'none', stack: null }
    : { choice: 'custom', stack: from.augmentation }
}

/** The stored fraction as the split dropdown offers it. */
function restoredValPct(from: Training | undefined): string {
  const pct = String(Math.round((from?.val_fraction ?? 0.1) * 100))
  return VAL_PERCENTS.includes(pct) ? pct : '10'
}

function groupTunables(tunables: Tunable[]): { name: string; knobs: Tunable[] }[] {
  const groups: { name: string; knobs: Tunable[] }[] = []
  for (const knob of tunables) {
    if (HAND_RENDERED.has(knob.key)) continue
    const group = groups.find((g) => g.name === knob.group)
    if (group) group.knobs.push(knob)
    else groups.push({ name: knob.group, knobs: [knob] })
  }
  return groups
}

function TunableField({ knob, value, onChange }: {
  knob: Tunable
  value: string
  onChange: (value: string) => void
}) {
  const id = `training-knob-${knob.key}`
  const placeholder = formatDefault(knob.default)
  return (
    <div data-testid="tunable-field" data-tuned={value !== '' || undefined}>
      <div className="mb-1 flex items-center gap-1">
        <label className="block text-sm font-medium text-ink" htmlFor={id}>
          {knob.label}
        </label>
        <Hint text={knob.help} about={knob.label} />
      </div>
      {knob.kind === 'bool' ? (
        <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className={inputClass}>
          <option value="">Default ({placeholder})</option>
          <option value="on">On</option>
          <option value="off">Off</option>
        </select>
      ) : knob.kind === 'choice' ? (
        <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className={inputClass}>
          <option value="">Default ({placeholder})</option>
          {knob.choices.map((choice) => <option key={choice} value={choice}>{choice}</option>)}
        </select>
      ) : (
        <input
          id={id}
          className={inputClass}
          type="number"
          min={knob.min ?? knob.above ?? undefined}
          max={knob.max ?? undefined}
          step={knob.kind === 'int' ? 1 : 'any'}
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </div>
  )
}

export function TrainForm({ task, models, targets, gpuTypes, from, takenNames, onClose,
                              onStarted }: TrainFormProps) {
  const [name, setName] = useState(() => (from ? freeName(from.name, takenNames) : ''))
  const [description, setDescription] = useState(from?.description ?? '')
  const [jobs, setJobs] = useState<Job[] | null>(null)
  const [groups, setGroups] = useState<Group[]>([])
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [machineSettled, setMachineSettled] = useState<Record<string, number>>({})
  const [humanOnly, setHumanOnly] = useState(from?.human_checked_only ?? false)
  const [pages, setPages] = useState<Record<string, number>>({})
  const [humanCheckedPages, setHumanCheckedPages] = useState<Record<string, number>>({})
  const [leftOut, setLeftOut] = useState<LeftOut[]>([])
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(from?.dataset_job_ids ?? []))
  // Datasets the run trained on that this account cannot open, or that are gone.
  const [droppedDatasets, setDroppedDatasets] = useState(0)
  const defaultModel = models.find((m) => m.is_default)
  const restoredBase = from?.base_model_id ?? null
  const baseIsGone = restoredBase !== null && !models.some((m) => m.id === restoredBase)
  const [baseId, setBaseId] = useState<string>(() => {
    if (from) return restoredBase !== null && !baseIsGone ? String(restoredBase) : ''
    return defaultModel ? String(defaultModel.id) : ''
  })
  const [baseTouched, setBaseTouched] = useState(false)

  // The dialog can open before the models list resolves; adopt the task default
  // when it arrives unless the user already made a choice. A rerun never adopts it:
  // its blank base means the run it copies trained from scratch.
  useEffect(() => {
    if (!from && !baseTouched && baseId === '' && defaultModel) setBaseId(String(defaultModel.id))
  }, [from, baseTouched, baseId, defaultModel])
  const { isAdmin } = useAuth()
  const restoredTarget = from && targets[from.target] ? from.target : null
  // A run validated on datasets of its own has no field here that says it.
  const lostHoldout = !!from && from.split_strategy === 'holdout'
  const [target, setTarget] = useState<'local' | 'slurm'>(
    restoredTarget ?? (targets.local ? 'local' : 'slurm'))
  const [advanced, setAdvanced] = useState(!!from)
  const [epochs, setEpochs] = useState(from?.epochs ? String(from.epochs) : '')
  const [batchSize, setBatchSize] = useState(
    from && restoredTarget ? String(from.batch_size ?? '') : '')
  const [learningRate, setLearningRate] = useState(
    typeof from?.hyperparams.learning_rate === 'number' ? String(from.hyperparams.learning_rate) : '')
  const [earlyStop, setEarlyStop] = useState(typeof from?.hyperparams.patience === 'number')
  const [patience, setPatience] = useState(
    typeof from?.hyperparams.patience === 'number' ? String(from.hyperparams.patience) : '10')
  // Without a preference a run starts on the first card the deployment lists.
  const firstGpu = Object.keys(gpuTypes)[0] ?? ''
  const [gpuType, setGpuType] = useState(from?.gpu_type ?? firstGpu)
  // A rerun keeps its card; a new run follows the card its backend prefers until one is picked.
  const [gpuPicked, setGpuPicked] = useState(!!from?.gpu_type)
  const [gpuCount, setGpuCount] = useState(String(
    Math.min(from?.gpu_count ?? 2, gpuTypes[from?.gpu_type ?? ''] ?? Infinity)))
  const chooseGpu = (type: string) => {
    setGpuType(type)
    if (Number(gpuCount) > gpuTypes[type]) setGpuCount(String(gpuTypes[type]))
  }
  const [valPct, setValPct] = useState(from ? restoredValPct(from) : '10')
  const [strategy, setStrategy] = useState<SplitStrategy>(
    from && from.split_strategy !== 'holdout' ? from.split_strategy : 'uniform')
  const [testIds, setTestIds] = useState<string[]>(from?.test_job_ids ?? [])
  const [buildLm, setBuildLm] = useState(from?.build_lm ?? false)
  const [options, setOptions] = useState<TrainingOptions | null>(null)
  const [cannotTrain, setCannotTrain] = useState<string | null>(null)
  const lmOffered = options?.builds_lm ?? false
  // Blank follows the model's own default, which changes with the base model.
  const [lineShape, setLineShape] = useState<LineShape | ''>(from?.line_shape ?? '')
  const shownLineShape = lineShape || options?.line_shape || 'polygon'
  const [tuned, setTuned] = useState<Record<string, string>>(() => restoredKnobs(from))
  const [pipelines, setPipelines] = useState<AugmentPipeline[]>([])
  const [builtinStack, setBuiltinStack] = useState<AugmentSpec | null>(null)
  // 'builtin' leaves the train module's own stack, 'none' trains on clean crops, a number
  // is one of the caller's pipelines, 'custom' is the stack built in the overlay.
  const [augmentChoice, setAugmentChoice] = useState<string>('builtin')
  const [customStack, setCustomStack] = useState<AugmentSpec | null>(null)
  const [editingStack, setEditingStack] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useAutoClear(error, setError)
  const [busy, setBusy] = useState(false)
  const [reviewing, setReviewing] = useState(false)
  const [session, setSession] = useState<ClusterSession | null>(null)

  const clusterBlocked = target === 'slurm' && !!session?.enabled && !session.connected

  // The knobs and their defaults come from the model backend the run would train on; with
  // none, the form says why the run cannot train.
  useEffect(() => {
    getTrainingOptions(task, baseId ? Number(baseId) : null)
      .then((found) => {
        setOptions(found)
        setCannotTrain(null)
      })
      .catch((e: Error) => {
        setOptions(null)
        setCannotTrain(e.message)
      })
  }, [task, baseId])

  const preferredGpu = options?.preferred_gpu ?? null
  useEffect(() => {
    if (gpuPicked) return
    const card = preferredGpu && gpuTypes[preferredGpu] ? preferredGpu : firstGpu
    setGpuType(card)
    setGpuCount((count) => String(Math.min(Number(count), gpuTypes[card] ?? Infinity)))
  }, [preferredGpu, gpuPicked, gpuTypes, firstGpu])

  // Augmentation is optional throughout: if the pipelines cannot be listed the run still
  // starts, on the stack the train module carries.
  useEffect(() => {
    listAugmentPipelines(task)
      .then((res) => {
        setPipelines(res.pipelines)
        setBuiltinStack(res.builtin.spec)
        if (from) {
          const restored = restoredAugmentation(from, res.pipelines)
          setAugmentChoice(restored.choice)
          setCustomStack(restored.stack)
          return
        }
        const preferred = res.pipelines.find((p) => p.is_default)
        if (preferred) setAugmentChoice(String(preferred.id))
      })
      .catch(() => undefined)
  }, [task, from])

  useEffect(() => {
    // Groups are a nicety on top of the list: if they fail to load the datasets are
    // still all there, ungrouped.
    listGroups().then(setGroups).catch(() => undefined)
    listJobs()
      .then(async (rows) => {
        setJobs(rows)
        if (from) {
          const reachable = from.dataset_job_ids.filter((id) => rows.some((j) => j.id === id && j.data_use.training))
          setChosen(new Set(reachable))
          setDroppedDatasets(from.dataset_job_ids.length - reachable.length)
          setTestIds(from.test_job_ids.filter((id) => rows.some((j) => j.id === id && j.test_pages && j.data_use.test)))
        }
        if (rows.length) {
          const res = await trainingPreview(task, rows.map((j) => j.id))
          setCounts(res.counts)
          setMachineSettled(res.machine_settled ?? {})
          setPages(res.pages)
          setHumanCheckedPages(res.human_checked_pages)
        }
      })
      .catch((e: Error) => setError(e.message))
  }, [task, from])

  // The test-set dropdown groups by the same rule the picker does.
  const sections = useMemo(() => datasetSections(jobs, groups), [jobs, groups])
  // A dataset whose owner switched training off is not offered; the backend refuses it too.
  const trainable = useMemo(() => jobs?.filter((j) => j.data_use.training) ?? null, [jobs])
  const notTrainable = (jobs ?? []).filter((j) => !j.data_use.training).map((j) => j.name)

  const setMany = (ids: string[], on: boolean) =>
    setChosen((prev) => {
      const next = new Set(prev)
      for (const id of ids) {
        if (on) next.add(id)
        else next.delete(id)
      }
      return next
    })

  // Pages sharing a scan with test pages are left out of the selection; the dialog says
  // how many, and where their test pages are.
  useEffect(() => {
    if (chosen.size === 0) {
      setLeftOut([])
      return
    }
    // Asked once ticking settles, and only the newest answer is shown.
    let live = true
    const timer = window.setTimeout(() => {
      trainingPreview(task, [...chosen])
        .then((res) => { if (live) setLeftOut(res.left_out) })
        .catch(() => { if (live) setLeftOut([]) })
    }, LEFT_OUT_DEBOUNCE_MS)
    return () => {
      live = false
      window.clearTimeout(timer)
    }
  }, [task, chosen])

  const toggle = (id: string) => {
    setChosen((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const checkedInChosen = [...chosen].reduce((sum, id) => sum + (counts[id] ?? 0), 0)
  // Of those, what language models settled between themselves rather than a person.
  const settledInChosen = [...chosen].reduce((sum, id) => sum + (machineSettled[id] ?? 0), 0)
  const totalItems = humanOnly ? checkedInChosen - settledInChosen : checkedInChosen
  const trainPages = humanOnly ? humanCheckedPages : pages
  const epochsDefault = formatDefault(options?.columns.epochs)
  const lrDefault = formatDefault(options?.tunables.find((t) => t.key === 'learning_rate')?.default)
  const batchDefault = String(
    (target === 'local' ? options?.batch.local : options?.batch.cluster[gpuType]) ?? 'auto')
  const knobGroups = groupTunables(options?.tunables ?? [])
  const tunedCount = Object.values(tuned).filter((v) => v.trim() !== '').length
  const chosenPipeline = pipelines.find((p) => String(p.id) === augmentChoice)
  const stackLabel = augmentChoice === 'builtin' ? "the model's own"
    : augmentChoice === 'none' ? 'none'
    : augmentChoice === 'custom' ? 'custom' : chosenPipeline?.name ?? 'unknown'
  // What the overlay opens on: whatever the picker currently names.
  const stackToEdit = augmentChoice === 'custom' ? customStack
    : augmentChoice === 'none' ? EMPTY_STACK
    : chosenPipeline?.spec ?? builtinStack
  const setKnob = (key: string, value: string) => setTuned((prev) => ({ ...prev, [key]: value }))
  const totalPages = [...chosen].reduce((sum, id) => sum + (trainPages[id] ?? 0), 0)
  const testCandidates = (jobs ?? []).filter((j) => (j.test_pages ?? 0) > 0 && j.data_use.test)
  const allTestsChosen = testCandidates.length > 0 && testCandidates.every((j) => testIds.includes(j.id))
  const leftOutPages = leftOut.reduce((sum, row) => sum + row.pages, 0)
  const nameTaken = takenNames.some((n) => n.trim().toLowerCase() === name.trim().toLowerCase())
  // The stored batch was measured for the hardware that run used, so a rerun on other
  // hardware starts from that target's own default instead.
  const chooseTarget = (next: 'local' | 'slurm') => {
    setTarget(next)
    if (from) setBatchSize(next === from.target ? String(from.batch_size ?? '') : '')
  }
  const unknownKnobs = options && from
    ? Object.keys(from.hyperparams).filter((key) => !options.tunables.some((t) => t.key === key))
    : []
  // What a rerun could not carry over. Saying nothing would hand back a different run
  // under a name that claims otherwise.
  const restoreNotes = !from ? [] : [
    ...(droppedDatasets > 0
      ? [`${droppedDatasets} of its ${from.dataset_job_ids.length} datasets are not yours to open`]
      : []),
    ...(baseIsGone ? ['its base model is gone, so this one starts from scratch'] : []),
    ...(restoredTarget === null
      ? [`it ran on the ${from.target === 'slurm' ? 'cluster' : 'local GPU'}, which you may not submit to`]
      : []),
    ...(target !== from.target ? ['batch size is cleared, so the new target measures its own'] : []),
    ...(lostHoldout
      ? ['it validated on datasets of its own - a split is cut from the training data instead']
      : []),
    ...(unknownKnobs.length > 0
      ? [`${unknownKnobs.join(', ')} ${unknownKnobs.length === 1 ? 'is' : 'are'} no longer offered`]
      : []),
  ]
  // Mirrors the splitters: the split divides whole pages (never taking all of them),
  // per dataset for the stratified strategy - at least one of every dataset that has two -
  // over the union otherwise.
  const rankPick = (n: number, atLeastOne = false) => {
    const picked = Math.round((n * Number(valPct)) / 100)
    return Math.min(atLeastOne ? Math.max(picked, 1) : picked, Math.max(n - 1, 0))
  }
  const expectedValPages = strategy === 'stratified'
    ? [...chosen].reduce((sum, id) => sum + rankPick(trainPages[id] ?? 0, true), 0)
    : rankPick(totalPages)

  // What the run is made of and how it is shaped - everything but its labels - which is
  // also what the pre-flight reviews, so the review and the run cannot disagree.
  const settings: PreflightRequest = {
      task,
      dataset_job_ids: [...chosen],
      base_model_id: baseId === '' ? null : Number(baseId),
      target,
      epochs: epochs.trim() === '' ? null : Number(epochs),
      batch_size: batchSize.trim() === '' ? null : Number(batchSize),
      gpu_type: target === 'slurm' && gpuTypes[gpuType] ? gpuType : null,
      gpu_count: target === 'slurm' ? Number(gpuCount) : null,
      hyperparams: {
        ...tunedValues(options?.tunables ?? [], tuned),
        ...(learningRate.trim() === '' ? {} : { learning_rate: Number(learningRate) }),
        ...(earlyStop && patience.trim() !== '' ? { patience: Number(patience) } : {}),
      },
      val_fraction: Number(valPct) / 100,
      split_strategy: strategy,
      valid_job_ids: [],
      test_job_ids: testIds,
      build_lm: lmOffered && buildLm,
      human_checked_only: humanOnly,
      ...(task === 'lines' ? { line_shape: lineShape || null } : {}),
      augmentation_pipeline_id: chosenPipeline ? chosenPipeline.id : null,
      augmentation: augmentChoice === 'custom' ? customStack
        : augmentChoice === 'none' ? EMPTY_STACK
        : null,
  }
  const reviewed = usePreflight(reviewing ? settings : null)

  const start = async () => {
    setBusy(true)
    setError(null)
    try {
      await createTraining({
        ...settings,
        name: name.trim(),
        description: description.trim() === '' ? null : description.trim(),
        preflight_id: reviewed.id,
      })
      onClose()
      onStarted()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const errorLine = error && (
    <p data-testid="dialog-error" className="mb-1 text-sm text-danger">
      {error}
    </p>
  )

  if (reviewing) {
    return (
      <div data-testid="training-review">
        <div className="mb-1 flex items-center gap-1">
          <h2 className="text-sm font-medium text-ink">Pre-flight</h2>
          <Hint about="the pre-flight"
                text="A review of exactly what this run would train on. It only warns - Train starts the run whatever it finds." />
        </div>
        <div className="mb-3">
          <PreflightPanel preflight={reviewed.preflight} pending={reviewed.pending} />
        </div>
        {errorLine}
        <div className="mt-2 flex items-center justify-between">
          <span className="text-xs text-ink-muted">
            {name.trim()} - {totalItems} {TASK_UNIT[task]}
          </span>
          <div className="flex gap-2">
            <button disabled={busy} onClick={() => setReviewing(false)} className={`${modalBtn} disabled:opacity-40`}>
              Back
            </button>
            <button disabled={busy || clusterBlocked} onClick={start} className={`${modalPrimaryBtn} disabled:opacity-40`}>
              {busy ? 'Starting…' : 'Train'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <>
      {restoreNotes.length > 0 && (
        <p
          data-testid="rerun-notes"
          className="mb-3 rounded border border-warn/40 bg-warn/10 px-2 py-1.5 text-xs text-warn"
        >
          Settings taken from "{from?.name}", except: {restoreNotes.join('; ')}.
        </p>
      )}
      {/* Wide enough for two columns: what the run is made of on the left, what it is
          measured and shaped by on the right. */}
      <div className="grid gap-x-4 md:grid-cols-2">
        <div>
        <label className={labelClass} htmlFor="training-name">
          Model name
        </label>
        <input id="training-name" autoFocus value={name} onChange={(e) => setName(e.target.value)}
               className={`${inputClass} ${nameTaken ? 'mb-1' : 'mb-3'}`} />
        {nameTaken && (
          <p data-testid="name-taken" className="mb-3 text-xs text-danger">
            A {task} model, archived or not, or an unfinished run already has this name.
          </p>
        )}

        <label className={labelClass} htmlFor="training-description">
          Description
        </label>
        <Textarea
          size="md"
          id="training-description"
          rows={2}
          placeholder="optional - shown on the model card"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="mb-3 w-full resize-none"
        />

        <div className="mb-1 text-sm font-medium text-ink">Datasets</div>
        <p className="mb-1 text-xs text-ink-muted">
          Only {TASK_UNIT[task]} are used; the snapshot is frozen when the training starts.
        </p>
        <DatasetPicker
          jobs={trainable}
          groups={groups}
          counts={counts}
          chosen={chosen}
          onToggle={toggle}
          onSetMany={setMany}
        />
        {notTrainable.length > 0 && (
          <LeftOutNote data-testid="not-trainable" className="mt-1.5" names={notTrainable}
                       reason={`as ${notTrainable.length === 1 ? 'its owner does' : 'their owners do'} not allow training`} />
        )}

        </div>

        <div>
        <fieldset data-testid="training-test-sets" className="relative">
        <legend className={labelClass}>Test sets</legend>
        {testCandidates.length > 1 && (
          <button type="button" data-testid="test-sets-select-all"
                  onClick={() => setTestIds(allTestsChosen ? [] : testCandidates.map((j) => j.id))}
                  className="absolute right-0 top-0 text-xs font-medium text-accent-ink hover:underline">
            {allTestsChosen ? 'Clear all' : 'Select all'}
          </button>
        )}
        <p className="mb-1 text-xs text-ink-muted">
          Optional - the test pages of datasets, never trained on and scored with the base
          and the new model once the training finishes.
        </p>
        {testCandidates.length === 0 ? (
          <p className="mb-3 text-xs text-ink-subtle">No dataset has test pages yet.</p>
        ) : (
          <div className={`mb-3 max-h-48 overflow-y-auto rounded border border-line-strong py-1`}>
            {sections.map((section) => {
              const options = section.jobs.filter((j) => testCandidates.includes(j))
              if (options.length === 0) return null
              return (
                <Fragment key={section.key}>
                  {section.label && (
                    <div className="px-2 pt-1 text-[10px] uppercase tracking-wide text-ink-subtle">{section.label}</div>
                  )}
                  {options.map((job) => (
                    <label key={job.id} className="flex cursor-pointer items-center gap-2 px-2 py-0.5 text-sm hover:bg-raised">
                      <input type="checkbox" className="accent-accent"
                             checked={testIds.includes(job.id)}
                             onChange={(e) => setTestIds((ids) =>
                               e.target.checked ? [...ids, job.id] : ids.filter((id) => id !== job.id))} />
                      <span className="min-w-0 flex-1 truncate">{job.name}</span>
                      <span className="shrink-0 text-xs text-ink-muted">
                        {job.test_pages} test page{job.test_pages === 1 ? '' : 's'}
                      </span>
                    </label>
                  ))}
                </Fragment>
              )
            })}
          </div>
        )}
        </fieldset>
        {settledInChosen > 0 && (
          <label className="mb-3 flex items-start gap-1.5 text-xs text-ink-muted">
            <input
              type="checkbox"
              data-testid="human-checked-only"
              checked={humanOnly}
              onChange={(e) => setHumanOnly(e.target.checked)}
              className="mt-0.5 cursor-pointer accent-accent"
            />
            <span>
              Train only on lines a person verified
              <span className="block text-[11px] text-ink-muted" data-testid="settled-count">
                {settledInChosen} of {checkedInChosen} checked lines were settled by models, not people.
              </span>
            </span>
          </label>
        )}
        {lmOffered && (
        <label className="mb-3 flex items-start gap-1.5 text-xs text-ink-muted">
          <input
            type="checkbox"
            data-testid="build-lm"
            checked={buildLm}
            onChange={(e) => setBuildLm(e.target.checked)}
            className="mt-0.5 cursor-pointer accent-accent"
          />
          <span>
            Fit a language model to this material
            <span className="block text-[11px] text-ink-muted">
              The shipped one is built from every corpus at once, which costs accuracy on a hand
              it was not built for. Beam search then uses this run's own text instead.
            </span>
          </span>
        </label>
        )}

        <label className={labelClass} htmlFor="training-base">
          Base model
        </label>
        <select
          id="training-base"
          value={baseId}
          onChange={(e) => {
            setBaseTouched(true)
            setBaseId(e.target.value)
          }}
          className={`${inputClass} mb-3`}
        >
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              Fine-tune {m.name}
            </option>
          ))}
          <option value="">From scratch</option>
        </select>

        {task === 'lines' && (
          <>
            <div className="mb-1 flex items-center gap-1">
              <label className="block text-sm font-medium text-ink" htmlFor="training-line-shape">
                Line shape
              </label>
              <Hint text="What each checked line is turned into before the model learns it. A detector that shrinks every line to a core, as PP-OCRv6 does, needs an outline it can shrink in one piece."
                    about="line shape" />
            </div>
            <select
              id="training-line-shape"
              data-testid="line-shape"
              value={shownLineShape}
              onChange={(e) => setLineShape(e.target.value as LineShape)}
              className={`${inputClass} mb-3`}
            >
              {LINE_SHAPES.map((shape) => (
                <option key={shape.id} value={shape.id}>
                  {shape.label} - {shape.hint}{shape.id === options?.line_shape ? ' (this model\'s default)' : ''}
                </option>
              ))}
            </select>
          </>
        )}

        {targets.slurm && (
          <div className="mb-3 flex items-center gap-4 text-sm">
            <label
              className={`flex items-center gap-1.5 ${targets.local ? 'cursor-pointer' : 'cursor-default opacity-50'}`}
              title={targets.local ? '' : 'An admin has not granted you the local GPU'}
            >
              <input type="radio" checked={target === 'local'} disabled={!targets.local}
                     onChange={() => chooseTarget('local')}
                     className="cursor-pointer accent-accent disabled:cursor-default" />
              Local GPU
            </label>
            <label className="flex cursor-pointer items-center gap-1.5">
              <input type="radio" checked={target === 'slurm'} onChange={() => chooseTarget('slurm')}
                     className="cursor-pointer accent-accent" />
              Cluster (SLURM)
              <span
                data-testid="cluster-experimental"
                className="rounded bg-warn/10 px-1.5 py-0.5 text-[11px] font-medium text-warn"
              >
                highly experimental
              </span>
            </label>
          </div>
        )}

        {target === 'slurm' && (
          <div className="mb-3">
            {/* Answering the cluster's second factor needs the admin's own code, so a
                granted member sees the session state but never the connect step. */}
            <ClusterUnlock autoStart={isAdmin} canUnlock={isAdmin} onStatus={setSession} />
          </div>
        )}

        <div className="mb-1 flex items-center gap-1">
          <label className="block text-sm font-medium text-ink" htmlFor="training-augment">
            Augmentation
          </label>
          <Hint text={`What the ${task === 'ocr' ? 'line crops' : 'pages'} are put through before the model sees them, every epoch.`}
                about="augmentation" />
        </div>
        <div className="mb-3 flex gap-2">
          <select
            id="training-augment"
            className={inputClass}
            value={augmentChoice}
            onChange={(e) => setAugmentChoice(e.target.value)}
          >
            <option value="builtin">Model default (the stack {task.toUpperCase()} training carries)</option>
            {pipelines.map((pipeline) => (
              <option key={pipeline.id} value={String(pipeline.id)}>
                {pipeline.name}
                {pipeline.is_default ? ' (default)' : ''}
              </option>
            ))}
            <option value="none">None - train on the crops as scanned</option>
            {customStack && <option value="custom">Custom (built for this run)</option>}
          </select>
          <Button variant="ghost" size="sm" data-testid="customise-augmentation" onClick={() => setEditingStack(true)}>
            Customise…
          </Button>
        </div>

        </div>
      </div>

      {cannotTrain && (
        <p data-testid="cannot-train" className="mb-3 text-xs text-warn">
          This run cannot train: {cannotTrain}.
        </p>
      )}
      <button
        type="button"
        data-testid="advanced-toggle"
        aria-expanded={advanced}
        onClick={() => setAdvanced((v) => !v)}
        className="mb-2 flex items-center gap-1 text-sm font-medium text-ink-muted hover:text-ink"
      >
        <span className="text-xs">{advanced ? '▾' : '▸'}</span> Advanced options
        {tunedCount > 0 && (
          <span data-testid="tuned-count" className="font-normal text-ink-muted">
            · {tunedCount} tuned
          </span>
        )}
      </button>
      {advanced && (
        <div className="mb-3 rounded border border-line p-3">
          {options && (
            <p data-testid="trains-on-backend" className="mb-3 text-xs text-ink-muted">
              Trains on model backend "{options.backend}", with the settings it offers.
            </p>
          )}
          <div className="mb-3 grid grid-cols-3 gap-3">
            <div>
              <label className={labelClass} htmlFor="training-epochs">
                Epochs
              </label>
              <input
                id="training-epochs"
                className={inputClass}
                type="number"
                min={1}
                placeholder={epochsDefault}
                value={epochs}
                onChange={(e) => setEpochs(e.target.value)}
              />
            </div>
            <div className="flex-1">
              <label className={labelClass} htmlFor="training-batch">
                Batch size
              </label>
              <input
                id="training-batch"
                className={inputClass}
                type="number"
                min={1}
                // A local run gets one card, so it starts from a batch that fits it
                // rather than the model's own default; a cluster run from its card's.
                placeholder={batchDefault}
                value={batchSize}
                onChange={(e) => setBatchSize(e.target.value)}
              />
            </div>
            <div className="flex-1">
              <label className={labelClass} htmlFor="training-lr">
                Learning rate
              </label>
              <input
                id="training-lr"
                className={inputClass}
                type="number"
                min={0}
                step="any"
                placeholder={lrDefault}
                value={learningRate}
                onChange={(e) => setLearningRate(e.target.value)}
              />
            </div>
          </div>
          <div className="mb-3 flex items-end gap-3">
            <div className="flex-1">
              <div className="flex items-center gap-1">
                <label className="flex items-center gap-1.5 text-sm font-medium text-ink">
                  <input
                    type="checkbox"
                    data-testid="early-stop-toggle"
                    checked={earlyStop}
                    onChange={(e) => setEarlyStop(e.target.checked)}
                  />
                  Early stop
                </label>
                <Hint text={`Stop when the validation ${task === 'ocr' ? 'CER' : 'score'} has not improved for the given number of epochs.`}
                      about="early stop" />
              </div>
            </div>
            <div className="flex-1">
              <label className={labelClass} htmlFor="training-patience">
                Patience
              </label>
              <input
                id="training-patience"
                type="number"
                min={1}
                step={1}
                disabled={!earlyStop}
                value={patience}
                onChange={(e) => setPatience(e.target.value)}
                className={`${inputClass} disabled:opacity-40`}
              />
            </div>
          </div>
          {target === 'slurm' && Object.keys(gpuTypes).length > 0 && (
            <div className="mb-3 flex gap-3">
              <div className="flex-1">
                <label className={labelClass} htmlFor="training-gpu-type">
                  GPU type
                </label>
                <select
                  id="training-gpu-type"
                  className={inputClass}
                  value={gpuType}
                  onChange={(e) => {
                    setGpuPicked(true)
                    chooseGpu(e.target.value)
                  }}
                >
                  {Object.entries(gpuTypes).map(([type, max]) => (
                    <option key={type} value={type}>
                      {GPU_LABELS[type] ?? type} (up to {max})
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex-1">
                <label className={labelClass} htmlFor="training-gpu-count">
                  GPUs
                </label>
                <select
                  id="training-gpu-count"
                  className={inputClass}
                  value={gpuCount}
                  onChange={(e) => setGpuCount(e.target.value)}
                >
                  {Array.from({ length: gpuTypes[gpuType] ?? 1 }, (_, i) => i + 1).map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}
          <div className="flex gap-3">
            <div className="flex-1">
              <label className={labelClass} htmlFor="training-strategy">
                Validation data
              </label>
              <select
                id="training-strategy"
                className={inputClass}
                value={strategy}
                onChange={(e) => setStrategy(e.target.value as SplitStrategy)}
              >
                <option value="uniform">Random split</option>
                <option value="stratified">Split within each dataset</option>
              </select>
            </div>
            <div className="flex-1">
              <label className={labelClass} htmlFor="training-val">
                Validation split
              </label>
              <select id="training-val" value={valPct} onChange={(e) => setValPct(e.target.value)} className={inputClass}>
                {VAL_PERCENTS.map((p) => (
                  <option key={p} value={p}>
                    {p}%
                  </option>
                ))}
              </select>
            </div>
          </div>
          {/* Every other knob the train module exposes, grouped as the manifest groups
              them. Blank means the trainer's own default, which the placeholder names. */}
          {knobGroups.map((group) => {
            const tunedHere = group.knobs.filter((k) => (tuned[k.key] ?? '').trim() !== '').length
            return (
              <details key={group.name} data-testid="knob-group" data-group={group.name} className="mt-3">
                <summary className="cursor-pointer text-sm font-medium text-ink">
                  {group.name}
                  {tunedHere > 0 && (
                    <span className="ml-1 font-normal text-ink-muted">· {tunedHere} tuned</span>
                  )}
                </summary>
                <div className="mt-2 grid grid-cols-2 gap-3">
                  {group.knobs.map((knob) => (
                    <TunableField
                      key={knob.key}
                      knob={knob}
                      value={tuned[knob.key] ?? ''}
                      onChange={(value) => setKnob(knob.key, value)}
                    />
                  ))}
                </div>
              </details>
            )
          })}
        </div>
      )}

      <p data-testid="submit-summary" className="mb-1 text-xs text-ink-muted">
        Will run with:{' '}
        {[
          `${epochs.trim() || epochsDefault} epochs`,
          `batch ${batchSize.trim() || batchDefault}`,
          `lr ${learningRate.trim() || lrDefault}`,
          earlyStop ? `early stop after ${patience.trim() || '10'}` : 'no early stop',
          `${valPct}% ${strategy === 'uniform' ? 'random' : 'per-dataset'} validation split`,
          ...(testIds.length ? [`test: ${testIds.map((id) => jobs?.find((j) => j.id === id)?.name ?? '').join(', ')}`] : []),
          ...(target === 'slurm' ? [`${gpuCount}x ${GPU_LABELS[gpuType] ?? gpuType}`] : []),
          `augmentation: ${stackLabel}`,
          ...(tunedCount > 0 ? [`${tunedCount} more knob${tunedCount === 1 ? '' : 's'} tuned`] : []),
        ].join(' · ')}
      </p>
      {totalItems > 0 && expectedValPages < 1 && (
        <p data-testid="empty-val-warning" className="mb-1 text-xs text-warn">
          At {valPct}% none of the {totalPages} eligible page{totalPages === 1 ? '' : 's'} would
          land in validation - the baseline/result comparison would be skipped.
        </p>
      )}
      {leftOutPages > 0 && (
        <p data-testid="left-out-notice" className="mb-1 text-xs text-ink-muted">
          {leftOutPages} page{leftOutPages === 1 ? '' : 's'} left out: same scan as test pages
          in {leftOut.map((row) => row.name).join(', ')}
        </p>
      )}
      {errorLine}
      <div className="mt-2 flex items-center justify-between">
        <span className="text-xs text-ink-muted">
          {totalItems} {TASK_UNIT[task]} selected
        </span>
        <div className="flex gap-2">
          <button onClick={onClose} className={modalBtn}>
            Cancel
          </button>
          <button
            disabled={busy || !name.trim() || nameTaken || chosen.size === 0 || totalItems === 0
                      || clusterBlocked}
            onClick={() => setReviewing(true)}
            className={`${modalPrimaryBtn} disabled:opacity-40`}
          >
            Next
          </button>
        </div>
      </div>
      {editingStack && (
        <AugmentOverlay
          task={task}
          spec={stackToEdit}
          jobIds={[...chosen]}
          onClose={() => setEditingStack(false)}
          onUse={(spec) => {
            setCustomStack(spec)
            setAugmentChoice('custom')
            setEditingStack(false)
          }}
        />
      )}
    </>
  )
}
