import type { Page } from '@playwright/test'
import { test, expect } from '../helpers/test'
import { backendFetch, getPageDetail, identity, jobPageIds, pageLines, seedCompletedJob, shareJob, uniqueName } from '../helpers/api'
import { seedSession } from '../helpers/session'

async function firstLine(jobId: string, pageId: number) {
  return (await pageLines(jobId, pageId))[0]
}

async function lineText(jobId: string, pageId: number, lineId: number): Promise<string | null> {
  const line = (await pageLines(jobId, pageId)).find((l) => l.id === lineId)
  return line?.corrected_text ?? null
}

/** Records the newest revision each of the tab's live feeds has delivered, so a test can
 *  wait for the feed to have caught up instead of sleeping past it. */
async function recordFeedRevision(tab: Page) {
  await tab.addInitScript(() => {
    const NativeEventSource = window.EventSource
    const heard = window as unknown as { feedRevision: number }
    heard.feedRevision = 0
    window.EventSource = class extends NativeEventSource {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init)
        this.addEventListener('message', (event) => {
          const { revision } = JSON.parse(event.data)
          if (Number.isFinite(revision)) heard.feedRevision = Math.max(heard.feedRevision, revision)
        })
      }
    }
  })
}

function feedRevision(tab: Page): Promise<number> {
  return tab.evaluate(() => (window as unknown as { feedRevision: number }).feedRevision)
}

async function correctAs(username: string, lineId: number, text: string) {
  return backendFetch(`/api/lines/${lineId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...identity(username, 'member') },
    body: JSON.stringify({ corrected_text: text }),
  })
}

async function seedSharedPage(username: string) {
  const jobId = await seedCompletedJob(uniqueName('Collab'), 1)
  await shareJob(jobId, [username])
  const [pageId] = await jobPageIds(jobId)
  return { jobId, pageId }
}

test.describe('Scenario: one person in two tabs', () => {
  test('a correction made in one tab appears in the other, and the tab that made it does not reload for it', async ({ page, browser }) => {
    const jobId = await seedCompletedJob(uniqueName('Two tabs'), 1)
    const [pageId] = await jobPageIds(jobId)
    const lines = await pageLines(jobId, pageId)
    const header = lines.find((l) => l.text === 'Sample Header line 1')!
    const paragraph = lines.find((l) => l.text === 'Sample Paragraph line 1')!

    const otherContext = await browser.newContext({ storageState: await page.context().storageState() })
    const otherTab = await otherContext.newPage()
    await otherTab.goto(`/jobs/${jobId}/pages/${pageId}`)
    await recordFeedRevision(page)
    await page.goto(`/jobs/${jobId}/pages/${pageId}`)
    // The stub's first line is its first row.
    const headerText = (tab: typeof page) => tab.getByTestId('line-row').first().getByTestId('line-text')
    await expect(headerText(otherTab)).toHaveText('Sample Header line 1')
    await expect(headerText(page)).toHaveText('Sample Header line 1')

    let reloadsHere = 0
    page.on('request', (r) => {
      if (r.method() === 'GET' && r.url().endsWith(`/api/jobs/${jobId}/pages/${pageId}`)) reloadsHere += 1
    })

    await headerText(page).click()
    await page.getByTestId('line-editor').fill('typed in the first tab')
    await page.keyboard.press('Enter')
    await expect.poll(() => lineText(jobId, pageId, header.id)).toBe('typed in the first tab')
    await expect(headerText(otherTab)).toHaveText('typed in the first tab')

    // Taking it back is a second write of this tab's, and the other tab follows that too.
    await page.getByTestId('line-row').first().hover()
    await page.getByTitle('Revert to OCR text').click()
    await expect.poll(() => lineText(jobId, pageId, header.id)).toBeNull()
    await expect(headerText(page)).toHaveText('Sample Header line 1')
    await expect(headerText(otherTab)).toHaveText('Sample Header line 1')

    // Once the feed has delivered the echoes of this tab's writes, a colleague's write
    // arrives in an event of its own, so a reload for an echo cannot hide behind it.
    const ownWrites = (await getPageDetail(jobId, pageId)).job_revision
    await expect.poll(() => feedRevision(page)).toBeGreaterThanOrEqual(ownWrites)
    expect(reloadsHere).toBe(0)
    await backendFetch(`/api/lines/${paragraph.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...identity('colleague', 'admin') },
      body: JSON.stringify({ corrected_text: 'typed by a colleague' }),
    })
    await expect.poll(() => lineText(jobId, pageId, paragraph.id)).toBe('typed by a colleague')
    await expect(page.getByTestId('line-text').filter({ hasText: 'typed by a colleague' })).toHaveCount(1)
    expect(reloadsHere).toBe(1)
    await expect(otherTab.getByTestId('line-text').filter({ hasText: 'typed by a colleague' })).toHaveCount(1)

    await otherContext.close()
  })
})

test.describe('Scenario: two people on one page', () => {
  test('a colleague\'s correction appears without reloading', async ({ page }) => {
    const colleague = `live-${Date.now()}`
    seedSession('member', colleague)
    const { jobId, pageId } = await seedSharedPage(colleague)
    const line = await firstLine(jobId, pageId)

    await page.goto(`/jobs/${jobId}/pages/${pageId}`)
    const row = page.getByTestId('line-row').first()
    await expect(row.getByTestId('line-text')).toBeVisible()
    const before = await row.getByTestId('line-text').textContent()

    await correctAs(colleague, line.id, 'their fresh reading')
    await expect(row.getByTestId('line-text')).toHaveText('their fresh reading')
    expect(before).not.toBe('their fresh reading')
    await expect(row.getByText('edited')).toBeVisible()
  })

  test('saving over a colleague\'s edit is refused, and either version can be kept', async ({ page }) => {
    const colleague = `clash-${Date.now()}`
    seedSession('member', colleague)
    const { jobId, pageId } = await seedSharedPage(colleague)
    const line = await firstLine(jobId, pageId)

    await page.goto(`/jobs/${jobId}/pages/${pageId}`)
    const row = page.getByTestId('line-row').first()
    await row.getByTestId('line-text').click()
    const editor = page.getByTestId('line-editor')
    await expect(editor).toBeVisible()

    await correctAs(colleague, line.id, 'theirs')
    await expect.poll(() => lineText(jobId, pageId, line.id)).toBe('theirs')

    await editor.fill('mine')
    await page.keyboard.press('Enter')

    const conflict = page.getByTestId('line-conflict')
    await expect(conflict).toContainText(`${colleague} changed this line while you were editing it.`)
    await expect(conflict.getByTestId('conflict-theirs')).toHaveText('theirs')
    await expect(conflict.getByTestId('conflict-mine')).toHaveText('mine')
    expect(await lineText(jobId, pageId, line.id)).toBe('theirs')

    await conflict.getByRole('button', { name: 'Keep theirs' }).click()
    await expect(conflict).toHaveCount(0)
    await expect(row.getByTestId('line-text')).toHaveText('theirs')
    expect(await lineText(jobId, pageId, line.id)).toBe('theirs')

    await row.getByTestId('line-text').click()
    await correctAs(colleague, line.id, 'theirs again')
    await expect.poll(() => lineText(jobId, pageId, line.id)).toBe('theirs again')
    await page.getByTestId('line-editor').fill('mine after all')
    await page.keyboard.press('Enter')
    await expect(conflict.getByTestId('conflict-theirs')).toHaveText('theirs again')
    await conflict.getByRole('button', { name: 'Overwrite with mine' }).click()
    await expect(conflict).toHaveCount(0)
    await expect(row.getByTestId('line-text')).toHaveText('mine after all')
    await expect.poll(() => lineText(jobId, pageId, line.id)).toBe('mine after all')
  })
})
