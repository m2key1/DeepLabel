import type { Page } from '@playwright/test'

/** A person's role, cluster account and Disable on the Admin page, which sit in their
 *  details: opened here unless they already are. */
export async function accountControls(page: Page, username: string) {
  const controls = page.locator(`[data-testid="user-account"][data-user="${username}"]`)
  if (await controls.count() === 0) {
    await page.getByRole('button', { name: `Show details for ${username}` }).click()
  }
  return controls
}

/** The Admin page's API tokens, on their own tab. */
export async function adminTokens(page: Page) {
  await page.getByRole('tab', { name: 'API tokens' }).click()
  return page.getByTestId('admin-tokens')
}
