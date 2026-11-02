import { test, expect } from '../helpers/test'
import { markLinesChecked, markTestPages, seedCompletedJob, TEST_SCAN_WIDTH, uniqueName } from '../helpers/api'

test.describe('Scenario: picking many datasets for a training at once', () => {
  test('Select all takes every dataset a search shows, and every test set, and Clear all lets them go',
    async ({ page }) => {
      const tag = uniqueName('Bulk pick')
      await markLinesChecked(await seedCompletedJob(`${tag} A`, 1), 3)
      await markLinesChecked(await seedCompletedJob(`${tag} B`, 1), 2)
      const testA = await seedCompletedJob(`${tag} test A`, 1, { width: TEST_SCAN_WIDTH, height: 800 })
      const testB = await seedCompletedJob(`${tag} test B`, 1, { width: TEST_SCAN_WIDTH, height: 800 })
      await markTestPages(testA)
      await markTestPages(testB)

      await page.goto('/models/train?task=ocr')
      await page.getByRole('searchbox', { name: 'Search datasets' }).fill(`${tag} `)
      const selectAll = page.getByTestId('datasets-select-all')
      await expect(selectAll).toHaveText('Select all 2')
      await selectAll.click()
      await expect.poll(async () => (await page.getByTestId('dataset-pick').allTextContents()).sort())
        .toEqual([`${tag} A×`, `${tag} B×`])
      await expect(page.getByText('5 checked lines selected')).toBeVisible()
      await expect(selectAll).toHaveText('Clear all')
      await selectAll.click()
      await expect(page.getByText('0 checked lines selected')).toBeVisible()
      await expect(page.getByTestId('dataset-pick')).toHaveCount(0)

      // The test sets search the same way, and Select all takes what the search shows.
      await page.getByRole('searchbox', { name: 'Search test sets' }).fill(`${tag} test`)
      const tests = page.getByTestId('training-test-sets')
      const ours = tests.getByTestId('test-set-option').getByRole('checkbox')
      await expect(ours).toHaveCount(2)
      const selectTests = tests.getByTestId('test-sets-select-all')
      await expect(selectTests).toHaveText('Select all 2')
      // It stands on the search row, clear of the help text above it.
      const search = await page.getByRole('searchbox', { name: 'Search test sets' }).boundingBox()
      const button = await selectTests.boundingBox()
      const help = await tests.getByText('Optional - the test pages of datasets').boundingBox()
      expect(button!.y).toBeGreaterThanOrEqual(search!.y - 1)
      expect(button!.y + button!.height).toBeLessThanOrEqual(search!.y + search!.height + 1)
      expect(button!.y).toBeGreaterThanOrEqual(help!.y + help!.height)
      await selectTests.click()
      await expect(ours.nth(0)).toBeChecked()
      await expect(ours.nth(1)).toBeChecked()
      await expect.poll(async () => (await tests.getByTestId('test-set-pick').allTextContents()).sort())
        .toEqual([`${tag} test A×`, `${tag} test B×`])
      await expect(page.getByTestId('submit-summary')).toContainText(`${tag} test A`)
      await expect(selectTests).toHaveText('Clear all')
      await selectTests.click()
      await expect(tests.getByTestId('test-set-pick')).toHaveCount(0)
      await expect(ours.nth(0)).not.toBeChecked()
    })
})
