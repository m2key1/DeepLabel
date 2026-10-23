import { test, expect } from '../helpers/test'

test.describe('Scenario: signing in and out', () => {
  // Start without the shared session so the login bounce itself is under test.
  test.use({ storageState: { cookies: [], origins: [] } })

  test('visiting the app logs in via the dev bypass and lands on the jobs page', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('link', { name: 'DeepLabel' })).toBeVisible()
    await page.getByTestId('user-menu').click()
    await expect(page.getByTestId('profile-name')).toHaveText('dev')
    await expect(page.getByRole('link', { name: 'New job' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Admin' })).toBeVisible()
  })

  test('logging out cycles the session and signs back in cleanly', async ({ page }) => {
    await page.goto('/')
    const before = (await page.context().cookies()).find((c) => c.name === 'sid')
    await page.getByTestId('user-menu').click()
    await page.getByRole('button', { name: 'Log out' }).click()
    // The logout/login navigation chain lands back on '/' with a fresh session;
    // poll for the new cookie rather than racing the redirects.
    await expect
      .poll(async () => {
        const sid = (await page.context().cookies()).find((c) => c.name === 'sid')?.value
        return sid && sid !== before?.value ? sid : null
      })
      .not.toBeNull()
    await expect(page.getByRole('link', { name: 'DeepLabel' })).toBeVisible()
  })
})
