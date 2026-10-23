import type { Page, Route } from '@playwright/test'
import { test, expect } from '../helpers/test'
import {
  backendFetch, createGroup, listTrainings, markLinesChecked, moveJobToGroup, seedCompletedJob,
  uniqueName,
} from '../helpers/api'
import { cancelledRun, pickDataset } from '../helpers/training'

const refuse = (status: number, detail: string) => (route: Route) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ detail }) })

const sharing = async (page: Page) =>
  (await (await page.request.get('/api/settings')).json()).share_activity

test.describe('Scenario: a request the server refuses is said, not swallowed', () => {
  test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: 'ignoreErrors' })
    await page.request.patch('/api/settings', { data: { share_activity: true } })
  })

  test('a settings save that fails is put back and says why', async ({ page }) => {
    await page.request.patch('/api/settings', { data: { share_activity: true } })
    await page.route('**/api/settings', (route) => route.request().method() === 'PATCH'
      ? refuse(503, 'the settings store is down')(route) : route.continue())

    await page.goto('/settings?section=together')
    const share = page.getByTestId('share-activity')
    await expect(share).toBeChecked()
    await share.click()

    await expect(page.getByTestId('settings-save-error'))
      .toHaveText('Your settings were not saved: the settings store is down')
    // Back at once, not at the next background re-read five seconds later.
    await expect(share).toBeChecked({ timeout: 1_000 })
    expect(await sharing(page)).toBe(true)
  })

  test('a settings save that fails is put back even when the settings cannot be read either', async ({ page }) => {
    await page.request.patch('/api/settings', { data: { share_activity: true } })
    await page.goto('/settings?section=together')
    const share = page.getByTestId('share-activity')
    await expect(share).toBeChecked()

    await page.route('**/api/settings', refuse(503, 'the settings store is down'))
    const reread = page.waitForResponse((r) => r.url().endsWith('/api/settings') && r.request().method() === 'GET')
    await share.click()

    await expect(page.getByTestId('settings-save-error'))
      .toHaveText('Your settings were not saved: the settings store is down')
    expect((await reread).status()).toBe(503)
    await expect(share).toBeChecked({ timeout: 1_000 })
    expect(await sharing(page)).toBe(true)
  })

  test('the dataset list keeps grouped datasets on screen when the groups do not load', async ({ page }) => {
    const groupName = uniqueName('Unloaded group')
    const jobName = uniqueName('In an unloaded group')
    const group = await createGroup(groupName)
    const jobId = await seedCompletedJob(jobName, 1)
    await moveJobToGroup(jobId, group.id)
    await page.route('**/api/groups', (route) => route.request().method() === 'GET'
      ? refuse(500, 'groups are unavailable')(route) : route.continue())

    await page.goto(`/?q=${encodeURIComponent(jobName)}`)
    await expect(page.getByRole('alert').filter({ hasText: 'Could not load the groups' }))
      .toHaveText('Could not load the groups: groups are unavailable')
    const fallback = page.locator('[data-testid="list-section"][data-title="Groups not loaded"]')
    await expect(fallback.getByText(jobName)).toBeVisible()
    expect((await backendFetch(`/api/jobs/${jobId}`)).group_id).toBe(group.id)
  })

  test('grouped datasets wait for their groups rather than being called not loaded', async ({ page }) => {
    const groupName = uniqueName('Slow group')
    const jobName = uniqueName('In a slow group')
    const group = await createGroup(groupName)
    const jobId = await seedCompletedJob(jobName, 1)
    await moveJobToGroup(jobId, group.id)
    let release: () => void = () => undefined
    const released = new Promise<void>((resolve) => { release = resolve })
    await page.route('**/api/groups', async (route) => {
      if (route.request().method() === 'GET') await released
      await route.continue()
    })
    const jobsListed = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/jobs')

    await page.goto(`/?q=${encodeURIComponent(jobName)}`)
    await jobsListed
    const fallback = page.locator('[data-testid="list-section"][data-title="Groups not loaded"]')
    const ownSection = page.locator('[data-testid="list-section"]').filter({ hasText: groupName })
    await expect(page.getByTestId('jobs-skeleton')).toHaveCount(0)
    await expect(fallback).toHaveCount(0)

    release()
    await expect(ownSection.getByText(jobName)).toBeVisible()
    await expect(fallback).toHaveCount(0)
  })

  test('the queue page says it could not be read instead of staying blank', async ({ page }) => {
    await page.clock.install()
    await page.route('**/api/queue', refuse(500, 'the queue is unreachable'))
    await page.goto('/queue')
    await expect(page.getByTestId('queue-error')).toHaveText('Could not read the queue: the queue is unreachable')
    const idle = page.getByTestId('queue-idle')
    await expect(idle).toHaveCount(0)

    // The next look gets through, onto a GPU with nothing on it.
    await page.unroute('**/api/queue')
    await page.route('**/api/queue', async (route) => {
      const response = await route.fetch()
      const queue = await response.json()
      await route.fulfill({ response, json: { ...queue, gpu: { ...queue.gpu, running: null, queued: [] } } })
    })
    await page.clock.runFor(3_000)
    await expect(page.getByTestId('queue-error')).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'Local GPU' })).toBeVisible()
    await expect(idle).toHaveText('The GPU is idle - nothing running.')
  })

  test("a run page's pre-flight that fails to load once is read again", async ({ page }) => {
    const runId = await cancelledRun('Preflight retried')
    let refused = 0
    await page.route(`**/api/trainings/${runId}/preflight`, (route) => {
      if (refused > 0) return route.continue()
      refused += 1
      return refuse(502, 'bad gateway')(route)
    })

    await page.goto(`/models/runs/${runId}?tab=data`)
    await expect(page.getByTestId('preflight')).toHaveAttribute('data-status', 'done')
    expect(refused).toBe(1)
    await expect(page.getByTestId('preflight-error')).toHaveCount(0)
    await expect(page.getByTestId('preflight-report')).toBeVisible()
  })

  test('a pre-flight refused for its settings says so and promises no run', async ({ page }) => {
    const datasetName = uniqueName('Refused settings')
    const jobId = await seedCompletedJob(datasetName, 1)
    await markLinesChecked(jobId, 6)
    const refusal = 'the selected datasets contain no checked material for this task'
    await page.route('**/api/trainings/preflights', (route) => route.request().method() === 'POST'
      ? refuse(400, refusal)(route) : route.continue())

    const modelName = uniqueName('Refused')
    await page.goto('/models/train?task=ocr')
    await page.getByLabel('Model name').fill(modelName)
    await pickDataset(page, datasetName)
    await expect(page.getByText('6 checked lines selected')).toBeVisible()
    await page.getByRole('button', { name: 'Next', exact: true }).click()

    const review = page.getByTestId('training-review')
    await expect(review.getByTestId('preflight')).toHaveAttribute('data-status', 'error')
    await expect(review.getByTestId('preflight-error')).toHaveText(`These settings were refused: ${refusal}.`)
    expect((await listTrainings()).filter((t) => t.name === modelName)).toEqual([])
  })
})
