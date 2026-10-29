import { test, expect } from '../helpers/test'
import {
  backendFetch, correctLine, getJob, getPageDetail, identity, jobPageIds, pageDeletedFlags, pageLines,
  seedCompletedJob, uniqueName, waitForJobStatus,
} from '../helpers/api'
import { scanPng } from '../helpers/image'
import { seedMapJob } from '../helpers/map'
import { datasetAction } from '../helpers/dataset'

const DEV = identity('dev', 'admin')

test.describe('Scenario: working with a dataset', () => {
  test('the pages table sorts and shift-click selects a range', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Table work'), 3)
    await page.goto(`/jobs/${jobId}`)
    await expect(page.locator('tbody tr')).toHaveCount(3)

    const filenameHeader = page.getByRole('columnheader', { name: /Filename/ })
    await filenameHeader.click()
    await expect(filenameHeader).toHaveAttribute('aria-sort', 'ascending')
    await expect(page.locator('tbody tr').first()).toContainText('scan_1.png')
    await filenameHeader.click()
    await expect(filenameHeader).toHaveAttribute('aria-sort', 'descending')
    await expect(page.locator('tbody tr').first()).toContainText('scan_3.png')

    const rowCheckbox = (row: number) => page.locator('tbody tr').nth(row).locator('input[type="checkbox"]')
    await rowCheckbox(0).click()
    await rowCheckbox(2).click({ modifiers: ['Shift'] })
    await expect(page.getByText('3 selected')).toBeVisible()

    await page.getByRole('button', { name: 'Mark layout complete' }).click()
    await expect(page.locator('tbody').getByText('complete')).toHaveCount(3)
  })

  test('the status column says which step a page has been through, in words', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Status words'), 1)
    const [pageId] = await jobPageIds(jobId)
    // Backend oracle: the stored name is still the pipeline's own.
    expect((await getPageDetail(jobId, pageId)).status).toBe('done')

    await page.goto(`/jobs/${jobId}`)
    const cell = page.locator('tbody tr').first().locator('td[data-col="status"]')
    await expect(cell.locator('[data-status="done"]')).toHaveText('Read')
  })

  test('the review column counts lines, and says how the regions stand on hover',
    async ({ page }) => {
      const jobId = await seedCompletedJob(uniqueName('Counted'), 1)
      const [pageId] = await jobPageIds(jobId)
      const lines = await pageLines(jobId, pageId)
      const detail = await getPageDetail(jobId, pageId)
      const regions = detail.elements.filter((e: { kind: string }) => e.kind === 'content')
      // Six lines under two regions: the two numbers are far enough apart to tell which
      // one the column is showing.
      expect({ lines: lines.length, regions: regions.length }).toEqual({ lines: 6, regions: 2 })

      await page.goto(`/jobs/${jobId}`)
      const cell = page.locator('tbody tr').first().locator('td[data-col="checked"]')
      await expect(cell).toHaveText('0/6')
      await expect(cell.locator('span')).toHaveAttribute('title', '0/2 regions with every line reviewed')

      await backendFetch(`/api/lines/${lines[0].id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...DEV },
        body: JSON.stringify({ checked: true }),
      })
      await page.reload()
      await expect(cell).toHaveText('1/6')
    })

  // Marking a selection that was already marked used to be a click that did nothing.
  test('the bulk review button undoes itself once the whole selection is reviewed', async ({ page }) => {
    const jobId = await seedMapJob(uniqueName('Bulk review'), 3)
    await page.goto(`/jobs/${jobId}`)
    await expect(page.locator('tbody tr')).toHaveCount(3)

    const rowCheckbox = (row: number) => page.locator('tbody tr').nth(row).locator('input[type="checkbox"]')
    const bulk = page.getByTestId('bulk-layout-checked')
    const reviewed = page.locator('tbody').getByText('reviewed')

    await rowCheckbox(0).click()
    await rowCheckbox(1).click()
    await expect(bulk).toHaveText('Mark reviewed')
    await bulk.click()
    await expect(reviewed).toHaveCount(2)

    // Extending the selection to the untouched tile finishes the rest and leaves the two
    // alone - toggling each tile instead would flip those back off and land on 1.
    await rowCheckbox(2).click()
    await expect(bulk).toHaveText('Mark reviewed')
    await bulk.click()
    await expect(reviewed).toHaveCount(3)

    // Now that everything selected is reviewed, the same button is the way back.
    await expect(bulk).toHaveText('Mark unreviewed')
    await bulk.click()
    await expect(reviewed).toHaveCount(0)
  })

  test('a deleted page leaves the table and only comes back from the Deleted filter', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Restorable'), 2)
    const row = (filename: string) => page.getByRole('row').filter({ hasText: filename })
    await page.goto(`/jobs/${jobId}`)
    await expect(page.locator('tbody tr')).toHaveCount(2)

    await row('scan_1.png').locator('input[type="checkbox"]').click()
    await page.getByRole('button', { name: 'Delete', exact: true }).click()

    await expect.poll(() => pageDeletedFlags(jobId)).toEqual([true, false])
    await expect(row('scan_1.png')).toHaveCount(0)
    await expect(row('scan_2.png')).toHaveCount(1)
    await expect(page.getByTestId('page-filter-all')).toHaveText('All · 1')

    // The delete reads as permanent: the page is only reachable through the
    // Deleted filter, which is where restoring it lives.
    await page.getByTestId('page-filter-deleted').click()
    await expect(row('scan_1.png')).toHaveCount(1)
    await expect(row('scan_2.png')).toHaveCount(0)
    await row('scan_1.png').locator('input[type="checkbox"]').click()
    await page.getByRole('button', { name: 'Restore 1' }).click()

    await expect.poll(() => pageDeletedFlags(jobId)).toEqual([false, false])
    await expect(page.getByTestId('page-filter-all')).toHaveText('All · 2')
  })

  test('adding pages reprocesses the dataset and grows the table', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Growing'), 2)
    await page.goto(`/jobs/${jobId}`)
    await expect(page.locator('tbody tr')).toHaveCount(2)

    // The dashed add-row below the table takes files straight to the pipeline.
    await expect(page.getByRole('button', { name: /Add pages - drop scans/ })).toBeVisible()
    await page
      .locator('input[type="file"]')
      .setInputFiles([{ name: 'extra.png', mimeType: 'image/png', buffer: scanPng(600, 800, 2) }])

    await expect(page.locator('tbody tr')).toHaveCount(3)
    // All three thumbnails render once the appended page has been ingested.
    await expect(page.locator('tbody img')).toHaveCount(3)

    // The upload shows the same progress panel a new dataset's does, in place of the row.
    await waitForJobStatus(jobId, 'done')
    await expect(page.getByTestId('add-pages')).toBeEnabled()
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    await page.route('**/api/jobs/*/pages/upload', async (route) => {
      await held
      await route.continue()
    })
    await page.locator('input[type="file"]')
      .setInputFiles([{ name: 'second-extra.png', mimeType: 'image/png', buffer: scanPng(600, 800, 3) }])
    const progress = page.getByTestId('upload-progress')
    await expect(progress).toHaveAttribute('role', 'progressbar')
    await expect(progress).toHaveText(/^Uploading… \d+%[\d.]+ (B|KB|MB) of [\d.]+ (B|KB|MB)$/)
    await expect(page.getByTestId('add-pages')).toHaveCount(0)
    release()
    await expect(page.locator('tbody tr')).toHaveCount(4)
    await expect(progress).toHaveCount(0)
    await expect(page.getByTestId('add-pages')).toBeVisible()
    await page.unroute('**/api/jobs/*/pages/upload')

    // The rare server-path flow stays reachable from the same row.
    await page.getByText('from server path').click()
    await expect(page.getByText('Add pages from a server path')).toBeVisible()
    await page.getByRole('button', { name: 'Cancel' }).click()
  })

  test('the re-run dialog offers a choice per phase and counts what each one costs',
    async ({ page }) => {
      const jobId = await seedCompletedJob(uniqueName('Re-runnable'), 2)
      const [pageId] = await jobPageIds(jobId)
      const [first] = await pageLines(jobId, pageId)
      await correctLine(first.id, 'Settled by hand')

      await page.goto(`/jobs/${jobId}`)
      await datasetAction(page, 'rerun-open')

      // Line detection: 2 pages x 2 elements x 3 lines from the stub runner, one of them
      // now checked and corrected. Re-offering it is the first answer.
      const choices = page.getByTestId('rerun-choice')
      await expect(choices).toHaveCount(2)
      await expect(choices.first()).toBeChecked()
      await expect(page.getByTestId('rerun-choices'))
        .toContainText('1 corrected and 1 checked go to the pool')

      // OCR: the careful answer spares the checked line and says how many it leaves.
      await page.locator('[data-testid="rerun-phase"][data-phase="ocr"]').check()
      await expect(choices.first()).toBeChecked()
      await expect(page.getByTestId('rerun-choices'))
        .toContainText('11 lines · 1 checked left as they are')
      await expect(page.getByTestId('rerun-choices'))
        .toContainText('12 lines · 1 checked and 1 corrected are cleared')

      await page.getByRole('button', { name: 'Cancel' }).click()
      await expect(page.getByTestId('rerun-choice')).toHaveCount(0)
      await expect(page.getByTestId('rerun-phase')).toHaveCount(0)
    })

  test('re-running the reading leaves a checked line exactly as it was', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Re-run scope'), 1)
    const [pageId] = await jobPageIds(jobId)
    const [first] = await pageLines(jobId, pageId)
    await correctLine(first.id, 'Settled by hand')

    await page.goto(`/jobs/${jobId}`)
    await datasetAction(page, 'rerun-open')
    await page.locator('[data-testid="rerun-phase"][data-phase="ocr"]').check()
    await page.getByTestId('rerun-confirm').click()

    // Backend oracle: five of the six lines are emptied for the re-read; the checked one
    // keeps its reading, its correction and its sign-off.
    await expect
      .poll(async () => (await pageLines(jobId, pageId)).filter((l) => l.text !== null).length)
      .toBe(1)
    const kept = (await pageLines(jobId, pageId)).find((l) => l.id === first.id)!
    expect(kept.corrected_text).toBe('Settled by hand')
    expect(kept.checked).toBe(true)
  })

  // The width only reaches the mask export, so a value that lived in the input alone
  // would look set and still export the old stroke - the job row is the oracle.
  test('a line-tracing job sets its export line width from the header', async ({ page }) => {
    const jobId = await seedMapJob(uniqueName('Line width'), 1, 'map_lines')
    await page.goto(`/jobs/${jobId}`)

    const field = page.getByTestId('job-line-width')
    await expect(field).toHaveValue('3')

    await field.fill('6')
    await field.press('Enter')
    await expect.poll(async () => (await backendFetch(`/api/jobs/${jobId}`)).line_width).toBe(6)

    // Out of range is pulled back into range rather than sent and refused with a 400.
    await field.fill('99')
    await field.blur()
    await expect(field).toHaveValue('25')
    await expect.poll(async () => (await backendFetch(`/api/jobs/${jobId}`)).line_width).toBe(25)

    // Clearing the field is "never mind", not width 0.
    await field.fill('')
    await field.blur()
    await expect(field).toHaveValue('25')
    await expect((await backendFetch(`/api/jobs/${jobId}`)).line_width).toBe(25)
  })

  // A polygon job's masks are filled areas: it has no stroke to widen.
  test('a polygon map job has no line width field', async ({ page }) => {
    const jobId = await seedMapJob(uniqueName('No line width'), 1)
    await page.goto(`/jobs/${jobId}`)

    await expect(page.getByRole('button', { name: 'Masks (zip)' })).toBeVisible()
    await expect(page.getByTestId('job-line-width')).toHaveCount(0)
  })
})

test.describe('Scenario: reading the page table at a glance', () => {
  test('the worst and average confidence are shown as a matching pair of badges',
    async ({ page }) => {
      const jobId = await seedCompletedJob(uniqueName('Confidence pair'), 1)

      await page.goto(`/jobs/${jobId}`)
      const cell = page.locator('tbody tr').first().locator('td[data-col="confidence"]')
      // The stub reads a header at .97/.92/.90 and a paragraph at .55/.82/.95, so the
      // worst of the six is 55% and their mean rounds to 85%.
      const worst = cell.getByTitle('Worst line on the page')
      const average = cell.getByTitle("Average over the page's lines")
      await expect(worst).toHaveText('55%')
      await expect(average).toHaveText('ø 85%')
      // Both are badges of the same shape and size - the average used to be bare grey
      // text beside a bordered one.
      const shape = (badge: typeof worst) => badge.evaluate((el) => {
        const style = getComputedStyle(el)
        return { padding: style.padding, radius: style.borderRadius, font: `${style.fontSize} ${style.fontWeight}` }
      })
      const worstShape = await shape(worst)
      expect(worstShape.padding).not.toBe('0px')
      expect(await shape(average)).toEqual(worstShape)
    })

  test('the confidence badges stay on one line in a narrow window', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Narrow'), 1)
    await page.setViewportSize({ width: 760, height: 600 })
    await page.goto(`/jobs/${jobId}`)
    const cell = page.locator('tbody tr').first().locator('[data-col="confidence"]')
    const worst = cell.getByTitle('Worst line on the page')
    const average = cell.getByTitle("Average over the page's lines")
    await expect(average).toHaveText('ø 85%')
    // The average used to break after its ø into a box twice the height of the other; one
    // line tall, it differs from it only by its border.
    expect((await average.boundingBox())!.height).toBeLessThan((await worst.boundingBox())!.height * 1.3)
  })

  test('the top bar buttons are all the same height', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Top bar'), 1)

    await page.goto(`/jobs/${jobId}`)
    const transcript = await page.getByRole('group', { name: 'Read' }).boundingBox()
    const run = await page.getByTestId('dataset-run').boundingBox()
    // Transcript was a size smaller than everything beside it.
    expect(transcript!.height).toBe(run!.height)
  })

  test('Complete marks a dataset finished, and the dataset list shows and filters by it', async ({ page }) => {
    const name = uniqueName('Finished volume')
    const jobId = await seedCompletedJob(name, 1)
    const other = uniqueName('Open volume')
    await seedCompletedJob(other, 1)

    await page.goto(`/jobs/${jobId}`)
    const complete = page.getByRole('switch', { name: 'Complete' })
    await expect(complete).toHaveAttribute('aria-checked', 'false')
    await complete.click()
    await expect(complete).toHaveAttribute('aria-checked', 'true')
    await expect.poll(async () => (await getJob(jobId)).checked).toBe(true)

    await page.goto('/?q=volume')
    const row = (title: string) => page.getByTestId('job-card').filter({ hasText: title })
    await expect(row(name).getByTestId('complete-label')).toHaveText('Complete')
    await expect(row(other)).toBeVisible()
    await expect(row(other).getByTestId('complete-label')).toHaveCount(0)

    await page.getByTestId('filter-menu').click()
    await page.getByTestId('filter-complete-1').click()
    await expect(page.getByTestId('filter-complete-1')).toBeChecked()
    await expect(row(name)).toBeVisible()
    await expect(row(other)).toHaveCount(0)
    await page.getByTestId('filter-complete-0').click()
    await expect(page.getByTestId('filter-complete-0')).toBeChecked()
    await expect(row(other)).toBeVisible()
    await expect(row(name)).toHaveCount(0)
    await expect(page.locator('[data-testid="filter-chip"][data-filter="complete"]')).toContainText('In progress')

    await page.goto(`/jobs/${jobId}`)
    await complete.click()
    await expect.poll(async () => (await getJob(jobId)).checked).toBe(false)
  })
})

test.describe('Scenario: choosing what to download', () => {
  test('the export menu offers the standard formats first, and reviewed-only applies to all of them',
    async ({ page }) => {
      const jobId = await seedCompletedJob(uniqueName('Downloads'), 1)
      await page.goto(`/jobs/${jobId}`)
      await page.getByRole('button', { name: 'Export', exact: true }).click()
      const menu = page.getByTestId('export-menu')
      await expect(menu.getByTestId('export-format')).toHaveCount(8)
      expect(await menu.getByTestId('export-format').evaluateAll((links) => links.map((l) => l.getAttribute('data-format'))))
        .toEqual(['page', 'alto', 'hocr', 'tei', 'zip', 'json', 'md', 'txt'])
      const pageXml = menu.locator('[data-testid="export-format"][data-format="page"]')
      await expect(pageXml).toHaveAttribute('href', `/api/jobs/${jobId}/export?format=page`)

      await menu.getByTestId('export-reviewed').check()
      await expect(pageXml).toHaveAttribute('href', `/api/jobs/${jobId}/export?format=page&checked_only=true`)
      await expect(menu.locator('[data-testid="export-format"][data-format="tei"]'))
        .toHaveAttribute('href', `/api/jobs/${jobId}/export?format=tei&checked_only=true`)
    })
})
