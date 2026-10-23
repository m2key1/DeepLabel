import type { Request } from '@playwright/test'
import { test, expect } from '../helpers/test'
import { backendFetch, jobPageIds, seedCompletedJob, shareJob, uniqueName } from '../helpers/api'
import { seedSession, useSession } from '../helpers/session'
import { FRONTEND } from '../helpers/frontend'


interface PresenceUser {
  username: string
  job_id: string | null
  page_id: number | null
}

async function whereIs(username: string): Promise<PresenceUser | null> {
  const res = await backendFetch('/api/presence')
  return res.users.find((u: PresenceUser) => u.username === username) ?? null
}

test.describe('Scenario: seeing who is where', () => {
  test('a colleague on a page shows up on Admin, the dataset and the page, and moves on', async ({ page, browser }) => {
    const username = `present-${Date.now()}`
    const token = seedSession('member', username)
    const jobName = uniqueName('Presence')
    const jobId = await seedCompletedJob(jobName)
    await shareJob(jobId, [username])
    const [pageId] = await jobPageIds(jobId)

    const colleague = await browser.newContext()
    await useSession(colleague, token)
    const theirTab = await colleague.newPage()
    await theirTab.goto(`/jobs/${jobId}/pages/${pageId}`)
    await expect.poll(async () => (await whereIs(username))?.page_id ?? null).toBe(pageId)

    await page.goto('/admin')
    const row = page.getByTestId('user-row').filter({ hasText: username })
    // The row says they are here. Where they are is the presence list's business and
    // theirs, not a column in a list of everybody - the same phrase, absent here and
    // present there.
    await expect(row.getByTestId('live-now')).toContainText('online')
    await expect(row).not.toContainText('viewing page')
    // Tabs closed by earlier scenarios linger until their minute is up, so the count
    // is not this test's to assert; the person being listed is.
    await expect(page.getByTestId('presence-pill')).toHaveText(/^\d+ online$/)
    await page.getByTestId('presence-pill').click()
    await expect(page.getByTestId('presence-list').getByText(username)).toBeVisible()
    await expect(page.getByTestId('presence-list')).toContainText(`viewing page 1 of ${jobName}`)
    await expect(page.getByTestId('presence-list').getByRole('link').filter({ hasText: username }))
      .toHaveAttribute('href', `/jobs/${jobId}/pages/${pageId}`)

    await page.goto(`/jobs/${jobId}`)
    const pageRow = page.getByRole('row').filter({ hasText: 'scan_1.png' })
    await expect(pageRow.getByTestId('presence-avatars').getByLabel(username)).toBeVisible()

    await page.goto(`/jobs/${jobId}/pages/${pageId}`)
    await expect(page.getByTestId('presence-banner')).toHaveText(`${username} has this page open`)

    await theirTab.goto('/')
    await expect.poll(async () => (await whereIs(username))?.page_id ?? null).toBeNull()
    await expect(page.getByTestId('presence-banner')).toHaveCount(0)
    await colleague.close()
  })

  test('switching sharing off makes a person invisible at once, and the choice sticks', async ({ browser }) => {
    const username = `unseen-${Date.now()}`
    const token = seedSession('member', username)
    const colleague = await browser.newContext()
    await useSession(colleague, token)
    const theirTab = await colleague.newPage()

    await theirTab.goto('/settings?section=together')
    await expect.poll(async () => (await whereIs(username)) !== null).toBe(true)

    await theirTab.getByTestId('share-activity').uncheck()
    await expect.poll(async () => whereIs(username)).toBeNull()
    await expect.poll(async () => {
      const res = await fetch(`${FRONTEND}/api/settings`, { headers: { cookie: `sid=${token}` } })
      return (await res.json()).share_activity
    }).toBe(false)

    // A tab that shares sends its first heartbeat as it mounts, from the effect that runs
    // just before the one asking who else is here - so once that question is out, any
    // beat would be too.
    const beats: string[] = []
    const isPresence = (r: Request) => new URL(r.url()).pathname === '/api/presence'
    theirTab.on('request', (r) => {
      if (r.method() === 'POST' && isPresence(r)) beats.push(r.url())
    })
    const asked = theirTab.waitForRequest((r) => r.method() === 'GET' && isPresence(r))
    await theirTab.reload()
    await asked
    await expect(theirTab.getByTestId('share-activity')).not.toBeChecked()
    expect(beats).toEqual([])
    expect(await whereIs(username)).toBeNull()

    await theirTab.getByTestId('share-activity').check()
    await expect.poll(async () => (await whereIs(username)) !== null).toBe(true)
    expect(beats.length).toBeGreaterThan(0)
    await colleague.close()
  })
})

test.describe('Scenario: a deployment without a secure context', () => {
  test('the app boots where crypto.randomUUID is missing', async ({ page }) => {
    // randomUUID is secure-context only, and the app is served over plain HTTP on
    // its published port. localhost counts as secure, so only this removes it.
    await page.addInitScript(() => {
      Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true })
    })
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))

    const name = uniqueName('NoSecureCtx')
    await seedCompletedJob(name, 1)
    await page.goto('/')
    // the removal has to have taken, or this test passes for the wrong reason
    expect(await page.evaluate(() => typeof crypto.randomUUID)).toBe('undefined')

    await expect(page.getByTestId('job-card').filter({ hasText: name })).toBeVisible()
    expect(errors).toEqual([])
  })
})
