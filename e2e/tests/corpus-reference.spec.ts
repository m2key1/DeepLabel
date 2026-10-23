import { test, expect } from '../helpers/test'
import {
  backendFetch, correctLine, identity, jobPageIds, llmStats, pageCandidates, pageLines,
  resetLlmStats, seedLlmConnection, shareJob, slowOcrModelId, uniqueName, waitForJobStatus,
} from '../helpers/api'
import { seedSession, useSession } from '../helpers/session'
import { scanPng } from '../helpers/image'
import { openViewer } from '../helpers/viewer'

const DEV = identity('dev', 'admin')

// 'stub-perfect' answers with the stub runner's own six lines verbatim. See e2e/README.md.
const PERFECT = 'stub-perfect'

// Exactly what the stub runner reads every page as, in element then line order.
const OCR_LINES = ['Header', 'Paragraph'].flatMap(
  (element) => [1, 2, 3].map((i) => `Sample ${element} line ${i}`))

// A corpus arrives as whole documents whose filenames share nothing with the scans: the
// only correspondence is the text. Reading order is name order, so these two letters are
// numbered rather than named after the scans they were written on.
const DOCUMENT_ONE = 'letter-01-neujahr'
const DOCUMENT_TWO = 'letter-02-fastenzeit'

const LETTER_ONE = [
  'Dem Hochwohlgebornen Herrn Vetter zu Neujahr',
  'Nachdem die Fasten vorueber sind melde ich',
  'dass der Zehent von Grossweikersdorf eingegangen',
  'und die Schafe auf der Hutweide gezaehlt wurden',
  'Gott befohlen und viel Gesundheit im neuen Jahr',
  'Geschrieben zu Krems am ersten Jaenner',
]

const LETTER_TWO = [
  'An den wohlehrwuerdigen Pfarrer zu Sankt Michael',
  'Die Fastenzeit hat uns heuer frueh getroffen',
  'und der Wein im Keller ist merklich geringer',
  'Ich bitte um zwei Eimer aus dem Stiftskeller',
  'sobald der Fuhrmann wieder nach Krems faehrt',
  'Der Bote wartet auf Antwort bis Donnerstag',
  'Zum zweiten melde ich den Tod des Schaffners',
  'der am Sonntag nach der Vesper verschieden ist',
  'Seine Witwe bittet um Nachlass des Bestandzinses',
  'Der Grundherr hat noch keinen Bescheid gegeben',
  'Ich empfehle mich Eurer Hochwuerden ergebenst',
  'Geschrieben zu Krems am dritten Maerz',
]

// Letter two runs over two leaves: six lines on each.
const PAGE_TWO_LINES = LETTER_TWO.slice(0, 6)
const PAGE_THREE_LINES = LETTER_TWO.slice(6)

function formOf(name: string, pageCount: number, variantBase: number): FormData {
  const form = new FormData()
  form.append('name', name)
  form.append('line_mode', 'per_crop')
  // Autocheck on, so "a model's reading checked nothing off" is a claim about where that
  // ground truth came from rather than about a switch nobody flipped.
  form.append('gt_autocheck', 'true')
  for (let i = 0; i < pageCount; i++) {
    const png = scanPng(600, 800, variantBase + i + 1)
    form.append('files', new Blob([new Uint8Array(png)], { type: 'image/png' }), `scan_${i + 1}.png`)
  }
  return form
}

async function seedCorpusJob(name: string, pageCount: number, variantBase: number): Promise<string> {
  const { job_id: jobId } = await backendFetch(
    '/api/jobs', { method: 'POST', body: formOf(name, pageCount, variantBase), headers: DEV })
  await waitForJobStatus(jobId, 'done')
  return jobId
}

/** Corrects every page to read exactly the corpus lines it carries, which is what gives
 *  the cut something to anchor to and makes each span derivable by hand. */
async function transcribeAs(jobId: string, perPage: string[][]) {
  const pageIds = await jobPageIds(jobId)
  for (const [index, pageId] of pageIds.entries()) {
    const lines = await pageLines(jobId, pageId)
    for (const [position, line] of lines.entries()) {
      await correctLine(line.id, perPage[index][position], false)
    }
  }
}

async function putDocuments(jobId: string, documents: Record<string, string[]>) {
  const form = new FormData()
  for (const [name, lines] of Object.entries(documents)) {
    form.append('files', new Blob([`${lines.join('\n')}\n`], { type: 'text/plain' }), `${name}.txt`)
  }
  return backendFetch(`/api/jobs/${jobId}/documents`, { method: 'POST', body: form, headers: DEV })
}

function upload(name: string, lines: string[]) {
  return { name: `${name}.txt`, mimeType: 'text/plain', buffer: Buffer.from(`${lines.join('\n')}\n`) }
}

async function documentRows(jobId: string) {
  const body = await backendFetch(`/api/jobs/${jobId}/documents`, { headers: DEV })
  return (body.documents as { name: string; lines: number; pages: number }[])
    .map(({ name, lines, pages }) => ({ name, lines, pages }))
}

async function documentText(jobId: string, name: string): Promise<string> {
  const body = await backendFetch(`/api/jobs/${jobId}/documents/${name}`, { headers: DEV })
  return body.text
}

interface Span {
  document: string | null
  anchors: number
  score: number
  text: string
}

/** What each page is answerable for, in reading order - the oracle for a cut. */
async function referenceSpans(jobId: string): Promise<Span[]> {
  const body = await backendFetch(`/api/jobs/${jobId}/reference`, { headers: DEV })
  return (body.pages as Span[]).map(({ document, anchors, score, text }) =>
    ({ document, anchors, score, text }))
}

async function referenceSources(jobId: string): Promise<(string | null)[]> {
  const body = await backendFetch(`/api/jobs/${jobId}/reference`, { headers: DEV })
  return (body.pages as { gt_source: string | null }[]).map((page) => page.gt_source)
}

async function readTally(jobId: string) {
  const status = await backendFetch(`/api/jobs/${jobId}/groundtruth/status`, { headers: DEV })
  const { done, pending, running, error } = status
  return { done, pending, running, error }
}

async function corpusSettings(jobId: string) {
  const job = await backendFetch(`/api/jobs/${jobId}`, { headers: DEV })
  return { gt_prompt: job.gt_prompt, reference_overlap: job.reference_overlap }
}

const span = (document: string, anchors: number, score: number, lines: string[]): Span =>
  ({ document, anchors, score, text: lines.join('\n') })

test.describe('Scenario: cutting a corpus across the scans and reading them against it', () => {
  test('the corpus is cut onto the pages and read back as their ground truth', async ({ page }) => {
    const jobId = await seedCorpusJob(uniqueName('Corpus read'), 3, 300)
    await transcribeAs(jobId, [LETTER_ONE, PAGE_TWO_LINES, PAGE_THREE_LINES])
    const connection = uniqueName('Diplomatic')
    await seedLlmConnection(connection, [PERFECT], DEV)
    await resetLlmStats()

    await page.goto(`/jobs/${jobId}`)
    await page.getByTestId('corpus-open').click()
    await expect(page.getByTestId('documents-empty')).toBeVisible()

    await page.getByTestId('corpus-upload').setInputFiles([
      upload(DOCUMENT_ONE, LETTER_ONE),
      upload(DOCUMENT_TWO, LETTER_TWO),
      { name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from('not a corpus file\n') },
    ])
    await expect(page.getByTestId('documents-note'))
      .toHaveText('2 documents stored. Not .txt, so left out: notes.md.')
    await expect(page.getByTestId('documents-empty')).toHaveCount(0)

    await expect.poll(() => documentRows(jobId)).toEqual([
      { name: DOCUMENT_ONE, lines: 6, pages: 0 },
      { name: DOCUMENT_TWO, lines: 12, pages: 0 },
    ])
    // Kept exactly as uploaded: the cut reads the file, not a tidied copy of it.
    expect(await documentText(jobId, DOCUMENT_TWO)).toBe(`${LETTER_TWO.join('\n')}\n`)

    const documents = page.getByTestId('document-row')
    await expect(documents).toHaveCount(2)
    await expect(documents.nth(1)).toHaveAttribute('data-name', DOCUMENT_TWO)
    await expect(documents.nth(1).getByTestId('document-lines')).toHaveText('12')
    await expect(documents.nth(1).getByTestId('document-pages')).toHaveText('-')

    // Nothing has been read yet, so no page carries ground truth of any provenance.
    await expect(page.getByTestId('gt-source')).toHaveCount(0)

    await page.getByTestId('reference-cut').click()
    await expect(page.getByTestId('cut-note'))
      .toHaveText('Placed 3 of 3 pages from 2 documents. 0 anchored nothing of their own.')
    await expect(page.getByTestId('cut-note')).toHaveAttribute('data-tone', 'ok')

    // Letter one fits on one leaf; letter two is cut between leaves two and three, and
    // each of them is given two corpus lines of slack past its own end.
    await expect.poll(() => referenceSpans(jobId)).toEqual([
      span(DOCUMENT_ONE, 6, 1, LETTER_ONE),
      span(DOCUMENT_TWO, 6, 1, LETTER_TWO.slice(0, 8)),
      span(DOCUMENT_TWO, 6, 1, LETTER_TWO.slice(4)),
    ])
    await expect.poll(() => documentRows(jobId)).toEqual([
      { name: DOCUMENT_ONE, lines: 6, pages: 1 },
      { name: DOCUMENT_TWO, lines: 12, pages: 2 },
    ])

    const spans = page.getByTestId('reference-row')
    await expect(spans).toHaveCount(3)
    await expect(page.getByTestId('reference-summary'))
      .toHaveText('3 of 3 pages placed · every page anchored')
    await expect(spans.nth(2)).toHaveAttribute('data-document', DOCUMENT_TWO)
    await expect(spans.nth(2)).toHaveAttribute('data-anchors', '6')
    await expect(spans.nth(2)).toHaveAttribute('data-trouble', 'none')
    await expect(spans.nth(2).getByTestId('reference-text'))
      .toHaveText(LETTER_TWO.slice(4).join(' '))

    // Nothing is in trouble, so the filter empties the list and says why.
    await page.getByTestId('reference-trouble-only').click()
    await expect(page.getByTestId('reference-all-well')).toBeVisible()
    await expect(spans).toHaveCount(0)
    await page.getByTestId('reference-trouble-only').click()
    await expect(spans).toHaveCount(3)

    await expect(page.getByTestId('gt-status'))
      .toHaveText('0 done · 0 pending · 0 running · 0 failed, over 3 placed pages.')
    await page.locator(`[data-testid="gt-pick"][data-label="${connection} ${PERFECT}"]`)
      .getByRole('checkbox').check()
    await expect(page.getByTestId('gt-cost')).toHaveText('3 calls over 3 placed pages.')

    await page.getByTestId('gt-start').click()
    await expect(page.getByTestId('gt-note')).toHaveText('3 readings queued over 3 pages.')

    await expect.poll(() => readTally(jobId), { timeout: 30_000 })
      .toEqual({ done: 3, pending: 0, running: 0, error: 0 })
    // One call per page, no page read twice.
    expect(await llmStats()).toMatchObject({ calls: { [PERFECT]: 3 } })

    await expect.poll(() => referenceSources(jobId)).toEqual(['llm', 'llm', 'llm'])
    await expect(page.getByTestId('gt-status'))
      .toHaveText('3 done · 0 pending · 0 running · 0 failed, over 3 placed pages.')
    await expect(page.getByTestId('gt-source')).toHaveCount(3)
    await expect(page.getByTestId('gt-source').first()).toHaveAttribute('data-source', 'llm')
    await expect(page.getByTestId('gt-source').first()).toHaveText('read by a model')

    // The last answer queues the dataset for alignment alone. The lines carry what a
    // person transcribed, so the alignment offers the model's reading beside that text
    // instead of writing over it, and checks nothing off although this dataset asks for
    // autocheck: ground truth a machine wrote is not a person's transcription.
    const [firstPage] = await jobPageIds(jobId)
    const offered = async () => {
      const lines = await pageLines(jobId, firstPage)
      const candidates = await pageCandidates(firstPage)
      return lines.map((l) => candidates
        .filter((c) => c.line_id === l.id && c.source === 'align')
        .map((c) => ({ text: c.text, model: /^align:llm@/.test(c.author ?? '') })))
    }
    await expect.poll(offered, { timeout: 30_000 })
      .toEqual(OCR_LINES.map((text) => [{ text, model: true }]))
    expect((await pageLines(jobId, firstPage)).map((l) => ({ text: l.corrected_text, checked: l.checked })))
      .toEqual(LETTER_ONE.map((text) => ({ text, checked: false })))

    // That alignment was queued by the last answer landing, so it is still running when
    // the assertion above passes. Seeing it out leaves the one job worker idle for
    // whatever spec comes next, and says the automatic re-run finishes rather than hangs.
    await waitForJobStatus(jobId, 'done')
  })

  test('a page transcribed by hand is skipped unless asked, then keeps its text beside the reading',
       async ({ page }) => {
    // README: "A page that already carries a person's transcription - a .txt uploaded
    // beside its scan - is left out of a read by default ... Read anyway, such a page keeps
    // its transcription: the model's answer never overwrites it".
    const typed = ['Sample Header line I', ...OCR_LINES.slice(1)]
    const form = formOf(uniqueName('Corpus by hand'), 1, 380)
    form.append('files', new Blob([typed.join('\n')], { type: 'text/plain' }), 'scan_1.txt')
    const { job_id: jobId } = await backendFetch(
      '/api/jobs', { method: 'POST', body: form, headers: DEV })
    await waitForJobStatus(jobId, 'done')
    await putDocuments(jobId, { [DOCUMENT_ONE]: typed })
    const connection = uniqueName('Diplomatic by hand')
    await seedLlmConnection(connection, [PERFECT], DEV)
    await expect.poll(() => referenceSources(jobId)).toEqual(['sidecar'])

    await page.goto(`/jobs/${jobId}/corpus`)
    await page.getByTestId('reference-cut').click()
    await expect(page.getByTestId('cut-note'))
      .toHaveText('Placed 1 of 1 pages from 1 document. 0 anchored nothing of their own.')
    const label = `${connection} ${PERFECT}`
    await page.locator(`[data-testid="gt-pick"][data-label="${label}"]`)
      .getByRole('checkbox').check()
    await resetLlmStats()

    await expect(page.getByTestId('gt-cost')).toHaveText('0 calls over 0 placed pages.')
    await expect(page.getByTestId('gt-transcribed'))
      .toHaveText("1 page carries a person's transcription and is skipped.")
    await page.getByTestId('gt-start').click()
    await expect(page.getByTestId('gt-note'))
      .toHaveText('0 readings queued over 0 pages, 1 transcribed by hand skipped.')
    expect(await readTally(jobId)).toEqual({ done: 0, pending: 0, running: 0, error: 0 })
    expect((await llmStats()).calls[PERFECT] ?? 0).toBe(0)

    await page.getByTestId('gt-include-transcribed').check()
    await expect(page.getByTestId('gt-cost')).toHaveText('1 call over 1 placed page.')
    await expect(page.getByTestId('gt-transcribed'))
      .toHaveText("1 page carries a person's transcription and is read for comparison.")
    await page.getByTestId('gt-start').click()
    await expect(page.getByTestId('gt-note')).toHaveText('1 reading queued over 1 page.')
    await expect.poll(() => readTally(jobId), { timeout: 30_000 })
      .toEqual({ done: 1, pending: 0, running: 0, error: 0 })
    expect((await llmStats()).calls[PERFECT]).toBe(1)

    const [pageId] = await jobPageIds(jobId)
    const offered = async () => {
      const lines = await pageLines(jobId, pageId)
      const candidates = await pageCandidates(pageId)
      return lines.map((l) => ({
        corrected: l.corrected_text,
        reading: candidates.filter((c) => c.line_id === l.id && c.author === `align:llm:${label}`)
          .map((c) => c.text),
      }))
    }
    await expect.poll(offered, { timeout: 30_000 }).toEqual(
      typed.map((corrected, i) => ({ corrected, reading: [OCR_LINES[i]] })))
    expect(await referenceSources(jobId)).toEqual(['sidecar'])
    await expect(page.getByTestId('gt-source')).toHaveAttribute('data-source', 'sidecar')
    await expect(page.getByTestId('gt-source')).toHaveText('transcribed by hand')
    await waitForJobStatus(jobId, 'done')

    await openViewer(page, jobId, pageId)
    await page.getByTestId('line-row').filter({ hasText: 'Sample Header line I' }).click()
    const reading = page.locator(
      `[data-testid="line-candidate"][data-author="align:llm:${label}"]`)
    await expect(reading.getByTestId('candidate-text')).toHaveText('Sample Header line 1')
    await expect(reading.getByTestId('candidate-reader'))
      .toHaveText(`diplomatic reading - ${label}`)
  })

  test('a corpus that anchors nothing is called out page by page', async ({ page }) => {
    const jobId = await seedCorpusJob(uniqueName('Corpus adrift'), 2, 340)
    const adrift = 'tagebuch-eintrag'
    const lines = LETTER_TWO.slice(0, 8)
    // Uploaded without transcribing the scans, so no line of either page says anything
    // the corpus says: every span is only what its neighbours left over.
    await putDocuments(jobId, { [adrift]: lines })

    await page.goto(`/jobs/${jobId}/corpus`)
    await page.getByTestId('reference-cut').click()
    await expect(page.getByTestId('cut-note'))
      .toHaveText('Placed 2 of 2 pages from 1 document. 2 anchored nothing of their own.')

    await expect.poll(() => referenceSpans(jobId)).toEqual([
      span(adrift, 0, 0, lines.slice(0, 6)),
      span(adrift, 0, 0, lines.slice(2)),
    ])

    const spans = page.getByTestId('reference-row')
    await expect(spans).toHaveCount(2)
    await expect(page.getByTestId('reference-summary'))
      .toHaveText('2 of 2 pages placed · 2 not anchored')
    await expect(spans.nth(0)).toHaveAttribute('data-trouble', 'unanchored')
    await expect(spans.nth(0)).toHaveAttribute('data-anchors', '0')
    await expect(spans.nth(0).getByTestId('reference-trouble')).toHaveText('not anchored')

    // Both pages need a look, so the filter keeps both and never claims all is well.
    await page.getByTestId('reference-trouble-only').click()
    await expect(spans).toHaveCount(2)
    await expect(page.getByTestId('reference-all-well')).toHaveCount(0)

    // No model has read them, so no page shows a provenance badge.
    await expect(page.getByTestId('gt-source')).toHaveCount(0)
  })

  test('wording asking for what nothing supplies is refused, and the overlap moves the cut',
       async ({ page }) => {
    const jobId = await seedCorpusJob(uniqueName('Corpus wording'), 3, 360)
    await transcribeAs(jobId, [LETTER_ONE, PAGE_TWO_LINES, PAGE_THREE_LINES])
    await putDocuments(jobId, { [DOCUMENT_ONE]: LETTER_ONE, [DOCUMENT_TWO]: LETTER_TWO })

    await page.goto(`/jobs/${jobId}/corpus`)

    // An empty editor asks with the shipped wording, so that is what a person starts from.
    const { default: shipped } = await backendFetch(
      `/api/jobs/${jobId}/groundtruth/prompt`, { headers: DEV })
    await expect(page.getByTestId('gt-prompt')).toHaveValue('')
    await page.getByTestId('gt-prompt-shipped').click()
    await expect(page.getByTestId('gt-prompt')).toHaveValue(shipped)
    expect(shipped).toContain('{{reference}}')
    await expect(page.getByTestId('gt-prompt-shipped')).toBeDisabled()

    await page.getByTestId('gt-prompt').fill('Transcribe page {{page_number}} of {{reference}}')
    await page.getByTestId('corpus-settings-save').click()
    await expect(page.getByTestId('settings-note')).toHaveAttribute('data-tone', 'bad')
    await expect(page.getByTestId('settings-note'))
      .toHaveText('nothing supplies {{page_number}}. Available: reference')
    await expect.poll(() => corpusSettings(jobId))
      .toEqual({ gt_prompt: '', reference_overlap: 2 })

    const wording = 'Transcribe this scan line by line. The edited text reads:\n{{reference}}'
    await page.getByTestId('gt-prompt').fill(wording)
    await page.getByTestId('reference-overlap').fill('0')
    await page.getByTestId('corpus-settings-save').click()
    await expect(page.getByTestId('settings-note')).toHaveAttribute('data-tone', 'ok')
    await expect.poll(() => corpusSettings(jobId))
      .toEqual({ gt_prompt: wording, reference_overlap: 0 })

    // With no slack, letter two is cut exactly where the leaves part: neither page holds
    // a line of the other, where two lines of each reached over before.
    await page.getByTestId('reference-cut').click()
    await expect(page.getByTestId('cut-note')).toHaveAttribute('data-tone', 'ok')
    await expect.poll(() => referenceSpans(jobId)).toEqual([
      span(DOCUMENT_ONE, 6, 1, LETTER_ONE),
      span(DOCUMENT_TWO, 6, 1, PAGE_TWO_LINES),
      span(DOCUMENT_TWO, 6, 1, PAGE_THREE_LINES),
    ])
  })

  test('the cut says why it will not run', async ({ page }) => {
    const bare = await seedCorpusJob(uniqueName('Corpus bare'), 1, 380)

    await page.goto(`/jobs/${bare}/corpus`)
    await expect(page.getByTestId('documents-empty')).toBeVisible()
    await page.getByTestId('reference-cut').click()
    await expect(page.getByTestId('cut-note')).toHaveAttribute('data-tone', 'bad')
    await expect(page.getByTestId('cut-note')).toHaveText('this dataset has no corpus documents')
    expect(await referenceSpans(bare)).toEqual([
      { document: null, anchors: 0, score: 0, text: '' },
    ])

    // A run in flight owns the pages the cut would place, so it waits for one to finish
    // rather than moving the corpus underneath it. A slow reader keeps it running.
    const busyForm = formOf(uniqueName('Corpus busy'), 1, 390)
    busyForm.append('model_ocr_id', String(slowOcrModelId()))
    const { job_id: busy } = await backendFetch('/api/jobs', { method: 'POST', body: busyForm, headers: DEV })
    await putDocuments(busy, { [DOCUMENT_ONE]: LETTER_ONE })

    await page.goto(`/jobs/${busy}/corpus`)
    await page.getByTestId('reference-cut').click()
    await expect(page.getByTestId('cut-note')).toHaveAttribute('data-tone', 'bad')
    await expect(page.getByTestId('cut-note')).toHaveText('job is queued or running')
    expect(await referenceSpans(busy)).toEqual([
      { document: null, anchors: 0, score: 0, text: '' },
    ])

    // The dataset that was deliberately made slow is seen out before this spec ends. One
    // job worker serves the whole deployment, so a spec that walks away from a running
    // run hands the next one a queue that is already busy - which is how this file made
    // create-dataset.spec.ts time out waiting for 'done' on a run of its own.
    await waitForJobStatus(busy, 'done')
  })
})

test.describe('Scenario: reviewing the cut where it is most likely wrong', () => {
  test('the leaves that anchored nothing come first in the span review', async ({ page }) => {
    const jobId = await seedCorpusJob(uniqueName('Corpus review order'), 3, 420)
    const pageIds = await jobPageIds(jobId)
    // The first two leaves read as the corpus says; the third keeps its OCR, so nothing on
    // it anchors and its span is only what its neighbours left over.
    await transcribeAs(jobId, [LETTER_ONE, PAGE_TWO_LINES, OCR_LINES])
    await putDocuments(jobId, { [DOCUMENT_ONE]: LETTER_ONE, [DOCUMENT_TWO]: LETTER_TWO })

    await page.goto(`/jobs/${jobId}/corpus`)
    await page.getByTestId('reference-cut').click()
    await expect.poll(async () => (await referenceSpans(jobId)).map((s) => s.anchors > 0))
      .toEqual([true, true, false])

    const rows = page.getByTestId('reference-row')
    await expect(rows).toHaveCount(3)
    await expect(rows.nth(0)).toHaveAttribute('data-page-id', String(pageIds[2]))
    await expect(rows.nth(0)).toHaveAttribute('data-trouble', 'unanchored')
    // The rest follow in reading order.
    await expect(rows.nth(1)).toHaveAttribute('data-page-id', String(pageIds[0]))
    await expect(rows.nth(2)).toHaveAttribute('data-page-id', String(pageIds[1]))
  })
})

test.describe('Scenario: taking the whole corpus away again', () => {
  test('deleting the last document and cutting again leaves no page answering for it', async () => {
    const jobId = await seedCorpusJob(uniqueName('Corpus withdrawn'), 2, 440)
    await transcribeAs(jobId, [LETTER_ONE, PAGE_TWO_LINES])
    await putDocuments(jobId, { [DOCUMENT_ONE]: LETTER_ONE })
    await backendFetch(`/api/jobs/${jobId}/reference/cut`, { method: 'POST', headers: DEV })
    await expect.poll(async () => (await referenceSpans(jobId)).map((s) => s.document))
      .toEqual([DOCUMENT_ONE, DOCUMENT_ONE])

    await backendFetch(`/api/jobs/${jobId}/documents/${DOCUMENT_ONE}`, { method: 'DELETE', headers: DEV })
    expect(await documentRows(jobId)).toEqual([])
    await backendFetch(`/api/jobs/${jobId}/reference/cut`, { method: 'POST', headers: DEV })

    expect((await referenceSpans(jobId)).map(({ document, text }) => ({ document, text })))
      .toEqual([{ document: null, text: '' }, { document: null, text: '' }])
  })
})

test.describe('Scenario: coming back to read the corpus again', () => {
  test('the model picked for the diplomatic read is the one picked next time', async ({ page }) => {
    const jobId = await seedCorpusJob(uniqueName('Corpus remembered'), 1, 460)
    await transcribeAs(jobId, [LETTER_ONE])
    await putDocuments(jobId, { [DOCUMENT_ONE]: LETTER_ONE })
    await backendFetch(`/api/jobs/${jobId}/reference/cut`, { method: 'POST', headers: DEV })
    const connection = uniqueName('Remembered')
    const seeded = await seedLlmConnection(connection, [PERFECT, 'stub-typo'], DEV)
    const perfect = seeded.models.find((m) => m.model === PERFECT)!.id
    const typo = seeded.models.find((m) => m.model === 'stub-typo')!.id
    // The lines are read with the careful model, which is what the corpus pick starts
    // from until a diplomatic read has chosen for itself.
    await backendFetch(`/api/jobs/${jobId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...DEV },
      body: JSON.stringify({ llm_model_ids: [perfect] }),
    })

    const pick = (model: string) => page
      .locator(`[data-testid="gt-pick"][data-label="${connection} ${model}"]`).getByRole('checkbox')
    await page.goto(`/jobs/${jobId}/corpus`)
    await expect(pick(PERFECT)).toBeChecked()
    await expect(pick('stub-typo')).not.toBeChecked()
    await expect(page.locator(`[data-testid="gt-pick"][data-label="${connection} ${PERFECT}"]`)
      .getByTestId('llm-visibility')).toHaveText('Private')

    await pick(PERFECT).uncheck()
    await pick('stub-typo').check()
    await page.getByTestId('gt-start').click()
    await expect(page.getByTestId('gt-note')).toHaveText('1 reading queued over 1 page.')

    const models = async () => {
      const job = await backendFetch(`/api/jobs/${jobId}`, { headers: DEV })
      return { gt: job.gt_model_ids, lines: job.llm_model_ids }
    }
    await expect.poll(models).toEqual({ gt: [typo], lines: [perfect] })

    await page.reload()
    await expect(pick('stub-typo')).toBeChecked()
    await expect(pick(PERFECT)).not.toBeChecked()
    await expect.poll(() => readTally(jobId), { timeout: 30_000 })
      .toEqual({ done: 1, pending: 0, running: 0, error: 0 })
    await waitForJobStatus(jobId, 'done')
  })
})

test.describe('Scenario: the corpus wording is the assignee\'s working tool', () => {
  test('a member the dataset is shared with edits the corpus prompt and it is saved', async ({ page }) => {
    const jobId = await seedCorpusJob(uniqueName('Assignee wording'), 1, 380)
    const member = `member-${Date.now()}`
    await shareJob(jobId, [member])
    await useSession(page.context(), seedSession('member', member))

    await page.goto(`/jobs/${jobId}/corpus`)
    const wording = 'Transcribe the leaf as it stands. The edition reads:\n{{reference}}'
    await expect(page.getByTestId('gt-prompt')).toHaveValue('')
    await page.getByTestId('gt-prompt').fill(wording)
    await page.getByTestId('corpus-settings-save').click()

    await expect(page.getByTestId('settings-note')).toHaveAttribute('data-tone', 'ok')
    await expect.poll(() => corpusSettings(jobId))
      .toEqual({ gt_prompt: wording, reference_overlap: 2 })
  })
})
