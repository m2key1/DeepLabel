import { test, expect } from '../helpers/test'
import { createDataset } from '../helpers/new-dataset'
import { backendFetch, getJob, uniqueName, waitForJobStatus } from '../helpers/api'
import { scanPng } from '../helpers/image'
import { openDatasetMenu } from '../helpers/dataset'

interface PageRow { id: number; filename: string; status: string }

async function createFromUpload(page: import('@playwright/test').Page, name: string,
                                files: { name: string; buffer: Buffer }[]): Promise<string> {
  await page.goto('/new')
  await page.getByLabel('Job name').fill(name)
  await page.locator('input[type="file"]').setInputFiles(
    files.map((f) => ({ name: f.name, mimeType: 'image/png', buffer: f.buffer })))
  await createDataset(page)
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

test.describe('Scenario: a volume uploaded in parts by the client', () => {
  test('the dataset waits as uploading until its owner starts it', async ({ page }) => {
    const form = new FormData()
    form.append('name', uniqueName('Held volume'))
    form.append('hold', 'true')
    form.append('files', new Blob([new Uint8Array(scanPng(600, 800, 41))], { type: 'image/png' }), 'scan_1.png')
    const { job_id: jobId } = await backendFetch('/api/jobs', { method: 'POST', body: form })
    const more = new FormData()
    more.append('files', new Blob([new Uint8Array(scanPng(600, 800, 42))], { type: 'image/png' }), 'scan_2.png')
    await backendFetch(`/api/jobs/${jobId}/pages/upload`, { method: 'POST', body: more })

    await page.goto(`/jobs/${jobId}`)
    await expect(page.getByTestId('status-badge')).toHaveText('uploading')
    // Re-running would start it on part of its pages: only the start is offered.
    const run = await openDatasetMenu(page, 'dataset-run')
    await expect(run.getByTestId('llm-read-open')).toBeVisible()
    await expect(run.getByTestId('rerun-open')).toHaveCount(0)
    await page.keyboard.press('Escape')
    expect((await getJob(jobId)).status).toBe('uploading')

    await page.getByTestId('start-job').click()
    await expect(page.getByTestId('phase-strip')).toHaveAttribute('data-status', 'done', { timeout: 30_000 })
    // Done is said by the steps' checks; the status chip only stands in for what they cannot say.
    await expect(page.getByTestId('status-badge')).toHaveCount(0)
    const job = await waitForJobStatus(jobId, 'done')
    expect(job.pages.map((p: PageRow) => p.filename).sort()).toEqual(['scan_1.png', 'scan_2.png'])
    await expect(page.getByTestId('start-job')).toHaveCount(0)
    await expect((await openDatasetMenu(page, 'dataset-run')).getByTestId('rerun-open')).toBeVisible()
  })
})
