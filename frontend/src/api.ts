export type JobStatus = 'uploading' | 'queued' | 'running' | 'done' | 'error' | 'cancelled'
export type Phase = 'ingest' | 'layout' | 'lines' | 'ocr' | 'predict' | 'tile'
export type ExportFormat = 'json' | 'md' | 'txt' | 'zip'
export type Task = 'text' | 'map_segmentation' | 'map_lines'

// Both map tasks annotate tiles: same ingest/tiling/classes/export machinery, same
// editor and routes. Polygon-vs-line differences key on Region.kind, not on the task.
export const isTileTask = (task: Task) => task !== 'text'

export interface Counters {
  pages_total: number
  pages_ingested: number
  pages_layout_done: number
  elements_total: number
  elements_lines_done: number
  lines_total: number
  lines_ocr_done: number
  pages_predicted?: number
  maps_total?: number
  maps_tiled?: number
  tile_positions_total?: number
  tile_positions_done?: number
  gt_total?: number
  gt_matched?: number
}

export type OcrConvention = Record<string, boolean>

/** A shared remark on a dataset or a page, and who last wrote it when. */
export interface Note {
  text: string
  by: string
  at: string
}

export interface Job {
  id: string
  name: string
  owner: string
  status: JobStatus
  phase: Phase | null
  counters: Counters
  created_at: string
  model_layout_id: number | null
  model_lines_id: number | null
  model_ocr_id: number | null
  ocr_decode: OcrDecode
  /** The transcription-convention flags this dataset asks its OCR model for. */
  ocr_convention?: OcrConvention
  /** The flags the last OCR run could honour; null before any run recorded them. */
  ocr_convention_read?: string[] | null
  /** Whether layout elements are boxes or outlines. */
  layout_shape?: LayoutShape
  /** Language models this dataset is read with, and how its agreement is settled. */
  llm_model_ids?: number[]
  llm_consensus_min?: number
  llm_autocheck?: boolean
  /** Whether the local OCR model counts as one of the voices above. Off by default: on a
   *  dataset training that model, letting it confirm its own targets approves the mistakes
   *  it already makes. */
  llm_consensus_with_ocr?: boolean
  /** Wording of this dataset's own, which replaces the models'. Empty uses theirs. */
  llm_prompt?: string
  error: string | null
  checked: boolean
  auto_redetect: boolean
  task: Task
  run_layout: boolean
  run_lines: boolean
  run_ocr: boolean
  /** Where line detection looks: 'per_crop' inside each layout box, 'per_page' across the
   *  whole scan. Meaningless without line detection, and forced to per_page without layout. */
  line_mode: string
  /** How the pages are laid out, for ordering the lines of a page with no layout boxes. */
  reading_order: string
  /** Dataset detail only: the template of its layout model, where that template reads top
   *  to bottom and so sets the order instead of `reading_order`. */
  reading_order_template?: string | null
  /** Whether alignment checks matched lines off, and whether the transcription lists every
   *  line in reading order so that a match following that order counts too. */
  gt_autocheck: boolean
  gt_ordered: boolean
  run_predict: boolean
  model_id: string | null
  run_tile: boolean
  tile_size: number
  line_width: number
  group_id: number | null
  shared_with: string[]
  pages_total?: number
  layout_checked_pages?: number
  /** Pages marked as test data, which no training uses. */
  test_pages?: number
  /** Whether pages added from now on arrive as test pages. */
  new_pages_test?: boolean
  note?: Note | null
  lines_total?: number
  lines_done?: number
  /** When a person last touched it - the pipeline's own passes do not count. Absent on a
   *  dataset nobody has worked on yet, which is why Recent can be shorter than it looks. */
  last_activity?: string
}

export interface Group {
  id: number
  name: string
  owner: string
  shared_with: string[]
  /** Datasets in it the caller can see. Absent on an older backend. */
  count?: number
}

export interface PageSummary {
  id: number
  idx: number
  filename: string
  width: number | null
  height: number | null
  status: string
  layout_checked: boolean
  lines_checked: boolean
  deleted: boolean
  /** Test data: never trained on, and what a run's test set is scored on. */
  is_test?: boolean
  note?: Note | null
  /** Degrees the scan has been turned since it arrived. Renditions are served immutable,
   *  so a turned page's pictures are asked for under this. Absent from the dataset
   *  detail's own page list, which the table falls back to on an older backend only. */
  rotation?: number
  min_confidence: number | null
  avg_confidence: number | null
  elements_total: number
  elements_checked: number
  /** Live lines on the page and how many are checked, whatever element holds them. A
   *  dataset that skipped layout keeps them all in one orphan bucket the element counts
   *  above exclude, so these are what its review progress is read from. */
  lines_total: number
  lines_reviewed: number
  /** Language models holding a reading of this page - what the LLM chip counts. */
  llm_models?: number
  regions_total?: number
  regions_checked?: number
}

/** A duplicate or an unreadable scan: never rendered, nothing to review, counted nowhere. */
export function isUncounted(page: { status: string }): boolean {
  return page.status === 'duplicate' || page.status === 'unreadable'
}

export interface UnreadablePage {
  id: number
  filename: string
  error: string
}

export interface JobDetail extends Job {
  pages: PageSummary[]
  /** Pages that are not deleted, always present so a caller without the list can count. */
  pages_live?: number
  pages_checked: number
  /** Pages whose scan ingest could not read, each with the reason - counted nowhere. */
  unreadable?: UnreadablePage[]
  /** A map job's live tiles, leaving out duplicates - nothing can be done to those. */
  tiles_total?: number
  tiles_annotated?: number
  tiles_reviewed?: number
}

/** 'start' starts the pages over under the dataset's own settings: the boxes go as for a
 *  layout re-run, but layout stays as it is set, so with it off lines span the whole page. */
export type RerunPhase = 'layout' | 'start' | 'lines' | 'ocr' | 'align'

export interface RerunPreview {
  lines: number
  corrected: number
  checked: number
  layout_checked: number
  elements_edited: number
}

export interface ConfBand {
  x0: number
  x1: number
  c: number
}

export interface Line {
  id: number
  order_idx: number
  polygon: [number, number][]
  text: string | null
  corrected_text: string | null
  /** Who wrote `corrected_text`: a person's name, or a machine author such as
   *  `llm:consensus@2` or `align:gt@0.95` (see isMachineAuthor). Null when there is no
   *  correction, or when it was written before the author was kept. */
  corrected_by: string | null
  confidence: number | null
  /** Per-character confidence bands. `x0`/`x1` are fractions of the line width, from the
   *  CTC alignment, so a band sits over the ink it describes. Rows written before
   *  alignment landed carry the legacy `number[]`, drawn with even spacing. */
  conf_profile: ConfBand[] | number[] | null
  orientation: number // loupe deskew override, degrees (0/90/180/270)
  needs_ocr: boolean // geometry changed; awaiting the batched re-OCR
  checked: boolean
  /** Who settled it: null or 'human' for a person, 'align' for a matched transcription,
   *  'llm' for language models agreeing among themselves. */
  check_source: 'human' | 'align' | 'llm' | null
  /** Which model read `text`, so that read can be offered back under its name. */
  text_author: string
  /** How many distinct language models read this line the same way. */
  llm_agree_count: number
  /** How the server cuts this line's crop. Part of the crop URL, so a change to the way
   *  crops are cut cannot go on being served from a browser cache. */
  crop_recipe: string
  /** Newest revision logged for this row (0 if none); sent back with an edit to detect a clash. */
  revision: number
}

export type Bbox = [number, number, number, number]

export interface PageElement {
  id: number
  order_idx: number
  class_name: string
  raw_class_name: string | null
  bbox: Bbox
  conf: number | null
  kind: 'content' | 'container' | 'orphan'
  checked: boolean
  /** The element's outline, kept once its dataset has used polygon elements; its bbox is
   *  then the outline's bounds. Drawn and edited only while the dataset is in polygon mode. */
  polygon: Ring | null
  lines: Line[]
  revision: number
}

import type { Ring } from './lib/geometry/core'
export type { Ring }

export interface MapClass {
  id: number
  name: string
  color: [number, number, number]
  priority: number
  regions?: number // live region count job-wide (from the per-job classes endpoint)
}

export interface MapModel {
  id: string
  label: string
  checkpoint_available: boolean
  // The square window the model reads; prediction slides it over each tile.
  input_size: number
  classes: MapClass[]
}

// Whether this deployment can cut maps into tiles and pre-annotate them, and if not, why.
export interface MapRunner {
  available: boolean
  reason: string | null
}

export const TILE_SIZE_MIN = 256
export const TILE_SIZE_MAX = 4096

// An edge detector offered by the tile editor's area-detect tool. `params` is the method's
// parameter schema, carried for a future settings UI; today the server runs its defaults.
export interface EdgeMethod {
  id: string
  label: string
  available: boolean
  params: Record<string, { default: unknown; [k: string]: unknown }>
}

export type RegionKind = 'polygon' | 'polyline'

export interface Region {
  id: number
  order_idx: number
  class_id: number
  class_name: string
  points: Ring
  // Always empty for a polyline (an open traced line has no interior to punch).
  holes: Ring[]
  kind: RegionKind
  checked: boolean
  revision: number
}

export interface PageDetail {
  id: number
  idx: number
  filename: string
  width: number
  height: number
  layout_checked: boolean
  lines_checked: boolean
  /** Test data: never trained on, nor any page with the same scan. */
  is_test: boolean
  note: Note | null
  /** How far the scan has been turned, 0/90/180/270. */
  rotation: number
  elements: PageElement[]
  regions?: Region[]
  /** How the lines of a page with no layout boxes are ordered: this page's own answer,
   *  null when it follows the dataset's, which is the one beside it. */
  reading_order: string | null
  job_reading_order: string
  /** The template of the dataset's layout model, where it reads top to bottom and so sets
   *  the order instead of the page's or the dataset's setting. */
  reading_order_template: string | null
  /** The dataset's newest revision when this was loaded: where a live view starts listening. */
  job_revision: number
  /** Which models produced what is on the page, and how much people have since done by hand. */
  provenance?: PageProvenance
}

export interface ProvenanceModel {
  id: number
  /** Null when the model has since been deleted. */
  name: string | null
  /** The first characters of the weights' sha256, null until they are in the weight store. */
  hash: string | null
}

export interface PageProvenance {
  layout: (ProvenanceModel & { at: string | null }) | null
  lines: (ProvenanceModel & { at: string | null }) | null
  lines_total: number
  lines_by_hand: number
  /** One entry per model that read lines on this page, the largest share first; a null
   *  model is text no model on record read (imported, or read before this was kept). */
  ocr: { model: ProvenanceModel | null; lines: number; at: string | null }[]
  ocr_corrected: number
}

/** How a volume is laid out, in the order the controls offer it. `auto` works each page
 *  out from the channels its lines leave; the rest are leaves by columns. */
export const READING_ORDERS = ['auto', '1x1', '1x2', '1x3', '2x1', '2x2', '2x3'] as const

export const READING_ORDER_LABEL: Record<string, string> = {
  auto: 'Work it out per page',
  '1x1': 'Single page, one column',
  '1x2': 'Single page, two columns',
  '1x3': 'Single page, three columns',
  '2x1': 'Double page, one column each',
  '2x2': 'Double page, two columns each',
  '2x3': 'Double page, three columns each',
}

/** One revision that touched the open page, streamed from pageEventsUrl. */
export type RevisionAction = 'create' | 'update' | 'delete' | 'check' | 'origin' | 'revert'

export interface PageChange {
  revision: number
  kind: 'line' | 'element' | 'region' | 'page'
  id: number
  author: string
  action: RevisionAction
  /** The tab that wrote it (CLIENT_ID); null for scripts and runners. */
  client: string | null
}

/** The revisions one write logged - what the editor hands back to take that write back. */
export interface EditSpan {
  from: number
  to: number
}

export type Spanned<T> = T & { span: EditSpan }

/** What a revert reached, as it now stands: the client replaces these wholesale. A line
 *  that went comes back through its element's list, or drops out of it. */
export interface RevertResult {
  elements: PageElement[]
  regions: Region[]
  removed_elements: number[]
  removed_regions: number[]
  span: EditSpan
  reading_order: string | null
}

export interface PageChangeEvent {
  revision: number
  changes: PageChange[]
}

/** The 409 body when an edit carried a stale revision: who saved since, and the row as it stands. */
export interface ConflictDetail<T> {
  code: 'conflict'
  message: string
  author: string | null
  changed_at: string | null
  revision: number
  current: T
}

export interface Revision {
  id: number
  author: string
  action: RevisionAction
  created_at: string
  snapshot: Record<string, unknown>
}

export interface ReviewLine {
  id: number
  page_id: number
  page_idx: number
  confidence: number
  /** Sent here from an evaluation page; queued checked or not until a person checks it. */
  flagged: boolean
}

export interface ReviewQueue {
  max_conf: number
  total: number
  lines: ReviewLine[]
}

export interface QueueEntry {
  kind: 'dataset' | 'training' | 'evaluation'
  id: string | number
  name: string
  owner: string
  status: string
  phase: string | null
  created_at: string
  /** When it last joined the queue - its creation, unless it was run again since. */
  queued_at: string
  /** When it last left the queue; null while it waits. */
  started_at: string | null
  /** Datasets only: false when the viewer cannot open it (its name is redacted too). */
  accessible?: boolean
  /** Datasets only: just what draws the progress bar, so nothing more leaks to whoever
   *  cannot open the dataset. */
  job?: Pick<Job, 'status' | 'counters' | 'run_layout' | 'run_lines' | 'run_ocr' | 'run_predict' | 'run_tile'>
  training?: {
    task: ModelTask
    target: 'local' | 'slurm'
    epochs: number | null
    progress_last: ProgressPoint | null
    snapshot_progress: { done: number; total: number } | null
  }
}

export interface PendingReocr {
  /** Total lines flagged for a re-read that the batcher's next sweep will pick up. */
  lines: number
  datasets: { id: string; name: string; lines: number; accessible: boolean }[]
  /** Seconds until that sweep; null while the batcher has not started. */
  next_pass_in: number | null
}

export interface QueueState {
  gpu: { running: QueueEntry | null; queued: QueueEntry[] }
  cluster: QueueEntry[]
  pending_reocr: PendingReocr | null
}

export interface JobEvent {
  status: JobStatus
  phase: Phase | null
  counters: Counters
}

export type LineMode = 'per_crop' | 'per_page'

// Which pipeline phases a new job runs. OCR needs line polygons, so the server
// coerces ocr to false when lines is false.
export interface Phases {
  layout: boolean
  lines: boolean
  ocr: boolean
  predict: boolean
  tile: boolean
}

// Raw CTC output or the full beam-search-plus-LM/decoder rescoring path.
export type OcrDecode = 'beam' | 'rescored' | 'greedy'

// Per-task model picks for a job; null means the task default.
export interface ModelPicks {
  layout: number | null
  lines: number | null
  ocr: number | null
}

export type Role = 'admin' | 'member' | 'viewer'

export type ModelTask = 'layout' | 'lines' | 'ocr'

/** One of a model's files as DeepLabel's weight store holds it, by content. */
export interface ModelFile {
  role: 'weights' | 'lm' | 'lm_dict' | 'config'
  filename: string
  sha256: string
  size: number
}

export interface RegistryModel {
  id: number
  task: ModelTask
  name: string
  source: 'builtin' | 'backend' | 'trained' | 'imported'
  checkpoint: string
  trained_from: number | null
  metrics: Record<string, unknown> | null
  notes: string | null
  is_default: boolean
  archived: boolean
  lm_path: string | null
  lm_dict_path: string | null
  /** What the model resizes a line crop to before reading it. Null until an OCR run has
   *  loaded this checkpoint and said so - nothing on the API side can open one to ask. */
  target_height: number | null
  max_width: number | null
  /** The convention flags an OCR model is conditioned on. Null until a run has loaded it. */
  conventions: string[] | null
  /** The family's own name, set on its root; null when it is called after the root. */
  family_name: string | null
  /** A layout model's template, whose reading order the datasets it reads follow. */
  layout_template_id: number | null
  /** The model this one is the new version of; datasets on that one are offered this one. */
  supersedes: number | null
  /** The model backend it is read on, or null while no configured backend serves it. */
  runs_on?: string | null
  owner: string | null
  /** Empty until the model's files are in the weight store (python -m app.weights). */
  files: ModelFile[]
  created_at: string
}

export type TrainingStatus = 'queued' | 'preparing' | 'running' | 'done' | 'error' | 'cancelled'

export interface Training {
  id: number
  task: ModelTask
  name: string
  owner: string
  base_model_id: number | null
  target: 'local' | 'slurm'
  status: TrainingStatus
  phase: string | null
  error: string | null
  dataset_job_ids: string[]
  valid_job_ids: string[]
  split_strategy: SplitStrategy
  test_job_ids: string[]
  /** Whether this run fits a language model to its own ground truth. */
  build_lm: boolean
  /** How this run's own language model build went, once it has. */
  lm_build: 'built' | 'failed' | null
  human_checked_only: boolean
  /** What a lines run trains each line as; null for the other tasks. */
  line_shape: LineShape | null
  /** The augmentation stack this run froze at submit; null left the trainer's own. */
  augmentation: AugmentSpec | null
  /** The pipeline it came from, empty when it was built for this run alone. */
  augmentation_name: string
  epochs: number | null
  description: string | null
  /** Per GPU. With grad_accum_steps and the GPU count it makes the effective batch. */
  batch_size: number | null
  /** Set where the model backend declares the effective batch its rates were tuned at. */
  grad_accum_steps: number | null
  /** The factor on the trainer's learning rates once more GPUs outgrow that batch. */
  lr_scale: number | null
  /** What the backend's out-of-memory fallback trained at instead of what was asked. */
  batch_fallback: { asked: BatchSetting; trained: BatchSetting } | null
  /** How often the cluster run was resubmitted from its checkpoint after the time limit. */
  resumes: number
  /** The metrics its backend declared; null for a run trained before runs trained on backends. */
  metric_info: MetricInfo[] | null
  gpu_type: string | null
  gpu_count: number | null
  val_fraction: number
  hyperparams: Record<string, TunableValue>
  snapshot_counts: Record<string, number> | null
  /** How much of the snapshot is cut, while it is being cut. */
  snapshot_progress: { done: number; total: number } | null
  metrics: Record<string, unknown> | null
  model_id: number | null
  progress_last: ProgressPoint | null
  /** The statistics reviewed before the run started; null for runs from before them. */
  preflight_id: number | null
  created_at: string
}

/** How a model backend describes one metric it reports (MODEL-BACKENDS.md 6.9). A `*` in
 *  the key matches many - one per class - and `{}` in the label is what it matched. */
export interface MetricInfo {
  key: string
  label?: string
  unit?: 'fraction' | 'number' | 'gb' | 'seconds' | 'per_second'
  better?: 'higher' | 'lower'
  headline?: boolean
  detail?: boolean
}

/** A layout or lines run's last word: the trained model reading the
 *  validation pages through its backend, scored overall, per dataset and, for layout,
 *  per class. */
export interface FinalEvaluation {
  metric: string
  overall: Record<string, number> & { by_class?: Record<string, { AP50: number; instances: number }> }
  by_dataset: Record<string, Record<string, number>>
  error?: string
}

/** A layout or lines run's test datasets, read once trained by the new
 *  model and by the base it started from; no base where the run started from scratch. */
export interface TestEvaluation {
  trained: FinalEvaluation
  base?: FinalEvaluation
}

export interface BatchSetting {
  batch_size: number
  grad_accum_steps: number
}

export interface ProgressPoint {
  epoch?: number
  /** The optimiser step the point was written at, when the trainer reports one. */
  step?: number
  loss?: number
  cer?: number
  best_cer?: number
  /** Unix seconds when the trainer wrote the point; optional in the contract. */
  ts?: number
  /** Validation CER per dataset (keyed by job id), when the valid split spans several. */
  cer_by_dataset?: Record<string, number>
}

export type EvaluationStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled'

export interface Evaluation {
  id: number
  model_id: number
  training_id: number | null
  source: { snapshot?: number; jobs?: string[] }
  /** What was scored, named and redacted server-side; absent on a create response. */
  source_label?: string
  /** Per-dataset scores when the material spans several datasets; names resolved server-side. */
  breakdown?: { job_id: string; name: string; cer: number; wer: number; lines: number }[] | null
  decode: OcrDecode
  status: EvaluationStatus
  error: string | null
  cer: number | null
  wer: number | null
  line_count: number | null
  owner: string
  created_at: string
}

export type SplitStrategy = 'uniform' | 'stratified' | 'holdout'

export interface TrainingTargets {
  local: boolean
  slurm: boolean
}

export interface AppUser {
  id: number
  subject: string
  username: string
  email: string
  display_name: string
  role: Role
  active: number
  /** Training is granted per person and per target; admins always have both. */
  train_local: number
  train_cluster: number
  /** What this person may ask for: their role's set with their own exceptions applied. */
  capabilities: string[]
  /** Only the exceptions - a capability missing here is whatever the role says. */
  permissions: Record<string, boolean>
  /** SLURM account this person's cluster jobs are charged to; empty means the default. */
  slurm_account: string
  created_at: string
  /** Null until the first login. */
  last_login_at: string | null
  /** When the account was last used. A session outlives a login by weeks, so this is
   *  what "last seen" means; null until the next request after the column arrived. */
  last_seen_at: string | null
  /** Live browser sessions and unexpired API tokens. */
  sessions: number
  tokens: number
  /** Expired tokens, which stay listed until revoked and are counted apart. */
  expired_tokens: number
}

export interface UserAuditEntry {
  id: number
  actor: string
  field: string
  old_value: string
  new_value: string
  created_at: string
}

export type DatasetAccess = 'owner' | 'shared' | 'group'

export interface ContributorAccess {
  datasets: { id: string; name: string; task: Task; access: DatasetAccess }[]
  groups: { id: number; name: string; access: Exclude<DatasetAccess, 'group'> }[]
}

export interface EditCounts {
  lines: number
  elements: number
  regions: number
}

export interface ContributorActivity {
  days: number
  totals: EditCounts & { revisions: number; first_at: string | null; last_at: string | null }
  daily: { day: string; revisions: number }[]
  /** name is null once the dataset has been deleted; its revisions outlive it. */
  datasets: (EditCounts & { id: string; name: string | null; last_at: string })[]
}

export type KeyboardMode = 'auto' | 'show' | 'hide'

export interface PageOverlays {
  layout: boolean
  lines: boolean
  labels: boolean
  confidence: boolean
  order: boolean
}

/** Where the character keyboard's keys come from: the ones you picked, or whatever this
 *  dataset writes that a keyboard cannot type. */
export type KeyboardSource = 'own' | 'dataset'

export interface AppSettings {
  hotkeys: Record<string, string>
  keyboard: string[]
  keyboard_mode: KeyboardMode
  /** Broadcast which dataset and page this browser has open. */
  share_activity: boolean
  /** Show where other people are: avatars on datasets and pages, banners in the editors. */
  show_activity: boolean
  keyboard_source: KeyboardSource
  /** Which overlays the page viewer starts with. Toggling one in the viewer is for that
   *  session only; this is what a freshly opened page shows. */
  page_overlays: PageOverlays
  /** Groups folded shut on the dataset list, by id and 'ungrouped'. Kept with the account
   *  rather than the browser, so a list tidied on one machine opens tidy on the next. */
  collapsed_groups: (number | 'ungrouped')[]
  /** How much of the transcript page the scan takes, as a fraction of the pane. Kept with
   *  the account: how wide a scan wants to be is a property of the volume being read, not
   *  of the machine it is read on. */
  transcript_split: number
  /** Whether the transcript opens with the strip of every page's scan along the foot. */
  transcript_filmstrip: boolean
}

export type PresenceTargetKind = 'line' | 'element' | 'region'

export interface PresenceLocation {
  job_id?: string
  page_id?: number
  target?: { kind: PresenceTargetKind; id: number } | null
  editing?: boolean
}

/** One open browser tab of one person. */
export interface PresenceEntry {
  username: string
  tab: string
  seen_seconds_ago: number
  job_id: string | null
  job_name: string | null
  job_task: Task | null
  page_id: number | null
  page_idx: number | null
  target: { kind: PresenceTargetKind; id: number } | null
  editing: boolean
  /** False when the person is inside a dataset you cannot open: the place is withheld. */
  accessible: boolean
}

export interface PurgeManifest {
  pages: number
  bytes: number
  files: number
  external_sources: number
  pairs_written?: number
}

export interface StaleLines {
  elements: number
  pages: number
  corrected: number
  hand_edited: number
}

function errorMessage(status: number, body: string, fallback: string): string {
  try {
    const detail = JSON.parse(body)?.detail
    if (typeof detail === 'string') return detail
  } catch {
    /* not json */
  }
  return `${fallback}: ${status}`
}

// A failed call, with the status and the parsed `detail` kept for callers that act on
// them (a 409 conflict carries the other person's version). The message alone still
// reads well for the many places that just show it.
export class ApiError extends Error {
  readonly status: number
  readonly detail: unknown

  constructor(message: string, status: number, detail: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.detail = detail
  }
}

function parsedDetail(body: string): unknown {
  try {
    return JSON.parse(body)?.detail
  } catch {
    return undefined
  }
}

/** The conflict behind a failed edit, or null when it failed for any other reason. */
export function conflictOf<T>(error: unknown): ConflictDetail<T> | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null
  const detail = error.detail as Partial<ConflictDetail<T>> | undefined
  return detail?.code === 'conflict' ? (detail as ConflictDetail<T>) : null
}

// Shared failure path for every fetch here.
async function failed<T>(res: Response, what: string): Promise<T> {
  // Not authenticated: bounce to the login handshake and stall the caller while
  // the page navigates away (never resolve, so no error flashes first).
  if (res.status === 401) {
    window.location.href = '/api/login'
    return new Promise<T>(() => undefined)
  }
  const body = await res.text()
  const detail = parsedDetail(body)
  const message = typeof detail === 'object' && detail !== null && 'message' in detail && typeof detail.message === 'string'
    ? detail.message
    : errorMessage(res.status, body, what)
  throw new ApiError(message, res.status, detail)
}

/** This tab, as the revisions its writes log name it: the live feed skips only its own
 *  echo, so the same person's other tabs still hear every edit. getRandomValues rather
 *  than randomUUID, which a plain-http deployment does not have. */
export const CLIENT_ID = Array.from(crypto.getRandomValues(new Uint8Array(16)),
                                    (byte) => byte.toString(16).padStart(2, '0')).join('')

export async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  headers.set('X-Client-Id', CLIENT_ID)
  const res = await fetch(url, { ...init, headers })
  if (!res.ok) return failed<T>(res, `${init?.method ?? 'GET'} ${url} failed`)
  return res.json() as Promise<T>
}

const FILENAME_RE = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i

/**
 * Download a file the app can still report on. A plain `<a href>` to an API route is a
 * document navigation: when the server answers with an error instead of a file, the
 * browser replaces the whole SPA with that response — the user is thrown out of the app
 * and there is nothing left to show the message in. Fetching it keeps a failure a normal
 * rejected promise, and the blob reaches the disk by the same anchor click.
 */
export async function downloadFile(url: string, fallbackName: string): Promise<void> {
  const res = await fetch(url)
  if (!res.ok) return failed<void>(res, `GET ${url} failed`)
  const name = FILENAME_RE.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? fallbackName
  const href = URL.createObjectURL(await res.blob())
  const a = document.createElement('a')
  a.href = href
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Revoking in the same tick cancels the download in some browsers - the click only
  // queues it.
  setTimeout(() => URL.revokeObjectURL(href), 0)
}

export const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

function uploadForm<T>(url: string, form: FormData, onProgress: (loaded: number, total: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', url)
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded, e.total)
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(JSON.parse(xhr.responseText))
      else reject(new Error(errorMessage(xhr.status, xhr.responseText, `POST ${url} failed`)))
    }
    xhr.onerror = () => reject(new Error(`POST ${url} failed: network error`))
    xhr.send(form)
  })
}

export interface ApiToken {
  id: number
  user_id: number
  name: string
  prefix: string
  readonly: boolean
  created_at: string
  last_used_at: string | null
  expires_at: string | null
  /** Past its expiry: refused by the API, listed until revoked. */
  expired: boolean
  username: string
}

export function listApiTokens(): Promise<{ tokens: ApiToken[] }> {
  return request('/api/tokens')
}

/** The plaintext token comes back exactly once - only its hash is stored. */
export function createApiToken(body: {
  name: string
  readonly: boolean
  expires_days: number | null
}): Promise<ApiToken & { token: string }> {
  return request('/api/tokens', json('POST', body))
}

export function deleteApiToken(id: number): Promise<{ ok: boolean }> {
  return request(`/api/tokens/${id}`, { method: 'DELETE' })
}

export function listJobs(): Promise<Job[]> {
  return request('/api/jobs')
}

/** A dataset asked for without its page list. Everything read off that list - how many
 *  pages are checked, how many are live - is still answered, so a caller that reads the
 *  table from listPageRows never needs it. */
export type JobWithoutPages = Omit<JobDetail, 'pages'> & { pages?: undefined }

/** One dataset. `pages: false` leaves the page list out; on the largest dataset here
 *  that list is 10 MB of JSON the page table no longer renders in one go. */
export function getJob(jobId: string): Promise<JobDetail>
export function getJob(jobId: string, opts: { pages: false }): Promise<JobWithoutPages>
export function getJob(jobId: string, opts?: { pages: false }) {
  return request(`/api/jobs/${jobId}${opts?.pages === false ? '?pages=false' : ''}`)
}

export interface DatasetInfo {
  owner: string
  created_at: string
  task: Task
  line_mode: string
  group: string | null
  shared_with: string[]
  pages: number
  pages_deleted: number
  /** Uploads of a scan the dataset already holds: listed, never counted as pages. */
  pages_duplicate: number
  documents: number
  images: number
  maps: number
  transcriptions: number
  elements: number
  lines: number
  lines_checked: number
  regions: number
  regions_checked: number
  disk_bytes: number
  /** Bytes per top-level directory of the dataset, e.g. uploads, renditions, crops. */
  disk: Record<string, number>
  editors: { author: string; edits: number; last_at: string }[]
  models: { layout: string | null; lines: string | null; ocr: string | null }
}

export function datasetInfo(jobId: string): Promise<DatasetInfo> {
  return request(`/api/jobs/${jobId}/info`)
}

export function getPage(jobId: string, pageId: number | string): Promise<PageDetail> {
  return request(`/api/jobs/${jobId}/pages/${pageId}`)
}

export function getQueue(): Promise<QueueState> {
  return request('/api/queue')
}

export function getReviewQueue(jobId: string, maxConf: number): Promise<ReviewQueue> {
  return request(`/api/jobs/${jobId}/review?max_conf=${maxConf}`)
}

export function startJob(jobId: string): Promise<{ ok: boolean }> {
  return request(`/api/jobs/${jobId}/start`, { method: 'POST' })
}

export function cancelJob(jobId: string): Promise<{ ok: boolean }> {
  return request(`/api/jobs/${jobId}/cancel`, { method: 'POST' })
}

export async function deleteJob(jobId: string): Promise<void> {
  await request(`/api/jobs/${jobId}`, { method: 'DELETE' })
}

export function uploadJob(
  name: string,
  files: File[],
  lineMode: LineMode,
  phases: Phases,
  task: Task,
  onProgress: (loaded: number, total: number) => void,
  modelId?: string | null,
  tileSize = 512,
  skipBlank = true,
  lineWidth = 3,
  models?: ModelPicks,
  ocrDecode?: OcrDecode,
  gtAutocheck?: boolean,
  gtOrdered?: boolean,
  gtFromPdf?: boolean,
  readingOrder = 'auto',
  layoutTemplateId?: number | null,
  asTest = false,
): Promise<{ job_id: string }> {
  const form = new FormData()
  if (asTest) form.append('as_test', 'true')
  form.append('name', name)
  form.append('line_mode', lineMode)
  form.append('page_reading_order', readingOrder)
  form.append('task', task)
  form.append('run_layout', String(phases.layout))
  form.append('run_lines', String(phases.lines))
  form.append('run_ocr', String(phases.ocr))
  form.append('run_predict', String(phases.predict))
  form.append('run_tile', String(phases.tile))
  form.append('tile_size', String(tileSize))
  form.append('tile_skip_blank', String(skipBlank))
  form.append('line_width', String(lineWidth))
  if (modelId) form.append('model_id', modelId)
  if (models?.layout != null) form.append('model_layout_id', String(models.layout))
  if (models?.lines != null) form.append('model_lines_id', String(models.lines))
  if (models?.ocr != null) form.append('model_ocr_id', String(models.ocr))
  if (ocrDecode) form.append('ocr_decode', ocrDecode)
  if (gtAutocheck) form.append('gt_autocheck', 'true')
  if (gtOrdered) form.append('gt_ordered', 'true')
  if (gtFromPdf) form.append('gt_from_pdf', 'true')
  if (layoutTemplateId != null) form.append('layout_template_id', String(layoutTemplateId))
  for (const file of files) form.append('files', file)
  return uploadForm('/api/jobs', form, onProgress)
}

export function importJob(
  name: string,
  file: File,
  reviewed: boolean,
  onProgress: (loaded: number, total: number) => void,
): Promise<{ job_id: string; format: string; pages: number; lines: number }> {
  const form = new FormData()
  form.append('name', name)
  form.append('reviewed', String(reviewed))
  form.append('file', file)
  return uploadForm('/api/jobs/import', form, onProgress)
}

export function createJobFromPath(
  name: string,
  serverPath: string,
  lineMode: LineMode,
  phases: Phases,
  task: Task = 'text',
  modelId?: string | null,
  tileSize = 512,
  skipBlank = true,
  lineWidth = 3,
  models?: ModelPicks,
  ocrDecode?: OcrDecode,
  gtAutocheck?: boolean,
  gtOrdered?: boolean,
  gtFromPdf?: boolean,
  readingOrder = 'auto',
  layoutTemplateId?: number | null,
): Promise<{ job_id: string; skipped_symlinks: string[] }> {
  return request('/api/jobs/path', json('POST', {
    name,
    server_path: serverPath,
    line_mode: lineMode,
    page_reading_order: readingOrder,
    task,
    model_id: modelId ?? null,
    run_layout: phases.layout,
    run_lines: phases.lines,
    run_ocr: phases.ocr,
    run_predict: phases.predict,
    run_tile: phases.tile,
    tile_size: tileSize,
    tile_skip_blank: skipBlank,
    line_width: lineWidth,
    model_layout_id: models?.layout ?? null,
    model_lines_id: models?.lines ?? null,
    model_ocr_id: models?.ocr ?? null,
    ocr_decode: ocrDecode ?? 'beam',
    gt_autocheck: gtAutocheck ?? false,
    gt_ordered: gtOrdered ?? false,
    gt_from_pdf: gtFromPdf ?? false,
    layout_template_id: layoutTemplateId ?? null,
  }))
}

export function uploadPages(
  jobId: string,
  files: File[],
  onProgress: (loaded: number, total: number) => void,
  asTest?: boolean,
): Promise<{ added: number }> {
  const form = new FormData()
  if (asTest !== undefined) form.append('as_test', String(asTest))
  for (const file of files) form.append('files', file)
  return uploadForm(`/api/jobs/${jobId}/pages/upload`, form, onProgress)
}

export function addPagesFromPath(
  jobId: string,
  serverPath: string,
): Promise<{ added: number; skipped_symlinks: string[] }> {
  return request(`/api/jobs/${jobId}/pages/path`, json('POST', { server_path: serverPath }))
}

export function rerunPreview(jobId: string): Promise<RerunPreview> {
  return request(`/api/jobs/${jobId}/rerun`)
}

/** `keepChecked` spares the lines somebody has read from an OCR re-run; `keepText`
 *  puts the text of the lines a detection replaces into the pool, to be re-offered on
 *  whatever it finds. Both default to the careful answer, as they do on the server. */
export function rerunJob(
  jobId: string, fromPhase: RerunPhase, force = false,
  opts: { keepChecked?: boolean; keepText?: boolean } = {},
): Promise<{ ok: boolean }> {
  return request(`/api/jobs/${jobId}/rerun`, json('POST', {
    from_phase: fromPhase, force,
    keep_checked: opts.keepChecked ?? true,
    keep_text: opts.keepText ?? true,
  }))
}

export interface RepredictScope {
  tiles: number
  regions_discard: number
  regions_kept: number
  reviewed: number
}

export function repredictPreview(jobId: string, force = false): Promise<RepredictScope> {
  return request(`/api/jobs/${jobId}/repredict?force=${force}`)
}

export function repredictJob(jobId: string, force = false): Promise<{ ok: boolean; regions_discarded: number; tiles: number }> {
  return request(`/api/jobs/${jobId}/repredict`, json('POST', { force }))
}

export interface ReocrPreview {
  lines: number
  unchecked: number
  checked: number
  authors: { author: string; lines: number }[]
}

export function reocrPreview(jobId: string): Promise<ReocrPreview> {
  return request(`/api/jobs/${jobId}/reocr`)
}

export function reocr(jobId: string, scope: 'pending' | 'unchecked' = 'pending'): Promise<{ lines: number }> {
  return request(`/api/jobs/${jobId}/reocr`, json('POST', { scope }))
}

/** A step of a dataset that a newer model could be run for, and what running it costs. */
export interface NewerModelOffer {
  task: ModelTask
  from: { id: number | null; name: string }
  to: { id: number; name: string }
  /** OCR: the lines a re-read covers, and the checked ones it leaves alone. */
  unchecked?: number
  checked?: number
  /** Layout and lines: what detecting again replaces. */
  lines?: number
  corrected?: number
  boxes?: number
  layout_checked?: number
}

export function getNewerModels(jobId: string): Promise<{ offers: NewerModelOffer[] }> {
  return request(`/api/jobs/${jobId}/newer-models`)
}

export function runNewerModels(jobId: string, tasks: ModelTask[]): Promise<unknown> {
  return request(`/api/jobs/${jobId}/newer-models`, json('POST', { tasks }))
}

export function declineNewerModels(jobId: string): Promise<unknown> {
  return request(`/api/jobs/${jobId}/newer-models/dismiss`, json('POST', {}))
}

export function redetectPreview(jobId: string): Promise<StaleLines> {
  return request(`/api/jobs/${jobId}/redetect`)
}

export function redetectLines(jobId: string, pageId?: number): Promise<{ ok: boolean }> {
  return request(`/api/jobs/${jobId}/redetect`, json('POST', { page_id: pageId ?? null }))
}

export function purgePreview(jobId: string): Promise<PurgeManifest> {
  return request(`/api/jobs/${jobId}/purge`)
}

export function purgePages(jobId: string): Promise<PurgeManifest> {
  return request(`/api/jobs/${jobId}/purge`, { method: 'POST' })
}

export function setJobChecked(jobId: string, checked: boolean): Promise<{ checked: boolean }> {
  return request(`/api/jobs/${jobId}`, json('PATCH', { checked }))
}

/** How this dataset is read: how many models must agree, whether agreement may check a
 *  line off, and wording of its own that replaces the models'. */
export function setJobLlmSettings(jobId: string, body: {
  llm_consensus_min?: number
  llm_autocheck?: boolean
  llm_consensus_with_ocr?: boolean
  llm_prompt?: string
  /** The models this dataset is read with, settable without starting a read. */
  llm_model_ids?: number[]
}): Promise<{ llm_consensus_min: number; llm_autocheck: boolean; llm_prompt: string }> {
  return request(`/api/jobs/${jobId}`, json('PATCH', body))
}

export interface Processing {
  line_mode: string
  run_layout: boolean
  run_lines: boolean
  run_ocr: boolean
  /** How the pages are laid out, for ordering the lines of a page with no layout boxes.
   *  Changing it puts the pages it applies to back in order at once. */
  reading_order: string
  /** Read by the next Alignment run, which is what re-running it from the dataset is for. */
  gt_autocheck: boolean
  gt_ordered: boolean
  /** A map dataset's tile size, for the maps cut from then on. */
  tile_size: number
  /** Whether layout elements are boxes or outlines. Into outlines, every box takes its
   *  four corners; back to boxes, the outlines are kept for switching back. */
  layout_shape: LayoutShape
}

export type LayoutShape = 'box' | 'polygon'

/** Which phases the next run performs, and whether lines are looked for inside the layout
 *  boxes or across the whole page. Nothing already recognised is touched; the server
 *  settles the combinations that cannot run, so what comes back is what was stored. */
export function setJobProcessing(jobId: string, body: Partial<Processing>): Promise<Processing> {
  return request(`/api/jobs/${jobId}`, json('PATCH', body))
}

export function setLineWidth(jobId: string, lineWidth: number): Promise<{ line_width: number }> {
  return request(`/api/jobs/${jobId}`, json('PATCH', { line_width: lineWidth }))
}

/** An empty text removes the note. */
export function setJobNote(jobId: string, text: string): Promise<Note | null> {
  return request(`/api/jobs/${jobId}/note`, json('PUT', { text }))
}

export function setPageNote(pageId: number, text: string): Promise<Note | null> {
  return request(`/api/pages/${pageId}/note`, json('PUT', { text }))
}

export function setNewPagesTest(jobId: string, newPagesTest: boolean): Promise<{ new_pages_test: boolean }> {
  return request(`/api/jobs/${jobId}`, json('PATCH', { new_pages_test: newPagesTest }))
}

export function setAutoRedetect(jobId: string, autoRedetect: boolean): Promise<{ auto_redetect: boolean }> {
  return request(`/api/jobs/${jobId}`, json('PATCH', { auto_redetect: autoRedetect }))
}

export function renameJob(jobId: string, name: string): Promise<{ name: string }> {
  return request(`/api/jobs/${jobId}`, json('PATCH', { name }))
}

export function setJobGroup(jobId: string, groupId: number | null): Promise<{ group_id: number | null }> {
  return request(`/api/jobs/${jobId}`, json('PATCH', { group_id: groupId }))
}

export function shareJob(jobId: string, usernames: string[]): Promise<{ shared_with: string[] }> {
  return request(`/api/jobs/${jobId}/share`, json('PUT', { usernames }))
}

export function shareGroup(groupId: number, usernames: string[]): Promise<{ shared_with: string[] }> {
  return request(`/api/groups/${groupId}/share`, json('PUT', { usernames }))
}

export function listGroups(): Promise<Group[]> {
  return request('/api/groups')
}

export function createGroup(name: string): Promise<Group> {
  return request('/api/groups', json('POST', { name }))
}

export function renameGroup(groupId: number, name: string): Promise<Group> {
  return request(`/api/groups/${groupId}`, json('PATCH', { name }))
}

/** One dataset's worth of settings, applied to every dataset in a group. Only the fields
 *  sent are changed; `skipped` names the datasets that could not take them and why. */
export interface GroupJobsPatch {
  model_layout_id?: number | null
  model_lines_id?: number | null
  model_ocr_id?: number | null
  ocr_decode?: OcrDecode
  llm_model_ids?: number[]
  line_mode?: string
  run_layout?: boolean
  run_lines?: boolean
  run_ocr?: boolean
}

export interface GroupJobsOutcome {
  changed: { id: string; name: string }[]
  skipped: { id: string; name: string; reason: string }[]
}

export function setGroupJobs(groupId: number, body: GroupJobsPatch): Promise<GroupJobsOutcome> {
  return request(`/api/groups/${groupId}/jobs`, json('PATCH', body))
}

/** Actions over a selection of datasets. The backend runs each one through the same code
 *  the single-dataset route uses, so a refusal reads the same and lands in `skipped`
 *  rather than failing the whole request. */
export type BulkAction = 'rerun' | 'reocr' | 'redetect'

export interface BulkOutcome {
  ok: boolean
  changed: { id: string; name: string }[]
  skipped: { id: string; name: string; reason: string }[]
}

export interface BulkPreview {
  action: BulkAction
  /** Datasets the action would actually run on - the selection minus `blocked`. */
  datasets: number
  blocked: { id: string; name: string; reason: string }[]
  totals: Record<string, number>
}

/** The page table, a screenful at a time. The dataset endpoint still returns every page,
 *  which is 10 MB of JSON on the largest volume here; this asks for what is on screen and
 *  lets the database do the filtering and ordering, so paging through a filter walks the
 *  filtered set rather than the first N pages of everything. */
export type PageFilter =
  'all' | 'reviewed' | 'lines-reviewed' | 'layout-reviewed' | 'unreviewed-lines' | 'layout-unchecked'
  | 'no-layout' | 'test-pages' | 'has-note' | 'deleted'

export type PageSort =
  'idx' | 'filename' | 'dimensions' | 'status' | 'layout' | 'checked' | 'confidence' | 'llm' | 'test'

export interface PageRowsQuery {
  filter?: PageFilter
  sort?: PageSort
  desc?: boolean
  offset?: number
  limit?: number
}

export interface PageRows {
  rows: PageSummary[]
  /** How many pages the filter matched, which is what the table counts against. */
  matched: number
  offset: number
  limit: number
  /** What each chip would show, so they can be labelled without a request each. */
  counts: Record<PageFilter, number>
}

export function listPageRows(jobId: string, query: PageRowsQuery = {}): Promise<PageRows> {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value))
  }
  const q = params.toString()
  return request(`/api/jobs/${jobId}/page-rows${q ? `?${q}` : ''}`)
}

/** A re-run is previewed from the phase it runs from: alignment discards nothing, and
 *  layout is refused where a page was signed off. */
export function bulkPreview(jobIds: string[], action: BulkAction, fromPhase?: string): Promise<BulkPreview> {
  return request('/api/bulk/preview', json('POST', { job_ids: jobIds, action, from_phase: fromPhase }))
}

export function bulkRerun(jobIds: string[], fromPhase: string, force = false): Promise<BulkOutcome> {
  return request('/api/bulk/rerun', json('POST', { job_ids: jobIds, from_phase: fromPhase, force }))
}

export function bulkReocr(jobIds: string[], scope: 'pending' | 'unchecked'): Promise<BulkOutcome> {
  return request('/api/bulk/reocr', json('POST', { job_ids: jobIds, scope }))
}

export function bulkRedetect(jobIds: string[]): Promise<BulkOutcome> {
  return request('/api/bulk/redetect', json('POST', { job_ids: jobIds }))
}

export function bulkSettings(jobIds: string[], patch: GroupJobsPatch): Promise<BulkOutcome> {
  return request('/api/bulk/settings', json('PATCH', { job_ids: jobIds, patch }))
}

export function bulkMove(jobIds: string[], groupId: number | null): Promise<BulkOutcome> {
  return request('/api/bulk/group', json('PATCH', { job_ids: jobIds, group_id: groupId }))
}

export async function deleteGroup(groupId: number): Promise<void> {
  await request(`/api/groups/${groupId}`, { method: 'DELETE' })
}

export interface UserName {
  id: number
  username: string
  display_name: string
  /** Where their picture is, or null for an account that has none - which draws its
   *  initials instead, so this must not be an address that 404s. */
  avatar: string | null
}

export function getUserNames(): Promise<{ users: UserName[] }> {
  return request('/api/users/names')
}

/** Everyone's picture by username, for every role - only accounts that have one. */
export function getAvatars(): Promise<{ avatars: Record<string, string> }> {
  return request('/api/users/avatars')
}

/** Your own picture. Only ever your own: there is no route that takes someone else's. */
export function setMyAvatar(file: File): Promise<{ avatar: string }> {
  const body = new FormData()
  body.append('file', file)
  return request('/api/users/me/avatar', { method: 'PUT', body })
}

export function clearMyAvatar(): Promise<{ avatar: null }> {
  return request('/api/users/me/avatar', { method: 'DELETE' })
}

/** Who someone is, as the auth service knows them. `email` is there only for the person
 *  themselves and for admins. */
export interface Person {
  username: string
  display_name: string
  /** Where their picture is, or '' for none. */
  avatar: string
  role: Role
  created_at: string
  email?: string
}

export function getPerson(username: string): Promise<Person> {
  return request(`/api/people/${encodeURIComponent(username)}`)
}

export interface PersonStats {
  lines_corrected: number
  lines_checked: number
  pages_signed_off: number
  regions_drawn: number
  datasets_owned: number
  datasets_shared: number
  /** Only the groups the caller may open. */
  groups: { id: number; name: string }[]
  trainings: { started: number; done: number; failed: number }
  models_trained: number
  evaluations: number
  best_cer: number | null
  last_active: string | null
}

/** What a person has done. The figures count everything; the names listed are only
 *  those the caller may open. */
export interface PersonProfile {
  stats: PersonStats
  recent_datasets: { id: string; name: string; last_edit: string }[]
  /** Edits per day over the last year; a day without any is left out. */
  activity: { day: string; edits: number }[]
}

export function getPersonProfile(username: string): Promise<PersonProfile> {
  return request(`/api/people/${encodeURIComponent(username)}/profile`)
}

/** Archived models are left out unless asked for - their names stay taken all the same. */
export function listModels(includeArchived = false): Promise<{ models: RegistryModel[] }> {
  return request(includeArchived ? '/api/models?include_archived=true' : '/api/models')
}

export function patchModel(
  modelId: number,
  body: {
    name?: string; notes?: string; is_default?: boolean; archived?: boolean; lm_path?: string; lm_dict_path?: string
    family_name?: string; layout_template_id?: number | null; supersedes?: number | null
  },
): Promise<RegistryModel> {
  return request(`/api/models/${modelId}`, json('PATCH', body))
}

export interface ModelUsage {
  /** Datasets that read with this model: pinned to it, plus those following it as the default. */
  datasets: number
  pinned: number
  by_default: number
}

export function getModelUsage(modelId: number): Promise<ModelUsage> {
  return request(`/api/models/${modelId}/usage`)
}

export function setJobModels(
  jobId: string, models: ModelPicks, ocrDecode: OcrDecode, ocrConvention: OcrConvention,
): Promise<Job> {
  return request(`/api/jobs/${jobId}`, json('PATCH', {
    model_layout_id: models.layout,
    model_lines_id: models.lines,
    model_ocr_id: models.ocr,
    ocr_decode: ocrDecode,
    ocr_convention: ocrConvention,
  }))
}

export async function deleteTraining(trainingId: number): Promise<void> {
  await request(`/api/trainings/${trainingId}`, { method: 'DELETE' })
}

export function trainingProgress(
  trainingId: number,
): Promise<{
  points: ProgressPoint[]
  log_tail: string
  updated_at: number | null
  /** Job id to display name for every dataset the run touches, redacted per access. */
  datasets: Record<string, string>
}> {
  return request(`/api/trainings/${trainingId}/progress`)
}

export function listEvaluations(): Promise<{ evaluations: Evaluation[] }> {
  return request('/api/evaluations')
}

export interface EvaluationDetail extends Omit<Evaluation, 'breakdown'> {
  model_name: string | null
  training_name: string | null
  /** The decodes this model was scored with on the same material, this one included. */
  decodes: { decode: OcrDecode; evaluation_id: number }[]
  /** The datasets whose lines this viewer may see. */
  datasets: { job_id: string; name: string }[]
  /** Per-line records this viewer may see; zero for an evaluation from before they were kept. */
  line_rows: number
  /** Lines left out because they belong to datasets this viewer cannot open. */
  hidden_lines: number
}

/** [kind, truth, read]: '=' agreement, 's' substitution, 'i' insertion, 'd' deletion. */
export type EditOp = ['=' | 's' | 'i' | 'd', string, string]

/** One evaluation's reading of a line. A row holds one; a comparison would hold one per
 *  evaluation, joined on the line. */
export interface EvalReading {
  evaluation_id: number
  decode: OcrDecode
  prediction: string
  cer: number
  distance: number
  confidence: number | null
  ops: EditOp[]
}

export interface EvalLine {
  line_id: number
  job_id: string | null
  page_id: number | null
  ground_truth: string
  length: number
  reading: EvalReading
}

export interface EvalLineFilter {
  cer_min?: number
  cer_max?: number
  job_id?: string
  q?: string
}

export type EvalLineSort = 'cer' | 'confidence' | 'length'

export interface EvalScores { lines: number; chars: number; cer: number }

export interface EvalConfusion {
  ref: string
  hyp: string
  count: number
  example: { line_id: number; job_id: string | null; page_id: number | null; ground_truth: string; prediction: string; ops: EditOp[] }
}

export interface EvalSummary {
  headline: {
    lines: number
    chars: number
    words: number
    cer: number | null
    wer: number | null
    bow_wer: number | null
    bow_precision: number | null
    bow_recall: number | null
    edits: {
      substitutions: number
      insertions: number
      deletions: number
      total: number
      shares: { substitutions: number; insertions: number; deletions: number }
    }
    classes: { name: string; total: number; correct: number; accuracy: number }[]
    case_errors: { count: number; share: number }
  }
  confusions: { substitutions: EvalConfusion[]; insertions: EvalConfusion[]; deletions: EvalConfusion[] }
  characters: { char: string; class: string; total: number; errors: number; rate: number | null; inserted: number }[]
  by_length: (EvalScores & { bucket: string })[]
  by_dataset: (EvalScores & { key: string; name: string })[]
  by_page: (EvalScores & { key: number; filename: string | null; page_idx: number | null; job_id: string | null })[]
  calibration: (EvalScores & { bin: number; exact: number; exact_share: number; mean_confidence: number })[]
  train_known: boolean
  frequency: { char: string; test: number; test_share: number; train: number | null; train_share: number | null }[]
}

function filterParams(filter: EvalLineFilter): URLSearchParams {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(filter)) {
    if (value !== undefined && value !== '') params.set(key, String(value))
  }
  return params
}

export function getEvaluation(evalId: number): Promise<EvaluationDetail> {
  return request(`/api/evaluations/${evalId}`)
}

export function getEvaluationSummary(evalId: number): Promise<EvalSummary> {
  return request(`/api/evaluations/${evalId}/summary`)
}

export function listEvaluationLines(evalId: number, query: EvalLineFilter & {
  sort: EvalLineSort
  order: 'asc' | 'desc'
  offset: number
  limit: number
}): Promise<{ total: number; lines: EvalLine[] }> {
  return request(`/api/evaluations/${evalId}/lines?${filterParams(query)}`)
}

/** Flag every line in the filter for its dataset's review queue. */
export function sendEvaluationToReview(evalId: number, filter: EvalLineFilter): Promise<{
  flagged: number
  jobs: { job_id: string; name: string; lines: number; page_id: number }[]
}> {
  return request(`/api/evaluations/${evalId}/review`, json('POST', filter))
}

export function createEvaluation(body: {
  model_id: number
  job_ids: string[]
  decode: OcrDecode
  pages?: 'test' | 'all'
}): Promise<Evaluation> {
  return request('/api/evaluations', json('POST', body))
}

export function listTrainings(): Promise<{
  trainings: Training[]
  targets: TrainingTargets
  gpu_types: Record<string, number>
  trainable_tasks: ModelTask[]
  // Null unless the caller may act on it. reachable=false means a running cluster run
  // stopped reporting - the job is fine, the connection is not.
  cluster: { reachable: boolean } | null
}> {
  return request('/api/trainings')
}

/** Pages a run leaves out for sharing a scan with test pages, per dataset holding those. */
export interface LeftOut {
  job_id: string
  name: string
  pages: number
}

/** What the datasets would contribute to a run: by default what it may train on, or the
 *  checked material on their 'test' pages, or on 'all' of them. */
export function trainingPreview(
  task: ModelTask,
  jobIds: string[],
  pages: 'train' | 'test' | 'all' = 'train',
): Promise<{
  counts: Record<string, number>
  pages: Record<string, number>
  /** Of the checked material, what language models settled among themselves. */
  machine_settled: Record<string, number>
  /** The pages left once that is set aside, which is what a person-only split divides. */
  human_checked_pages: Record<string, number>
  left_out: LeftOut[]
}> {
  return request('/api/trainings/preview', json('POST', { task, job_ids: jobIds, pages }))
}

/** Mark pages as test data or unmark them; no page ids means every page of the dataset,
 *  and its "New pages are test pages" follows. */
export function markTestPages(
  jobId: string, pageIds: number[] | null, test: boolean,
): Promise<{ test_pages: number; pages: number; new_pages_test: boolean }> {
  return request(`/api/jobs/${jobId}/test-pages`,
    json('POST', { ...(pageIds ? { page_ids: pageIds } : {}), test }))
}

export interface ClusterSession {
  enabled: boolean
  connected: boolean
}

// A cluster behind a second factor hands back its own prompt to relay; the code the
// user types is passed straight through and never stored.
export interface ClusterUnlock {
  connected: boolean
  session_id?: string
  prompt?: string
}

export function getClusterSession(): Promise<ClusterSession> {
  return request('/api/slurm/session')
}

export function openClusterSession(): Promise<ClusterUnlock> {
  return request('/api/slurm/session', { method: 'POST' })
}

export function answerClusterSession(sessionId: string, code: string): Promise<{ connected: boolean }> {
  return request('/api/slurm/session/answer', json('POST', { session_id: sessionId, code }))
}

/** How a transform parameter is edited: one number, a low/high pair, a fixed-size tuple,
 *  a choice, a switch, or - for the few union-typed ones - raw JSON. */
export type AugmentParamKind = 'integer' | 'number' | 'range' | 'tuple' | 'enum' | 'boolean' | 'json'

export interface AugmentParam {
  name: string
  kind: AugmentParamKind
  /** The value albumentations uses when the parameter is left out. */
  default: unknown
  doc: string | null
  nullable: boolean
  min?: number | null
  max?: number | null
  items?: 'integer' | 'number'
  size?: number
  options?: (string | number)[]
}

export interface AugmentTransform {
  name: string
  category: string
  targets: string[]
  doc: string
  default_p: number
  params: AugmentParam[]
}

export interface AugmentCatalog {
  version: string | null
  transforms: AugmentTransform[]
  groups: { name: string; doc: string }[]
  /** Set when no training backend could be asked; the builder then has nothing to offer. */
  error: string | null
}

/** A pipeline in albumentations' own dict form - what the trainer loads. */
export interface AugmentSpec {
  transform: Record<string, unknown>
}

export interface AugmentPipeline {
  id: number
  task: ModelTask
  name: string
  owner: string
  spec: AugmentSpec
  /** The one pipeline per task an admin made the dialog's "Default". */
  is_default: boolean
  /** Whether this caller may rename, reshape or delete it. */
  editable: boolean
  created_at: string
  updated_at: string
}

export interface AugmentPreviewSample {
  line_id: number
  dataset: string
  text: string
  original: string
  /** One draw at the stack's own probabilities. */
  augmented: string
  /** The draw that strayed furthest of the several taken; null when only one was. */
  harshest: string | null
}

export interface AugmentPreview {
  ok: boolean
  error: string | null
  height?: number
  line_seed?: number
  render_seed?: number
  /** How many draws the harshest was chosen from. */
  draws?: number
  samples: AugmentPreviewSample[]
}

/** Every transform the training backends offer, with its parameters classified for the builder. */
export function getAugmentCatalog(): Promise<AugmentCatalog> {
  return request('/api/augmentations/catalog')
}

export function listAugmentPipelines(task: ModelTask): Promise<{
  pipelines: AugmentPipeline[]
  /** The stack the train module falls back to, or why it could not be read. */
  builtin: { spec: AugmentSpec | null; error: string | null }
}> {
  return request(`/api/augmentations/pipelines?task=${task}`)
}

export function createAugmentPipeline(body: { task: ModelTask; name: string; spec: AugmentSpec }):
Promise<AugmentPipeline> {
  return request('/api/augmentations/pipelines', json('POST', body))
}

export function updateAugmentPipeline(id: number, body: { name?: string; spec?: AugmentSpec }):
Promise<AugmentPipeline> {
  return request(`/api/augmentations/pipelines/${id}`, json('PATCH', body))
}

export function deleteAugmentPipeline(id: number): Promise<{ ok: boolean }> {
  return request(`/api/augmentations/pipelines/${id}`, { method: 'DELETE' })
}

export function setAugmentPipelineDefault(id: number, isDefault: boolean): Promise<AugmentPipeline> {
  return request(`/api/augmentations/pipelines/${id}/default`, json('POST', { default: isDefault }))
}

export function duplicateAugmentPipeline(id: number): Promise<AugmentPipeline> {
  return request(`/api/augmentations/pipelines/${id}/duplicate`, { method: 'POST' })
}

/** What a stack does to a few checked lines of the given datasets, before and after. */
export function previewAugmentation(body: {
  task: ModelTask
  spec: AugmentSpec
  job_ids: string[]
  /** Which lines are shown. */
  line_seed: number
  /** The draw the stack itself makes on them. */
  render_seed: number
}): Promise<AugmentPreview> {
  return request('/api/augmentations/preview', json('POST', body))
}

export type TunableKind = 'int' | 'float' | 'bool' | 'choice'

/** What a knob is set to: a number, a switch, or one of a choice knob's named settings. */
export type TunableValue = number | boolean | string

/** One knob of a task's training, as the backend manifest describes it. */
export interface Tunable {
  key: string
  label: string
  group: string
  kind: TunableKind
  help: string
  min: number | null
  max: number | null
  /** A bound the value must stay strictly above. */
  above: number | null
  /** The named settings a choice knob accepts, in the order they are offered. */
  choices: string[]
  /** The value an untuned run uses, read from the model repo; null while unknown. */
  default: TunableValue | null
}

export type LineShape = 'polygon' | 'rotated' | 'box'

export const LINE_SHAPES: { id: LineShape; label: string; hint: string }[] = [
  { id: 'polygon', label: 'Polygon', hint: 'each line exactly as it is outlined' },
  { id: 'rotated', label: 'Rotated rectangle', hint: 'the smallest rectangle round the line, at its slant' },
  { id: 'box', label: 'Box', hint: 'the upright rectangle round the line' },
]

export function lineShapeLabel(shape: LineShape): string {
  return LINE_SHAPES.find((s) => s.id === shape)?.label.toLowerCase() ?? shape
}

export interface TrainingOptions {
  tunables: Tunable[]
  /** Defaults of the knobs that are columns of their own (epochs). */
  columns: Record<string, number | null>
  source: string
  /** The model backend the run would train on, whose own knobs these are. */
  backend: string
  /** Whether the run can fit a language model to its own material. */
  builds_lm: boolean
  /** The batch a blank field is recorded as, per target and cluster card. */
  batch: { local: number; cluster: Record<string, number> }
  /** The cheapest cluster card its backend holds on, which the form starts on; null for none. */
  preferred_gpu: string | null
  /** The shape this model trains lines as unless told otherwise; null for other tasks. */
  line_shape: LineShape | null
}

/** The tunable knobs of a task and their defaults, as the model backend the run would
 *  train on declares them. */
export function getTrainingOptions(task: ModelTask, baseModelId?: number | null): Promise<TrainingOptions> {
  return request(`/api/trainings/options?task=${task}${baseModelId ? `&base_model_id=${baseModelId}` : ''}`)
}

export interface TrainingRequest {
  task: ModelTask
  name: string
  dataset_job_ids: string[]
  base_model_id: number | null
  target: 'local' | 'slurm'
  description: string | null
  epochs: number | null
  batch_size: number | null
  gpu_type?: string | null
  gpu_count?: number | null
  hyperparams: Record<string, TunableValue>
  val_fraction: number
  split_strategy: SplitStrategy
  valid_job_ids: string[]
  test_job_ids: string[]
  build_lm?: boolean
  /** Train only on lines a person verified, leaving out those models settled between them. */
  human_checked_only?: boolean
  augmentation_pipeline_id?: number | null
  augmentation?: AugmentSpec | null
  /** The pre-flight the form showed, kept with the run when its settings still match. */
  preflight_id?: number | null
  /** A lines run's line shape; left out it takes the model's default. */
  line_shape?: LineShape | null
}

export function createTraining(body: TrainingRequest): Promise<Training> {
  return request('/api/trainings', json('POST', body))
}

export interface PreflightLine {
  job_id: string
  page_id: number
  line_id: number
  text: string
}

export interface PreflightFlagged {
  count: number
  examples: PreflightLine[]
}

export interface PreflightDistribution {
  min: number
  median: number
  max: number
  /** examples: the bar's first lines by id; absent from a pre-flight stored before them. */
  bins: { lo: number; hi: number | null; n: number; examples?: PreflightLine[] }[]
}

export type PreflightMetric = 'height' | 'width' | 'aspect' | 'chars_per_line'

/** For each pair of distributions, how many lines each pair of their bars shares:
 *  joint[a][b][i][j] counts the lines in bar i of a and bar j of b. */
export type PreflightJoint = Partial<Record<PreflightMetric, Partial<Record<PreflightMetric, number[][]>>>>

export interface PreflightSplitCount {
  pages: number
  items: number
}

export type PreflightSplit = 'train' | 'val' | 'test'

export type PreflightCharFlag = 'rare' | 'split_only' | 'lookalike' | 'odd' | 'mixed_forms' | 'new_to_base'

export interface PreflightChar {
  char: string
  codepoints: string[]
  name: string
  total: number
  train: number
  val: number
  test: number
  flags: PreflightCharFlag[]
  hint: string
}

export interface PreflightFinding {
  code: string
  level: 'warn' | 'info'
  message: string
}

/** Statistics over exactly the material a run would train on. Warnings only. */
export interface PreflightResult {
  task: ModelTask
  /** What a split's items are: lines for OCR and line detection, boxes for layout. */
  unit: 'lines' | 'boxes'
  split: {
    datasets: ({ job_id: string } & Record<PreflightSplit, PreflightSplitCount>)[]
    totals: Record<PreflightSplit, PreflightSplitCount>
    duplicates: { content_hash: string; splits: PreflightSplit[]; pages: { job_id: string; page_id: number; filename: string }[] }[]
    duplicate_count: number
  }
  crops: {
    measured: number
    unknown: number
    height: PreflightDistribution | null
    width: PreflightDistribution | null
    aspect: PreflightDistribution | null
    tiny: PreflightFlagged
    degenerate: PreflightFlagged
    too_wide: (PreflightFlagged & { target_height: number; max_width: number }) | null
  } | null
  text: {
    chars_per_line: PreflightDistribution | null
    empty: PreflightFlagged
    run_on: PreflightFlagged
    sources: { person: number; transcription: number; models: number }
    characters: PreflightChar[]
    base_charset_known: boolean
  } | null
  /** Absent from a pre-flight stored before bars were linked. */
  joint?: PreflightJoint | null
  classes: ({ name: string; flags: string[] } & Record<PreflightSplit, number>)[] | null
  settings: {
    base_model: string | null
    target: 'local' | 'slurm'
    gpu_type: string | null
    devices: number
    batch_size: number
    batch_is_default: boolean
    /** Absent from a pre-flight stored before runs were scaled per card. */
    grad_accum_steps?: number | null
    lr_scale?: number | null
    effective_batch?: number | null
    epochs: number | null
    epochs_is_default: boolean
    steps_per_epoch: number
    total_steps: number | null
    validation: string
    test_datasets: number
    human_checked_only: boolean
    build_lm: boolean
    /** Absent from a pre-flight stored before lines runs chose one. */
    line_shape?: LineShape | null
    augmentation: string
    tuned: string[]
  }
  findings: PreflightFinding[]
}

export interface Preflight {
  id: number
  status: 'running' | 'done' | 'error'
  error: string | null
  created_at: string
  result: PreflightResult | null
  /** Dataset names by id, redacted for datasets the caller cannot open. */
  datasets: Record<string, string>
}

/** Start reviewing what a training with these settings would train on. */
export function startPreflight(body: Omit<TrainingRequest, 'name' | 'description' | 'preflight_id'>): Promise<{ id: number; status: 'running' }> {
  return request('/api/trainings/preflights', json('POST', body))
}

export function getPreflight(preflightId: number): Promise<Preflight> {
  return request(`/api/trainings/preflights/${preflightId}`)
}

/** The pre-flight a run was started with. */
export function getTrainingPreflight(trainingId: number): Promise<Preflight> {
  return request(`/api/trainings/${trainingId}/preflight`)
}

export function cancelTraining(trainingId: number): Promise<{ ok: boolean }> {
  return request(`/api/trainings/${trainingId}/cancel`, { method: 'POST' })
}

/** Submit a failed run again, keeping the snapshot it already cut. */
export function retryTraining(trainingId: number): Promise<Training> {
  return request(`/api/trainings/${trainingId}/retry`, { method: 'POST' })
}

/** Stop a queued or running evaluation; its row stays, without scores. */
export function cancelEvaluation(evalId: number): Promise<{ ok: boolean }> {
  return request(`/api/evaluations/${evalId}/cancel`, { method: 'POST' })
}

/** Queue a failed or cancelled evaluation again, in place. */
export function retryEvaluation(evalId: number): Promise<Evaluation> {
  return request(`/api/evaluations/${evalId}/retry`, { method: 'POST' })
}

export function setPagesDeleted(jobId: string, pageIds: number[], deleted: boolean): Promise<{
  updated: number
  pages_total: number
}> {
  return request(`/api/jobs/${jobId}/pages`, json('PATCH', { page_ids: pageIds, deleted }))
}

export function setPageLayoutChecked(pageId: number, layoutChecked: boolean): Promise<{ layout_checked: boolean }> {
  return request(`/api/pages/${pageId}`, json('PATCH', { layout_checked: layoutChecked }))
}

export function setPageLinesChecked(pageId: number, linesChecked: boolean): Promise<{ lines_checked: boolean }> {
  return request(`/api/pages/${pageId}`, json('PATCH', { lines_checked: linesChecked }))
}

/** This page's own layout, or '' to follow the dataset again. The lines of a page with
 *  no layout boxes are put back in order on the spot. */
export function setPageReadingOrder(pageId: number, structure: string): Promise<Spanned<{ id: number }>> {
  return request(`/api/pages/${pageId}`, json('PATCH', { reading_order: structure }))
}

/** `revision` is the token the edit was based on; the server refuses with 409 if someone saved since.
 *  `fromReading` says the text was taken from a reading on offer, so a typed correction it
 *  displaces is offered back under the person's name rather than lost. */
export function patchLine(
  lineId: number, correctedText: string | null, revision?: number, fromReading = false,
): Promise<Spanned<Line>> {
  return request(`/api/lines/${lineId}`,
    json('PATCH', { corrected_text: correctedText, revision, from_reading: fromReading }))
}

export function patchLinePolygon(lineId: number, polygon: [number, number][], revision?: number): Promise<Spanned<Line>> {
  return request(`/api/lines/${lineId}`, json('PATCH', { polygon, revision }))
}

/** Turn a scan clockwise, and everything drawn on it with it. The turn is kept rather
 *  than carried: what comes back is the page as if it had been scanned that way. */
export function turnPage(pageId: number, degrees: number): Promise<{
  id: number; job_id: string; rotation: number; width: number; height: number
}> {
  return request(`/api/pages/${pageId}/turn`, json('POST', { degrees }))
}

export function patchLineOrientation(lineId: number, orientation: number): Promise<Spanned<Line>> {
  return request(`/api/lines/${lineId}`, json('PATCH', { orientation }))
}

export function setLineChecked(lineId: number, checked: boolean, orientation?: number): Promise<Spanned<Line>> {
  // Checking persists any pending manual rotation (undefined = leave orientation as-is).
  return request(`/api/lines/${lineId}`,
    json('PATCH', orientation === undefined ? { checked } : { checked, orientation }))
}

/** `revision` is the one the line was loaded at; given, the delete is refused with 409 if
 *  someone saved since. A DELETE carries no body, so it rides the query string. */
export function deleteLine(
  lineId: number,
  revision?: number,
): Promise<{ deleted: boolean; revision: number; span: EditSpan }> {
  const q = revision === undefined ? '' : `?revision=${revision}`
  return request(`/api/lines/${lineId}${q}`, { method: 'DELETE' })
}

export function createLine(pageId: number, polygon: [number, number][]): Promise<Spanned<Line>> {
  return request(`/api/pages/${pageId}/lines`, json('POST', { polygon }))
}

export function splitLine(
  lineId: number,
  cut: { cut_x: number } | { cut_y: number } | { cut_line: [[number, number], [number, number]] },
): Promise<{ lines: Line[]; span: EditSpan }> {
  return request(`/api/lines/${lineId}/split`, json('POST', cut))
}

export function mergeLines(ids: number[]): Promise<Spanned<Line>> {
  return request('/api/lines/merge', json('POST', { ids }))
}

export function reocrLine(lineId: number): Promise<Line> {
  return request(`/api/lines/${lineId}/reocr`, { method: 'POST' })
}

export function patchElement(
  elementId: number,
  body: { checked?: boolean; class_name?: string; bbox?: Bbox; polygon?: Ring; deleted?: boolean; revision?: number },
): Promise<Spanned<PageElement>> {
  return request(`/api/elements/${elementId}`, json('PATCH', body))
}

export function setElementChecked(elementId: number, checked: boolean): Promise<Spanned<PageElement>> {
  return patchElement(elementId, { checked })
}

/** A box, or in a polygon dataset an outline drawn with the polygon pen. */
export function createElement(pageId: number, className: string,
                              shape: { bbox: Bbox } | { polygon: Ring }): Promise<Spanned<PageElement>> {
  return request(`/api/pages/${pageId}/elements`, json('POST', { class_name: className, ...shape }))
}

export function deleteElement(elementId: number): Promise<{ deleted: boolean; span: EditSpan }> {
  return request(`/api/elements/${elementId}`, { method: 'DELETE' })
}

export function splitElement(
  elementId: number,
  cut: { cut_x: number } | { cut_y: number },
): Promise<{ elements: PageElement[]; span: EditSpan }> {
  return request(`/api/elements/${elementId}/split`, json('POST', cut))
}

export function mergeElements(ids: number[]): Promise<Spanned<PageElement>> {
  return request('/api/elements/merge', json('POST', { ids }))
}

export function elementRevisions(elementId: number): Promise<Revision[]> {
  return request(`/api/elements/${elementId}/revisions`)
}

// Layout templates and a dataset's own copy of one.
export type LayoutRole = 'content' | 'container'
export type LayoutReads = 'down' | 'across'

export interface LayoutClass {
  id: number
  name: string
  role: LayoutRole
  /** How a container reads what it holds; null for content. */
  reads: LayoutReads | null
  /** '#rrggbb', or null for the colour derived from the name. */
  color: string | null
  position: number
}

export interface DatasetLayoutClass extends LayoutClass {
  /** Elements of this class in the dataset. */
  elements: number
  /** The class_name its elements are stored under (Schematismus keeps PageNumber as Pagenumber). */
  stored_as: string
  /** A Schematismus class of a Schematismus dataset: it can be recoloured, nothing else. */
  builtin: boolean
}

export interface DatasetLayoutClasses {
  template_id: number | null
  schematismus: boolean
  classes: DatasetLayoutClass[]
}

export interface LayoutTemplate {
  id: number
  name: string
  owner: string | null
  is_default: boolean
  /** The built-in Schematismus template, which cannot be changed. */
  builtin: boolean
  /** How what stands outside every container reads: top to bottom by centre, as the
   *  Schematismus pipeline does, or worked out from the page's leaves and columns. */
  outside_order: OutsideOrder
  classes: LayoutClass[]
}

export type OutsideOrder = 'top_to_bottom' | 'from_page'

export interface LayoutClassDraft {
  id?: number
  name: string
  role: LayoutRole
  reads: LayoutReads | null
  color: string | null
}

export function getLayoutTemplates(): Promise<LayoutTemplate[]> {
  return request<{ templates: LayoutTemplate[] }>('/api/layout-templates').then((r) => r.templates)
}

export function createLayoutTemplate(name: string, classes: LayoutClassDraft[],
                                     outside_order: OutsideOrder): Promise<LayoutTemplate> {
  return request('/api/layout-templates', json('POST', { name, classes, outside_order }))
}

/** "Save as template": a new template with a dataset's classes. */
export function saveLayoutTemplate(name: string, jobId: string): Promise<LayoutTemplate> {
  return request('/api/layout-templates', json('POST', { name, from_job_id: jobId }))
}

export function updateLayoutTemplate(
  id: number,
  body: { name?: string; classes?: LayoutClassDraft[]; outside_order?: OutsideOrder },
): Promise<LayoutTemplate> {
  return request(`/api/layout-templates/${id}`, json('PATCH', body))
}

export async function deleteLayoutTemplate(id: number): Promise<void> {
  await request(`/api/layout-templates/${id}`, { method: 'DELETE' })
}

export function makeDefaultLayoutTemplate(id: number): Promise<LayoutTemplate> {
  return request(`/api/layout-templates/${id}/default`, { method: 'PUT' })
}

export function getJobLayoutClasses(jobId: string): Promise<DatasetLayoutClasses> {
  return request(`/api/jobs/${jobId}/layout-classes`)
}

export function addJobLayoutClass(jobId: string, body: Omit<LayoutClassDraft, 'id'>): Promise<DatasetLayoutClass> {
  return request(`/api/jobs/${jobId}/layout-classes`, json('POST', body))
}

export function changeJobLayoutClass(
  jobId: string,
  classId: number,
  body: Partial<Omit<LayoutClassDraft, 'id'>>,
): Promise<DatasetLayoutClass & { elements_changed: number }> {
  return request(`/api/jobs/${jobId}/layout-classes/${classId}`, json('PATCH', body))
}

/** Remove a class: its elements are deleted, or merged into `into`. */
export function removeJobLayoutClass(
  jobId: string,
  classId: number,
  into?: number,
): Promise<{ removed: number; into: number | null; elements_affected: number }> {
  return request(`/api/jobs/${jobId}/layout-classes/${classId}${into != null ? `?into=${into}` : ''}`,
                 { method: 'DELETE' })
}

export interface LabelPlan {
  label: string
  /** The dataset class the label's boxes become; null when skipped or undecided. */
  class_id: number | null
  /** 'name': a class of that name; 'undecided': a run leaves the boxes out until decided. */
  how: 'name' | 'mapped' | 'skipped' | 'undecided'
}

export interface LayoutLabels {
  model_id: number | null
  labels: LabelPlan[]
  error?: string
}

/** A layout model's labels and which class of the dataset each becomes. */
export function getJobLayoutLabels(jobId: string, modelId?: number | null): Promise<LayoutLabels> {
  return request(`/api/jobs/${jobId}/layout-labels${modelId != null ? `?model_id=${modelId}` : ''}`)
}

/** What the dataset does with a model's labels: a class id, or null to leave the boxes out. */
export function decideJobLayoutLabels(
  jobId: string,
  modelId: number,
  choices: { label: string; class_id: number | null }[],
): Promise<LayoutLabels> {
  return request(`/api/jobs/${jobId}/layout-labels`, json('PUT', { model_id: modelId, choices }))
}

export function reorderJobLayoutClasses(jobId: string, order: number[]): Promise<DatasetLayoutClasses> {
  return request(`/api/jobs/${jobId}/layout-classes/order`, json('PUT', { order }))
}

export interface AppMeta {
  version: string
  commit: string | null
}

export function getMeta(): Promise<AppMeta> {
  return request('/api/meta')
}

let enabledTasks: Promise<Task[]> | null = null

// Which job kinds this deployment offers. Cached: it is deployment
// config, fixed for the lifetime of the page.
export function getEnabledTasks(): Promise<Task[]> {
  enabledTasks ??= request<{ tasks: Task[] }>('/api/tasks').then((r) => r.tasks)
  return enabledTasks
}

export function getMapModels(): Promise<{ models: MapModel[]; runner: MapRunner }> {
  return request('/api/map-models')
}

// `configured` is about the host, not the registry: the methods are listed either way, but
// without the detector's interpreter behind them the tool can only say it is unavailable.
// Cached like the enabled tasks — server config does not change under a session, and the
// tile editor asks on every tile. A rejection is not cached, so a blip can be retried.
let edgeMethods: Promise<{ configured: boolean; methods: EdgeMethod[] }> | null = null

export function getEdgeMethods(): Promise<{ configured: boolean; methods: EdgeMethod[] }> {
  edgeMethods ??= request<{ configured: boolean; methods: EdgeMethod[] }>('/api/edge-methods')
    .catch((e: Error) => {
      edgeMethods = null
      throw e
    })
  return edgeMethods
}

/** Trace the edges inside a selected area into unreviewed polyline regions. */
export function detectRegions(
  pageId: number,
  body: { method: string; area: Ring; class_id: number },
): Promise<{ regions: Region[]; span: EditSpan }> {
  return request(`/api/pages/${pageId}/regions/detect`, json('POST', body))
}

// Per-job class vocabulary (editable). Not cached — colours/classes change during a session.
export function getJobMapClasses(jobId: string): Promise<MapClass[]> {
  return request<{ classes: MapClass[] }>(`/api/jobs/${jobId}/map-classes`).then((r) => r.classes)
}

export function createJobClass(jobId: string, name: string, color: [number, number, number]): Promise<MapClass> {
  return request(`/api/jobs/${jobId}/map-classes`, json('POST', { name, color }))
}

export function patchJobClass(
  jobId: string,
  classId: number,
  body: { name?: string; color?: [number, number, number] },
): Promise<MapClass> {
  return request(`/api/jobs/${jobId}/map-classes/${classId}`, json('PATCH', body))
}

/** Drawable class ids, highest priority first; ids stay, only the ranks change. */
export function reorderJobClasses(jobId: string, order: number[]): Promise<MapClass[]> {
  return request<{ classes: MapClass[] }>(`/api/jobs/${jobId}/map-classes/order`, json('PUT', { order }))
    .then((r) => r.classes)
}

export function deleteJobClass(
  jobId: string,
  classId: number,
  mode: 'delete' | 'merge',
  into?: number,
): Promise<{ removed: number; mode: string; into: number | null; regions_affected: number }> {
  const q = mode === 'merge' ? `?mode=merge&into=${into}` : '?mode=delete'
  return request(`/api/jobs/${jobId}/map-classes/${classId}${q}`, { method: 'DELETE' })
}

export function createRegion(
  pageId: number,
  classId: number,
  points: Ring,
  holes: Ring[] = [],
  kind: RegionKind = 'polygon',
): Promise<Spanned<Region>> {
  return request(`/api/pages/${pageId}/regions`, json('POST', { class_id: classId, points, holes, kind }))
}

export function patchRegion(
  regionId: number,
  body: { class_id?: number; points?: Ring; holes?: Ring[]; checked?: boolean; deleted?: boolean; revision?: number },
): Promise<Spanned<Region>> {
  return request(`/api/regions/${regionId}`, json('PATCH', body))
}

export function deleteRegion(regionId: number): Promise<{ deleted: boolean; span: EditSpan }> {
  return request(`/api/regions/${regionId}`, { method: 'DELETE' })
}

/** Take a span of this page's edits back (undo), or put them back again (redo). Refused
 *  with a conflict when somebody else has edited in or after the span. */
export function revertSpan(pageId: number, span: EditSpan, direction: 'undo' | 'redo'): Promise<RevertResult> {
  return request(`/api/pages/${pageId}/revert`,
    json('POST', { from_revision: span.from, to_revision: span.to, direction }))
}

export interface MaskManifest {
  tiles: number
  regions: number
  reviewed_only: boolean
  dest: string
  // Fused variant only: source maps exported, and ones skipped for having no reviewed tile.
  maps?: number
  maps_skipped?: number
}

// `fused` swaps the per-tile mask set for one mask per source map, tiles stitched back
// into the shape they were cut from. Only tiled jobs (job.run_tile) have source maps.
const maskQuery = (fused: boolean) => (fused ? '?fused=true' : '')

export function maskExportPreview(jobId: string, fused = false): Promise<MaskManifest> {
  return request(`/api/jobs/${jobId}/maskset/preview${maskQuery(fused)}`)
}

export function maskExportWrite(jobId: string, fused = false): Promise<MaskManifest> {
  return request(`/api/jobs/${jobId}/maskset${maskQuery(fused)}`, { method: 'POST' })
}

export function downloadMaskSet(jobId: string, fused = false): Promise<void> {
  return downloadFile(`/api/jobs/${jobId}/maskset${maskQuery(fused)}`,
                      fused ? 'full-maps.zip' : 'masks.zip')
}

export function getMe(): Promise<{ id: number; user: string; role: Role; capabilities: string[] }> {
  return request('/api/me')
}

export function logout(): Promise<{ ok: boolean }> {
  return request('/api/logout', { method: 'POST' })
}

export function getUsers(): Promise<{ users: AppUser[]; capabilities: string[]; invitations: boolean }> {
  return request('/api/users')
}

export interface Invitation {
  link: string
  /** False when the email already had an account: the link then resets its password. */
  created: boolean
  valid_days: number
}

export function inviteUser(email: string, name: string): Promise<Invitation> {
  return request('/api/users/invitations', json('POST', { email, name }))
}

export function patchUser(
  id: number,
  body: {
    role?: Role; active?: boolean; train_local?: boolean; train_cluster?: boolean
    slurm_account?: string
    /** Exceptions to the role, one capability at a time. Setting one back to what the
     *  role says drops the exception rather than storing it. */
    permissions?: Record<string, boolean>
  },
): Promise<AppUser> {
  return request(`/api/users/${id}`, json('PATCH', body))
}

/** Every token in the instance, for the Admin page. Own tokens are listApiTokens. */
export function listAllApiTokens(): Promise<{ tokens: ApiToken[] }> {
  return request('/api/admin/tokens')
}

/** SLURM accounts the cluster login may charge to; empty when it is locked or unset. */
export function getSlurmAccounts(): Promise<{ accounts: string[] }> {
  return request('/api/slurm/accounts')
}

export function sendPresence(body: PresenceLocation & { tab: string }): Promise<{ ok: boolean }> {
  return request('/api/presence', json('POST', body))
}

/** Posted with sendBeacon as the tab closes, which is why it is a URL and not a function. */
export const PRESENCE_LEAVE_URL = '/api/presence/leave'

export function getPresence(): Promise<{ users: PresenceEntry[] }> {
  return request('/api/presence')
}

export function revokeUserSessions(id: number): Promise<{ revoked: number }> {
  return request(`/api/users/${id}/sessions`, { method: 'DELETE' })
}

export function getUserAudit(id: number): Promise<{ entries: UserAuditEntry[] }> {
  return request(`/api/users/${id}/audit`)
}

export function getContributorAccess(username: string): Promise<ContributorAccess> {
  return request(`/api/contributors/${encodeURIComponent(username)}/access`)
}

export function getContributorActivity(username: string, days = 30): Promise<ContributorActivity> {
  return request(`/api/contributors/${encodeURIComponent(username)}/activity?days=${days}`)
}

/** What this dataset writes beyond plain ASCII, in the order it was first met. */
export function getJobCharacters(jobId: string): Promise<{ characters: string[] }> {
  return request(`/api/jobs/${jobId}/characters`)
}

export function getSettings(): Promise<Partial<AppSettings>> {
  return request('/api/settings')
}

/** Write the named settings and get back the document they landed in. Not a PUT: the
 *  document is one blob per person, so sending all of it would take back whatever
 *  another tab changed since this one loaded. */
export function patchSettings(patch: Partial<AppSettings>): Promise<Partial<AppSettings>> {
  return request('/api/settings', json('PATCH', patch))
}

/** Where the page's deep-zoom tiles are served from, as a prefix ending in a slash:
 *  the viewer appends `{level}/{col}_{row}.jpg`. The rotation rides in the path rather
 *  than a query string, because a tile is served immutable and OpenSeadragon builds the
 *  rest of the url itself. */
export function tilesUrl(pageId: number, bust = 0): string {
  return `/api/pages/${pageId}/tiles/${bust}/`
}

export function renditionUrl(pageId: number, kind: 'thumb' | 'screen' | 'full', bust = 0): string {
  // Renditions are served immutable, so a page turned since the browser last looked
  // needs a url of its own or it keeps showing the old way up.
  return `/api/pages/${pageId}/rendition?kind=${kind}${bust ? `&b=${bust}` : ''}`
}

// The crop is served immutable, so a geometry edit must change the URL or the
// browser keeps the stale image. Versioning by bbox also self-corrects for edits
// another annotator made.
export function elementCropUrl(elementId: number, bbox?: Bbox): string {
  const v = bbox ? `?b=${bbox.map((n) => n.toFixed(5)).join('_')}` : ''
  return `/api/elements/${elementId}/crop${v}`
}

export function lineCropUrl(line: Line): string {
  // The deskewed base crop (orientation 0); the loupe spins the manual orientation on top
  // with CSS. Versioned by the line's revision, not its shape: while a reshape is in
  // flight the shape is already the new one here and still the old one on the server, so
  // a shape-keyed URL fetches - and caches - the crop that is being replaced. The
  // revision only moves once the server has stored it. The recipe comes from the server
  // because only it knows when the pixels are cut a different way.
  return `/api/lines/${line.id}/crop?b=${line.crop_recipe}_${line.revision}`
}

export function exportUrl(jobId: string, format: ExportFormat, checkedOnly = false): string {
  return `/api/jobs/${jobId}/export?format=${format}${checkedOnly ? '&checked_only=true' : ''}`
}

export interface TranscriptLine {
  id: number
  order_idx: number
  /** Page-normalised, so it can be drawn over a rendition of any size. */
  polygon: number[][]
  text: string | null
  corrected_text: string | null
  confidence: number | null
  checked: boolean
}

export interface TranscriptElement {
  order_idx: number
  class_name: string
  kind: string
  lines: TranscriptLine[]
}

export interface TranscriptPage {
  id: number
  idx: number
  filename: string
  width: number | null
  height: number | null
  rotation: number
  elements: TranscriptElement[]
}

export function getJobExport(jobId: string): Promise<{
  job: { id: string; name: string }
  pages: TranscriptPage[]
}> {
  return request(exportUrl(jobId, 'json'))
}

export function jobEventsUrl(jobId: string): string {
  return `/api/jobs/${jobId}/events`
}

export function pageEventsUrl(pageId: number, since: number): string {
  return `/api/pages/${pageId}/events?since=${since}`
}

/** One model an endpoint offers. Several per connection: one endpoint, one credential. */
export interface LlmModel {
  id: number
  connection_id: number
  model: string
  label: string
  prompt: string
  temperature: number
  max_image_edge: number
  /** Ceiling on the answer; null leaves it to the endpoint. */
  max_tokens: number | null
  /** Slots this model may hold at once, null for as many as the worker has. */
  max_concurrency: number | null
  /** Extra request fields as a JSON object, where a provider's own switches live. */
  extra_body: string
  enabled: boolean
  created_at: string
}

/** An OpenAI-compatible endpoint. The API key never comes back - only whether one is
 *  stored and its last characters, which is enough to tell two keys apart. */
export interface LlmConnection {
  id: number
  owner: string
  name: string
  base_url: string
  shared: boolean
  editable: boolean
  has_key: boolean
  key_hint: string
  created_at: string
  models: LlmModel[]
}

export interface LlmSettings {
  /** False where the deployment switched LLM pre-annotation off entirely. */
  enabled: boolean
  /** False when the backend has no LLM_SECRET_KEY, so no API key can be stored. */
  secret_configured: boolean
  default_prompt: string
  connections: LlmConnection[]
}

export function getLlmSettings(): Promise<LlmSettings> {
  return request('/api/llm/connections')
}

export function createLlmConnection(body: {
  name: string
  base_url: string
  api_key?: string | null
}): Promise<LlmConnection> {
  return request('/api/llm/connections', json('POST', body))
}

/** Omitting api_key leaves the stored key alone; null clears it. */
export function patchLlmConnection(id: number, body: {
  name?: string
  base_url?: string
  api_key?: string | null
  shared?: boolean
}): Promise<LlmConnection> {
  return request(`/api/llm/connections/${id}`, json('PATCH', body))
}

export function deleteLlmConnection(id: number): Promise<{ ok: boolean }> {
  return request(`/api/llm/connections/${id}`, { method: 'DELETE' })
}

/** Asks the endpoint what it offers, which is also how a connection is tested. */
export function probeLlmConnection(id: number): Promise<{ models: string[] }> {
  return request(`/api/llm/connections/${id}/probe`, { method: 'POST' })
}

export function createLlmModel(connectionId: number, body: {
  model: string
  label?: string
  prompt?: string
  temperature?: number
  max_image_edge?: number
}): Promise<LlmModel> {
  return request(`/api/llm/connections/${connectionId}/models`, json('POST', body))
}

export function patchLlmModel(id: number, body: Partial<{
  model: string
  label: string
  prompt: string
  temperature: number
  max_image_edge: number
  max_tokens: number | null
  max_concurrency: number | null
  extra_body: string
  enabled: boolean
}>): Promise<LlmModel> {
  return request(`/api/llm/models/${id}`, json('PATCH', body))
}

export function deleteLlmModel(id: number): Promise<{ ok: boolean }> {
  return request(`/api/llm/models/${id}`, { method: 'DELETE' })
}

/** Every enabled model the caller may read a page with - what a dataset's picker offers. */
export function listUsableLlmModels(): Promise<{ models: (LlmModel & { shared: boolean })[] }> {
  return request('/api/llm/models')
}

export interface LlmReadPreview {
  pages: number
  calls: number
  /** Readings taken under wording this dataset has since changed - the calls a refresh
   *  would make - and the pages they cover, one page read by two models being one page. */
  stale_prompt: number
  stale_pages: number
  models: { id: number; label: string; calls: number; reused: number; stale_prompt: number }[]
}

export interface LlmReadStatus {
  pages: number
  /** True while anything is still queued or in flight. */
  active: boolean
  pending: number
  running: number
  done: number
  error: number
  models: { id: number; label: string; pending: number; running: number; done: number; error: number }[]
  /** The failures, grouped: `summary` is the sentence, `detail` what the provider answered. */
  errors: { id: number; label: string; error: string; summary: string; detail: string; c: number }[]
}

/** Ask again for the dataset's failed readings, and only those. */
export function retryLlmReads(jobId: string): Promise<{ queued: number }> {
  return request(`/api/jobs/${jobId}/llm/retry`, { method: 'POST' })
}

/** What a run would cost. Pages already read - here or in any dataset holding the same
 *  scan - are free, so the preview separates them out. */
/** `pageIds` prices a selection rather than the dataset, so what the dialog promises is
 *  what the run bills. */
export function getLlmReadPreview(jobId: string, modelIds: number[],
                                  pageIds?: number[]): Promise<LlmReadPreview> {
  const query = [...modelIds.map((id) => `model_ids=${id}`),
                 ...(pageIds ?? []).map((id) => `page_ids=${id}`)].join('&')
  return request(`/api/jobs/${jobId}/llm/preview${query ? `?${query}` : ''}`)
}

/** `refresh` also takes again the readings made under wording since changed - never the
 *  default, since editing a prompt should not quietly re-bill a whole volume. `pageIds`
 *  reads only those pages; without it the whole dataset is read. */
export function startLlmRead(jobId: string, modelIds: number[], refresh = false,
                             pageIds?: number[]): Promise<{
  queued: number; reused: number; refreshed: number; models: { id: number; label: string }[]
}> {
  return request(`/api/jobs/${jobId}/llm/read`,
                 json('POST', { model_ids: modelIds, refresh, page_ids: pageIds ?? null }))
}

/** The caller's own default wording, and the shipped one it falls back to. */
export function getLlmPrompt(): Promise<{ prompt: string; default: string }> {
  return request('/api/llm/prompt')
}

export function putLlmPrompt(prompt: string): Promise<{ prompt: string; default: string }> {
  return request('/api/llm/prompt', json('PUT', { prompt }))
}

/** A picture the models are shown before the page - a chart of the glyphs a corpus
 *  prints. The bytes are fetched separately, so a listing stays small. */
export interface LlmReference {
  id: number
  job_id: string | null
  filename: string
  mime: string
  bytes: number
  digest: string
  created_at: string
}

export interface LlmReferenceList {
  references: LlmReference[]
  /** True where a dataset has none of its own and is showing the caller's default set. */
  inherited: boolean
  limit: number
  max_bytes: number
}

export function listLlmReferences(jobId?: string): Promise<LlmReferenceList> {
  return request(`/api/llm/references${jobId ? `?job_id=${encodeURIComponent(jobId)}` : ''}`)
}

export function addLlmReference(file: File, jobId?: string): Promise<LlmReference> {
  const form = new FormData()
  form.append('file', file)
  if (jobId) form.append('job_id', jobId)
  return request('/api/llm/references', { method: 'POST', body: form })
}

export function deleteLlmReference(referenceId: number): Promise<{ ok: boolean }> {
  return request(`/api/llm/references/${referenceId}`, { method: 'DELETE' })
}

export const llmReferenceImageUrl = (referenceId: number) =>
  `/api/llm/references/${referenceId}/image`

/** `pageIds` asks after those pages alone, which is what a view of one page needs: a run
 *  still working through the rest of the dataset is not this page being read. */
export function getLlmReadStatus(jobId: string, pageIds?: number[]): Promise<LlmReadStatus> {
  const query = (pageIds ?? []).map((id) => `page_ids=${id}`).join('&')
  return request(`/api/jobs/${jobId}/llm/status${query ? `?${query}` : ''}`)
}

/** Withdraws the readings not yet sent. Given `pageIds`, only those pages' readings, and
 *  the one in flight with them: its answer is thrown away when it lands. */
export function cancelLlmRead(jobId: string, pageIds?: number[]): Promise<{ cancelled: number }> {
  return request(`/api/jobs/${jobId}/llm/cancel`, {
    method: 'POST',
    ...(pageIds ? {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ page_ids: pageIds, in_flight: true }),
    } : {}),
  })
}

/** What settling the dataset again would touch under its current agreement settings: lines
 *  the readings on file would now fill in, and fill-ins the agreement no longer carries. */
export interface LlmSettlePreview {
  lines: number
  fill: number
  clear: number
}

export function getLlmSettlePreview(jobId: string): Promise<LlmSettlePreview> {
  return request(`/api/jobs/${jobId}/llm/settle`)
}

export interface LlmSettleResult {
  agreed: number
  filled: number
  cleared: number
  checked: number
}

/** Applies the agreement settings to the lines already read, from the readings on file.
 *  Saving a setting never does this by itself, and no model is asked. */
export function settleLlmAgain(jobId: string): Promise<LlmSettleResult> {
  return request(`/api/jobs/${jobId}/llm/settle`, { method: 'POST' })
}

/** One transcription held for a page: what OCR read, what a person corrected, or what a
 *  language model returned. `line_id` is null while it has no line to sit on. */
export interface LineCandidate {
  id: number
  page_id: number
  line_id: number | null
  source: 'ocr' | 'human' | 'align' | 'llm'
  author: string
  text: string
  order_idx: number
  similarity: number | null
  checked: boolean
  dismissed: boolean
  llm_model_id: number | null
}

/** Say which line a reading belongs to, or null to send it back to the pool. The fallback
 *  for a transcription the matcher could place nowhere. Returns the page's pool as it now
 *  stands, since attaching one reading can move another. */
export function attachCandidate(candidateId: number,
                                lineId: number | null): Promise<{ candidates: LineCandidate[] }> {
  return request(`/api/candidates/${candidateId}`, json('PATCH', { line_id: lineId }))
}

/** Deletes one line's reading by a language model; refused for one a checked line rests on. */
export function removeCandidate(candidateId: number): Promise<{ candidates: LineCandidate[] }> {
  return request(`/api/candidates/${candidateId}`, { method: 'DELETE' })
}

export interface LlmReadingsOnFile {
  id: number
  label: string
  readings: number
  /** Other datasets holding the same scans, which lose these readings too. */
  other_datasets: number
}

export function getLlmReadings(jobId: string): Promise<{ models: LlmReadingsOnFile[] }> {
  return request(`/api/jobs/${jobId}/llm/readings`)
}

/** Deletes the readings of the dataset's scans for good - one model's, or all of them. */
export function removeLlmReadings(jobId: string, modelId?: number): Promise<{ readings: number }> {
  return request(`/api/jobs/${jobId}/llm/readings${modelId === undefined ? '' : `?model_id=${modelId}`}`,
                 { method: 'DELETE' })
}

export function getPageLlmReadings(pageId: number): Promise<{ models: LlmReadingsOnFile[] }> {
  return request(`/api/pages/${pageId}/llm/readings`)
}

/** Deletes one page's readings for good, by the same rules as a dataset's. */
export function removePageLlmReadings(pageId: number, modelId?: number): Promise<{ readings: number }> {
  return request(`/api/pages/${pageId}/llm/readings${modelId === undefined ? '' : `?model_id=${modelId}`}`,
                 { method: 'DELETE' })
}

export function getPageCandidates(pageId: number): Promise<{ candidates: LineCandidate[] }> {
  return request(`/api/pages/${pageId}/candidates`)
}

export type PagePhase = 'layout' | 'lines' | 'ocr'

/** The capability each phase asks the backend for, on one page, a selection or a whole
 *  dataset alike. Alignment destroys nothing, so it asks for none. */
export const PHASE_CAPABILITY: Record<PagePhase, string> = {
  layout: 'pipeline.layout', lines: 'pipeline.lines', ocr: 'pipeline.ocr',
}

/** What running each phase on a page would replace, so the menu can say it beforehand. */
export interface PageRunCosts {
  layout: { elements: number; lines: number; corrections: number }
  lines: { lines: number; corrections: number }
  ocr: { unchecked: number; checked: number }
}

export function getPageRunCosts(pageId: number): Promise<PageRunCosts> {
  return request(`/api/pages/${pageId}/run`)
}

/** Run one phase on one page, whether or not it has run there before. What it overwrites
 *  goes to the page's pool first, so corrections come back onto what is detected next. */
export function runPagePhase(pageId: number, phase: PagePhase): Promise<{ ok: boolean }> {
  return request(`/api/pages/${pageId}/run`, json('POST', { phase }))
}

export interface PagesRun {
  phase: PagePhase
  pages: number
  /** Pages the phase had nothing to do on - every line already checked, say. Reported
   *  rather than failing the batch. */
  skipped: { page_id: number; reason: string }[]
}

/** Run one phase over a set of the dataset's pages, queueing the dataset once. */
export function runPagesPhase(jobId: string, phase: PagePhase,
                              pageIds: number[]): Promise<PagesRun> {
  return request(`/api/jobs/${jobId}/pages/run`, json('POST', { phase, page_ids: pageIds }))
}
