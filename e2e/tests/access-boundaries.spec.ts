import { test, expect } from '../helpers/test'
import {
  createGroup, createJob, moveJobToGroup, seedCompletedJob, shareJob, uniqueName,
} from '../helpers/api'
import { seedSession } from '../helpers/session'
import { FRONTEND } from '../helpers/frontend'

test.describe('Scenario: the shared queue shows how busy the GPU is, not what others hold', () => {
  test("a dataset someone cannot open says nothing about itself beyond that it is there",
    async () => {
      const username = `outsider-${Date.now()}`
      const session = seedSession('member', username)
      // A dataset with something to hide, kept on the queue by the slow reader [slow] gives it.
      const secretName = uniqueName('[slow] Private register')
      const jobId = await createJob(secretName, 1)
      await shareJob(jobId, ['confidant'])

      type Entry = { kind: string; id: string; [k: string]: unknown }
      const entryFor = async () => {
        const res = await fetch(`${FRONTEND}/api/queue`, { headers: { cookie: `sid=${session}` } })
        const { gpu } = (await res.json()) as { gpu: { running: Entry | null; queued: Entry[] } }
        return [gpu.running, ...gpu.queued].find((e) => e?.kind === 'dataset' && e.id === jobId)
      }
      await expect.poll(async () => (await entryFor()) !== undefined).toBe(true)
      const entry = (await entryFor())!

      // Redacted where it is named, as before.
      expect(entry.name).toBe('another dataset')
      expect(entry.accessible).toBe(false)
      // And not leaked one level down: the payload that carries it must not repeat the
      // name, or say who it was shared with.
      const serialized = JSON.stringify(entry)
      expect(serialized).not.toContain('Private register')
      expect(serialized).not.toContain('confidant')
    })
})

test.describe("Scenario: an admin reads the list as one person sees it", () => {
  test('a group that person cannot reach is not shown to them as an empty group',
    async ({ page }) => {
      const username = `lens-${Date.now()}`
      seedSession('member', username)
      const reachableName = uniqueName('Lens reachable')
      const unreachableName = uniqueName('Lens unreachable')
      const reachable = await createGroup(reachableName)
      const unreachable = await createGroup(unreachableName)
      const shared = await seedCompletedJob(uniqueName('Lens shared'), 1)
      const hidden = await seedCompletedJob(uniqueName('Lens hidden'), 1)
      await moveJobToGroup(shared, reachable.id)
      await moveJobToGroup(hidden, unreachable.id)
      await shareJob(shared, [username])

      await page.goto(`/?as=${encodeURIComponent(username)}`)
      const section = (title: string) =>
        page.locator(`[data-testid="list-section"][data-title="${title}"]`)
      await expect(section(reachableName)).toHaveCount(1)
      await expect(section(reachableName).getByTestId('job-card')).toHaveCount(1)
      await expect(section(unreachableName)).toHaveCount(0)
    })
})
