import { test, expect } from '../helpers/test'
import { backendFetch, getJob, patchJob, uniqueName, waitForJobStatus } from '../helpers/api'
import { scanPng } from '../helpers/image'

const PAGES = 2

async function datasetWithoutLayout(name: string): Promise<string> {
  const form = new FormData()
  form.append('name', name)
  form.append('run_layout', 'false')
  for (let i = 0; i < PAGES; i++) {
    form.append('files', new Blob([new Uint8Array(scanPng(undefined, undefined, i))], { type: 'image/png' }),
                `scan_${i + 1}.png`)
  }
  const { job_id: jobId } = await backendFetch('/api/jobs', { method: 'POST', body: form })
  await waitForJobStatus(jobId, 'done', 90_000)
  return jobId
}

test.describe('Scenario: a step switched on after the pages went through', () => {
  test('the dataset offers layout on the pages it passed by, and runs it there (#138)', async ({ page }) => {
    test.setTimeout(180_000)
    const name = uniqueName('Layout later')
    const jobId = await datasetWithoutLayout(name)
    // Passed by, not done: the step's count says so on the backend before anything is offered.
    expect((await getJob(jobId)).counters.pages_layout_done).toBe(0)
    expect(await backendFetch(`/api/jobs/${jobId}/steps-not-run`)).toEqual({ layout: 0, lines: 0, ocr: 0 })

    await page.goto(`/jobs/${jobId}`)
    await expect(page.getByTestId('phase-strip')).toHaveAttribute('data-status', 'done')
    await expect(page.getByTestId('steps-not-run')).toHaveCount(0)

    await patchJob(jobId, { run_layout: true })
    expect(await backendFetch(`/api/jobs/${jobId}/steps-not-run`)).toEqual({ layout: PAGES, lines: 0, ocr: 0 })
    await page.reload()
    const banner = page.getByTestId('steps-not-run')
    await expect(banner).toContainText(`Layout has not run on ${PAGES} pages`)

    await banner.getByTestId('steps-not-run-open').click()
    await expect(page.locator('[data-testid="rerun-phase"][data-phase="layout"]')).toBeChecked()
    await expect(page.getByTestId('rerun-only-missing')).toBeChecked()
    await page.getByTestId('rerun-confirm').click()

    await expect.poll(async () => (await getJob(jobId)).status, { timeout: 90_000 }).toBe('done')
    await expect.poll(async () => (await getJob(jobId)).counters.pages_layout_done).toBe(PAGES)
    expect(await backendFetch(`/api/jobs/${jobId}/steps-not-run`)).toEqual({ layout: 0, lines: 0, ocr: 0 })
    await expect(page.getByTestId('phase-strip')).toHaveAttribute('data-status', 'done')
    await expect(page.getByTestId('phase-strip').locator('[data-phase="layout"]')).toContainText(`${PAGES}/${PAGES}`)
    await expect(banner).toHaveCount(0)
  })
})
