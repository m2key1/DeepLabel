import { test, expect } from '../helpers/test'
import { createDataset, wizardStep } from '../helpers/new-dataset'
import { backendFetch, getJob, getPageDetail, uniqueName, waitForJobStatus } from '../helpers/api'
import { scanPng } from '../helpers/image'
import { textPdf } from '../helpers/pdf'

test.describe('Scenario: the upload form says what becomes of each text file', () => {
  test('a .txt beside a PDF is announced as a corpus document, and filed as one', async ({ page }) => {
    const name = uniqueName('Texts beside a PDF')
    await page.goto('/new')
    await page.getByLabel('Job name').fill(name)
    await page.locator('input[type="file"]').setInputFiles([
      { name: 'folio_1.png', mimeType: 'image/png', buffer: scanPng() },
      { name: 'folio_1.txt', mimeType: 'text/plain', buffer: Buffer.from('Sample Header line 1') },
      { name: 'volume.pdf', mimeType: 'application/pdf', buffer: textPdf([['Volume text']]) },
      { name: 'volume.txt', mimeType: 'text/plain', buffer: Buffer.from('A whole letter') },
    ])

    await expect(page.getByTestId('gt-pairing')).toContainText('Transcriptions found for 1 page -')
    await expect(page.getByTestId('corpus-documents')).toContainText(
      '1 text file is named after no image and is kept as a corpus document')
    await expect(page.getByTestId('corpus-documents')).toContainText('volume.txt')

    await createDataset(page)
    await expect(page).toHaveURL(/\/jobs\/[0-9a-f]{12}$/)
    const jobId = page.url().split('/').pop()!
    await waitForJobStatus(jobId, 'done')

    const { documents } = await backendFetch(`/api/jobs/${jobId}/documents`)
    expect(documents.map((d: { name: string }) => d.name)).toEqual(['volume'])
    const pages = (await getJob(jobId)).pages as { filename: string }[]
    expect(pages.map((p) => p.filename.replace(/\.[^.]+$/, '')).sort()).toEqual(['folio_1', 'volume_p0001'])
  })

  test('a PDF on its own is enough to create a dataset', async ({ page }) => {
    const name = uniqueName('A PDF alone')
    await page.goto('/new')
    await page.getByLabel('Job name').fill(name)
    await expect(page.getByText('Select at least one image or PDF')).toBeVisible()
    await page.locator('input[type="file"]').setInputFiles([
      { name: 'volume.pdf', mimeType: 'application/pdf', buffer: textPdf([['Volume text']]) },
    ])

    await expect(page.getByText('Select at least one image or PDF')).toHaveCount(0)
    await createDataset(page)
    await expect(page).toHaveURL(/\/jobs\/[0-9a-f]{12}$/)
    const jobId = page.url().split('/').pop()!
    await waitForJobStatus(jobId, 'done')

    const pages = (await getJob(jobId)).pages as { filename: string }[]
    expect(pages.map((p) => p.filename.replace(/\.[^.]+$/, ''))).toEqual(['volume_p0001'])
  })
})

type Line = { text: string; corrected_text: string | null }

async function correctedLines(jobId: string, pageId: number): Promise<string[]> {
  const detail = await getPageDetail(jobId, pageId)
  return detail.elements.flatMap((e: { lines: Line[] }) => e.lines)
    .map((l: Line) => l.corrected_text).filter((t: string | null): t is string => t !== null)
}

async function pagesByStem(jobId: string): Promise<Record<string, number>> {
  const pages = (await getJob(jobId)).pages as { id: number; filename: string }[]
  return Object.fromEntries(pages.map((p) => [p.filename.replace(/\.[^.]+$/, ''), p.id]))
}

test.describe('Scenario: the form follows the backend in what a text file is for', () => {
  test('a .txt named after a PDF page, or a scan in any case, is that page\'s transcription',
    async ({ page }) => {
      const name = uniqueName('Text for a PDF page')
      await page.goto('/new')
      await page.getByLabel('Job name').fill(name)
      await page.locator('input[type="file"]').setInputFiles([
        { name: 'volume.pdf', mimeType: 'application/pdf', buffer: textPdf([['First'], ['Second']]) },
        { name: 'volume_p0002.txt', mimeType: 'text/plain', buffer: Buffer.from('Sample Header line 1') },
        { name: 'volume.txt', mimeType: 'text/plain', buffer: Buffer.from('A whole letter') },
        { name: 'LEAF_2.png', mimeType: 'image/png', buffer: scanPng() },
        { name: 'leaf_2.TXT', mimeType: 'text/plain', buffer: Buffer.from('Sample Header line 2') },
      ])

      await expect(page.getByTestId('gt-pairing')).toContainText('Transcriptions found for 2 pages -')
      const corpus = page.getByTestId('corpus-documents')
      await expect(corpus).toContainText('1 text file is named after no image')
      await expect(corpus).toContainText('volume.txt')
      await expect(corpus).not.toContainText('volume_p0002.txt')
      await expect(corpus).not.toContainText('leaf_2.TXT')

      await createDataset(page)
      await expect(page).toHaveURL(/\/jobs\/[0-9a-f]{12}$/)
      const jobId = page.url().split('/').pop()!
      await waitForJobStatus(jobId, 'done')

      const { documents } = await backendFetch(`/api/jobs/${jobId}/documents`)
      expect(documents.map((d: { name: string }) => d.name)).toEqual(['volume'])
      const pages = await pagesByStem(jobId)
      expect(Object.keys(pages).sort()).toEqual(['LEAF_2', 'volume_p0001', 'volume_p0002'])
      expect(await correctedLines(jobId, pages.LEAF_2)).toEqual(['Sample Header line 2'])
      expect(await correctedLines(jobId, pages.volume_p0002)).toEqual(['Sample Header line 1'])
      expect(await correctedLines(jobId, pages.volume_p0001)).toEqual([])
    })
})

test.describe('Scenario: with reading off the form promises no matching', () => {
  test('transcriptions, corpus documents and a PDF\'s text layer are said to wait for a reading',
    async ({ page }) => {
      const name = uniqueName('Kept unread')
      await page.goto('/new')
      await page.getByLabel('Job name').fill(name)
      await page.locator('input[type="file"]').setInputFiles([
        { name: 'folio_1.png', mimeType: 'image/png', buffer: scanPng() },
        { name: 'folio_1.txt', mimeType: 'text/plain', buffer: Buffer.from('Sample Header line 1') },
        { name: 'letter.txt', mimeType: 'text/plain', buffer: Buffer.from('A whole letter') },
        { name: 'volume.pdf', mimeType: 'application/pdf', buffer: textPdf([['Volume text']]) },
      ])
      const pairing = page.getByTestId('gt-pairing')
      const corpus = page.getByTestId('corpus-documents')
      const unread = 'OCR is off for this dataset, so nothing is matched or cut until its pages are read.'
      await expect(pairing).toContainText('after reading, each transcription line is matched')
      await expect(page.getByTestId('gt-autocheck')).toBeVisible()
      await expect(corpus).toContainText('cut onto the pages they cover after reading')
      await expect(page.getByTestId('reading-off')).toHaveCount(0)

      // Reading is chosen on the next step; the files' step then says what waits for it.
      await wizardStep(page, 'run')
      await page.getByRole('checkbox', { name: /^OCR/ }).uncheck()
      await wizardStep(page, 'source')
      await expect(pairing).toHaveText('Transcriptions found for 1 page - kept with their pages, '
        + 'to be matched to the recognized lines once the pages are read.')
      await expect(page.getByTestId('gt-autocheck')).toHaveCount(0)
      await expect(corpus).not.toContainText('after reading')
      await expect(page.getByTestId('reading-off')).toHaveText(unread)
      await expect(page.getByTestId('gt-from-pdf')).toBeVisible()

      // Line detection off takes reading with it, and the form says the same.
      await wizardStep(page, 'run')
      await page.getByRole('checkbox', { name: /^OCR/ }).check()
      await wizardStep(page, 'source')
      await expect(page.getByTestId('reading-off')).toHaveCount(0)
      await wizardStep(page, 'run')
      await page.getByRole('checkbox', { name: /^Line segmentation/ }).uncheck()
      await wizardStep(page, 'source')
      await expect(page.getByTestId('reading-off')).toHaveText(unread)

      await createDataset(page)
      await expect(page).toHaveURL(/\/jobs\/[0-9a-f]{12}$/)
      const jobId = page.url().split('/').pop()!
      await waitForJobStatus(jobId, 'done')
      const job = await getJob(jobId)
      expect([job.run_layout, job.run_lines, job.run_ocr]).toEqual([false, false, false])
      const { documents } = await backendFetch(`/api/jobs/${jobId}/documents`)
      expect(documents.map((d: { name: string }) => d.name)).toEqual(['letter'])
    })
})

test.describe('Scenario: an export zip in a mixed selection', () => {
  test('the form names what the import leaves out, and a removed file is not sent', async ({ page }) => {
    const name = uniqueName('Mixed selection')
    await page.goto('/new')
    await page.getByLabel('Job name').fill(name)
    await page.locator('input[type="file"]').setInputFiles([
      { name: 'one.zip', mimeType: 'application/zip', buffer: Buffer.from('PK') },
      { name: 'two.zip', mimeType: 'application/zip', buffer: Buffer.from('PK') },
      { name: 'extra.png', mimeType: 'image/png', buffer: scanPng() },
    ])
    const notice = page.getByTestId('import-notice')
    await expect(notice).toBeVisible()
    await expect(page.getByTestId('import-ignored'))
      .toHaveText('Only one.zip is imported; left out: two.zip, extra.png.')
    await expect(page.getByTestId('wizard-step-run')).toHaveAttribute('data-skipped', 'true')

    await page.getByRole('button', { name: 'Remove one.zip' }).click()
    await expect(page.getByTestId('import-ignored'))
      .toHaveText('Only two.zip is imported; left out: extra.png.')
    await page.getByRole('button', { name: 'Remove two.zip' }).click()
    await expect(notice).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Remove extra.png' })).toBeVisible()

    await createDataset(page)
    await expect(page).toHaveURL(/\/jobs\/[0-9a-f]{12}$/)
    const jobId = page.url().split('/').pop()!
    await waitForJobStatus(jobId, 'done')
    expect(Object.keys(await pagesByStem(jobId))).toEqual(['extra'])
  })
})
