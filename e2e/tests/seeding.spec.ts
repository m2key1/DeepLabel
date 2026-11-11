import { test, expect } from '../helpers/test'
import {
  backendFetch, createJob, createJobWithoutLayout, getJob, importUnservedModel, seedCompletedJob, uniqueName,
  waitForJobStatus,
} from '../helpers/api'

/** One stack runs its tests one after another, but work a finished test started keeps going
 *  in the stack's one queue. A dataset the next test seeds waits behind it, and that wait is
 *  the queue's, not the dataset's: it must neither use up the time the run is given nor the
 *  test's own. */
test.describe('Scenario: seeding a dataset behind other work', () => {
  test('a dataset seeded behind a minute of queued work is waited for', async () => {
    // Four datasets on the slow reader, fifteen seconds each, hold the queue for a minute:
    // longer than a wait on a run allows, and longer than a test is given.
    const ahead: string[] = []
    for (let i = 1; i <= 4; i++) ahead.push(await createJob(uniqueName(`[slow] Ahead ${i}`), 1))
    await expect.poll(async () => {
      const { gpu } = await backendFetch('/api/queue')
      return [gpu.running, ...gpu.queued].filter(Boolean).map((entry: { id: string }) => entry.id)
    }).toEqual(expect.arrayContaining(ahead))

    const jobId = await seedCompletedJob(uniqueName('Seeded behind'), 1)
    expect((await getJob(jobId)).status).toBe('done')
    expect(await Promise.all(ahead.map(async (id) => (await getJob(id)).status)))
      .toEqual(['done', 'done', 'done', 'done'])
  })

  test('a run that fails ends the wait at once, with its reason', async () => {
    const unserved = importUnservedModel('lines', uniqueName('Unserved lines'))
    const jobId = await createJobWithoutLayout(uniqueName('Fails at once'), unserved, 1)
    await waitForJobStatus(jobId, 'error')

    const started = Date.now()
    await expect(waitForJobStatus(jobId, 'done')).rejects.toThrow(
      `job ${jobId} ended "error", expected "done": RuntimeError: the lines model (${unserved}) is not on a configured model backend`)
    expect(Date.now() - started).toBeLessThan(2_000)
  })
})
