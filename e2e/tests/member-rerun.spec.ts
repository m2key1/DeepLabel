import type { Browser } from '@playwright/test'
import { test, expect } from '../helpers/test'
import {
  createJob, greedyLines, identity, moveJobToGroup, patchJob, seedCompletedJob, shareJob, uniqueName,
  waitForJobStatus,
} from '../helpers/api'
import { asSession, seedSession, useSession, type SeededRole } from '../helpers/session'

/** Someone with one dataset of their own, decoding greedily so a line their re-run
 *  wrote is tellable from the beam run that made it, signed in in a fresh browser. */
async function withOwnDataset(browser: Browser, role: SeededRole, prefix: string) {
  const username = `${prefix}-${Date.now()}`
  const session = seedSession(role, username)
  const ownName = uniqueName(`${prefix} own`)
  const own = await createJob(ownName, 1, undefined, identity(username, role))
  await waitForJobStatus(own, 'done')
  await patchJob(own, { ocr_decode: 'greedy' })
  const context = await browser.newContext()
  await useSession(context, session)
  const page = await context.newPage()
  return { username, session, own, ownName, context, page }
}

test.describe('Scenario: re-running datasets in bulk', () => {
  test("a Reviewer's selection holding a dataset they were given is refused as a whole, naming it",
    async ({ browser }) => {
    // Whoever made a dataset manages it, so their own re-runs even though a Reviewer may not
    // run models on what they were only given.
    const { username, own, ownName, context, page } = await withOwnDataset(browser, 'reviewer', 'rerunner')
    const sharedName = uniqueName('Only shared to re-run')
    const shared = await seedCompletedJob(sharedName, 1)
    await patchJob(shared, { ocr_decode: 'greedy' })
    await shareJob(shared, [username])
    let reruns = 0
    page.on('request', (r) => {
      if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/bulk/rerun') reruns += 1
    })

    await page.goto('/')
    const card = (name: string) => page.getByTestId('job-card').filter({ hasText: name })
    for (const name of [ownName, sharedName]) await card(name).getByRole('checkbox').check()
    const bar = page.getByTestId('bulk-bar')
    await expect(bar).toContainText('2 selected')
    await bar.getByRole('button', { name: 'Re-run…' }).click()

    const dialog = page.getByRole('dialog')
    const refused = dialog.getByTestId('preview-refused')
    await expect(refused).toHaveText(`Nothing will be re-run: only a Manager may re-run ${sharedName}.`)
    await expect(dialog.getByRole('button', { name: 'Re-run', exact: true })).toBeDisabled()
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    expect(reruns).toBe(0)
    expect([await greedyLines(own), await greedyLines(shared)]).toEqual([0, 0])

    // Their own dataset alone re-runs: one one-page stub dataset is six lines.
    await card(sharedName).getByRole('checkbox').uncheck()
    await expect(bar).toContainText('1 selected')
    await bar.getByRole('button', { name: 'Re-run…' }).click()
    await expect(dialog.getByTestId('preview-datasets')).toHaveText('1')
    await expect(refused).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Re-run', exact: true }).click()
    await expect.poll(async () => greedyLines(own)).toBe(6)
    expect(reruns).toBe(1)
    expect(await greedyLines(shared)).toBe(0)
    await waitForJobStatus(own, 'done')
    await context.close()
  })

  test("a Manager's own group is re-run from its header", async ({ browser }) => {
    const { session, own, context, page } = await withOwnDataset(browser, 'manager', 'group-rerunner')
    const groupName = uniqueName('Member run group')
    const created = await asSession(session, '/api/groups', {
      method: 'POST', body: JSON.stringify({ name: groupName }),
    })
    expect(created.status).toBe(200)
    await moveJobToGroup(own, ((await created.json()) as { id: number }).id)

    await page.goto('/')
    const section = page.locator('[data-testid="list-section"]').filter({ hasText: groupName })
    await section.getByTestId('group-run').click()
    await page.getByRole('button', { name: 'Re-run…' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByTestId('preview-datasets')).toHaveText('1')
    await dialog.getByRole('button', { name: 'Re-run', exact: true }).click()
    await expect.poll(async () => greedyLines(own)).toBe(6)
    await waitForJobStatus(own, 'done')
    await context.close()
  })
})
