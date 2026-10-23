import { test, expect } from '../helpers/test'
import {
  getJob, getPageDetail, jobPageIds, seedCompletedJob, uniqueName, waitForJobStatus,
} from '../helpers/api'
import { scanPng } from '../helpers/image'
import { textPdf } from '../helpers/pdf'
import { withLayoutPerCrop } from '../helpers/new-dataset'

type Line = { text: string; corrected_text: string | null; checked: boolean }

async function pageLines(jobId: string, pageId: number): Promise<Line[]> {
  const detail = await getPageDetail(jobId, pageId)
  return detail.elements.flatMap((e: { lines: Line[] }) => e.lines)
}

// The stub OCR reads every page as 'Sample Header line 1..3' + 'Sample Paragraph
// line 1..3'. The transcription exercises all three outcomes: an exact match
// (auto-checked), a near match (corrected, not auto-checked), and garbage
// (left unmatched).
const TRANSCRIPTION = [
  'Sample Header line 1',
  'Sample Paragraf line 2',
  'Zzz qqq www',
].join('\n')

test.describe('Scenario: ingesting pages with existing transcriptions', () => {
  test('page texts are aligned to the recognized lines, best match first', async ({ page }) => {
    const name = uniqueName('With transcript')
    await page.goto('/new')
    await withLayoutPerCrop(page)
    await page.getByLabel('Job name').fill(name)
    await page.locator('input[type="file"]').setInputFiles([
      { name: 'folio_1.png', mimeType: 'image/png', buffer: scanPng() },
      { name: 'folio_1.txt', mimeType: 'text/plain', buffer: Buffer.from(TRANSCRIPTION) },
    ])
    await expect(page.getByTestId('gt-pairing')).toContainText('Transcriptions found for 1 of 1 page')
    await page.getByTestId('gt-autocheck').check()
    await page.getByRole('button', { name: 'Create job' }).click()
    await expect(page).toHaveURL(/\/jobs\/[0-9a-f]{12}$/)
    const jobId = page.url().split('/').pop()!
    await waitForJobStatus(jobId, 'done')

    const [pageId] = await jobPageIds(jobId)
    const lines = await pageLines(jobId, pageId)
    const byText = (t: string) => lines.find((l) => l.text === t)!

    // Exact match: transcription becomes the correction and auto-check applies.
    expect(byText('Sample Header line 1')).toMatchObject({
      corrected_text: 'Sample Header line 1', checked: true,
    })
    // Near match: corrected with the transcription, but below the auto-check bar.
    expect(byText('Sample Paragraph line 2')).toMatchObject({
      corrected_text: 'Sample Paragraf line 2', checked: false,
    })
    // Everything else stays untouched; the garbage line pairs with nothing.
    for (const text of ['Sample Header line 2', 'Sample Header line 3',
                        'Sample Paragraph line 1', 'Sample Paragraph line 3']) {
      expect(byText(text)).toMatchObject({ corrected_text: null, checked: false })
    }

    // Coverage lands in the counters and on the dataset card.
    const counters = (await getJob(jobId)).counters
    expect(counters.gt_total).toBe(3)
    expect(counters.gt_matched).toBe(2)
    // Coverage lives with the rest of a dataset's provenance, in its Info panel.
    await page.goto('/')
    await page.getByTestId('job-card').filter({ hasText: name })
      .getByTestId('job-info-toggle').click()
    await expect(page.getByTestId('gt-coverage'))
      .toHaveText('2/3 lines matched a recognized line')
  })

  test('a transcription added with a later page is aligned like one from creation', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Appended transcript'), 1)
    await page.goto(`/jobs/${jobId}`)

    await page.locator('input[type="file"]').setInputFiles([
      { name: 'scan_2.png', mimeType: 'image/png', buffer: scanPng(600, 800, 1) },
      { name: 'scan_2.txt', mimeType: 'text/plain', buffer: Buffer.from(TRANSCRIPTION) },
    ])

    // The append inserts the page and requeues the job in one commit, so a second
    // page means the re-run has started; only then is waiting for 'done' meaningful.
    await expect.poll(async () => (await getJob(jobId)).pages.length).toBe(2)
    await waitForJobStatus(jobId, 'done')

    const [firstId, appendedId] = await jobPageIds(jobId)
    const appended = await pageLines(jobId, appendedId)
    const byText = (t: string) => appended.find((l) => l.text === t)!

    expect(byText('Sample Header line 1')).toMatchObject({
      corrected_text: 'Sample Header line 1', checked: false,  // autocheck was never asked for
    })
    expect(byText('Sample Paragraph line 2')).toMatchObject({
      corrected_text: 'Sample Paragraf line 2', checked: false,
    })

    // The page that was there before the append carries no transcription of its own,
    // so the sweep over the whole job must leave every one of its lines alone.
    const first = await pageLines(jobId, firstId)
    // Six, because the stub reads every page the same way - an empty list would make
    // the "none of them corrected" assertion below pass for the wrong reason.
    expect(first).toHaveLength(6)
    expect(first.filter((l) => l.corrected_text !== null)).toEqual([])

    const counters = (await getJob(jobId)).counters
    expect(counters.gt_total).toBe(3)
    expect(counters.gt_matched).toBe(2)
  })

  test('an ordered transcription also checks off the lines the model read badly', async ({ page }) => {
    const name = uniqueName('Ordered transcript')
    await page.goto('/new')
    await withLayoutPerCrop(page)
    await page.getByLabel('Job name').fill(name)
    await page.locator('input[type="file"]').setInputFiles([
      { name: 'folio_1.png', mimeType: 'image/png', buffer: scanPng() },
      { name: 'folio_1.txt', mimeType: 'text/plain', buffer: Buffer.from(TRANSCRIPTION) },
    ])
    // The claim only means anything once matches may check themselves off at all.
    await expect(page.getByTestId('gt-ordered')).toHaveCount(0)
    await page.getByTestId('gt-autocheck').check()
    await page.getByTestId('gt-ordered').check()
    await page.getByRole('button', { name: 'Create job' }).click()
    await expect(page).toHaveURL(/\/jobs\/[0-9a-f]{12}$/)
    const jobId = page.url().split('/').pop()!
    await waitForJobStatus(jobId, 'done')

    const [pageId] = await jobPageIds(jobId)
    const lines = await pageLines(jobId, pageId)
    const byText = (t: string) => lines.find((l) => l.text === t)!

    // The exact match checks off as it always did...
    expect(byText('Sample Header line 1')).toMatchObject({
      corrected_text: 'Sample Header line 1', checked: true,
    })
    // ...and so does the near match, which the strict rule leaves for a human: it
    // follows the first match in both sequences, so the pairing is the right one.
    expect(byText('Sample Paragraph line 2')).toMatchObject({
      corrected_text: 'Sample Paragraf line 2', checked: true,
    })
    // Reading order is evidence about a pair, never a reason to invent one: the
    // garbage line matches nothing here just as it does under the strict rule.
    for (const text of ['Sample Header line 2', 'Sample Header line 3',
                        'Sample Paragraph line 1', 'Sample Paragraph line 3']) {
      expect(byText(text)).toMatchObject({ corrected_text: null, checked: false })
    }

    const counters = (await getJob(jobId)).counters
    expect(counters.gt_total).toBe(3)
    expect(counters.gt_matched).toBe(2)
  })
})

test.describe("Scenario: ingesting a PDF that carries its own text layer", () => {
  test('the text layer is offered only for PDFs, and once accepted it aligns like a sidecar', async ({ page }) => {
    const name = uniqueName('PDF transcript')
    await page.goto('/new')
    await withLayoutPerCrop(page)
    await page.getByLabel('Job name').fill(name)

    // An image on its own carries no text layer, so nothing may be offered...
    await page.locator('input[type="file"]').setInputFiles([
      { name: 'folio_1.png', mimeType: 'image/png', buffer: scanPng() },
    ])
    await expect(page.getByTestId('gt-from-pdf')).toHaveCount(0)

    // ...and the offer appears as soon as a PDF joins the upload.
    await page.locator('input[type="file"]').setInputFiles([
      { name: 'volume.pdf', mimeType: 'application/pdf', buffer: textPdf([TRANSCRIPTION.split('\n')]) },
    ])
    await expect(page.getByTestId('gt-from-pdf')).toHaveCount(1)
    await page.getByTestId('gt-from-pdf').check()
    await page.getByRole('button', { name: 'Create job' }).click()

    await expect(page).toHaveURL(/\/jobs\/[0-9a-f]{12}$/)
    const jobId = page.url().split('/').pop()!
    await waitForJobStatus(jobId, 'done')

    // The PDF page is the one expanded out of the document; the plain image is not.
    const job = await getJob(jobId)
    const pdfPage = job.pages.find((p: { filename: string }) => p.filename.startsWith('volume_p0001'))!
    const imagePage = job.pages.find((p: { filename: string }) => p.filename === 'folio_1.png')!

    const lines = await pageLines(jobId, pdfPage.id)
    const byText = (t: string) => lines.find((l) => l.text === t)!
    expect(byText('Sample Header line 1').corrected_text).toBe('Sample Header line 1')
    expect(byText('Sample Paragraph line 2').corrected_text).toBe('Sample Paragraf line 2')

    // The image page had no text layer of its own, so it must come through untouched.
    const untouched = await pageLines(jobId, imagePage.id)
    expect(untouched).toHaveLength(6)
    expect(untouched.filter((l) => l.corrected_text !== null)).toEqual([])

    expect(job.counters.gt_total).toBe(3)
    expect(job.counters.gt_matched).toBe(2)
  })

  test('a PDF text layer is never auto-checked, even alongside a sidecar that is', async ({ page }) => {
    // One job, one autocheck setting, two provenances - so the only thing that can
    // explain a difference in `checked` is where the transcription came from.
    const name = uniqueName('PDF vs sidecar')
    await page.goto('/new')
    await withLayoutPerCrop(page)
    await page.getByLabel('Job name').fill(name)
    await page.locator('input[type="file"]').setInputFiles([
      { name: 'folio_1.png', mimeType: 'image/png', buffer: scanPng() },
      { name: 'folio_1.txt', mimeType: 'text/plain', buffer: Buffer.from(TRANSCRIPTION) },
      { name: 'volume.pdf', mimeType: 'application/pdf', buffer: textPdf([TRANSCRIPTION.split('\n')]) },
    ])
    await page.getByTestId('gt-autocheck').check()
    await page.getByTestId('gt-from-pdf').check()
    await page.getByRole('button', { name: 'Create job' }).click()

    await expect(page).toHaveURL(/\/jobs\/[0-9a-f]{12}$/)
    const jobId = page.url().split('/').pop()!
    await waitForJobStatus(jobId, 'done')

    const job = await getJob(jobId)
    const idOf = (prefix: string) =>
      job.pages.find((p: { filename: string }) => p.filename.startsWith(prefix))!.id
    const exactMatch = async (prefix: string) =>
      (await pageLines(jobId, idOf(prefix))).find((l) => l.text === 'Sample Header line 1')!

    // The hand-written sidecar is trusted enough to mark reviewed...
    expect(await exactMatch('folio_1')).toMatchObject({
      corrected_text: 'Sample Header line 1', checked: true,
    })
    // ...the PDF's own text layer fills the correction in but never claims review,
    // despite being the identical string at the identical score.
    expect(await exactMatch('volume_p0001')).toMatchObject({
      corrected_text: 'Sample Header line 1', checked: false,
    })

    expect(job.counters.gt_total).toBe(6)
    expect(job.counters.gt_matched).toBe(4)
  })
})
