import { test, expect } from '../helpers/test'
import { BACKEND, jobPageIds, pageDeletedFlags, seedCompletedJob, uniqueName } from '../helpers/api'
import { LANDSCAPE } from '../helpers/viewer'

const ADMIN_HEADERS = { 'X-Frontend-Secret': 'e2e-secret', 'X-Auth-User': 'e2e-seeder', 'X-Auth-Role': 'admin' }

const thumbStatus = async (pageId: number) => {
  const res = await fetch(`${BACKEND}/api/pages/${pageId}/rendition?kind=thumb`, {
    headers: ADMIN_HEADERS,
  })
  return res.status
}

test.describe('Scenario: purging deleted pages', () => {
  test('purging frees the files and makes the delete permanent', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Purge'), 2, LANDSCAPE)
    const [firstPageId] = await jobPageIds(jobId)
    expect(await thumbStatus(firstPageId)).toBe(200)

    await page.goto(`/jobs/${jobId}`)
    await page.locator('tbody tr').first().locator('input[type="checkbox"]').click()
    await page.getByRole('button', { name: 'Delete', exact: true }).click()
    await expect.poll(() => pageDeletedFlags(jobId)).toEqual([true, false])

    // The scan upload, its two renditions and the 25 deep-zoom tiles of an 800 by 600 scan.
    const purgeButton = page.getByRole('button', { name: /^Purge \d/ })
    await expect(purgeButton).toHaveText('Purge 1')
    await purgeButton.click()
    await expect(page.getByText(/Permanently deletes 28 image file/)).toBeVisible()
    await page.getByRole('button', { name: 'Purge', exact: true }).click()
    await expect(page.getByText(/Freed /)).toBeVisible()
    await page.getByRole('button', { name: 'Close' }).click()

    // The image files are really gone, not just reported freed.
    await expect.poll(() => thumbStatus(firstPageId)).not.toBe(200)

    // Nothing left to free, so the button stops offering a purge - the page row
    // survives a purge, so counting rows kept it stuck at "Purge 1" forever.
    await expect(purgeButton).toHaveCount(0)

    // Restoring a purged page must fail - and the Deleted filter is the only place
    // left to try it from.
    await page.getByTestId('page-filter-deleted').click()
    await expect(page.locator('tbody tr')).toHaveCount(1)
    await page.locator('tbody tr').first().locator('input[type="checkbox"]').click()
    await page.getByRole('button', { name: 'Restore 1' }).click()
    await expect(page.getByText(/cannot be restored/)).toBeVisible()
    await expect.poll(() => pageDeletedFlags(jobId)).toEqual([true, false])
  })
})
