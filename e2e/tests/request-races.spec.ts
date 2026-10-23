import type { Page, Request, Route } from '@playwright/test'
import { test, expect } from '../helpers/test'
import {
  backendFetch, deleteElement, getPageDetail, jobPageIds, seedCompletedJob, uniqueName,
} from '../helpers/api'
import { seedSession, userRecord } from '../helpers/session'
import { cancelledRun } from '../helpers/training'
import { openViewer } from '../helpers/viewer'

// Longer than the five-second poll every list page runs, so a quiet window this long
// means the poll really stopped rather than that it had not come round yet.
const QUIET_MS = 6_000
// A reply already delivered still has to be applied by React before it can be seen, and
// a request a timer sent still has to reach the test before it is counted.
const APPLY_MS = 500

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Stops the page's clock, installed before it loaded, so from here on its timers fire
 *  only as far as the test runs them. */
async function stopClock(page: Page) {
  await page.clock.pauseAt(Date.now() + 1_000)
}

/** How many requests of one method the page has made to exactly this path since now. */
function countRequests(page: Page, method: string, path: string): () => number {
  let seen = 0
  page.on('request', (request) => {
    if (request.method() === method && new URL(request.url()).pathname === path) seen += 1
  })
  return () => seen
}

/** Holds the first request a route matches until `release` is called; the rest pass. */
async function holdFirst(page: Page, url: string | ((url: URL) => boolean)) {
  let held: Route | null = null
  let arrived: () => void = () => undefined
  const reached = new Promise<void>((resolve) => { arrived = resolve })
  await page.route(url, (route) => {
    if (held) return route.continue()
    held = route
    arrived()
  })
  return {
    reached,
    request: (): Request => held!.request(),
    release: async () => {
      const delivered = page.waitForResponse((r) => r.request() === held!.request())
      await held!.continue()
      await delivered
      await pause(APPLY_MS)
    },
  }
}

async function setVisibility(page: Page, state: 'hidden' | 'visible') {
  await page.evaluate((next) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => next })
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => next === 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
  }, state)
}

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' })
})

test.describe('Scenario: an answer that arrives late does not overwrite a newer one', () => {
  test('a role change is not undone by a list read that left before it', async ({ page }) => {
    const username = `late-read-${Date.now()}`
    seedSession('viewer', username)
    await page.clock.install()
    await page.goto('/admin')
    const role = page.getByTestId('user-row').filter({ hasText: username }).locator('select')
    await expect(role).toHaveValue('viewer')

    // The page's own re-read, sent while the person is still viewer and answered late.
    let stale: { route: Route; body: string } | null = null
    let staleReady: () => void = () => undefined
    const staleHeld = new Promise<void>((resolve) => { staleReady = resolve })
    await page.route('**/api/users', async (route) => {
      if (route.request().method() !== 'GET' || stale) return route.continue()
      const response = await route.fetch()
      stale = { route, body: await response.text() }
      staleReady()
    })
    await page.clock.runFor(30_000)
    await staleHeld
    expect(stale!.body).toContain(`"username":"${username}"`)

    await role.selectOption('member')
    await expect.poll(async () => (await userRecord(page, username)).role).toBe('member')
    const delivered = page.waitForResponse((r) => r.request() === stale!.route.request())
    await stale!.route.fulfill({ status: 200, contentType: 'application/json', body: stale!.body })
    await delivered
    await pause(APPLY_MS)
    await expect(role).toHaveValue('member')
  })

  test("the transcription dialog's cost is the one for the scope now picked", async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Late cost'), 2)
    const [firstId] = await jobPageIds(jobId)
    await page.goto(`/jobs/${jobId}`)
    await page.locator(`[data-page-row="${firstId}"]`).getByRole('checkbox').check()

    const scoped = await holdFirst(page, (url) => url.pathname === `/api/jobs/${jobId}/llm/preview`)
    await page.getByTestId('bulk-llm-read').click()
    await scoped.reached
    expect(new URL(scoped.request().url()).searchParams.getAll('page_ids')).toEqual([String(firstId)])

    await page.getByTestId('llm-scope-all').click()
    const cost = page.getByTestId('llm-cost')
    await expect(cost).toContainText('over 2 pages')
    await scoped.release()
    await expect(cost).toContainText('over 2 pages')
  })

  test("the page's run menu never offers the last opening's numbers as current", async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Run menu costs'), 1)
    const [pageId] = await jobPageIds(jobId)
    await openViewer(page, jobId, pageId)
    const menu = page.getByTestId('run-menu')
    const lines = page.locator('[data-testid="run-phase"][data-phase="lines"]')
    await menu.click()
    await expect(lines).toContainText('replaces 6 lines')
    await expect(lines).toBeEnabled()
    await menu.click()
    await expect(page.getByTestId('run-menu-items')).toHaveCount(0)

    const costs = await holdFirst(page, (url) => url.pathname === `/api/pages/${pageId}/run`)
    await menu.click()
    await costs.reached
    await expect(lines).toContainText('reading…')
    await expect(lines).toBeDisabled()
    await costs.release()
    await expect(lines).toContainText('replaces 6 lines')
    await expect(lines).toBeEnabled()
  })

  test('the hover preview is read again after the page changed', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Preview refreshed'), 1)
    const [pageId] = await jobPageIds(jobId)
    const boxes = (await getPageDetail(jobId, pageId)).elements
      .filter((e: { kind: string }) => e.kind === 'content')
    expect(boxes).toHaveLength(2)

    await page.goto(`/jobs/${jobId}`)
    const drawn = page.locator('aside svg rect')
    await expect(drawn).toHaveCount(2)
    await deleteElement(boxes[0].id)

    await page.locator(`[data-page-row="${pageId}"]`).getByRole('checkbox').check()
    await page.getByTestId('bulk-layout-checked').click()
    await expect.poll(async () => (await getPageDetail(jobId, pageId)).layout_checked).toBe(true)
    await expect(drawn).toHaveCount(1)
  })

  test('marking several pages complete shows the ones that saved when another fails', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Partly marked'), 2)
    const [savedId, refusedId] = await jobPageIds(jobId)
    await page.goto(`/jobs/${jobId}`)
    const saved = page.locator(`[data-page-row="${savedId}"]`)
    const refused = page.locator(`[data-page-row="${refusedId}"]`)
    await saved.getByRole('checkbox').check()
    await refused.getByRole('checkbox').check()
    await page.route(`**/api/pages/${refusedId}`, (route) => route.request().method() === 'PATCH'
      ? route.fulfill({ status: 500, contentType: 'application/json',
                        body: JSON.stringify({ detail: 'the page store is down' }) })
      : route.continue())

    await page.getByTestId('bulk-layout-checked').click()
    await expect(page.getByText('the page store is down')).toBeVisible()
    await expect.poll(async () => (await getPageDetail(jobId, savedId)).layout_checked).toBe(true)
    expect((await getPageDetail(jobId, refusedId)).layout_checked).toBe(false)
    await expect(saved.locator('[data-col="layout"]')).toHaveText('complete')
    await expect(refused.locator('[data-col="layout"]')).toHaveText('')
  })
})

test.describe('Scenario: polling only as much as there is news', () => {
  test('the dataset list stops polling in a hidden tab and reads at once when it is back', async ({ page }) => {
    await page.clock.install()
    const loaded = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/jobs')
    await page.goto('/')
    await loaded
    await stopClock(page)
    await setVisibility(page, 'hidden')
    const reads = countRequests(page, 'GET', '/api/jobs')
    await page.clock.runFor(QUIET_MS)
    await pause(APPLY_MS)
    expect(reads()).toBe(0)

    await setVisibility(page, 'visible')
    await expect.poll(reads).toBe(1)
    // And the poll is back on its five-second round.
    await page.clock.runFor(5_000)
    await expect.poll(reads).toBe(2)
  })

  test('settings are not re-read in a hidden tab and are read at once when it is back', async ({ page }) => {
    await page.clock.install()
    const loaded = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/settings')
    await page.goto('/')
    await loaded
    await stopClock(page)
    await setVisibility(page, 'hidden')
    const reads = countRequests(page, 'GET', '/api/settings')
    await page.clock.runFor(QUIET_MS)
    await pause(APPLY_MS)
    expect(reads()).toBe(0)

    await setVisibility(page, 'visible')
    await expect.poll(reads).toBe(1)
    await page.clock.runFor(5_000)
    await expect.poll(reads).toBe(2)
  })

  test('a dataset list opened in a hidden tab reads nothing until it is shown', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    })
    await page.clock.install()
    const reads = countRequests(page, 'GET', '/api/jobs')
    await page.goto('/')
    const waiting = page.getByTestId('jobs-skeleton')
    await expect(waiting).toBeVisible()
    await stopClock(page)
    await page.clock.runFor(QUIET_MS)
    await pause(APPLY_MS)
    expect(reads()).toBe(0)

    await setVisibility(page, 'visible')
    await expect.poll(reads).toBe(1)
    await expect(waiting).toHaveCount(0)
  })

  test('a finished run is read once, not every five seconds', async ({ page }) => {
    const runId = await cancelledRun('Finished run')
    const reads = countRequests(page, 'GET', '/api/trainings')
    await page.clock.install()
    await page.goto(`/models/runs/${runId}`)
    await expect(page.getByTestId('run-status')).toHaveText('cancelled')
    await stopClock(page)
    await page.clock.runFor(QUIET_MS)
    await pause(APPLY_MS)
    expect(reads()).toBe(1)
  })

  test('a dataset page that sees its counters move between looks keeps looking every five seconds',
       async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Looked at'), 1)
    const job = await backendFetch(`/api/jobs/${jobId}?pages=false`)
    // As if a run started and finished elsewhere between two looks.
    let moved = false
    await page.route((url) => url.pathname === `/api/jobs/${jobId}` && url.searchParams.get('pages') === 'false',
      (route) => moved
        ? route.fulfill({ json: { ...job, counters: { ...job.counters, pages_ingested: 99 } } })
        : route.continue())
    await page.clock.install()
    await page.goto(`/jobs/${jobId}`)
    await expect(page.locator('tbody tr')).toHaveCount(1)
    await stopClock(page)
    const looks = countRequests(page, 'GET', `/api/jobs/${jobId}`)
    moved = true

    await page.clock.runFor(5_000)
    // The look that saw the change and the reload it set off, and no fresh look on top.
    await expect.poll(looks).toBe(2)
    await pause(APPLY_MS)
    expect(looks()).toBe(2)
    await page.clock.runFor(5_000)
    await expect.poll(looks).toBe(3)
  })

  test('reopening the cluster session asks for its state once', async ({ page }) => {
    await page.route('**/api/trainings', async (route) => {
      if (route.request().method() !== 'GET') return route.continue()
      const response = await route.fetch()
      await route.fulfill({ response, json: { ...(await response.json()), cluster: { reachable: false } } })
    })
    await page.clock.install()
    await page.goto('/models?tab=runs')
    await page.getByTestId('cluster-lost').getByRole('button', { name: 'Reconnect' }).click()
    await expect(page.getByTestId('cluster-session')).toBeVisible()
    await stopClock(page)
    const asked = countRequests(page, 'GET', '/api/slurm/session')
    const listed = (r: { url: () => string }) => new URL(r.url()).pathname === '/api/trainings'
    for (let poll = 0; poll < 2; poll++) {
      const read = page.waitForResponse(listed)
      await page.clock.runFor(5_000)
      await read
    }
    await pause(APPLY_MS)
    expect(asked()).toBe(0)
  })

  test('a fast ingest refreshes the page table at most once per stretch', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Streamed'), 1)
    const job = await backendFetch(`/api/jobs/${jobId}?pages=false`)
    // Running as far as the page knows, so it follows the run's stream - twelve pages
    // ingested in one burst, and then the stream drops.
    await page.route((url) => url.pathname === `/api/jobs/${jobId}` && url.searchParams.get('pages') === 'false',
      (route) => route.fulfill({ json: { ...job, status: 'running',
                                         counters: { ...job.counters, pages_ingested: 0 } } }))
    const event = (ingested: number) => `data: ${JSON.stringify({
      status: 'running', phase: null, counters: { ...job.counters, pages_ingested: ingested } })}\n\n`
    const burst = Array.from({ length: 12 }, (_, i) => event(i + 1)).join('')
    const rows = countRequests(page, 'GET', `/api/jobs/${jobId}/page-rows`)
    let rowsBefore = -1
    let tableShown: () => void = () => undefined
    const shown = new Promise<void>((resolve) => { tableShown = resolve })
    let served: () => void = () => undefined
    const streamServed = new Promise<void>((resolve) => { served = resolve })
    await page.route(`**/api/jobs/${jobId}/events`, async (route) => {
      if (rowsBefore >= 0) return route.abort()
      await shown
      rowsBefore = rows()
      await route.fulfill({ status: 200, contentType: 'text/event-stream', body: burst })
      served()
    })

    await page.clock.install()
    await page.goto(`/jobs/${jobId}`)
    await expect(page.locator('tbody tr')).toHaveCount(1)
    await pause(APPLY_MS)
    await stopClock(page)
    tableShown()
    await streamServed
    // One read as the counts start moving, and one when the stream drops.
    await expect.poll(() => rows() - rowsBefore).toBe(2)
    // Nothing more inside the two seconds before the page reconnects.
    await page.clock.runFor(1_900)
    await pause(APPLY_MS)
    expect(rows() - rowsBefore).toBe(2)
  })

  test('the diplomatic read looks again, ever more slowly, until it learns whether anything runs',
       async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Status refused'), 1)
    const looks = countRequests(page, 'GET', `/api/jobs/${jobId}/groundtruth/status`)
    // A run may be in flight when the panel opens, so a failed first look cannot be taken
    // to mean there is nothing to follow.
    let refusals = 2
    await page.route(`**/api/jobs/${jobId}/groundtruth/status`, (route) => refusals-- > 0
      ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ detail: 'down' }) })
      : route.continue())
    await page.clock.install()
    await page.goto(`/jobs/${jobId}/corpus`)
    await expect.poll(looks).toBe(1)
    await stopClock(page)
    await page.clock.runFor(2_400)
    await expect.poll(looks).toBe(2)
    // The second failure waits twice as long as the first.
    await page.clock.runFor(4_799)
    await pause(APPLY_MS)
    expect(looks()).toBe(2)
    await page.clock.runFor(1)
    await expect.poll(looks).toBe(3)

    // That one got through and nothing runs, so the panel stops asking.
    await page.clock.runFor(60_000)
    await pause(APPLY_MS)
    expect(looks()).toBe(3)
  })

  test('a transform catalog that failed to load is asked for again', async ({ page }) => {
    const catalogReads = countRequests(page, 'GET', '/api/augmentations/catalog')
    let refused = false
    await page.route('**/api/augmentations/catalog', (route) => {
      if (refused) return route.continue()
      refused = true
      return route.fulfill({ status: 500, contentType: 'application/json',
                             body: JSON.stringify({ detail: 'venv unreadable' }) })
    })
    // Other specs leave pipelines behind, so the editor is opened on a new one rather
    // than relying on an empty list opening it by itself.
    const openEditor = async () => {
      await page.getByRole('link', { name: 'Augmentations' }).click()
      await page.getByTestId('start-empty').click()
      await expect(page.getByTestId('pipeline-preview')).toBeVisible()
    }
    await page.goto('/models')
    await openEditor()
    await expect(page.getByTestId('picker-option')).toHaveCount(0)

    await page.getByRole('link', { name: 'Models', exact: true }).click()
    await openEditor()
    await expect(page.getByTestId('picker-option').first()).toBeVisible()
    expect(catalogReads()).toBe(2)
  })
})

test.describe('Scenario: the page table by keyboard', () => {
  test('a page opens from its name and is selected by its named checkbox', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Keyboard table'), 2)
    const [firstId] = await jobPageIds(jobId)
    await page.goto(`/jobs/${jobId}`)
    const row = page.locator(`[data-page-row="${firstId}"]`)

    const select = row.getByRole('checkbox', { name: 'Select scan_1.png' })
    await select.focus()
    await page.keyboard.press('Space')
    await expect(select).toBeChecked()
    await expect(page.getByText('1 selected')).toBeVisible()

    await row.getByRole('link', { name: 'scan_1.png' }).focus()
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(new RegExp(`/jobs/${jobId}/pages/${firstId}$`))
  })
})
