import { test, expect } from '../helpers/test'
import {
  backendFetch, identity, markLinesChecked, seedCompletedJob, slowOcrModelId, uniqueName,
} from '../helpers/api'
import { JSON_HEADERS } from '../helpers/map'
import { seedSession, useSession } from '../helpers/session'

const DEV = identity('dev', 'admin')

interface EvaluationState { status: string; cer: number | null; line_rows: number }

const evaluationState = (evalId: number): Promise<EvaluationState> =>
  backendFetch(`/api/evaluations/${evalId}`, { headers: DEV })

/** An evaluation by the slow stub model, which spends 15 s on every request - long
 *  enough to be stopped while it reads. */
async function slowEvaluation(name: string): Promise<number> {
  const jobId = await seedCompletedJob(name, 1)
  await markLinesChecked(jobId, 4)
  const created = await backendFetch('/api/evaluations', {
    method: 'POST', headers: { ...JSON_HEADERS, ...DEV },
    body: JSON.stringify({ model_id: slowOcrModelId(), job_ids: [jobId], decode: 'beam' }),
  })
  await expect.poll(async () => (await evaluationState(created.id)).status, { timeout: 60_000 })
    .toBe('running')
  return created.id
}

async function stop(evalId: number) {
  await backendFetch(`/api/evaluations/${evalId}/cancel`, { method: 'POST', headers: DEV }).catch(() => {})
}

test.describe('Scenario: stopping an evaluation', () => {
  test('a running evaluation is cancelled from its page, keeps its row, and can be retried',
    async ({ page }) => {
      const evalId = await slowEvaluation(uniqueName('Cancelled eval'))
      try {
        await page.goto(`/evaluations/${evalId}`)
        await expect(page.getByTestId('retry-evaluation')).toHaveCount(0)
        await page.getByTestId('cancel-evaluation').click()

        await expect.poll(() => evaluationState(evalId))
          .toMatchObject({ status: 'cancelled', cer: null, line_rows: 0 })
        await expect(page.getByText('This evaluation was cancelled before it finished')).toBeVisible()
        await expect(page.getByTestId('cancel-evaluation')).toHaveCount(0)

        await page.getByTestId('retry-evaluation').click()
        await expect.poll(async () => (await evaluationState(evalId)).status).toMatch(/^(queued|running)$/)
        await expect(page.getByTestId('cancel-evaluation')).toBeVisible()
      } finally {
        await stop(evalId)
      }
    })

  test('the queue offers Cancel on a running evaluation and stops it', async ({ page }) => {
    const evalId = await slowEvaluation(uniqueName('Queued eval'))
    try {
      await page.goto('/queue')
      const row = page.getByTestId('queue-row').filter({ has: page.locator(`a[href="/evaluations/${evalId}"]`) })
      await row.getByTestId('queue-cancel').click()

      await expect.poll(async () => (await evaluationState(evalId)).status).toBe('cancelled')
      await expect(row).toHaveCount(0)
    } finally {
      await stop(evalId)
    }
  })

  test('a member is offered Cancel on their own rows only', async ({ page }) => {
    const member = uniqueName('quinn').toLowerCase().replace(/[^a-z0-9]/g, '')
    await useSession(page.context(), seedSession('member', member))
    const entry = (id: number, owner: string) => ({
      kind: 'evaluation', id, name: `Eval of ${owner}`, owner, status: 'queued', phase: null,
      created_at: '2026-01-03 00:00:00', queued_at: '2026-01-03 00:00:00', started_at: null,
    })
    await page.route('**/api/queue', (route) => route.fulfill({ json: {
      gpu: { running: null, queued: [entry(1, member), entry(2, 'dev')] }, cluster: [], pending_reocr: null,
    } }))

    await page.goto('/queue')

    const rows = page.getByTestId('queue-row')
    await expect(rows.filter({ hasText: `Eval of ${member}` }).getByTestId('queue-cancel')).toBeVisible()
    await expect(rows.filter({ hasText: 'Eval of dev' })).toBeVisible()
    await expect(rows.filter({ hasText: 'Eval of dev' }).getByTestId('queue-cancel')).toHaveCount(0)
  })
})
