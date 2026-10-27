import type { Page, Route } from '@playwright/test'
import { test, expect } from '../helpers/test'
import { backendFetch, createJob, getJob, seedCompletedJob, uniqueName, waitForJobStatus } from '../helpers/api'

const liveRows = async (jobId: string) =>
  (await backendFetch(`/api/jobs/${jobId}/page-rows`)).matched as number

/** Spoils the next `times` reads of the table's rows with `spoil`; every read after them
 *  reaches the server. Returns how many reads the page has made. */
async function spoilRowReads(page: Page, jobId: string, times: number, spoil: (route: Route) => Promise<void>) {
  let reads = 0
  await page.route((url) => url.pathname === `/api/jobs/${jobId}/page-rows`, (route) => {
    reads += 1
    return reads <= times ? spoil(route) : route.continue()
  })
  return () => reads
}

test.describe('Scenario: the page table agrees with the dataset however its rows read went', () => {
  test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: 'ignoreErrors' })
  })

  test('a rows read lost as the page is reloaded at the end of a run is read again', async ({ page }) => {
    const jobId = await createJob(uniqueName('Reloaded at the end'), 3)
    await page.goto(`/jobs/${jobId}`)
    await waitForJobStatus(jobId, 'done')
    await expect.poll(() => liveRows(jobId)).toBe(3)
    expect((await getJob(jobId)).pages_live).toBe(3)

    const reads = await spoilRowReads(page, jobId, 1, (route) => route.abort('internetdisconnected'))
    await page.reload()

    await expect(page.getByTestId('phase-strip')).toHaveAttribute('data-status', 'done')
    await expect(page.locator('[data-page-row]')).toHaveCount(3)
    await expect(page.getByTestId('page-filter-all')).toHaveText('All · 3')
    expect(reads()).toBe(2)
  })

  test('a rows read the server fails is read again, and again, until it answers', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Rows refused'), 2)
    await expect.poll(() => liveRows(jobId)).toBe(2)

    const reads = await spoilRowReads(page, jobId, 2, (route) =>
      route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ detail: 'busy' }) }))
    await page.goto(`/jobs/${jobId}`)

    await expect(page.locator('[data-page-row]')).toHaveCount(2)
    await expect(page.getByTestId('page-filter-all')).toHaveText('All · 2')
    expect(reads()).toBe(3)
  })

  test('a rows read that never answers is given up after half a minute and asked again', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Rows hanging'), 2)
    await expect.poll(() => liveRows(jobId)).toBe(2)

    const reads = await spoilRowReads(page, jobId, 1, () => new Promise<void>(() => {}))
    await page.clock.install()
    await page.goto(`/jobs/${jobId}`)
    await expect.poll(reads).toBe(1)
    await expect(page.getByText('No pages yet.')).toBeVisible()

    await page.clock.runFor(29_000)
    expect(reads()).toBe(1)
    await page.clock.runFor(2_000 + 1_000)

    await expect(page.locator('[data-page-row]')).toHaveCount(2)
    await expect(page.getByTestId('page-filter-all')).toHaveText('All · 2')
    expect(reads()).toBe(2)
  })

  test('a rows read refused for good is not asked again', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Rows forbidden'), 1)
    const reads = await spoilRowReads(page, jobId, 1, (route) =>
      route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ detail: 'not permitted' }) }))
    await page.goto(`/jobs/${jobId}`)

    await expect(page.getByText('not permitted')).toBeVisible()
    await expect(page.getByText('No pages yet.')).toBeVisible()
    await page.waitForTimeout(3_000)
    expect(reads()).toBe(1)
  })
})
