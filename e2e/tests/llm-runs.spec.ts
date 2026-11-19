import { test, expect } from '../helpers/test'
import {
  backendFetch, identity, jobPageIds, llmStats, pageCandidates, patchJob,
  resetLlmStats, seedDistinctPagesJob, seedLlmConnection, shareJob, uniqueName,
} from '../helpers/api'
import { scanPng } from '../helpers/image'
import { gtReads, llmReadStatus, pickModel, startLlmRead, waitForLlmReads } from '../helpers/llm'
import { seedSession, useSession } from '../helpers/session'
import { openViewer } from '../helpers/viewer'
import { datasetAction } from '../helpers/dataset'

const DEV = identity('dev', 'admin')

// 'stub-perfect' and 'stub-second' answer with the stub runner's own six lines verbatim;
// 'stub-slow' does the same after 15 seconds, which is the only way to catch a run while
// it is in flight; 'stub-echo' answers with the prompt it was given. See e2e/README.md.
const PERFECT = 'stub-perfect'
const SECOND = 'stub-second'
const SLOW = 'stub-slow'
const ECHO = 'stub-echo'

// Those six lines, in the order every page is read in.
const STUB_LINES = ['Header', 'Paragraph']
  .flatMap((cls) => [1, 2, 3].map((i) => `Sample ${cls} line ${i}`))

// What the read dialog says on the agreement settings only the dataset's owner may set.

// Two readings of 'stub-slow' queued one behind the other take just over 30 seconds.
const TWO_SLOW_READS_MS = 60_000

const json = (method: string, body: unknown, headers: Record<string, string> = DEV) => ({
  method, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
})

function patchModel(modelId: number, body: Record<string, unknown>) {
  return backendFetch(`/api/llm/models/${modelId}`, json('PATCH', body))
}

function readPreview(jobId: string, modelIds: number[]): Promise<{
  pages: number
  calls: number
  stale_prompt: number
  models: { id: number; calls: number; reused: number; stale_prompt: number }[]
}> {
  const query = modelIds.map((id) => `model_ids=${id}`).join('&')
  return backendFetch(`/api/jobs/${jobId}/llm/preview?${query}`, { headers: DEV })
}

function postRead(jobId: string, body: Record<string, unknown>, headers: Record<string, string> = DEV) {
  return backendFetch(`/api/jobs/${jobId}/llm/read`, json('POST', body, headers))
}

async function llmCandidates(pageId: number) {
  return (await pageCandidates(pageId)).filter((c) => c.source === 'llm' && !c.dismissed)
}

/** Like waitForLlmReads, with room for readings that queue behind one another. */
async function waitForSlowReads(jobId: string, expected: number) {
  await expect.poll(async () => {
    const status = await llmReadStatus(jobId)
    return { done: status.done, active: status.active }
  }, { timeout: TWO_SLOW_READS_MS }).toEqual({ done: expected, active: false })
}

test.describe('Scenario: who may start a run', () => {
  test('an assignee can start a read from the dialog', async ({ page }) => {
    test.setTimeout(90_000)
    const connection = uniqueName('Published')
    const seeded = await seedLlmConnection(connection, [PERFECT], DEV)
    // Published by its admin owner, so the endpoint is usable by everyone - which is the
    // README's whole reason for an assignee to be reading with it at all.
    await backendFetch(`/api/llm/connections/${seeded.id}`, json('PATCH', { shared: true }))
    const member = `assignee-${Date.now()}`
    const asMember = identity(member, 'manager')

    // Control: the backend lets this member read a dataset they are merely assigned to.
    const control = await seedDistinctPagesJob(uniqueName('Assignee control'), 1, 165)
    await shareJob(control, [member])
    await expect(postRead(control, { model_ids: [seeded.models[0].id] }, asMember))
      .resolves.toMatchObject({ queued: 1, reused: 0 })
    await waitForLlmReads(control, 1)

    const jobId = await seedDistinctPagesJob(uniqueName('Assignee reads'), 1, 160)
    await shareJob(jobId, [member])
    await resetLlmStats()
    await useSession(page.context(), seedSession('manager', member))

    await page.goto(`/jobs/${jobId}`)
    await datasetAction(page, 'llm-read-open')
    await pickModel(page, connection, PERFECT).check()
    await page.getByTestId('llm-start').click()

    // The same request the control made, now from the dialog: one page read, run over.
    await expect.poll(async () => {
      const status = await llmReadStatus(jobId)
      return { done: status.done, active: status.active }
    }, { timeout: 20_000 }).toEqual({ done: 1, active: false })
    expect((await llmStats()).calls[PERFECT]).toBe(1)
    const [pageId] = await jobPageIds(jobId)
    expect(await llmCandidates(pageId)).toHaveLength(6)
    await expect(page.getByText('not permitted')).toHaveCount(0)
  })

  test("an Annotator is not offered LLM reading, and a Manager given the dataset sets every agreement setting",
    async ({ page }) => {
      test.setTimeout(90_000)
      const connection = uniqueName('Published settings')
      const seeded = await seedLlmConnection(connection, [PERFECT], DEV)
      await backendFetch(`/api/llm/connections/${seeded.id}`, json('PATCH', { shared: true }))
      const stamp = Date.now()
      const annotator = `llm-annotator-${stamp}`
      const manager = `llm-manager-${stamp}`
      const jobId = await seedDistinctPagesJob(uniqueName('Agreement settings'), 1, 220)
      await shareJob(jobId, [annotator, manager])

      // Backend oracle: the agreement settings are a Manager's, not an Annotator's.
      const patchAs = (who: Record<string, string>, body: Record<string, unknown>) =>
        backendFetch(`/api/jobs/${jobId}`, json('PATCH', body, who))
      await expect(patchAs(identity(annotator, 'annotator'), { llm_autocheck: true })).rejects.toThrow('403')

      await useSession(page.context(), seedSession('manager', manager))
      await page.goto(`/jobs/${jobId}`)
      await expect(page.getByTestId('dataset-run')).toBeVisible()
      await datasetAction(page, 'llm-read-open')
      const autocheck = page.getByTestId('llm-autocheck')
      await expect(autocheck).toBeEnabled()
      await expect(page.getByTestId('llm-consensus-min')).toBeEnabled()
      await autocheck.check()
      await pickModel(page, connection, PERFECT).check()
      await resetLlmStats()
      await page.getByTestId('llm-start').click()
      await waitForLlmReads(jobId, 1)
      expect((await backendFetch(`/api/jobs/${jobId}`, { headers: DEV })).llm_autocheck).toBe(true)

      // The Annotator gets no Run menu: reading with LLMs is not theirs to start.
      await useSession(page.context(), seedSession('annotator', annotator))
      await page.goto(`/jobs/${jobId}`)
      await expect(page.getByRole('heading', { name: /Agreement settings/ })).toBeVisible()
      await expect(page.getByTestId('dataset-run')).toHaveCount(0)
    })
})
