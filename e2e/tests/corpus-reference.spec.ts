import type { Page } from '@playwright/test'
import { test, expect } from '../helpers/test'
import {
  backendFetch, correctLine, identity, jobPageIds, llmStats, pageCandidates, pageLines,
  resetLlmStats, seedLlmConnection, shareJob, slowOcrModelId, uniqueName, waitForJobStatus,
} from '../helpers/api'
import { seedSession, useSession } from '../helpers/session'
import { scanPng } from '../helpers/image'
import { openViewer } from '../helpers/viewer'
import { datasetAction, openDatasetMenu } from '../helpers/dataset'

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

/** The pages the table serves under the No document match filter - the backend oracle for
 *  what its chip lists. */
async function noMatchRowNames(jobId: string): Promise<string[]> {
  const body = await backendFetch(
    `/api/jobs/${jobId}/page-rows?filter=no-document-match&limit=50`, { headers: DEV })
  return (body.rows as { filename: string }[]).map((row) => row.filename)
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

const span = (document: string | null, anchors: number, score: number, lines: string[]): Span =>
  ({ document, anchors, score, text: lines.join('\n') })

/** The documents dialog, now a dataset page's More menu rather than its Corpus tab. */
async function openDocuments(page: Page) {
  const more = await openDatasetMenu(page, 'dataset-more')
  await more.getByTestId('documents-open').click()
  await expect(page.getByRole('dialog').getByRole('heading', { name: 'Documents' })).toBeVisible()
}

/** Cuts the corpus from the Run menu, which offers it only once the page has learned
 *  which documents the dataset holds and no run owns the pages. */
async function cutDocuments(page: Page) {
  await page.getByTestId('dataset-run').click()
  const items = page.getByTestId('dataset-run-items')
  await expect(items.getByTestId('corpus-cut')).toBeVisible()
  await items.getByTestId('corpus-cut').click()
}

/** The diplomatic read of the Run menu, switched to reading against the documents. The
 *  switch is offered once the page has learned which documents the dataset holds, which is
 *  also when the No document match chip appears. */
async function readAgainstDocuments(page: Page) {
  await expect(page.getByTestId('page-filter-no-document-match')).toBeVisible()
  await datasetAction(page, 'llm-read-open')
  await page.getByRole('button', { name: 'Against the documents' }).click()
  await expect(page.getByTestId('diplomatic-read')).toBeVisible()
}

test.describe('Scenario: cutting a corpus across the scans and reading them against it', () => {
  test('the corpus is cut onto the pages and read back as their ground truth', async ({ page }) => {
    const jobId = await seedCorpusJob(uniqueName('Corpus read'), 3, 300)
    await transcribeAs(jobId, [LETTER_ONE, PAGE_TWO_LINES, PAGE_THREE_LINES])
    const connection = uniqueName('Diplomatic')
    await seedLlmConnection(connection, [PERFECT], DEV)
    await resetLlmStats()

    await page.goto(`/jobs/${jobId}`)
    await openDocuments(page)
    await expect(page.getByTestId('documents-empty')).toBeVisible()

    await page.getByTestId('corpus-upload').setInputFiles([
      upload(DOCUMENT_ONE, LETTER_ONE),
      upload(DOCUMENT_TWO, LETTER_TWO),
      { name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from('not a corpus file\n') },
    ])
    await expect(page.getByTestId('documents-note'))
      .toHaveText('2 documents stored. Not .txt, so left out: notes.md.')
    await expect(page.getByTestId('document-row')).toHaveCount(2)

    await expect.poll(() => documentRows(jobId)).toEqual([
      { name: DOCUMENT_ONE, lines: 6, pages: 0 },
      { name: DOCUMENT_TWO, lines: 12, pages: 0 },
    ])
    // Kept exactly as uploaded: the cut reads the file, not a tidied copy of it.
    expect(await documentText(jobId, DOCUMENT_TWO)).toBe(`${LETTER_TWO.join('\n')}\n`)

    const documents = page.getByTestId('document-row')
    await expect(documents.nth(1)).toHaveAttribute('data-name', DOCUMENT_TWO)
    await expect(documents.nth(1).getByTestId('document-lines')).toHaveText('12')
    await expect(documents.nth(1).getByTestId('document-pages')).toHaveText('-')
    await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click()

    // Nothing has been read yet, so no page carries ground truth of any provenance.
    await expect.poll(() => referenceSources(jobId)).toEqual([null, null, null])

    await cutDocuments(page)
    await expect(page.getByTestId('job-notice')).toHaveText('Cut 2 documents onto 3 of 3 pages.')

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

    // Every page anchored a line of the documents, so the table counts none adrift - and
    // the chip only exists on a dataset that has documents cut onto it.
    await expect(page.getByTestId('page-filter-no-document-match')).toHaveText('No document match · 0')

    await readAgainstDocuments(page)

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

    await page.goto(`/jobs/${jobId}`)
    await cutDocuments(page)
    await expect(page.getByTestId('job-notice')).toHaveText('Cut 1 document onto 1 of 1 page.')
    const label = `${connection} ${PERFECT}`
    await readAgainstDocuments(page)
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
    await expect.poll(() => referenceSources(jobId)).toEqual(['sidecar'])
    await waitForJobStatus(jobId, 'done')

    await openViewer(page, jobId, pageId)
    await expect(page.getByTestId('page-reference')).toHaveAttribute('data-anchored', 'true')
    await expect(page.getByTestId('page-reference-toggle')).toHaveText(`From ${DOCUMENT_ONE}`)
    await page.getByTestId('page-reference-toggle').click()
    await expect(page.getByTestId('page-reference-text')).toHaveText(typed.join('\n'))

    await page.getByTestId('line-row').filter({ hasText: 'Sample Header line I' }).click()
    const reading = page.locator(
      `[data-testid="line-candidate"][data-author="align:llm:${label}"]`)
    await expect(reading.getByTestId('candidate-text')).toHaveText('Sample Header line 1')
    await expect(reading.getByTestId('candidate-reader'))
      .toHaveText(`diplomatic reading - ${label}`)
  })

  test('the leaves no line anchored are listed by the page table and marked in the viewer',
       async ({ page }) => {
    const jobId = await seedCorpusJob(uniqueName('Corpus adrift'), 2, 340)
    const adrift = 'tagebuch-eintrag'
    const lines = LETTER_TWO.slice(0, 8)
    // Uploaded without transcribing the scans, so no line of either page says anything
    // the corpus says: every span is only what its neighbours left over.
    await putDocuments(jobId, { [adrift]: lines })

    await page.goto(`/jobs/${jobId}`)
    await cutDocuments(page)
    await expect(page.getByTestId('job-notice'))
      .toHaveText('Cut 1 document onto 2 of 2 pages; 2 matched no line.')

    await expect.poll(() => referenceSpans(jobId)).toEqual([
      span(adrift, 0, 0, lines.slice(0, 6)),
      span(adrift, 0, 0, lines.slice(2)),
    ])

    // The chip says how many pages need a look, and the table lists exactly those two.
    const chip = page.getByTestId('page-filter-no-document-match')
    await expect(chip).toHaveText('No document match · 2')
    await chip.click()
    const pageIds = await jobPageIds(jobId)
    await expect(page.locator('tr[data-page-row]')).toHaveCount(2)
    for (const pageId of pageIds) {
      await expect(page.locator(`tr[data-page-row="${pageId}"]`)).toHaveCount(1)
    }
    await expect.poll(() => noMatchRowNames(jobId)).toEqual(['scan_1.png', 'scan_2.png'])

    await openViewer(page, jobId, pageIds[0])
    await expect(page.getByTestId('page-reference')).toHaveAttribute('data-anchored', 'false')
    await expect(page.getByTestId('page-reference-toggle'))
      .toHaveText(`From ${adrift} - no line of this page matched it`)
    await page.getByTestId('page-reference-toggle').click()
    await expect(page.getByTestId('page-reference-text')).toHaveText(lines.slice(0, 6).join('\n'))

    // No model has read them yet, so no page answers for anything it was not given.
    await expect.poll(() => referenceSources(jobId)).toEqual([null, null])
  })

  test('wording asking for what nothing supplies is refused, and the overlap moves the cut',
       async ({ page }) => {
    const jobId = await seedCorpusJob(uniqueName('Corpus wording'), 3, 360)
    await transcribeAs(jobId, [LETTER_ONE, PAGE_TWO_LINES, PAGE_THREE_LINES])
    await putDocuments(jobId, { [DOCUMENT_ONE]: LETTER_ONE, [DOCUMENT_TWO]: LETTER_TWO })

    await page.goto(`/jobs/${jobId}`)
    await readAgainstDocuments(page)

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
    await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click()
    await cutDocuments(page)
    await expect(page.getByTestId('job-notice')).toHaveText('Cut 2 documents onto 3 of 3 pages.')
    await expect.poll(() => referenceSpans(jobId)).toEqual([
      span(DOCUMENT_ONE, 6, 1, LETTER_ONE),
      span(DOCUMENT_TWO, 6, 1, PAGE_TWO_LINES),
      span(DOCUMENT_TWO, 6, 1, PAGE_THREE_LINES),
    ])
  })

  test('a cut that will not run is kept out of the Run menu, or comes back with why', async ({ page }) => {
    const bare = await seedCorpusJob(uniqueName('Corpus bare'), 1, 380)

    await page.goto(`/jobs/${bare}`)
    await page.getByTestId('dataset-run').click()
    // Nothing to cut, so there is no cut to be refused - while the same locator stands for
    // the dataset below that does hold documents.
    const runItems = page.getByTestId('dataset-run-items')
    await expect(runItems).toBeVisible()
    await expect(runItems.getByTestId('corpus-cut')).toHaveCount(0)
    await expect(backendFetch(`/api/jobs/${bare}/reference/cut`, { method: 'POST', headers: DEV }))
      .rejects.toThrow('this dataset has no corpus documents')
    expect(await referenceSpans(bare)).toEqual([
      { document: null, anchors: 0, score: 0, text: '' },
    ])

    // A run in flight owns the pages the cut would place. So there is nothing to click
    // either - and where the page has learned nothing of the run yet, the refused cut
    // comes back with what the backend says. A slow reader keeps the run in flight long
    // enough for that.
    const busyForm = formOf(uniqueName('Corpus busy'), 1, 390)
    busyForm.append('model_ocr_id', String(slowOcrModelId()))
    const { job_id: busy } = await backendFetch('/api/jobs', { method: 'POST', body: busyForm, headers: DEV })
    await putDocuments(busy, { [DOCUMENT_ONE]: LETTER_ONE })
    await page.goto(`/jobs/${busy}`)
    await page.getByTestId('dataset-run').click()
    await expect(runItems).toBeVisible()
    await expect(page.getByTestId('dataset-run-items').getByTestId('corpus-cut')).toHaveCount(0)
    expect(await referenceSpans(busy)).toEqual([
      { document: null, anchors: 0, score: 0, text: '' },
    ])

    // Loading the page while its status is still stale, then queueing a re-read over the
    // API, is the one order the cut can be clicked in behind the backend's back.
    const interrupted = await seedCorpusJob(uniqueName('Corpus interrupted'), 1, 400)
    await putDocuments(interrupted, { [DOCUMENT_ONE]: LETTER_ONE })
    await page.goto(`/jobs/${interrupted}`)
    await page.getByTestId('dataset-run').click()
    const cut = page.getByTestId('dataset-run-items').getByTestId('corpus-cut')
    await expect(cut).toBeVisible()
    await backendFetch(`/api/jobs/${interrupted}/reocr`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...DEV },
      body: JSON.stringify({ scope: 'unchecked' }),
    })
    await cut.click()
    await expect(page.getByTestId('job-error')).toHaveText('job is queued or running')

    // The dataset that was deliberately made slow is seen out before this spec ends. One
    // job worker serves the whole deployment, so a spec that walks away from a running
    // run hands the next one a queue that is already busy - which is how this file made
    // create-dataset.spec.ts time out waiting for 'done' on a run of its own.
    await waitForJobStatus(busy, 'done')
    await waitForJobStatus(interrupted, 'done')
  })
})

test.describe('Scenario: reviewing the cut where it is most likely wrong', () => {
  test('a leaf three down that anchored nothing is flagged in the table and in its viewer',
       async ({ page }) => {
    const jobId = await seedCorpusJob(uniqueName('Corpus review order'), 3, 420)
    const pageIds = await jobPageIds(jobId)
    // The first two leaves read as the corpus says; the third keeps its OCR, so nothing on
    // it anchors and its span is only what its neighbours left over.
    await transcribeAs(jobId, [LETTER_ONE, PAGE_TWO_LINES, OCR_LINES])
    await putDocuments(jobId, { [DOCUMENT_ONE]: LETTER_ONE, [DOCUMENT_TWO]: LETTER_TWO })

    await page.goto(`/jobs/${jobId}`)
    await cutDocuments(page)
    await expect(page.getByTestId('job-notice'))
      .toHaveText('Cut 2 documents onto 3 of 3 pages; 1 matched no line.')
    await expect.poll(async () => (await referenceSpans(jobId)).map((s) => s.anchors > 0))
      .toEqual([true, true, false])

    // Exactly the one drifting leaf is what the chip counts and the table lists.
    const chip = page.getByTestId('page-filter-no-document-match')
    await expect(chip).toHaveText('No document match · 1')
    await chip.click()
    await expect(page.locator('tr[data-page-row]')).toHaveCount(1)
    await expect(page.locator(`tr[data-page-row="${pageIds[2]}"]`)).toHaveCount(1)
    await expect.poll(() => noMatchRowNames(jobId)).toEqual(['scan_3.png'])

    // The drifting leaf says so in its own viewer; an anchored one says where it sits.
    await openViewer(page, jobId, pageIds[2])
    await expect(page.getByTestId('page-reference')).toHaveAttribute('data-anchored', 'false')
    await expect(page.getByTestId('page-reference-toggle'))
      .toHaveText(`From ${DOCUMENT_TWO} - no line of this page matched it`)
    await page.getByTestId('page-reference-toggle').click()
    await expect(page.getByTestId('page-reference-text')).toHaveText(LETTER_TWO.slice(4).join('\n'))

    await openViewer(page, jobId, pageIds[0])
    await expect(page.getByTestId('page-reference')).toHaveAttribute('data-anchored', 'true')
    await expect(page.getByTestId('page-reference-toggle')).toHaveText(`From ${DOCUMENT_ONE}`)
    await page.getByTestId('page-reference-toggle').click()
    await expect(page.getByTestId('page-reference-text')).toHaveText(LETTER_ONE.join('\n'))
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

test.describe('Scenario: removing the last document in the dataset', () => {
  test('takes the stretches it left on the pages with it, and on a dataset never cut asks nothing more', async ({ page }) => {
    const removeOnly = async (name: string) => {
      page.once('dialog', (dialog) => void dialog.accept())
      await page.getByRole('button', { name: `Remove ${name}`, exact: true }).click()
      await expect(page.getByTestId('documents-empty')).toBeVisible()
    }

    const cuts: string[] = []
    page.on('response', (r) => { if (r.url().includes('/reference/cut')) cuts.push(`${r.status()}`) })
    const cut = await seedCorpusJob(uniqueName('Corpus taken back'), 2, 450)
    await transcribeAs(cut, [LETTER_ONE, PAGE_TWO_LINES])
    await putDocuments(cut, { [DOCUMENT_ONE]: LETTER_ONE })
    await backendFetch(`/api/jobs/${cut}/reference/cut`, { method: 'POST', headers: DEV })
    await expect.poll(async () => (await referenceSpans(cut)).map((s) => s.document)).toEqual([DOCUMENT_ONE, DOCUMENT_ONE])
    await page.goto(`/jobs/${cut}`)
    await expect(page.getByTestId('page-filter-no-document-match')).toBeVisible()
    await openDocuments(page)
    await removeOnly(DOCUMENT_ONE)
    await expect.poll(async () => (await referenceSpans(cut)).map((s) => s.document)).toEqual([null, null])
    await expect(page.getByTestId('page-filter-no-document-match')).toHaveCount(0)
    expect(cuts).toEqual(['200'])

    // Nothing was ever cut here, so there is nothing to take back and nothing to refuse.
    const uncut = await seedCorpusJob(uniqueName('Corpus never cut'), 1, 455)
    await putDocuments(uncut, { [DOCUMENT_ONE]: LETTER_ONE })
    await page.goto(`/jobs/${uncut}`)
    await openDocuments(page)
    await removeOnly(DOCUMENT_ONE)
    await expect.poll(() => documentRows(uncut)).toEqual([])
    await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click()
    // Whatever the removal set off has answered by now.
    await page.waitForLoadState('networkidle')
    expect(cuts).toEqual(['200'])
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
    await page.goto(`/jobs/${jobId}`)
    await readAgainstDocuments(page)
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

    // Reopening the read is how a person comes back to it, and the pick it hid last.
    await page.reload()
    await readAgainstDocuments(page)
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
    // The working tool sits where the documents are read, so a dataset without them
    // offers no switch into it and nothing to edit.
    await putDocuments(jobId, { [DOCUMENT_ONE]: LETTER_ONE })
    const member = `member-${Date.now()}`
    await shareJob(jobId, [member])
    await useSession(page.context(), seedSession('manager', member))

    await page.goto(`/jobs/${jobId}`)
    await readAgainstDocuments(page)
    const wording = 'Transcribe the leaf as it stands. The edition reads:\n{{reference}}'
    await expect(page.getByTestId('gt-prompt')).toHaveValue('')
    await page.getByTestId('gt-prompt').fill(wording)
    await page.getByTestId('corpus-settings-save').click()

    await expect(page.getByTestId('settings-note')).toHaveAttribute('data-tone', 'ok')
    await expect.poll(() => corpusSettings(jobId))
      .toEqual({ gt_prompt: wording, reference_overlap: 2 })
  })
})
