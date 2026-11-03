import { test, expect } from '../helpers/test'

test.describe('Scenario: signing in and out', () => {
  // Start without the shared session so the login bounce itself is under test.
  test.use({ storageState: { cookies: [], origins: [] } })

  test('visiting the app logs in via the dev bypass and lands on the jobs page', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('link', { name: 'DeepLabel', exact: true })).toBeVisible()
    await page.getByTestId('user-menu').click()
    await expect(page.getByTestId('profile-name')).toHaveText('dev')
    await expect(page.getByRole('link', { name: 'New job' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Admin' })).toBeVisible()
  })

  test('logging out ends the session and, without a sign-in provider, signs back in cleanly', async ({ page, playwright }) => {
    await page.goto('/')
    await page.getByTestId('user-menu').click()
    const before = (await page.context().cookies()).find((c) => c.name === 'sid')
    expect(before).toBeDefined()
    // The browser leaves at once, so the answer is read on its way through.
    let loggedOut: unknown = null
    await page.route('**/api/logout', async (route) => {
      const response = await route.fetch()
      loggedOut = await response.json()
      await route.fulfill({ response })
    })
    await page.getByRole('button', { name: 'Log out' }).click()
    // With a provider this is its end-session address; the dev bypass has none to end.
    await expect.poll(() => loggedOut).toEqual({ ok: true, redirect: '/api/login' })
    await expect
      .poll(async () => {
        const sid = (await page.context().cookies()).find((c) => c.name === 'sid')?.value
        return sid && sid !== before?.value ? sid : null
      })
      .not.toBeNull()
    await expect(page.getByRole('link', { name: 'DeepLabel', exact: true })).toBeVisible()

    const oldSession = await playwright.request.newContext({
      baseURL: page.url(), extraHTTPHeaders: { Cookie: `sid=${before!.value}` } })
    expect((await oldSession.get('/api/me', { maxRedirects: 0 })).status()).toBe(401)
    await oldSession.dispose()
  })
})
