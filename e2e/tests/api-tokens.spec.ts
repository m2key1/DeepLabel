import { test, expect } from '../helpers/test'
import type { APIRequestContext } from '@playwright/test'
import { getJob, seedCompletedJob, uniqueName } from '../helpers/api'

/** A client that is only ever its token: the suite's storageState would otherwise ride
 *  along as a session cookie, which /validate resolves first - the request would then
 *  succeed no matter what the token says. */
function tokenClient(
  playwright: { request: { newContext: (o: object) => Promise<APIRequestContext> } },
  baseURL: string | undefined,
  token: string,
): Promise<APIRequestContext> {
  return playwright.request.newContext({
    baseURL,
    storageState: { cookies: [], origins: [] },
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  })
}

async function mintToken(page: import('@playwright/test').Page, name: string, readonly: boolean) {
  // Dismiss any secret still on screen first: otherwise the read below can return the
  // previous token, and the test would go on to use the wrong one.
  const secretBox = page.getByTestId('token-secret')
  if (await secretBox.count()) await secretBox.getByRole('button', { name: 'Dismiss' }).click()
  await expect(secretBox).toHaveCount(0)

  await page.getByLabel('Token name').fill(name)
  const checkbox = page.getByTestId('token-readonly')
  if (readonly) await checkbox.check()
  else await checkbox.uncheck()
  await page.getByRole('button', { name: 'Create token' }).click()

  await expect(secretBox).toHaveCount(1)
  const secret = await secretBox.locator('code').innerText()
  expect(secret).toMatch(/^dlp_/)
  return secret
}

test.describe('Scenario: scripting against the API with a token', () => {
  test('a token reads the same API as the UI, and a read-only one is refused writes',
    async ({ page, playwright, baseURL }) => {
      const jobId = await seedCompletedJob(uniqueName('Tokens'), 1)

      await page.goto('/settings?section=tokens')
      const fullName = uniqueName('cli')
      const readonlyName = uniqueName('ci')
      const full = await mintToken(page, fullName, false)
      const readonly = await mintToken(page, readonlyName, true)
      const rows = page.getByTestId('token-row')
      await expect(rows.filter({ hasText: fullName })).toContainText('read/write')
      await expect(rows.filter({ hasText: readonlyName })).toContainText('read-only')

      const asFull = await tokenClient(playwright, baseURL, full)
      const asReadonly = await tokenClient(playwright, baseURL, readonly)

      // Reading: both tokens see the seeded dataset, exactly as their owner does.
      for (const client of [asFull, asReadonly]) {
        const response = await client.get('/api/jobs')
        expect(response.status()).toBe(200)
        const ids = (await response.json()).map((j: { id: string }) => j.id)
        expect(ids).toContain(jobId)
      }

      // Writing: the read-only token is refused, and the dataset is still there after.
      const refused = await asReadonly.delete(`/api/jobs/${jobId}`)
      expect(refused.status()).toBe(403)
      expect((await refused.json()).detail).toBe('read-only API token')
      expect((await getJob(jobId)).id).toBe(jobId)

      // The full token may write - proven against backend state, not the response alone.
      const renamed = uniqueName('Renamed')
      const patched = await asFull.patch(`/api/jobs/${jobId}`, { data: { name: renamed } })
      expect(patched.status()).toBe(200)
      await expect.poll(async () => (await getJob(jobId)).name).toBe(renamed)

      // An unknown token is nobody, so a leaked prefix alone opens nothing.
      const stranger = await tokenClient(playwright, baseURL, full.slice(0, 12))
      expect((await stranger.get('/api/jobs')).status()).toBe(401)
    })

  test('revoking a token stops it immediately', async ({ page, playwright, baseURL }) => {
    await page.goto('/settings?section=tokens')
    const doomed = await mintToken(page, 'temporary', false)
    const keeper = await mintToken(page, 'keeper', false)

    const asDoomed = await tokenClient(playwright, baseURL, doomed)
    expect((await asDoomed.get('/api/jobs')).status()).toBe(200)

    page.on('dialog', (d) => d.accept())
    await page.getByTestId('token-row').filter({ hasText: 'temporary' })
      .getByRole('button', { name: 'Revoke' }).click()

    await expect(page.getByTestId('token-row').filter({ hasText: 'temporary' })).toHaveCount(0)
    await expect(page.getByTestId('token-row').filter({ hasText: 'keeper' })).toHaveCount(1)
    expect((await asDoomed.get('/api/jobs')).status()).toBe(401)

    const asKeeper = await tokenClient(playwright, baseURL, keeper)
    expect((await asKeeper.get('/api/jobs')).status()).toBe(200)
  })
})

test.describe("Scenario: a token reaches the auth service's endpoints too", () => {
  test('a token answers who it is and reads its owner\'s settings, as the interface does',
    async ({ page, playwright, baseURL }) => {
      await page.goto('/settings?section=tokens')
      const token = await mintToken(page, uniqueName('whoami'), true)
      const me = await (await page.request.get('/api/me')).json()
      const settings = await (await page.request.get('/api/settings')).json()

      const client = await tokenClient(playwright, baseURL, token)
      const whoami = await client.get('/api/me')
      expect(whoami.status()).toBe(200)
      expect(me.user).toBe('dev')
      expect(await whoami.json()).toEqual(me)

      const theirs = await client.get('/api/settings')
      expect(theirs.status()).toBe(200)
      expect(await theirs.json()).toEqual(settings)

      // The same client is refused without its token, so the answers above are the token's.
      const anonymous = await playwright.request.newContext({ baseURL, storageState: { cookies: [], origins: [] } })
      expect((await anonymous.get('/api/me')).status()).toBe(401)
      await client.dispose()
      await anonymous.dispose()
    })
})
