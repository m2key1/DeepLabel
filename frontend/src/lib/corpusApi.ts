import { json, request } from '../api'

const jobUrl = (jobId: string) => `/api/jobs/${jobId}`

/** One transcribed document of the corpus: a whole letter or entry, spanning as many
 *  scanned pages as it was written on. */
export interface CorpusDocument {
  name: string
  idx: number
  characters: number
  /** Non-blank lines, which is the unit the cut works in. */
  lines: number
  /** Pages this document was cut onto - 0 until the corpus has been cut. */
  pages: number
}

export function listDocuments(jobId: string): Promise<{ documents: CorpusDocument[] }> {
  return request(`${jobUrl(jobId)}/documents`)
}

export function readDocument(jobId: string, name: string): Promise<{ name: string; text: string }> {
  return request(`${jobUrl(jobId)}/documents/${encodeURIComponent(name)}`)
}

export interface DocumentUpload {
  stored: number
  /** Uploaded filenames that were not .txt, so nothing was kept of them. */
  skipped: string[]
  documents: number
}

/** Add documents, or replace ones already held by uploading the same name again. */
export function uploadDocuments(jobId: string, files: File[]): Promise<DocumentUpload> {
  const form = new FormData()
  for (const file of files) form.append('files', file, file.name)
  return request(`${jobUrl(jobId)}/documents`, { method: 'POST', body: form })
}

export function deleteDocument(jobId: string, name: string): Promise<{ documents: number }> {
  return request(`${jobUrl(jobId)}/documents/${encodeURIComponent(name)}`,
                 { method: 'DELETE' })
}

/** What one page is answerable for, and how well the cut pinned it down. */
export interface ReferencePage {
  page_id: number
  idx: number
  filename: string
  document: string | null
  /** Recognized lines on this page that anchored to a corpus line. Zero means the span
   *  is only what its neighbours left over. */
  anchors: number
  /** Mean similarity of those anchors, 0 where there are none. */
  score: number
  text: string
  /** Where this page's ground truth came from: 'llm' for a model's diplomatic reading. */
  gt_source: string | null
}

export function listReference(jobId: string, limit = 200, offset = 0): Promise<{
  total: number
  pages: ReferencePage[]
}> {
  return request(`${jobUrl(jobId)}/reference?limit=${limit}&offset=${offset}`)
}

export interface CutOutcome {
  documents: number
  pages: number
  placed: number
  unanchored: number
}

export function cutReference(jobId: string): Promise<CutOutcome> {
  return request(`${jobUrl(jobId)}/reference/cut`, { method: 'POST' })
}

export interface GroundTruthPreview {
  pages: number
  calls: number
  /** Placed pages a person transcribed, which a read skips unless asked to include them. */
  transcribed: number
  models: { id: number; label: string; calls: number; reused: number }[]
}

export function getGroundTruthPreview(jobId: string, modelIds: number[],
                                      includeTranscribed = false): Promise<GroundTruthPreview> {
  const query = [...modelIds.map((id) => `model_ids=${id}`),
    `include_transcribed=${includeTranscribed}`].join('&')
  return request(`${jobUrl(jobId)}/groundtruth/preview?${query}`)
}

/** A page whose wording or span has moved is read again regardless, since its question has
 *  changed. `refresh` reads again the ones whose question has not moved too. A page a person
 *  transcribed is skipped unless `includeTranscribed` asks for it. */
export function startGroundTruthRead(jobId: string, modelIds: number[], refresh = false,
                                     pageIds?: number[], includeTranscribed = false): Promise<{
  queued: number
  reused: number
  pages: number
  skipped: number
}> {
  return request(`${jobUrl(jobId)}/groundtruth/read`, json('POST', {
    model_ids: modelIds, refresh, page_ids: pageIds ?? null,
    include_transcribed: includeTranscribed,
  }))
}

export interface GroundTruthStatus {
  pending: number
  running: number
  done: number
  error: number
  errors: { page_id: number; label: string; error: string }[]
  pages: number
}

export function getGroundTruthStatus(jobId: string): Promise<GroundTruthStatus> {
  return request(`${jobUrl(jobId)}/groundtruth/status`)
}

export function cancelGroundTruthRead(jobId: string): Promise<{ cancelled: number }> {
  return request(`${jobUrl(jobId)}/groundtruth/cancel`, { method: 'POST' })
}

export interface GroundTruthWording {
  /** This dataset's own wording, empty when it has none. */
  prompt: string
  /** The shipped wording, which is what an empty one asks with. */
  default: string
  /** The names a wording may ask each page to fill in. */
  variables: string[]
}

export function getGroundTruthWording(jobId: string): Promise<GroundTruthWording> {
  return request(`${jobUrl(jobId)}/groundtruth/prompt`)
}

/** The dataset as this page reads it: its name, whether a run is in flight, and the two
 *  settings the corpus owns. */
export interface CorpusSettings {
  name: string
  status: string
  /** This dataset's own wording for the diplomatic read. Empty uses the shipped one. */
  gt_prompt: string
  /** Corpus lines of slack given to each side of a page's span, 0 to 20. */
  reference_overlap: number
  /** The models this dataset's lines are read with. */
  llm_model_ids: number[]
  /** The models the last diplomatic reading used - what the picker starts from, falling
   *  back to the line-reading models before the first one. */
  gt_model_ids: number[]
}

export function readCorpusSettings(jobId: string): Promise<CorpusSettings> {
  return request(jobUrl(jobId))
}

/** The patch answers with the settings as they now stand, which is what the editor
 *  reseeds from - the backend strips the wording, so what was typed is not what is held. */
export function saveCorpusSettings(jobId: string, body: {
  gt_prompt?: string
  reference_overlap?: number
}): Promise<{ gt_prompt: string; reference_overlap: number }> {
  return request(jobUrl(jobId), json('PATCH', body))
}
