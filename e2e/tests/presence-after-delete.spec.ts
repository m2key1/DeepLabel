import { test, expect } from '../helpers/test'
import { backendFetch, identity, seedCompletedJob, shareJob, uniqueName } from '../helpers/api'

type Entry = { username: string; job_id: string | null }

test.describe('Scenario: someone was in a dataset that has just been deleted', () => {
  test('who is online still answers, without the dataset that is gone', async () => {
    const colleague = `presence-${Date.now()}`
    const jobId = await seedCompletedJob(uniqueName('Deleted under them'), 1)
    await shareJob(jobId, [colleague])
    await backendFetch('/api/presence', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...identity(colleague, 'member') },
      body: JSON.stringify({ tab: 'tab-1', job_id: jobId }),
    })
    const before = (await backendFetch('/api/presence')).users as Entry[]
    expect(before.filter((e) => e.username === colleague).map((e) => e.job_id)).toEqual([jobId])

    await backendFetch(`/api/jobs/${jobId}`, { method: 'DELETE' })

    // Within the minute the colleague's tab is remembered, an admin's view must still load.
    const after = (await backendFetch('/api/presence')).users as Entry[]
    expect(after.filter((e) => e.username === colleague).map((e) => e.job_id)).toEqual([null])
  })
})
