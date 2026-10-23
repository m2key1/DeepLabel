import { test, expect } from '../helpers/test'
import {
  backendFetch, createGroup, createJob, createTraining, getJob, identity, listRegistryModels, listTrainings,
  markLinesChecked, seedCompletedJob, uniqueName, waitForJobStatus,
} from '../helpers/api'

test.describe('Scenario: filing a dataset under a project', () => {
  test('a member cannot file a dataset under a project they cannot see', async () => {
    const member = `filer-${Date.now()}`
    const asMember = identity(member, 'member')
    const own = await createJob(uniqueName('Filer own'), 1, undefined, asMember)
    await waitForJobStatus(own, 'done')
    const openName = uniqueName('Their own project')
    const open = await backendFetch('/api/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...asMember },
      body: JSON.stringify({ name: openName }),
    })
    const closedName = uniqueName('Not theirs')
    const closed = await createGroup(closedName)

    const fileUnder = (groupId: number) => backendFetch(`/api/jobs/${own}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...asMember },
      body: JSON.stringify({ group_id: groupId }),
    })
    // Refused as if the project did not exist, and the dataset stays where it was.
    await expect(fileUnder(closed.id)).rejects.toThrow(/404/)
    expect((await getJob(own)).group_id).toBeNull()
    const theirGroups = async () =>
      ((await backendFetch('/api/groups', { headers: asMember })) as { name: string }[])
        .map((g) => g.name)
    expect(await theirGroups()).not.toContain(closedName)

    // Their own project takes it, so the refusal above is about whose project it is.
    await fileUnder(open.id)
    expect((await getJob(own)).group_id).toBe(open.id)
    expect(await theirGroups()).toContain(openName)
  })
})

test.describe('Scenario: renaming a model', () => {
  test("a model cannot be renamed to another model's name", async () => {
    const jobId = await seedCompletedJob(uniqueName('Rename source'), 1)
    await markLinesChecked(jobId, 6)
    const train = async (name: string) => {
      await createTraining({
        task: 'ocr', name, dataset_job_ids: [jobId], target: 'local',
        epochs: 1, batch_size: 4, val_fraction: 0.3,
      })
      await expect.poll(async () => (await listTrainings()).find((t) => t.name === name)?.status,
                        { timeout: 60_000 }).toBe('done')
      return (await listRegistryModels()).find((m) => m.name === name)!
    }
    const first = await train(uniqueName('Reader A'))
    const second = await train(uniqueName('Reader B'))

    const rename = (name: string) => backendFetch(`/api/models/${second.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    await expect(rename(first.name.toUpperCase())).rejects.toThrow(/409/)
    const names = (await listRegistryModels()).filter((m) => [first.id, second.id].includes(m.id))
      .map((m) => m.name).sort()
    expect(names).toEqual([first.name, second.name].sort())

    // A free name is taken without complaint.
    const fresh = uniqueName('Reader C')
    await rename(fresh)
    expect((await listRegistryModels()).find((m) => m.id === second.id)?.name).toBe(fresh)
  })
})
