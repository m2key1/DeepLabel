import { test, expect } from '../helpers/test'

test.describe('Scenario: backend failures', () => {
  test('a backend outage surfaces as an error instead of a blank page', async ({ page }) => {
    await page.route('**/api/jobs', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'backend unreachable (e2e)' }),
      }),
    )
    await page.goto('/')
    await expect(page.getByText('backend unreachable (e2e)')).toBeVisible()
  })
})
