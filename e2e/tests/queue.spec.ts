import { test, expect } from '../helpers/test'
import {
  backendFetch, identity, jobPageIds, pageLines, seedCompletedJob, uniqueName,
} from '../helpers/api'

const DEV = identity('dev', 'admin')
const OTHER = identity('quentin', 'member')

const rows = (page: import('@playwright/test').Page) => page.getByTestId('queue-row')

/** A queue payload the page will be given. Real runs finish faster than a page can be
 *  opened, so what the list looks like while work is waiting is served rather than raced;
 *  the shape is pinned against the live endpoint in its own test below. */
function serveQueue(page: import('@playwright/test').Page, payload: unknown) {
  return page.route('**/api/queue', (route) => route.fulfill({ json: payload }))
}

const dataset = (id: string, name: string, status: string, extra = {}) => ({
  kind: 'dataset', id, name, owner: 'dev', status, phase: null,
  created_at: '2026-01-01 00:00:00', queued_at: '2026-01-01 00:00:00', accessible: true,
  job: { id, name, owner: 'dev', status, phase: null, created_at: '2026-01-01 00:00:00',
         counters: {}, pages_total: 1, pages_done: 0 },
  ...extra,
})

const training = (id: number, name: string, status: string) => ({
  kind: 'training', id, name, owner: 'dev', status, phase: null,
  created_at: '2026-01-02 00:00:00', queued_at: '2026-01-02 00:00:00',
  training: { task: 'ocr', target: 'slurm', epochs: 10, progress_last: null,
              snapshot_progress: null },
})

const EMPTY = { gpu: { running: null, queued: [] }, cluster: [], pending_reocr: null }

test.describe('Scenario: what the shared GPU is doing', () => {
  test('an idle instance says so rather than showing an empty table', async ({ page }) => {
    await serveQueue(page, EMPTY)

    await page.goto('/queue')

    await expect(page.getByTestId('queue-idle')).toBeVisible()
    await expect(rows(page)).toHaveCount(0)
  })

  test('what is running is shown apart from what is waiting, in the order it will run',
    async ({ page }) => {
      await serveQueue(page, {
        ...EMPTY,
        gpu: {
          running: dataset('j-running', 'Volume I', 'running'),
          queued: [dataset('j-next', 'Volume II', 'queued'),
                   dataset('j-last', 'Volume III', 'queued')],
        },
      })

      await page.goto('/queue')

      await expect(page.getByTestId('queue-idle')).toHaveCount(0)
      await expect(rows(page)).toHaveCount(3)
      await expect(rows(page).nth(0)).toContainText('Volume I')
      await expect(rows(page).nth(1)).toContainText('Volume II')
      await expect(rows(page).nth(2)).toContainText('Volume III')
    })

  test('each row says what kind of work it is and links to it', async ({ page }) => {
    await serveQueue(page, {
      ...EMPTY,
      gpu: { running: null, queued: [dataset('j-next', 'Volume II', 'queued')] },
    })

    await page.goto('/queue')

    await expect(rows(page).first()).toHaveAttribute('data-kind', 'dataset')
    await expect(rows(page).first().getByRole('link', { name: 'Volume II' }))
      .toHaveAttribute('href', '/jobs/j-next')
  })

  test('a training opens its run page and an evaluation its own page', async ({ page }) => {
    const evaluation = { kind: 'evaluation', id: 5, name: 'Kurrent on Volume II', owner: 'dev', status: 'queued',
                         phase: null, created_at: '2026-01-03 00:00:00' }
    await serveQueue(page, {
      ...EMPTY,
      gpu: { running: null, queued: [evaluation] },
      cluster: [training(12, 'OCR sweep', 'running')],
    })

    await page.goto('/queue')

    await expect(rows(page).filter({ hasText: 'OCR sweep' }).getByRole('link', { name: 'OCR sweep' }))
      .toHaveAttribute('href', '/models/runs/12')
    await expect(rows(page).filter({ hasText: 'Kurrent on Volume II' })
      .getByRole('link', { name: 'Kurrent on Volume II' })).toHaveAttribute('href', '/evaluations/5')
    await rows(page).filter({ hasText: 'OCR sweep' }).getByRole('link').click()
    await expect(page).toHaveURL(/\/models\/runs\/12$/)
  })

  test('a running row counts from when it started, a waiting one from when it was queued',
    async ({ page }) => {
      await page.clock.setFixedTime(new Date('2026-01-01T10:17:03Z'))
      await serveQueue(page, {
        ...EMPTY,
        gpu: {
          running: dataset('j-running', 'Census', 'running', { started_at: '2026-01-01 10:05:00' }),
          // Made weeks ago and run again: it waits from when it was queued, not made.
          queued: [dataset('j-next', 'Letters', 'queued',
                           { created_at: '2025-11-20 09:00:00', queued_at: '2026-01-01 10:15:00', started_at: null })],
        },
        cluster: [{ ...training(12, 'OCR sweep', 'running'), created_at: '2026-01-01 07:00:00',
                    started_at: '2026-01-01 07:14:50' }],
      })

      await page.goto('/queue')

      const time = (name: string) => rows(page).filter({ hasText: name }).getByTestId('queue-row-time')
      await expect(time('Census')).toHaveText('12:03')
      await expect(time('Letters')).toHaveText('waiting 2:03')
      await expect(time('OCR sweep')).toHaveText('3:02:13')
    })

  test('a dataset the viewer cannot reach is counted but not named or linked',
    async ({ page }) => {
      await serveQueue(page, {
        ...EMPTY,
        gpu: {
          running: null,
          queued: [{ ...dataset('j-theirs', 'another dataset', 'queued'), accessible: false }],
        },
      })

      await page.goto('/queue')

      await expect(rows(page)).toHaveCount(1)
      await expect(rows(page).first()).toContainText('another dataset')
      await expect(rows(page).first().getByRole('link')).toHaveCount(0)
    })

  test('a training bound for the cluster is listed apart from the local GPU',
    async ({ page }) => {
      await serveQueue(page, { ...EMPTY, cluster: [training(1, 'OCR sweep', 'running')] })

      await page.goto('/queue')

      await expect(page.getByRole('heading', { name: 'Local GPU' })).toBeVisible()
      await expect(page.getByRole('heading', { name: /Cluster/ })).toBeVisible()
      await expect(rows(page).filter({ hasText: 'OCR sweep' })).toHaveAttribute(
        'data-kind', 'training')
    })

  test('the cluster section is absent when nothing is on it', async ({ page }) => {
    await serveQueue(page, EMPTY)

    await page.goto('/queue')

    await expect(page.getByRole('heading', { name: /Cluster/ })).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'Local GPU' })).toBeVisible()
  })
})

test.describe('Scenario: lines waiting to be read again', () => {
  test('they are counted on the queue with a countdown to the sweep', async ({ page }) => {
    // Real state, not served: a flagged line stays flagged until the batcher's sweep,
    // which is long enough to be deterministic.
    const name = uniqueName('Flagged')
    const jobId = await seedCompletedJob(name, 1)
    const [pageId] = await jobPageIds(jobId)
    const [line] = await pageLines(jobId, pageId)

    await backendFetch(`/api/lines/${line.id}/reocr`, { method: 'POST', headers: DEV })

    await page.goto('/queue')
    const pending = page.getByTestId('queue-pending-reocr')
    await expect(pending).toContainText('flagged for re-read')
    await expect(pending).toContainText(/picked up in \d+s/)

    // Backend oracle: the count comes from the same WHERE the batcher sweeps on.
    const queue = await backendFetch('/api/queue', { headers: DEV })
    const mine = queue.pending_reocr.datasets.find((d: { name: string }) => d.name === name)
    expect(mine.lines).toBe(1)
  })

  test('nothing flagged means the row is not there at all', async ({ page }) => {
    await serveQueue(page, EMPTY)

    await page.goto('/queue')

    await expect(page.getByTestId('queue-pending-reocr')).toHaveCount(0)
  })
})

test.describe('Scenario: the queue payload itself', () => {
  test('the live endpoint has the shape the page is built on', async () => {
    /** Guards the served payloads above: if the real response changed, they would keep
     *  passing against a shape the app no longer produces. */
    const queue = await backendFetch('/api/queue', { headers: DEV })

    expect(Object.keys(queue).sort()).toEqual(['cluster', 'gpu', 'pending_reocr'])
    expect(Object.keys(queue.gpu).sort()).toEqual(['queued', 'running'])
    expect(Array.isArray(queue.cluster)).toBe(true)
    for (const entry of [...queue.gpu.queued, ...(queue.gpu.running ? [queue.gpu.running] : []), ...queue.cluster]) {
      expect(entry).toHaveProperty('started_at')
    }
  })

  test('it is global, so a dataset someone cannot reach is redacted rather than hidden',
    async () => {
      const name = uniqueName('Not for quentin')
      const jobId = await seedCompletedJob(name, 1)
      const [pageId] = await jobPageIds(jobId)
      const [line] = await pageLines(jobId, pageId)
      await backendFetch(`/api/lines/${line.id}/reocr`, { method: 'POST', headers: DEV })

      const theirs = await backendFetch('/api/queue', { headers: OTHER })
      const entry = theirs.pending_reocr.datasets.find(
        (d: { id: string }) => d.id === jobId)

      expect(entry.accessible).toBe(false)
      expect(entry.name).toBe('another dataset')
      expect(entry.lines).toBe(1), 'the work is still counted'
    })
})
