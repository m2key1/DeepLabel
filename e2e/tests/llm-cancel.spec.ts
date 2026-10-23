import { test, expect } from '../helpers/test'
import {
  addLlmReference, backendFetch, createJob, identity, llmReferences, resetLlmStats,
  seedDistinctPagesJob, seedLlmConnection, uniqueName,
} from '../helpers/api'
import { scanPng } from '../helpers/image'

const DEV = identity('dev', 'admin')
// Reads correctly but takes 15 seconds a page, so a run can be caught half-way.
const SLOW = 'stub-slow'

const status = (jobId: string) =>
  backendFetch(`/api/jobs/${jobId}/llm/status`, { headers: DEV })

test.describe('Scenario: cancelling a language-model run', () => {
  test("cancelling one dataset leaves another dataset's queued readings alone", async () => {
    test.setTimeout(120_000)
    const connection = await seedLlmConnection(uniqueName('Slow reader'), [SLOW], DEV)
    const model = connection.models[0]
    // One page in flight at a time, so the second waits as pending.
    await backendFetch(`/api/llm/models/${model.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...DEV },
      body: JSON.stringify({ max_concurrency: 1 }),
    })
    // Two datasets holding the same two scans - a volume and a copy of it.
    const asked = await seedDistinctPagesJob(uniqueName('Asked to read'), 2, 900)
    const bystander = await seedDistinctPagesJob(uniqueName('Same scans'), 2, 900)
    await resetLlmStats()

    await backendFetch(`/api/jobs/${asked}/llm/read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...DEV },
      body: JSON.stringify({ model_ids: [model.id] }),
    })
    await expect.poll(async () => {
      const s = await status(asked)
      return { running: s.running, pending: s.pending }
    }).toEqual({ running: 1, pending: 1 })

    // Nothing was asked of the copy, so cancelling it has nothing to drop.
    const answer = await backendFetch(`/api/jobs/${bystander}/llm/cancel`, {
      method: 'POST', headers: DEV,
    })
    expect(answer).toEqual({ cancelled: 0 })

    // The dataset that asked still gets both of its pages read.
    await expect.poll(async () => {
      const s = await status(asked)
      return { done: s.done, active: s.active }
    }, { timeout: 60_000 }).toEqual({ done: 2, active: false })
  })

  test('cancelling the dataset that asked drops what it has not sent yet', async () => {
    test.setTimeout(120_000)
    const connection = await seedLlmConnection(uniqueName('Slow reader'), [SLOW], DEV)
    const model = connection.models[0]
    await backendFetch(`/api/llm/models/${model.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...DEV },
      body: JSON.stringify({ max_concurrency: 1 }),
    })
    const asked = await seedDistinctPagesJob(uniqueName('Changed its mind'), 2, 950)

    await backendFetch(`/api/jobs/${asked}/llm/read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...DEV },
      body: JSON.stringify({ model_ids: [model.id] }),
    })
    await expect.poll(async () => {
      const s = await status(asked)
      return { running: s.running, pending: s.pending }
    }).toEqual({ running: 1, pending: 1 })

    const answer = await backendFetch(`/api/jobs/${asked}/llm/cancel`, { method: 'POST', headers: DEV })
    expect(answer).toEqual({ cancelled: 1 })
    // The one in flight is paid for and kept; the one never sent is gone.
    await expect.poll(async () => {
      const s = await status(asked)
      return { done: s.done, pending: s.pending, active: s.active }
    }, { timeout: 60_000 }).toEqual({ done: 1, pending: 0, active: false })
  })
})

test.describe("Scenario: a dataset's reference charts", () => {
  test('the limit is per dataset, whoever adds the picture', async () => {
    const owner = `charts-${Date.now()}`
    const ownerHeaders = identity(owner, 'member')
    const jobId = await createJob(uniqueName('Charted'), 1, undefined, ownerHeaders)
    for (let i = 0; i < 4; i++) {
      await addLlmReference(`chart_${i}.png`, new Uint8Array(scanPng(40, 40 + i)), 'image/png',
                            jobId, ownerHeaders)
    }
    expect((await llmReferences(jobId, ownerHeaders)).references).toHaveLength(4)

    // An admin may edit the dataset's set, but a fifth picture is one too many for it.
    await expect(addLlmReference('chart_4.png', new Uint8Array(scanPng(40, 44)), 'image/png', jobId))
      .rejects.toThrow(/400/)
    expect((await llmReferences(jobId, ownerHeaders)).references.map((r) => r.filename))
      .toEqual(['chart_0.png', 'chart_1.png', 'chart_2.png', 'chart_3.png'])
  })
})
