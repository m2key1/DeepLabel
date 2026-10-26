import { execSync } from 'node:child_process'
import { scanPng } from './image'

// Talks to the backend directly, bypassing nginx and the auth service, so tests can
// seed data without driving the UI. The headers mirror what nginx would attach.
export const BACKEND = `http://localhost:${process.env.E2E_BACKEND_PORT ?? 8001}`

const HEADERS = {
  'X-Frontend-Secret': 'e2e-secret',
  'X-Auth-User': 'e2e-seeder',
  'X-Auth-Role': 'admin',
}

export function uniqueName(prefix: string): string {
  return `${prefix} ${Date.now()}-${Math.floor(Math.random() * 1000)}`
}

export function identity(username: string, role: 'admin' | 'member' | 'viewer'): Record<string, string> {
  const headers: Record<string, string> = { 'X-Auth-User': username, 'X-Auth-Role': role }
  // What nginx forwards for a default member: the pipeline phases and training on the local
  // GPU, not the cluster. Tests that need other grants set the header themselves.
  if (role !== 'viewer') headers['X-Auth-Caps'] = 'pipeline.layout pipeline.lines pipeline.ocr train.local'
  return headers
}

export async function backendFetch(path: string, init: RequestInit = {}, attempts = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(`${BACKEND}${path}`, {
        ...init,
        headers: { ...HEADERS, ...(init.headers ?? {}) },
      })
      if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} failed: ${res.status} ${await res.text()}`)
      return res.json()
    } catch (error) {
      // Seeding must not fail a scenario over a transient socket error while the
      // containers are warming up; HTTP errors above are rethrown untouched.
      const transient = error instanceof TypeError
      if (!transient || attempt >= attempts) throw error
      await new Promise((r) => setTimeout(r, 500 * attempt))
    }
  }
}

export interface ScanSize {
  width: number
  height: number
}

export async function createJob(
  name: string, pageCount = 2, size?: ScanSize, headers?: Record<string, string>,
): Promise<string> {
  const form = new FormData()
  form.append('name', name)
  form.append('line_mode', 'per_crop')
  if (name.includes('[slow]')) form.append('model_ocr_id', String(slowOcrModelId()))
  // Distinct scans: ingest marks a page whose content another page of the job already
  // has as a duplicate, and a duplicate is never read.
  for (let i = 0; i < pageCount; i++) {
    const png = scanPng(size?.width, size?.height, i)
    form.append('files', new Blob([new Uint8Array(png)], { type: 'image/png' }), `scan_${i + 1}.png`)
  }
  const res = await backendFetch('/api/jobs', { method: 'POST', body: form, headers })
  return res.job_id
}

export async function getJob(jobId: string) {
  return backendFetch(`/api/jobs/${jobId}`)
}

export async function setOcrConvention(jobId: string, convention: Record<string, boolean>) {
  return backendFetch(`/api/jobs/${jobId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ocr_convention: convention }),
  })
}

export async function getPageDetail(jobId: string, pageId: number) {
  return backendFetch(`/api/jobs/${jobId}/pages/${pageId}`)
}

export async function jobPageIds(jobId: string): Promise<number[]> {
  const job = await getJob(jobId)
  return [...job.pages].sort((a, b) => a.idx - b.idx).map((p: { id: number }) => p.id)
}

export async function waitForJobStatus(jobId: string, status: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const job = await getJob(jobId)
    if (job.status === status) return job
    if (Date.now() > deadline) {
      throw new Error(`job ${jobId} is "${job.status}", expected "${status}" within ${timeoutMs}ms`)
    }
    await new Promise((r) => setTimeout(r, 300))
  }
}

export async function seedCompletedJob(name: string, pageCount = 2, size?: ScanSize): Promise<string> {
  const jobId = await createJob(name, pageCount, size)
  await waitForJobStatus(jobId, 'done')
  return jobId
}

export async function markLinesChecked(jobId: string, count: number): Promise<number> {
  let marked = 0
  for (const pageId of await jobPageIds(jobId)) {
    if (marked >= count) break
    const detail = await getPageDetail(jobId, pageId)
    const lines = detail.elements
      .flatMap((e: { lines: { id: number }[] }) => e.lines)
      .slice(0, count - marked)
    for (const line of lines) {
      await backendFetch(`/api/lines/${line.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ checked: true }),
      })
    }
    marked += lines.length
  }
  return marked
}

export interface TrainingRow {
  id: number
  name: string
  status: string
  owner: string
  target: string
  attempt: number
  error: string | null
  model_id: number | null
  base_model_id: number | null
  batch_size: number | null
  grad_accum_steps: number | null
  lr_scale: number | null
  batch_fallback: { asked: Record<string, number>; trained: Record<string, number> } | null
  resumes: number
  gpu_type: string | null
  gpu_count: number | null
  slurm_account: string
  split_strategy: string
  valid_job_ids: string[]
  test_job_ids: string[]
  hyperparams: Record<string, number | boolean>
  snapshot_counts: Record<string, number> | null
  augmentation: { transform: Record<string, unknown> } | null
  augmentation_name: string
  line_shape: 'polygon' | 'rotated' | 'box' | null
}

export async function listTrainings(): Promise<TrainingRow[]> {
  const res = await backendFetch('/api/trainings')
  return res.trainings
}

/** Submits a run as the seeder, or as whoever `headers` names. A refusal rejects with the
 *  status in its message, so it is asserted with rejects.toThrow. */
export function createTraining(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return backendFetch('/api/trainings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

export async function augmentPipelines(task: string, headers?: Record<string, string>): Promise<{
  pipelines: {
    id: number; name: string; owner: string; is_default: boolean; editable: boolean
    spec: { transform: Record<string, unknown> }
  }[]
  builtin: { spec: { transform: Record<string, unknown> } | null; error: string | null }
}> {
  return backendFetch(`/api/augmentations/pipelines?task=${task}`, headers ? { headers } : {})
}

export async function listEvaluations(): Promise<
  {
    id: number
    model_id: number
    training_id: number | null
    source: { snapshot?: number; jobs?: string[]; test_pages?: boolean }
    decode: string
    status: string
    cer: number | null
    wer: number | null
    line_count: number | null
    breakdown: { job_id: string; name: string; cer: number; wer: number; lines: number }[] | null
  }[]
> {
  const res = await backendFetch('/api/evaluations')
  return res.evaluations
}

export async function getReocrPreview(jobId: string): Promise<{
  lines: number
  unchecked: number
  checked: number
  authors: { author: string; lines: number }[]
}> {
  return backendFetch(`/api/jobs/${jobId}/reocr`)
}

// A page that never had layout keeps its lines in one invisible bucket, classed Unassigned.
// With no box to read inside, the stub's line model finds the lines of both its boxes.
export const UNASSIGNED_LINES = Array.from({ length: 6 }, (_, i) => `Sample Unassigned line ${i + 1}`)

// Who read the page: the stub OCR backend's builtin model, as DeepLabel names it (decode defaults to beam, which adds no suffix).
export const OCR_AUTHOR = 'model:ocr@stub (builtin)'
export const OCR_READER = 'stub (builtin)'

/** How many live lines the greedy pass wrote. The stub signs a greedy reading '#greedy',
 *  so a dataset switched to greedy before a re-read makes the re-read lines tellable from
 *  the first run's - the words themselves come back identical. */
export async function greedyLines(jobId: string): Promise<number> {
  const preview = await getReocrPreview(jobId)
  return preview.authors
    .filter((a) => a.author.endsWith('#greedy'))
    .reduce((sum, a) => sum + a.lines, 0)
}

export async function getTrainingProgress(trainingId: number): Promise<{
  points: { epoch?: number; loss?: number; cer?: number; ts?: number; cer_by_dataset?: Record<string, number> }[]
  log_tail: string
  updated_at: number | null
  datasets: Record<string, string>
}> {
  return backendFetch(`/api/trainings/${trainingId}/progress`)
}

/** A model whose weights file holds only `behaviour`, imported into the weight store the way
 *  an admin imports one, on its task's stub backend: 'stub-slow' waits 15 s before every
 *  prediction, 'stub-misread' reads OCR with a fixed cycle of four errors. */
export function importStubModel(task: 'layout' | 'lines' | 'ocr', name: string,
                                behaviour: 'stub-slow' | 'stub-misread'): number {
  const script = `printf %s ${behaviour} > /tmp/stub-weights && ` +
    `python -m app.weights import /tmp/stub-weights --task ${task} --name '${name}'`
  const out = execSync(`docker compose -f ../compose.e2e.yml exec -T backend sh -c "${script}"`)
  return JSON.parse(out.toString()).model_id
}

let slowOcrModel: number | null = null

/** An OCR model that takes 15 s over every request, which keeps a dataset reading it on the
 *  queue long enough to be seen there. createJob gives it to a dataset named '[slow]'. */
export function slowOcrModelId(): number {
  slowOcrModel ??= importStubModel('ocr', uniqueName('Slow reader'), 'stub-slow')
  return slowOcrModel
}

export async function listRegistryModels(includeArchived = false): Promise<
  { id: number; task: string; name: string; source: string; notes: string | null; is_default: boolean
    trained_from: number | null; archived: boolean; family_name: string | null; layout_template_id: number | null
    files: { role: string; filename: string; sha256: string; size: number }[] }[]
> {
  const res = await backendFetch(`/api/models?include_archived=${includeArchived}`)
  return res.models
}

export async function setElementChecked(elementId: number, checked = true) {
  return backendFetch(`/api/elements/${elementId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ checked }),
  })
}

export async function exportText(jobId: string, format: string, checkedOnly = false): Promise<string> {
  const res = await fetch(
    `${BACKEND}/api/jobs/${jobId}/export?format=${format}${checkedOnly ? '&checked_only=true' : ''}`,
    { headers: HEADERS },
  )
  if (!res.ok) throw new Error(`export failed: ${res.status}`)
  return res.text()
}

/** A page's picture as the backend serves it. 'full' is the scan as it is held now - the
 *  file itself, not a rendition of it; 'screen' and 'thumb' are the copies the runner wrote. */
export async function pageRendition(pageId: number, kind: 'full' | 'screen' | 'thumb'): Promise<Buffer> {
  const res = await fetch(`${BACKEND}/api/pages/${pageId}/rendition?kind=${kind}`, { headers: HEADERS })
  if (!res.ok) throw new Error(`GET rendition?kind=${kind} failed: ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

export async function markLayoutChecked(pageId: number) {
  return backendFetch(`/api/pages/${pageId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ layout_checked: true }),
  })
}

export async function setPagesDeleted(jobId: string, pageIds: number[], deleted = true) {
  return backendFetch(`/api/jobs/${jobId}/pages`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ page_ids: pageIds, deleted }),
  })
}

export async function pageDeletedFlags(jobId: string): Promise<boolean[]> {
  const job = await getJob(jobId)
  return [...job.pages]
    .sort((a: { idx: number }, b: { idx: number }) => a.idx - b.idx)
    .map((p: { deleted: boolean }) => p.deleted)
}

/** The datasets a session is served - the oracle for anything the list claims about
 *  who can see what. Without headers it is the dev admin, who is served everything. */
export function listJobs(headers?: Record<string, string>): Promise<{ id: string; name: string }[]> {
  return backendFetch('/api/jobs', headers ? { headers } : undefined)
}

export async function shareJob(jobId: string, usernames: string[]) {
  return backendFetch(`/api/jobs/${jobId}/share`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usernames }),
  })
}

export async function shareGroup(groupId: number, usernames: string[]) {
  return backendFetch(`/api/groups/${groupId}/share`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usernames }),
  })
}

export interface DatasetInfo {
  owner: string
  created_at: string
  group: string | null
  pages: number
  pages_deleted: number
  documents: number
  images: number
  elements: number
  lines: number
  lines_checked: number
  disk_bytes: number
  disk: Record<string, number>
  editors: { author: string; edits: number; last_at: string }[]
}

export async function datasetInfo(jobId: string): Promise<DatasetInfo> {
  return backendFetch(`/api/jobs/${jobId}/info`)
}

export async function createGroup(name: string): Promise<{ id: number; name: string }> {
  return backendFetch('/api/groups', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
}

export function patchJob(jobId: string, body: Record<string, unknown>) {
  return backendFetch(`/api/jobs/${jobId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export function moveJobToGroup(jobId: string, groupId: number | null) {
  return patchJob(jobId, { group_id: groupId })
}

/** The stub provider (e2e/stub/llm/server.py) as the test host reaches it. */
export const LLM_STUB = `http://localhost:${process.env.E2E_LLM_PORT ?? 8002}`
/** The same stub as the backend container reaches it, over the compose network. */
export const LLM_BASE_URL = 'http://llm:8000/v1'

export interface LlmCallStats {
  calls: Record<string, number>
  total: number
  /** Media types of the pictures each model was last sent, in order - the page is the
   *  last of them, so anything before it is a reference the client chose to show. */
  images: Record<string, string[]>
}

/** How many completions the stub provider was asked for, per model. The oracle for
 *  "this did not cost an API call". */
export async function llmStats(): Promise<LlmCallStats> {
  const res = await fetch(`${LLM_STUB}/_stats`)
  if (!res.ok) throw new Error(`GET ${LLM_STUB}/_stats failed: ${res.status}`)
  return res.json()
}

export async function resetLlmStats(): Promise<void> {
  await fetch(`${LLM_STUB}/_reset`, { method: 'POST' })
}

export interface LlmModelRow {
  id: number
  model: string
  label: string
  prompt: string
  temperature: number
  max_image_edge: number
  enabled: boolean
}

export interface LlmConnectionRow {
  id: number
  owner: string
  name: string
  base_url: string
  shared: boolean
  editable: boolean
  has_key: boolean
  key_hint: string
  models: LlmModelRow[]
}

export async function llmSettings(headers?: Record<string, string>): Promise<{
  enabled: boolean
  secret_configured: boolean
  default_prompt: string
  connections: LlmConnectionRow[]
}> {
  return backendFetch('/api/llm/connections', { headers })
}

/** Registers an endpoint and its models straight through the API, for scenarios whose
 *  subject is what the models do rather than how they were set up. */
export async function seedLlmConnection(
  name: string,
  models: string[],
  headers?: Record<string, string>,
  apiKey?: string,
): Promise<LlmConnectionRow> {
  const created = await backendFetch('/api/llm/connections', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(headers ?? {}) },
    body: JSON.stringify({ name, base_url: LLM_BASE_URL, api_key: apiKey ?? null }),
  })
  // Labels are what the model picker shows and what a scenario locates a row by, so they
  // carry the connection's unique name - two tests otherwise both offer a 'stub-perfect'.
  for (const model of models) {
    await backendFetch(`/api/llm/connections/${created.id}/models`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(headers ?? {}) },
      body: JSON.stringify({ model, label: `${name} ${model}` }),
    })
  }
  const settings = await llmSettings(headers)
  return settings.connections.find((c) => c.id === created.id)!
}

export async function correctLine(lineId: number, text: string, checked = true) {
  return backendFetch(`/api/lines/${lineId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ corrected_text: text, checked }),
  })
}

export async function drawLine(pageId: number, polygon: number[][]) {
  return backendFetch(`/api/pages/${pageId}/lines`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ polygon }),
  })
}

export async function setElementClass(elementId: number, className: string) {
  return backendFetch(`/api/elements/${elementId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ class_name: className }),
  })
}

export async function deleteElement(elementId: number) {
  return backendFetch(`/api/elements/${elementId}`, { method: 'DELETE' })
}

export async function setElementBbox(elementId: number, bbox: number[]) {
  return backendFetch(`/api/elements/${elementId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bbox }),
  })
}

/** Queue the dataset so the runner re-detects lines under elements whose geometry drifted. */
export async function redetectLines(jobId: string, pageId?: number) {
  return backendFetch(`/api/jobs/${jobId}/redetect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(pageId === undefined ? {} : { page_id: pageId }),
  })
}

export interface PageLine {
  id: number
  text: string | null
  corrected_text: string | null
  /** Who wrote the correction: a person's username, 'llm:consensus@N', or 'align:...'. */
  corrected_by: string | null
  checked: boolean
  /** Who settled it: null for a person, 'llm' for language models agreeing. */
  check_source: 'human' | 'align' | 'llm' | null
  /** How many distinct language models read this line the same way. */
  llm_agree_count: number
  polygon: number[][]
}

export async function pageLines(jobId: string, pageId: number): Promise<PageLine[]> {
  const detail = await getPageDetail(jobId, pageId)
  return detail.elements.flatMap((e: { lines: PageLine[] }) => e.lines)
}

export interface Candidate {
  id: number
  line_id: number | null
  source: string
  text: string
  author: string | null
  checked: boolean
  /** Set aside - superseded by a later reading, or a line somebody deleted. Kept either way. */
  dismissed: boolean
  similarity: number | null
}

/** Every transcription held for a page, attached to a line or still orphaned. */
export async function pageCandidates(pageId: number): Promise<Candidate[]> {
  const res = await backendFetch(`/api/pages/${pageId}/candidates`)
  return res.candidates
}

/** A dataset whose pages differ in content, so each counts as a scan of its own. Pages
 *  seeded by createJob are byte-identical, which is fine for annotation but makes any
 *  per-scan count - what a language-model run costs, say - ambiguous. */
export async function seedDistinctPagesJob(
  name: string, pageCount = 2, variantBase = 0, width = 600,
): Promise<string> {
  const form = new FormData()
  form.append('name', name)
  form.append('line_mode', 'per_crop')
  for (let i = 0; i < pageCount; i++) {
    // Raise variantBase for scans no other dataset holds - readings are keyed by the scan,
    // so two datasets seeded from the same base deliberately share what was paid for.
    const png = scanPng(width, 800, variantBase + i + 1)
    form.append('files', new Blob([new Uint8Array(png)], { type: 'image/png' }), `scan_${i + 1}.png`)
  }
  const { job_id: jobId } = await backendFetch('/api/jobs', { method: 'POST', body: form })
  await waitForJobStatus(jobId, 'done')
  return jobId
}

/** Scans this wide are seeded for test pages alone. A test page keeps every page of the
 *  same scan out of training, and scanPng's variants repeat every 120, so a variant base
 *  of its own is not enough: at the common width a test page is some other spec's scan. */
export const TEST_SCAN_WIDTH = 640

/** Mark a dataset's pages as test data - those given, or every page. */
export async function markTestPages(jobId: string, pageIds?: number[]) {
  return backendFetch(`/api/jobs/${jobId}/test-pages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...(pageIds ? { page_ids: pageIds } : {}), test: true }),
  })
}

/** Each page's test flag, in page order. */
export async function testFlags(jobId: string): Promise<boolean[]> {
  return ((await getJob(jobId)).pages as { is_test: boolean }[]).map((p) => p.is_test)
}

/** The model ids the stub provider serves, so a scenario counts what it actually offers
 *  rather than a number that goes stale the next time a behaviour is added. */
export async function llmStubModels(): Promise<string[]> {
  const res = await fetch(`${LLM_STUB}/v1/models`)
  if (!res.ok) throw new Error(`GET ${LLM_STUB}/v1/models failed: ${res.status}`)
  const body = await res.json()
  return body.data.map((m: { id: string }) => m.id).sort()
}

/** A dataset whose pipeline never ran - what an import, or a dataset created with the
 *  phases switched off, leaves behind: ingested pages carrying nothing at all. */
export async function seedJobWithoutLayout(name: string, pageCount = 1): Promise<string> {
  const form = new FormData()
  form.append('name', name)
  form.append('line_mode', 'per_page')
  form.append('run_layout', 'false')
  for (let i = 0; i < pageCount; i++) {
    const png = scanPng(600, 800, 80 + i)
    form.append('files', new Blob([new Uint8Array(png)], { type: 'image/png' }), `scan_${i + 1}.png`)
  }
  const { job_id: jobId } = await backendFetch('/api/jobs', { method: 'POST', body: form })
  await waitForJobStatus(jobId, 'done')
  return jobId
}

export async function seedJobWithoutPipeline(name: string, pageCount = 1): Promise<string> {
  const form = new FormData()
  form.append('name', name)
  form.append('line_mode', 'per_crop')
  form.append('run_layout', 'false')
  form.append('run_lines', 'false')
  form.append('run_ocr', 'false')
  for (let i = 0; i < pageCount; i++) {
    const png = scanPng(600, 800, 70 + i)
    form.append('files', new Blob([new Uint8Array(png)], { type: 'image/png' }), `scan_${i + 1}.png`)
  }
  const { job_id: jobId } = await backendFetch('/api/jobs', { method: 'POST', body: form })
  await waitForJobStatus(jobId, 'done')
  return jobId
}

export async function addLlmReference(
  name: string,
  bytes: Uint8Array,
  mime = 'image/png',
  jobId?: string,
  headers?: Record<string, string>,
): Promise<{ id: number; filename: string }> {
  const form = new FormData()
  form.append('file', new Blob([bytes as BlobPart], { type: mime }), name)
  if (jobId) form.append('job_id', jobId)
  const res = await fetch(`${BACKEND}/api/llm/references`, {
    method: 'POST',
    headers: { ...HEADERS, ...(headers ?? {}) },
    body: form,
  })
  if (!res.ok) throw new Error(`POST /api/llm/references failed: ${res.status} ${await res.text()}`)
  return res.json()
}

export async function llmReferences(
  jobId?: string,
  headers?: Record<string, string>,
): Promise<{ references: { id: number; filename: string }[]; inherited: boolean }> {
  return backendFetch(`/api/llm/references${jobId ? `?job_id=${jobId}` : ''}`,
                      headers ? { headers } : {})
}

export async function llmReferenceImage(
  referenceId: number,
  headers?: Record<string, string>,
): Promise<Uint8Array> {
  const res = await fetch(`${BACKEND}/api/llm/references/${referenceId}/image`, {
    headers: { ...HEADERS, ...(headers ?? {}) },
  })
  if (!res.ok) throw new Error(`GET reference image failed: ${res.status}`)
  return new Uint8Array(await res.arrayBuffer())
}

/** A tiny but genuine PNG, so what reaches the provider is a real image. */
export const TINY_PNG = Uint8Array.from(atob(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
), (c) => c.charCodeAt(0))

/** The overlays a viewer opens with when nobody has changed them - `OVERLAY_DEFAULTS` in
 *  settings.tsx. These live in the signed-in user's settings on the backend, and every
 *  spec runs as the same user, so a spec that changes them changes them for the ones that
 *  follow. Anything that depends on what a page opens with sets them first. */
export const OVERLAY_DEFAULTS = {
  layout: true, lines: false, labels: true, confidence: false, order: false,
}

/** The palette's source, restored by the specs that change it: settings belong to the
 *  signed-in person, and every spec runs as the same one. */
export async function setKeyboardSource(
  page: { request: { patch: Function } },
  source: 'own' | 'dataset' = 'own',
): Promise<void> {
  await page.request.patch('/api/settings', { data: { keyboard_source: source } })
}

/** Which dataset-list sections are folded. Restored by the specs that change them, for
 *  the same reason as the palette above. */
export async function setCollapsedGroups(
  page: { request: { patch: Function } },
  groups: (number | 'ungrouped')[] = [],
): Promise<void> {
  await page.request.patch('/api/settings', { data: { collapsed_groups: groups } })
}

/** How the transcript page opens - how wide the scan sits, and whether the strip of every
 *  page is along the foot. Restored by the specs that change them, for the same reason as
 *  the palette above. */
export async function setTranscriptView(
  page: { request: { patch: Function } },
  { split = 0.55, filmstrip = false }: { split?: number; filmstrip?: boolean } = {},
): Promise<void> {
  await page.request.patch('/api/settings',
    { data: { transcript_split: split, transcript_filmstrip: filmstrip } })
}

export async function setPageOverlays(
  // Settings are held by the auth service against the signed-in session, so they are
  // reached through the browser's own context rather than the backend.
  page: { request: { patch: Function } },
  overlays: Record<string, boolean> = OVERLAY_DEFAULTS,
): Promise<void> {
  await page.request.patch('/api/settings', { data: { page_overlays: overlays } })
}
