import { test, expect } from '../helpers/test'
import {
  backendFetch, getJob, jobPageIds, listEvaluations, listRegistryModels, markLinesChecked, markTestPages,
  seedDistinctPagesJob, TEST_SCAN_WIDTH, testFlags, uniqueName,
} from '../helpers/api'
import { scanPng } from '../helpers/image'
import { pickDataset } from '../helpers/training'
import { openViewer } from '../helpers/viewer'

// Every scan here is TEST_SCAN_WIDTH wide: a test page keeps every page of the same scan
// out of training, and the common stub scans are in every spec.

const switchOf = async (jobId: string) => (await getJob(jobId)).new_pages_test as boolean

test.describe('Scenario: marking test data on a dataset', () => {
  test('a selection of pages is marked, and the dataset counts and lists them', async ({ page }) => {
    const jobId = await seedDistinctPagesJob(uniqueName('Selected test pages'), 3, 0, TEST_SCAN_WIDTH)
    await page.goto(`/jobs/${jobId}`)

    const rows = page.locator('[data-page-row]')
    await expect(rows).toHaveCount(3)
    await expect(page.getByTestId('job-test-pages')).toHaveText('Test data: none')
    await page.getByRole('checkbox', { name: 'Select scan_1.png' }).click()
    await page.getByRole('checkbox', { name: 'Select scan_2.png' }).click()
    await page.getByTestId('bulk-test-pages').click()

    await expect.poll(() => testFlags(jobId)).toEqual([true, true, false])
    expect(await switchOf(jobId)).toBe(false)
    await expect(page.getByTestId('job-test-pages')).toHaveText('Test data: 2 of 3 pages')
    await expect(rows.locator('[data-testid="page-test"][aria-checked="true"]')).toHaveCount(2)
    await expect(rows.locator('[data-testid="page-test"][aria-checked="false"]')).toHaveCount(1)
    await expect(page.getByTestId('page-filter-test-pages')).toHaveText('Test pages · 2')

    // Marked already, so the same selection's button undoes it.
    await expect(page.getByTestId('bulk-test-pages')).toHaveText('Unmark test pages')
    await page.getByTestId('bulk-test-pages').click()
    await expect.poll(() => testFlags(jobId)).toEqual([false, false, false])
    await expect(page.getByTestId('job-test-pages')).toHaveText('Test data: none')
  })

  test("a row's Test cell marks that one page", async ({ page }) => {
    const jobId = await seedDistinctPagesJob(uniqueName('Row test page'), 2, 5, TEST_SCAN_WIDTH)
    await page.goto(`/jobs/${jobId}`)

    const cell = page.getByRole('switch', { name: 'Test page: scan_2.png' })
    await expect(cell).toHaveAttribute('aria-checked', 'false')
    await cell.click()

    await expect.poll(() => testFlags(jobId)).toEqual([false, true])
    await expect(cell).toHaveAttribute('aria-checked', 'true')
    await expect(page).toHaveURL(new RegExp(`/jobs/${jobId}$`))
    await expect(page.getByTestId('job-test-pages')).toHaveText('Test data: 1 of 2 pages')
  })

  test('the whole dataset is test data, and an upload can still add pages that are not',
    async ({ page }) => {
      const jobId = await seedDistinctPagesJob(uniqueName('Whole test set'), 2, 10, TEST_SCAN_WIDTH)
      await page.goto(`/jobs/${jobId}`)

      await page.getByTestId('job-test-pages').click()
      const dialog = page.getByRole('dialog', { name: 'Test data' })
      await dialog.getByRole('radio', { name: 'The whole dataset, including pages added later' }).check()
      await dialog.getByRole('button', { name: 'Save' }).click()

      await expect.poll(() => testFlags(jobId)).toEqual([true, true])
      expect(await switchOf(jobId)).toBe(true)
      await expect(page.getByTestId('job-test-pages')).toHaveText('Test data: whole dataset')
      await expect(page.getByTestId('add-as-test')).toBeChecked()

      await page.getByTestId('add-as-test').uncheck()
      await page.locator('input[type="file"]').setInputFiles(
        [{ name: 'extra.png', mimeType: 'image/png', buffer: scanPng(TEST_SCAN_WIDTH, 800, 13) }])
      await expect.poll(() => testFlags(jobId)).toEqual([true, true, false])
      await expect(page.getByTestId('job-test-pages')).toHaveText('Test data: 2 of 3 pages')
    })

  test('No test pages unmarks every page and warns first', async ({ page }) => {
    const jobId = await seedDistinctPagesJob(uniqueName('Unmarked whole'), 2, 20, TEST_SCAN_WIDTH)
    await markTestPages(jobId)
    await page.goto(`/jobs/${jobId}`)

    // Opened before the dataset's counts are in, the dialog still settles on what is marked.
    await page.getByTestId('job-test-pages').click()
    const dialog = page.getByRole('dialog', { name: 'Test data' })
    await expect(dialog.getByRole('radio', { name: 'The whole dataset, including pages added later' })).toBeChecked()
    await expect(page.getByTestId('job-test-pages')).toHaveText('Test data: whole dataset')
    await expect(dialog.getByTestId('test-data-unmark-warning')).toHaveCount(0)
    await dialog.getByRole('radio', { name: 'No test pages' }).check()
    await expect(dialog.getByTestId('test-data-unmark-warning')).toHaveText(
      'Training may then use the 2 pages marked now.')
    await dialog.getByRole('button', { name: 'Save' }).click()

    await expect.poll(() => testFlags(jobId)).toEqual([false, false])
    expect(await switchOf(jobId)).toBe(false)
    await expect(page.getByTestId('job-test-pages')).toHaveText('Test data: none')
  })

  test('the page viewer marks the page it shows', async ({ page }) => {
    const jobId = await seedDistinctPagesJob(uniqueName('Viewer test page'), 2, 30, TEST_SCAN_WIDTH)
    const [, second] = await jobPageIds(jobId)
    await openViewer(page, jobId, second)

    const toggle = page.getByTestId('page-test-toggle')
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await toggle.click()

    await expect.poll(() => testFlags(jobId)).toEqual([false, true])
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
  })

  test('a dataset created as test pages keeps its switch on', async ({ page }) => {
    const name = uniqueName('Created as test')
    await page.goto('/new')
    await page.getByLabel('Job name').fill(name)
    await page.locator('input[type="file"]').setInputFiles(
      [{ name: 'a.png', mimeType: 'image/png', buffer: scanPng(TEST_SCAN_WIDTH, 800, 41) }])
    await page.getByTestId('as-test').check()
    await page.getByRole('button', { name: 'Create job' }).click()
    await expect(page).toHaveURL(/\/jobs\/[0-9a-f]{12}$/)
    const jobId = page.url().split('/').pop()!

    await expect.poll(() => testFlags(jobId)).toEqual([true])
    expect(await switchOf(jobId)).toBe(true)
  })
})

test.describe('Scenario: the dataset list', () => {
  test('it says how much of a dataset is test data and filters by it', async ({ page }) => {
    const whole = uniqueName('List whole test')
    const part = uniqueName('List part test')
    const none = uniqueName('List no test')
    const wholeJob = await seedDistinctPagesJob(whole, 1, 50, TEST_SCAN_WIDTH)
    const partJob = await seedDistinctPagesJob(part, 2, 60, TEST_SCAN_WIDTH)
    await seedDistinctPagesJob(none, 1, 70, TEST_SCAN_WIDTH)
    await markTestPages(wholeJob)
    await markTestPages(partJob, [(await jobPageIds(partJob))[0]])

    await page.goto(`/?q=${encodeURIComponent('List ')}`)
    const row = (name: string) => page.getByTestId('job-card').filter({ hasText: name })
    await expect(row(whole).getByTestId('test-pages-label')).toHaveText('test set')
    await expect(row(part).getByTestId('test-pages-label')).toHaveText('1 of 2 test pages')
    await expect(row(none)).toBeVisible()
    await expect(row(none).getByTestId('test-pages-label')).toHaveCount(0)

    await page.getByTestId('filter-menu').click()
    await page.getByTestId('filter-test').click()
    await expect(page.getByTestId('filter-test')).toBeChecked()
    await expect(row(whole)).toBeVisible()
    await expect(row(part)).toBeVisible()
    await expect(row(none)).toHaveCount(0)
    // The filter shows as a chip beside the search, and its cross takes it off again.
    await page.keyboard.press('Escape')
    const chip = page.locator('[data-testid="filter-chip"][data-filter="test"]')
    await expect(chip).toContainText('Has test data')
    await expect(page.getByTestId('filter-menu')).toContainText('1')
    await chip.getByRole('button', { name: 'Remove filter: Has test data' }).click()
    await expect(row(none)).toBeVisible()
    await expect(page.getByTestId('filter-chip')).toHaveCount(0)
    await expect(page).not.toHaveURL(/[?&]test=1/)
  })
})

test.describe('Scenario: training and scoring around test pages', () => {
  test('the training form offers test sets by their test pages and says what it leaves out',
    async ({ page }) => {
      const trainName = uniqueName('Leaves out train')
      const heldName = uniqueName('Leaves out held')
      // The same base: the held set's first scan is the training set's first one too.
      const trainJob = await seedDistinctPagesJob(trainName, 2, 80, TEST_SCAN_WIDTH)
      const heldJob = await seedDistinctPagesJob(heldName, 1, 80, TEST_SCAN_WIDTH)
      await markLinesChecked(trainJob, 12)
      await markTestPages(heldJob, [(await jobPageIds(heldJob))[0]])

      const preview = await backendFetch('/api/trainings/preview', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task: 'ocr', job_ids: [trainJob] }),
      })
      expect(preview.left_out).toEqual([{ job_id: heldJob, name: heldName, pages: 1 }])
      expect(preview.counts[trainJob]).toBe(6)

      await page.goto('/models/train?task=ocr')
      await pickDataset(page, trainName)
      await expect(page.getByText('6 checked lines selected')).toBeVisible()
      await expect(page.getByTestId('left-out-notice')).toHaveText(
        `1 page left out: same scan as test pages in ${heldName}`)
      const testSets = page.getByTestId('training-test-sets')
      const held = testSets.getByRole('checkbox', { name: heldName })
      await expect(held).toHaveCount(1)
      await expect(held).not.toBeChecked()
      await expect(testSets.getByRole('checkbox', { name: trainName })).toHaveCount(0)
    })

  test('an evaluation of a dataset with test pages scores them unless all pages are asked for',
    async ({ page }) => {
      const name = uniqueName('Scored test pages')
      const jobId = await seedDistinctPagesJob(name, 2, 90, TEST_SCAN_WIDTH)
      await markLinesChecked(jobId, 12)
      await markTestPages(jobId, [(await jobPageIds(jobId))[0]])
      const builtin = (await listRegistryModels()).find((m) => m.task === 'ocr' && m.source === 'backend')!

      await page.goto(`/models/${builtin.id}`)
      await page.getByRole('button', { name: 'Evaluate…' }).click()
      await pickDataset(page, name)
      const choice = page.getByTestId('eval-pages')
      await expect(choice.getByRole('radio', { name: 'Test pages only' })).toBeChecked()
      await expect(page.getByText('6 checked lines selected')).toBeVisible()
      await choice.getByRole('radio', { name: 'All pages' }).check()
      await expect(page.getByText('12 checked lines selected')).toBeVisible()
      await choice.getByRole('radio', { name: 'Test pages only' }).check()
      await page.getByRole('button', { name: 'Start evaluation' }).click()

      await expect.poll(async () => (await listEvaluations()).find(
        (e) => e.model_id === builtin.id && e.source.jobs?.[0] === jobId)?.source)
        .toEqual({ jobs: [jobId], test_pages: true })
    })
})
