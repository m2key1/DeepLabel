import { test, expect } from '../helpers/test'
import { createDataset } from '../helpers/new-dataset'
import { getJob, uniqueName } from '../helpers/api'
import { scanPng } from '../helpers/image'
import { textPdf } from '../helpers/pdf'

test.describe('Scenario: taking part of a PDF', () => {
  test('a PDF opens as its pages on the Pages step, and only the pages left in are uploaded (#46)', async ({ page }) => {
    const name = uniqueName('Part of a PDF')
    await page.goto('/new')
    await page.getByLabel('Job name').fill(name)
    await page.locator('input[type="file"]').setInputFiles([
      { name: 'folio.png', mimeType: 'image/png', buffer: scanPng() },
      { name: 'volume.pdf', mimeType: 'application/pdf', buffer: textPdf([['Cover'], ['Page two'], ['Blank'], ['Page four']]) },
    ])
    await page.getByTestId('wizard-next').click()

    const picks = page.getByTestId('page-pick')
    await expect(picks).toHaveCount(5)
    expect(await picks.evaluateAll((tiles) => tiles.map((t) => t.getAttribute('data-file')))).toEqual(
      ['folio.png', 'volume.pdf · p. 1', 'volume.pdf · p. 2', 'volume.pdf · p. 3', 'volume.pdf · p. 4'])
    // Each page is drawn from the PDF in the browser, nothing uploaded yet.
    await expect(picks.nth(1).locator('canvas')).toHaveAttribute('data-rendered', 'true')
    expect(await picks.nth(1).locator('canvas').evaluate((c: HTMLCanvasElement) => c.width)).toBeGreaterThan(0)
    await expect(page.getByTestId('page-picker-count')).toHaveText('5 of 5 pages included')

    await page.getByRole('checkbox', { name: 'volume.pdf · p. 1' }).uncheck()
    await page.getByRole('checkbox', { name: 'volume.pdf · p. 3' }).uncheck()
    await expect(page.getByTestId('page-picker-count')).toHaveText('3 of 5 pages included')

    await createDataset(page)
    await expect(page).toHaveURL(/\/jobs\/[0-9a-f]{12}$/)
    const jobId = page.url().split('/').pop()!
    await expect.poll(async () => ((await getJob(jobId)).pages as { filename: string }[]).map((p) => p.filename).sort())
      .toEqual(['folio.png', 'volume_p0002.png', 'volume_p0004.png'])
  })

  test('a range picks pages of a PDF by their place in the list', async ({ page }) => {
    await page.goto('/new')
    await page.getByLabel('Job name').fill(uniqueName('A range of a PDF'))
    await page.locator('input[type="file"]').setInputFiles([
      { name: 'volume.pdf', mimeType: 'application/pdf', buffer: textPdf([['One'], ['Two'], ['Three'], ['Four'], ['Five']]) },
    ])
    await page.getByTestId('wizard-next').click()
    await expect(page.getByTestId('page-pick')).toHaveCount(5)
    await page.getByTestId('page-range').fill('2-3, 5')
    await page.getByRole('button', { name: 'Apply' }).click()
    expect(await page.getByTestId('page-pick').evaluateAll((tiles) => tiles.map((t) => t.getAttribute('data-included'))))
      .toEqual(['false', 'true', 'true', 'false', 'true'])

    await createDataset(page)
    await expect(page).toHaveURL(/\/jobs\/[0-9a-f]{12}$/)
    const jobId = page.url().split('/').pop()!
    await expect.poll(async () => ((await getJob(jobId)).pages as { filename: string }[]).map((p) => p.filename).sort())
      .toEqual(['volume_p0002.png', 'volume_p0003.png', 'volume_p0005.png'])
  })

  test('two files of one name are picked apart, and PDFs that share a name go whole', async ({ page }) => {
    await page.goto('/new')
    await page.getByLabel('Job name').fill(uniqueName('Twin names'))
    await page.locator('input[type="file"]').setInputFiles([
      { name: 'scan.png', mimeType: 'image/png', buffer: scanPng() },
      { name: 'scan.png', mimeType: 'image/png', buffer: scanPng(undefined, undefined, 1) },
      { name: 'volume.pdf', mimeType: 'application/pdf', buffer: textPdf([['One'], ['Two']]) },
      { name: 'volume.pdf', mimeType: 'application/pdf', buffer: textPdf([['Uno'], ['Due'], ['Tre']]) },
    ])
    await page.getByTestId('wizard-next').click()
    const picks = page.getByTestId('page-pick')
    // A pick is sent by file name, so two PDFs of one name could not be told apart: whole.
    await expect(picks).toHaveCount(4)
    expect(await picks.evaluateAll((tiles) => tiles.map((t) => t.getAttribute('data-file'))))
      .toEqual(['scan.png', 'scan.png', 'volume.pdf', 'volume.pdf'])
    await expect(page.getByText('PDFs that share a name are taken whole.')).toBeVisible()
    await picks.nth(0).getByRole('checkbox').uncheck()
    expect(await picks.evaluateAll((tiles) => tiles.map((t) => t.getAttribute('data-included'))))
      .toEqual(['false', 'true', 'true', 'true'])
  })
})
