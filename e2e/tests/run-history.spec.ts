import { test, expect } from '../helpers/test'
import { backendFetch, jobPageIds, pageLines, seedCompletedJob, uniqueName, waitForJobStatus } from '../helpers/api'

const lines = (n: number) => `${n} ${n === 1 ? 'line' : 'lines'}`
const lineIds = async (jobId: string, pageId: number) => (await pageLines(jobId, pageId)).map((l) => l.id).sort((a, b) => a - b)

test.describe('Scenario: taking back a run', () => {
  test('a re-detection is reverted from the History tab, and the lines it replaced come back (#39)', async ({ page }) => {
    test.setTimeout(150_000)
    const jobId = await seedCompletedJob(uniqueName('Revert a run'), 1)
    const [pageId] = await jobPageIds(jobId)
    const before = await lineIds(jobId, pageId)
    expect(before.length).toBeGreaterThan(0)

    await backendFetch(`/api/jobs/${jobId}/rerun`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from_phase: 'lines' }),
    })
    await waitForJobStatus(jobId, 'done', 90_000)
    const detected = await lineIds(jobId, pageId)
    expect(detected.filter((id) => before.includes(id))).toEqual([])

    await page.goto(`/jobs/${jobId}`)
    await page.getByTestId('dataset-views').locator('[data-view="history"]').click()
    const runs = page.getByTestId('run')
    await expect(runs).toHaveCount(2)
    const rerun = runs.first()
    await expect(rerun).toContainText('Re-run from Lines')
    await expect(runs.last()).toContainText('First run')
    await expect(rerun.getByTestId('run-changed')).toHaveText(`changed ${lines(before.length + detected.length)}`)

    // What it changed: its pages in the table, and its lines in Review.
    const runId = Number(await rerun.getAttribute('data-run'))
    const queue = await backendFetch(`/api/jobs/${jobId}/review?run=${runId}`)
    expect(queue.lines.map((l: { id: number }) => l.id).sort((a: number, b: number) => a - b)).toEqual(detected)
    await rerun.getByTestId('run-pages').click()
    await expect(page.getByTestId(`page-filter-run:${runId}`)).toHaveText('Last changed by a run · 1')
    await expect(page.getByRole('row').filter({ has: page.locator('[data-status]') })).toHaveCount(1)
    await page.goBack()
    await rerun.getByTestId('run-review').click()
    await expect(page).toHaveURL(new RegExp(`/jobs/${jobId}/pages/${pageId}\\?review=0.85&run=${runId}$`))
    await expect(page.getByTestId('review-run')).toHaveText('lines a run changed')
    await page.goBack()

    await rerun.getByTestId('run-revert-open').click()
    const preview = page.getByTestId('run-revert-preview')
    await expect(preview).toContainText(`${lines(before.length)} go back to how they stood before it`)
    await expect(preview).toContainText(`${lines(detected.length)} it made are taken off the pages`)
    await page.getByTestId('run-revert-confirm').click()

    await expect.poll(() => lineIds(jobId, pageId)).toEqual(before)
    await expect(rerun.getByTestId('run-reverted')).toBeVisible()
    await expect(rerun.getByTestId('run-revert-open')).toHaveCount(0)
    await expect(runs.last().getByTestId('run-revert-open')).toHaveCount(1)
  })
})
