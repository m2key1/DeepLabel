import type { Browser } from '@playwright/test'
import { test, expect } from '../helpers/test'
import {
  createJob, getPageDetail, identity, jobPageIds, seedCompletedJob, setElementBbox, shareJob, uniqueName,
  waitForJobStatus,
} from '../helpers/api'
import { asSession, seedSession, useSession, userRecord } from '../helpers/session'

// The stub layout's Paragraph box with x1 pulled in past the staleness threshold, so its
// lines no longer match it and a re-detection has something to do.
const MOVED_PARAGRAPH = [0.1, 0.2, 0.88, 0.85]

async function paragraphLineIds(jobId: string): Promise<number[]> {
  const [pageId] = await jobPageIds(jobId)
  const paragraph = (await getPageDetail(jobId, pageId)).elements
    .find((e: { class_name: string }) => e.class_name === 'Paragraph')!
  return paragraph.lines.map((l: { id: number }) => l.id)
}

async function moveParagraph(jobId: string) {
  const [pageId] = await jobPageIds(jobId)
  const paragraph = (await getPageDetail(jobId, pageId)).elements
    .find((e: { class_name: string }) => e.class_name === 'Paragraph')!
  await setElementBbox(paragraph.id, MOVED_PARAGRAPH)
}

async function signedInMember(browser: Browser, prefix: string) {
  const username = `${prefix}-${Date.now()}`
  const session = seedSession('member', username)
  const context = await browser.newContext()
  await useSession(context, session)
  return { username, session, context, page: await context.newPage() }
}

async function ownDataset(username: string, prefix: string) {
  const name = uniqueName(prefix)
  const id = await createJob(name, 1, undefined, identity(username, 'member'))
  await waitForJobStatus(id, 'done')
  return { id, name }
}

test.describe('Scenario: a member re-detects lines over a selection', () => {
  test('the datasets with nothing to re-detect are named and left alone, the rest re-detected',
    async ({ browser }) => {
      const { username, context, page } = await signedInMember(browser, 'redetector')
      const stale = await ownDataset(username, 'Redetect own stale')
      const fresh = await ownDataset(username, 'Redetect own fresh')
      const sharedName = uniqueName('Redetect shared stale')
      const shared = { id: await seedCompletedJob(sharedName, 1), name: sharedName }
      await shareJob(shared.id, [username])
      for (const job of [stale, shared]) await moveParagraph(job.id)
      const before: Record<string, number[]> = {}
      for (const job of [stale, fresh, shared]) before[job.id] = await paragraphLineIds(job.id)
      expect(before[fresh.id]).toHaveLength(3)

      await page.goto('/')
      const card = (name: string) => page.getByTestId('job-card').filter({ hasText: name })
      for (const job of [stale, fresh, shared]) await card(job.name).getByRole('checkbox').check()
      const bar = page.getByTestId('bulk-bar')
      await expect(bar).toContainText('3 selected')
      await bar.getByRole('button', { name: 'Re-detect lines…' }).click()

      const dialog = page.getByRole('dialog')
      await expect(dialog.getByTestId('preview-datasets')).toHaveText('2')
      await expect(dialog.getByTestId('preview-blocked'))
        .toHaveText(`1 will be left alone - no elements need line re-detection: ${fresh.name}.`)
      await dialog.getByRole('button', { name: 'Re-detect lines', exact: true }).click()

      // Re-detection writes fresh line rows, so the ids are what tells it ran.
      for (const job of [stale, shared]) {
        await expect.poll(async () => {
          const ids = await paragraphLineIds(job.id)
          return ids.length === 3 && ids.every((id) => !before[job.id].includes(id))
        }, { timeout: 30_000 }).toBe(true)
        await waitForJobStatus(job.id, 'done')
      }
      expect(await paragraphLineIds(fresh.id)).toEqual(before[fresh.id])
      await context.close()
    })

  test('a member without the line-detection capability is not offered it', async ({ page, browser }) => {
    const { username, session, context, page: memberPage } = await signedInMember(browser, 'no-redetect')
    const own = await ownDataset(username, 'Redetect refused')
    await moveParagraph(own.id)
    const before = await paragraphLineIds(own.id)

    const record = await userRecord(page, username)
    const revoked = await page.request.patch(`/api/users/${record.id}`, {
      data: { permissions: { 'pipeline.lines': false } },
    })
    expect(revoked.status()).toBe(200)
    await expect.poll(async () => (await userRecord(page, username)).capabilities)
      .toEqual(['pipeline.layout', 'pipeline.ocr', 'train.local'])

    await memberPage.goto('/')
    await memberPage.getByTestId('job-card').filter({ hasText: own.name }).getByRole('checkbox').check()
    const bar = memberPage.getByTestId('bulk-bar')
    await expect(bar.getByRole('button', { name: 'Re-run…' })).toBeVisible()
    await expect(bar.getByRole('button', { name: 'Re-detect lines…' })).toHaveCount(0)

    const refused = await asSession(session, '/api/bulk/redetect', {
      method: 'POST', body: JSON.stringify({ job_ids: [own.id] }),
    })
    expect(refused.status).toBe(403)
    expect(await paragraphLineIds(own.id)).toEqual(before)
    await context.close()
  })
})
