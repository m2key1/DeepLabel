import { test, expect } from '../helpers/test'
import { getJob, uniqueName, waitForJobStatus } from '../helpers/api'
import { scanPng } from '../helpers/image'

interface PageRow { id: number; filename: string; status: string }

async function createFromUpload(page: import('@playwright/test').Page, name: string,
                                files: { name: string; buffer: Buffer }[]): Promise<string> {
  await page.goto('/new')
  await page.getByLabel('Job name').fill(name)
  await page.locator('input[type="file"]').setInputFiles(
    files.map((f) => ({ name: f.name, mimeType: 'image/png', buffer: f.buffer })))
  await page.getByRole('button', { name: 'Create job' }).click()
  await expect(page).toHaveURL(/\/jobs\/[0-9a-f]{12}$/)
  return page.url().split('/').pop()!
}

test.describe('Scenario: what ingest makes of the scans uploaded', () => {
  test('one unreadable scan fails its own page and the dataset names it', async ({ page }) => {
    const jobId = await createFromUpload(page, uniqueName('One empty scan'), [
      { name: 'a.png', buffer: scanPng(600, 800, 1) },
      { name: 'b.png', buffer: Buffer.alloc(0) },
      { name: 'c.png', buffer: scanPng(600, 800, 2) },
    ])

    await waitForJobStatus(jobId, 'done')
    await expect.poll(async () => ((await getJob(jobId)).pages as PageRow[])
      .map((p) => [p.filename, p.status])).toEqual([['a.png', 'done'], ['b.png', 'unreadable'], ['c.png', 'done']])
    const job = await getJob(jobId)
    const empty = (job.pages as PageRow[])[1]
    expect(job.unreadable).toEqual([{ id: empty.id, filename: 'b.png', error: 'b.png could not be read: the file is empty' }])
    expect(job.pages_live).toBe(2)

    await expect(page.getByTestId('unreadable-pages')).toHaveText(
      'One file could not be read as an image and was left out - delete it and upload a readable copy.'
      + 'b.png could not be read: the file is empty')
    await expect(page.locator(`[data-page-row="${empty.id}"]`).getByTestId('page-unreadable')).toHaveText('unreadable')
    await expect(page.getByTestId('page-unreadable')).toHaveCount(1)
  })

  test('unpadded page numbers are put in natural order', async ({ page }) => {
    const jobId = await createFromUpload(page, uniqueName('Unpadded numbers'), [
      { name: 'scan_10.png', buffer: scanPng(600, 800, 3) },
      { name: 'scan_2.png', buffer: scanPng(600, 800, 4) },
      { name: 'scan_1.png', buffer: scanPng(600, 800, 5) },
    ])

    await waitForJobStatus(jobId, 'done')
    const pages = (await getJob(jobId)).pages as (PageRow & { idx: number })[]
    expect(pages.map((p) => [p.idx, p.filename])).toEqual([[0, 'scan_1.png'], [1, 'scan_2.png'], [2, 'scan_10.png']])

    const rows = page.locator('[data-page-row]')
    await expect(rows).toHaveCount(3)
    expect(await rows.evaluateAll((els) => els.map((el) => Number(el.getAttribute('data-page-row')))))
      .toEqual(pages.map((p) => p.id))
  })
})
