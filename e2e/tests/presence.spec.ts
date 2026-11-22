import { test, expect } from '../helpers/test'
import {
  backendFetch, createJob, getPageDetail, identity, jobPageIds, seedCompletedJob, shareJob, uniqueName, waitForJobStatus,
} from '../helpers/api'
import { asSession, seedSession, useSession } from '../helpers/session'
import { FRONTEND } from '../helpers/frontend'


interface PresenceUser {
  username: string
  job_id: string | null
  page_id: number | null
  targets: { kind: string; id: number }[]
}

async function whereIs(username: string): Promise<PresenceUser | null> {
  const res = await backendFetch('/api/presence')
  return res.users.find((u: PresenceUser) => u.username === username) ?? null
}

test.describe('Scenario: seeing which box a colleague holds', () => {
  test('a box a colleague selects is marked in your region list and on your scan, and let go when they do (#80)',
    async ({ page, browser }) => {
      const username = `holding-${Date.now()}`
      const token = seedSession('manager', username)
      const jobId = await seedCompletedJob(uniqueName('Held box'))
      await shareJob(jobId, [username])
      const [pageId] = await jobPageIds(jobId)
      const [held, free] = (await getPageDetail(jobId, pageId)).elements.map((e: { id: number }) => e.id)

      const colleague = await browser.newContext()
      await useSession(colleague, token)
      const theirTab = await colleague.newPage()
      await theirTab.goto(`/jobs/${jobId}/pages/${pageId}`)
      await theirTab.getByRole('button', { name: /^Edit/ }).click()
      await theirTab.locator(`[data-testid="region-row"][data-region-id="${held}"] button`).first().click()
      await expect.poll(async () => (await whereIs(username))?.targets ?? null)
        .toEqual([{ kind: 'element', id: held }])

      await page.goto(`/jobs/${jobId}/pages/${pageId}`)
      await page.getByRole('button', { name: /^Edit/ }).click()
      const row = (id: number) => page.locator(`[data-testid="region-row"][data-region-id="${id}"]`)
      await expect(row(held).getByTestId('presence-avatars').getByLabel(username)).toBeVisible()
      await expect(row(free)).toBeVisible()
      await expect(row(free).getByTestId('presence-avatars')).toHaveCount(0)
      const outline = page.locator('[data-testid="presence-box"]')
      await expect(outline).toHaveCount(1)
      await expect(outline).toHaveAttribute('data-id', String(held))
      await expect(outline).toHaveAttribute('data-user', username)

      await theirTab.keyboard.press('Escape')
      await expect.poll(async () => (await whereIs(username))?.targets ?? null).toEqual([])
      await expect(row(held).getByTestId('presence-avatars')).toHaveCount(0)
      await expect(outline).toHaveCount(0)
      await colleague.close()
    })
})

test.describe('Scenario: seeing who is where', () => {
  // Admins leave no trace where they do not belong (#131, decision 322); other admins still see them.
  test('an admin on a page of a dataset they do not belong to shows no avatar to its people', async ({ page, browser }) => {
    const lena = `lena-${Date.now()}`
    const lenaSession = seedSession('annotator', lena)
    const jobId = await createJob(uniqueName('Not the admins'), 1, undefined, identity(lena, 'annotator'))
    await waitForJobStatus(jobId, 'done')
    const [pageId] = await jobPageIds(jobId)

    // The browser's own session is the dev admin, who neither made nor was given it.
    await page.goto(`/jobs/${jobId}/pages/${pageId}`)
    const devTabs = async () => (await backendFetch('/api/presence')).users
      .filter((u: PresenceUser) => u.username === 'dev')
    await expect.poll(async () => (await devTabs()).some((u: PresenceUser) => u.page_id === pageId)).toBe(true)

    const lenaContext = await browser.newContext()
    await useSession(lenaContext, lenaSession)
    const asLena = (await (await lenaContext.request.get('/api/presence')).json()).users
      .filter((u: PresenceUser) => u.username === 'dev')
    expect(asLena.length).toBeGreaterThan(0)
    expect(asLena.map((u: PresenceUser) => u.page_id)).toEqual(asLena.map(() => null))

    const lenaTab = await lenaContext.newPage()
    await lenaTab.goto(`/jobs/${jobId}`)
    await expect(lenaTab.getByTestId('presence-pill')).toHaveText(/^\d+ others? online$/)
    const pageRow = lenaTab.getByRole('row').filter({ hasText: 'scan_1.png' })
    await expect(pageRow).toHaveCount(1)
    await expect(pageRow.getByTestId('presence-avatars').getByLabel('dev')).toHaveCount(0)
    await lenaTab.goto(`/jobs/${jobId}/pages/${pageId}`)
    await expect(lenaTab.getByTestId('presence-pill')).toHaveText(/^\d+ others? online$/)
    await expect(lenaTab.getByTestId('presence-banner')).toHaveCount(0)
    await lenaContext.close()
  })

  test('a colleague on a page shows up on Admin, the dataset and the page, and moves on', async ({ page, browser }) => {
    const username = `present-${Date.now()}`
    const token = seedSession('manager', username)
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
    // Tabs closed by earlier scenarios linger for their two minutes, so the count is not
    // this test's to assert; the person being listed is.
    await expect(page.getByTestId('presence-pill')).toHaveText(/^\d+ others? online$/)
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

  test('switching sharing off keeps a person online but hides where they are, and the choice sticks', async ({ browser }) => {
    const username = `unseen-${Date.now()}`
    const token = seedSession('manager', username)
    const jobId = await seedCompletedJob(uniqueName('Unseen'))
    await shareJob(jobId, [username])
    const [pageId] = await jobPageIds(jobId)
    const colleague = await browser.newContext()
    await useSession(colleague, token)
    const theirTab = await colleague.newPage()
    await theirTab.goto(`/jobs/${jobId}/pages/${pageId}`)
    await expect.poll(async () => (await whereIs(username))?.page_id ?? null).toBe(pageId)

    const share = (on: boolean) => fetch(`${FRONTEND}/api/settings`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', cookie: `sid=${token}` },
      body: JSON.stringify({ share_activity: on }),
    })
    expect((await share(false)).status).toBe(200)
    // Still online, on no page anyone else can see.
    await expect.poll(async () => {
      const entry = await whereIs(username)
      return entry && [entry.username, entry.job_id, entry.page_id]
    }, { timeout: 30_000 }).toEqual([username, null, null])

    // The choice sticks: a reload reports in again, still with no place.
    const asked = theirTab.waitForRequest((r) => r.method() === 'GET' && new URL(r.url()).pathname === '/api/presence')
    await theirTab.reload()
    await asked
    await expect.poll(async () => (await whereIs(username))?.username ?? null).toBe(username)
    expect((await whereIs(username))?.page_id).toBeNull()

    expect((await share(true)).status).toBe(200)
    await expect.poll(async () => (await whereIs(username))?.page_id ?? null, { timeout: 30_000 }).toBe(pageId)
    await colleague.close()
  })

  // README: "online" means having DeepLabel open - in view or in a background tab, a viewer's
  // too - and the admin page and the top bar both read that one list (#139).
  test('anyone with DeepLabel open is online in both places, and a request without a tab is not', async ({ page, browser }) => {
    const stamp = Date.now()
    const viewer = `viewing-${stamp}`
    const behind = `behind-${stamp}`
    const tabless = `tabless-${stamp}`

    const viewerContext = await browser.newContext()
    await useSession(viewerContext, seedSession('viewer', viewer))
    await (await viewerContext.newPage()).goto('/')
    // A tab left behind another one: the browser reports it hidden.
    const behindContext = await browser.newContext()
    await useSession(behindContext, seedSession('manager', behind))
    await behindContext.addInitScript(() => {
      Object.defineProperty(document, 'visibilityState', { get: () => 'hidden' })
      Object.defineProperty(document, 'hidden', { get: () => true })
    })
    await (await behindContext.newPage()).goto('/')
    // Someone whose account just made a request, with no DeepLabel tab open.
    expect((await asSession(seedSession('manager', tabless), '/api/jobs')).status).toBe(200)

    await expect.poll(async () => [(await whereIs(viewer))?.username ?? null, (await whereIs(behind))?.username ?? null])
      .toEqual([viewer, behind])
    expect(await whereIs(tabless)).toBeNull()

    await page.goto('/admin')
    const row = (name: string) => page.getByTestId('user-row').filter({ hasText: name })
    await expect(row(viewer).getByTestId('live-now')).toContainText('online')
    await expect(row(behind).getByTestId('live-now')).toContainText('online')
    await expect(row(tabless)).toBeVisible()
    await expect(row(tabless).getByTestId('live-now')).toHaveCount(0)

    // The top bar counts the others; how many is not this test's to assert, as tabs from
    // earlier scenarios linger for their two minutes, but these two are among them.
    await expect(page.getByTestId('presence-pill')).toHaveText(/^\d+ others? online$/)
    await page.getByTestId('presence-pill').click()
    for (const name of [viewer, behind]) await expect(page.getByTestId('presence-list').getByText(name)).toBeVisible()
    await expect(page.getByTestId('presence-list').getByText(tabless)).toHaveCount(0)

    await viewerContext.close()
    await behindContext.close()
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
