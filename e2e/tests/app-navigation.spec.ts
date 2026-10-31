import { test, expect } from '../helpers/test'
import { backendFetch, createJob, identity, jobPageIds, seedCompletedJob, uniqueName, waitForJobStatus } from '../helpers/api'
import { seedSession } from '../helpers/session'
import { LANDSCAPE, openViewer } from '../helpers/viewer'

test.describe('Scenario: the shortcut sheet is in front of the page', () => {
  test('a key pressed while the sheet is open does not act on the page behind it', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Sheet open'), 2, LANDSCAPE)
    const [first] = await jobPageIds(jobId)
    await openViewer(page, jobId, first)

    await page.keyboard.press('?')
    await expect(page.getByTestId('shortcut-sheet')).toBeVisible()
    await page.keyboard.press('ArrowRight')
    await expect(page).toHaveURL(new RegExp(`/pages/${first}$`))
    await expect(page.getByTestId('shortcut-sheet')).toBeVisible()

    // Closed, the same key turns the page, so the key above was the sheet's to swallow.
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('shortcut-sheet')).toHaveCount(0)
    await page.keyboard.press('ArrowRight')
    await expect(page).not.toHaveURL(new RegExp(`/pages/${first}$`))
  })
})

test.describe("Scenario: an admin reading the list as someone else", () => {
  test('"only mine" means that person\'s datasets under the lens', async ({ page }) => {
    const member = `lens-mine-${Date.now()}`
    seedSession('member', member)
    const theirsName = uniqueName('Their own dataset')
    const theirs = await createJob(theirsName, 1, undefined, identity(member, 'member'))
    await waitForJobStatus(theirs, 'done')

    await page.goto(`/?as=${encodeURIComponent(member)}`)
    await expect(page.getByTestId('job-card').filter({ hasText: theirsName })).toHaveCount(1)
    await page.getByTestId('filter-menu').click()
    await page.getByTestId('filter-mine').click()
    await expect(page).toHaveURL(/[?&]mine=1/)
    await expect(page.getByTestId('job-card').filter({ hasText: theirsName })).toHaveCount(1)
    await expect(page.getByText('No dataset matches.')).toHaveCount(0)
  })
})

test.describe('Scenario: following a link to nowhere', () => {
  test('an unknown address keeps the app around it and says so', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('link', { name: 'DeepLabel', exact: true })).toBeVisible()
    await page.goto('/no/such/place')
    await expect(page.getByRole('link', { name: 'DeepLabel', exact: true })).toBeVisible()
    await expect(page.getByText(/not found/i)).toBeVisible()
  })
})

test.describe('Scenario: finding out which release this is and where to report a problem', () => {
  test('every page but the editors and the transcript ends with the version and the project links', async ({ page }) => {
    expect(await backendFetch('/api/meta')).toEqual({ version: '0.1.0', commit: null })
    const jobId = await seedCompletedJob(uniqueName('Footer'), 1, LANDSCAPE)
    const [first] = await jobPageIds(jobId)
    const repo = 'https://github.com/m2key1/DeepLabel'
    const footer = page.getByTestId('app-footer')

    for (const path of ['/', `/jobs/${jobId}`, '/models', '/people/dev']) {
      await page.goto(path)
      await expect(footer.getByTestId('app-version')).toHaveText('DeepLabel 0.1.0')
    }
    await expect(footer.getByRole('link', { name: 'DeepLabel 0.1.0' })).toHaveAttribute('href', `${repo}/tree/v0.1.0`)
    await expect(footer.getByRole('link', { name: 'Documentation' })).toHaveAttribute('href', `${repo}/blob/main/docs/FEATURES.md`)
    await expect(footer.getByRole('link', { name: 'Source on GitHub' })).toHaveAttribute('href', repo)
    await expect(footer.getByRole('link', { name: 'Report a problem' })).toHaveAttribute('href', `${repo}/issues/new`)
    await expect(page.getByTestId('profile').getByTestId('app-version')).toHaveCount(0)

    await openViewer(page, jobId, first)
    await expect(footer).toHaveCount(0)
    await page.goto(`/jobs/${jobId}/tiles/${first}`)
    await expect(page.getByTestId('tile-canvas')).toBeVisible()
    await expect(footer).toHaveCount(0)
    await page.goto(`/jobs/${jobId}/transcript`)
    await expect(page.getByTestId('transcript-text')).toBeVisible()
    await expect(footer).toHaveCount(0)
  })
})
