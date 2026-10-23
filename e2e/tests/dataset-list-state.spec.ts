import { test, expect } from '../helpers/test'
import {
  createGroup, markLinesChecked, moveJobToGroup, seedCompletedJob, setCollapsedGroups,
  uniqueName,
} from '../helpers/api'

test.describe('Scenario: the list remembers how it was left', () => {
  test.afterEach(async ({ page }) => setCollapsedGroups(page, []))

  test('folding away the Ungrouped section survives a reload, like a project does', async ({ page }) => {
    await seedCompletedJob(uniqueName('Loose dataset'), 1)
    await setCollapsedGroups(page, [])
    await page.goto('/')

    const ungrouped = page.locator('[data-testid="list-section"][data-title="Ungrouped"]')
    const toggle = ungrouped.getByRole('button', { name: /Ungrouped/ }).first()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    // Account-side oracle: the fold is stored with the rest of the person's settings.
    await expect.poll(async () => (await (await page.request.get('/api/settings')).json()).collapsed_groups)
      .toEqual(['ungrouped'])

    await page.reload()
    await expect(page.locator('[data-testid="list-section"][data-title="Ungrouped"]')
      .getByRole('button', { name: /Ungrouped/ }).first()).toHaveAttribute('aria-expanded', 'false')
  })

  test('clearing a search that matched nothing keeps the chosen view and order', async ({ page }) => {
    await seedCompletedJob(uniqueName('Something to find'), 1)
    await page.goto('/?view=cards&sort=newest&q=zzzz-no-such-dataset')
    await expect(page.getByText('No dataset matches.')).toBeVisible()
    await page.getByRole('button', { name: 'Clear the search and filters' }).click()

    await expect(page).toHaveURL(/[?&]view=cards/)
    await expect(page).toHaveURL(/[?&]sort=newest/)
    await expect(page).not.toHaveURL(/[?&]q=/)
    await expect(page.getByText('No dataset matches.')).toHaveCount(0)
    await expect(page.getByTestId('job-card').first()).toBeVisible()
  })
})

test.describe('Scenario: what a group re-read will actually do', () => {
  test('a dataset with no unchecked lines is not counted among those it will re-read',
    async ({ page }) => {
      const groupName = uniqueName('Half done group')
      const group = await createGroup(groupName)
      const fresh = await seedCompletedJob(uniqueName('Still to read'), 1)
      const finished = await seedCompletedJob(uniqueName('Every line checked'), 1)
      for (const jobId of [fresh, finished]) await moveJobToGroup(jobId, group.id)
      await markLinesChecked(finished, 6)

      await page.goto('/')
      const section = page.locator('section').filter({ hasText: groupName })
      await section.getByTestId('group-run').click()
      await page.getByRole('button', { name: 'Re-read OCR…' }).click()

      // The re-read would refuse the finished one ("no unchecked lines"), so the
      // confirmation counts only the one it will run.
      const dialog = page.getByTestId('bulk-preview')
      await expect(dialog.getByTestId('preview-datasets')).toHaveText('1')
      await expect(dialog.getByTestId('preview-unchecked')).toHaveText('6')
      await expect(dialog.getByTestId('preview-checked')).toHaveText('6')
    })
})
