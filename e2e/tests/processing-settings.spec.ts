import type { Page } from '@playwright/test'
import { test, expect } from '../helpers/test'
import {
  UNASSIGNED_LINES, correctLine, deleteElement, getJob, getPageDetail, jobPageIds, pageCandidates, pageLines,
  seedCompletedJob, uniqueName, waitForJobStatus,
} from '../helpers/api'
import { seedMapJob } from '../helpers/map'

/** The settings live in the dataset's own menu on the list, not inside the dataset. */
async function openProcessing(page: Page, name: string) {
  await page.goto('/')
  const card = page.getByTestId('job-card').filter({ hasText: name })
  await card.getByTestId('job-menu').click()
  await card.getByTestId('processing-open').click()
}

test.describe('Scenario: changing how a dataset is processed', () => {
  test('the line mode and the phases can be changed after the first run', async ({ page }) => {
    const name = uniqueName('Processing')
    const jobId = await seedCompletedJob(name, 1)
    expect(await getJob(jobId)).toMatchObject({
      line_mode: 'per_crop', run_layout: true, run_lines: true, run_ocr: true,
    })

    await openProcessing(page, name)
    await page.locator('[data-testid="processing-line-mode-option"][data-mode="per_page"]').click()
    await page.getByTestId('processing-save').click()
    await expect(page.getByTestId('processing-save')).toHaveCount(0)

    await expect.poll(async () => (await getJob(jobId)).line_mode).toBe('per_page')
    // Nothing already recognised is discarded by the change.
    const [pageId] = await jobPageIds(jobId)
    expect(await pageLines(jobId, pageId)).toHaveLength(6)
  })

  test('turning layout off takes per-crop detection with it', async ({ page }) => {
    const name = uniqueName('Processing layout off')
    const jobId = await seedCompletedJob(name, 1)

    await openProcessing(page, name)
    const layout = page.locator('[data-testid="processing-phase"][data-phase="layout"]')
      .getByRole('checkbox')
    await layout.uncheck()
    // The dialog says the same thing the server will store, rather than promising per-crop
    // and quietly saving per-page.
    await expect(page.locator('[data-testid="processing-line-mode-option"][data-mode="per_page"]'))
      .toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('[data-testid="processing-line-mode-option"][data-mode="per_crop"]'))
      .toBeDisabled()
    await page.getByTestId('processing-save').click()

    await expect.poll(async () => {
      const job = await getJob(jobId)
      return { layout: job.run_layout, mode: job.line_mode }
    }).toEqual({ layout: false, mode: 'per_page' })
  })

  test('turning line segmentation off takes OCR with it', async ({ page }) => {
    const name = uniqueName('Processing lines off')
    const jobId = await seedCompletedJob(name, 1)

    await openProcessing(page, name)
    await page.locator('[data-testid="processing-phase"][data-phase="lines"]')
      .getByRole('checkbox').uncheck()
    await expect(page.locator('[data-testid="processing-phase"][data-phase="ocr"]')
      .getByRole('checkbox')).toBeDisabled()
    await page.getByTestId('processing-save').click()

    await expect.poll(async () => {
      const job = await getJob(jobId)
      return { lines: job.run_lines, ocr: job.run_ocr }
    }).toEqual({ lines: false, ocr: false })
  })

  // The phase choices share their class list with the line-mode buttons, which sit in a
  // flex row. A label is inline by default, so a list that only reads as a flex child left
  // the three of them running together with their borders broken across the wraps.
  test('each phase choice is a card of its own', async ({ page }) => {
    const name = uniqueName('Processing cards')
    await seedCompletedJob(name, 1)
    await openProcessing(page, name)

    const choices = page.getByTestId('processing-phase')
    await expect(choices).toHaveCount(3)
    const boxes = []
    for (const choice of await choices.all()) boxes.push((await choice.boundingBox())!)

    // One width, because each fills the dialog rather than shrinking to its own text.
    expect(new Set(boxes.map((b) => Math.round(b.width))).size).toBe(1)
    // Stacked in order, with no two sharing a line.
    for (let i = 1; i < boxes.length; i++) {
      expect(boxes[i].y).toBeGreaterThanOrEqual(boxes[i - 1].y + boxes[i - 1].height)
    }
  })

  test('a dataset that runs no text phases is not offered them', async ({ page }) => {
    const textName = uniqueName('Has text phases')
    const mapName = uniqueName('Has no text phases')
    await seedCompletedJob(textName, 1)
    await seedMapJob(mapName, 1)

    await page.goto('/')
    const text = page.getByTestId('job-card').filter({ hasText: textName })
    await text.getByTestId('job-menu').click()
    await expect(text.getByTestId('processing-open')).toBeVisible()

    // A tile dataset has no layout, lines or OCR to arrange, and the server refuses the
    // patch outright, so the same menu carries no entry that would open the dialog.
    const map = page.getByTestId('job-card').filter({ hasText: mapName })
    await map.getByTestId('job-menu').click()
    await expect(map.getByRole('button', { name: 'Models…' })).toBeVisible()
    await expect(map.getByTestId('processing-open')).toHaveCount(0)
  })
})

/** What a page layout found nothing on looks like: no content box, so its lines can only
 *  be whatever detection scrapes off the whole scan. Reached by deleting the boxes the stub
 *  drew, which takes their lines with them. */
async function stripTheLayoutFrom(jobId: string, pageId: number) {
  const detail = await getPageDetail(jobId, pageId)
  for (const element of detail.elements) await deleteElement(element.id)
  expect(await pageLines(jobId, pageId)).toHaveLength(0)
}

test.describe('Scenario: the pages layout found nothing on', () => {
  test('they are filtered to, and given their lines back on their own', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('No layout pages'), 2)
    const [first, second] = await jobPageIds(jobId)
    await stripTheLayoutFrom(jobId, first)

    await page.goto(`/jobs/${jobId}`)
    const chip = page.getByTestId('page-filter-no-layout')
    await expect(chip).toHaveText('No layout · 1')
    await chip.click()
    await expect(page.locator('tbody tr')).toHaveCount(1)

    await page.locator('tbody tr').first().locator('input[type="checkbox"]').click()
    await page.getByTestId('bulk-run-lines').click()
    await expect(page.getByText(/Line detection queued for 1 page/)).toBeVisible()

    await waitForJobStatus(jobId, 'done', 60_000)
    // With no box to detect inside, the line phase reads the whole scan and puts what it
    // finds in one unassigned bucket - which is what a per-crop dataset falls back to
    // anyway. This used to queue the dataset and change nothing: phase_relines was pointed
    // at elements that did not exist, so it passed the page by.
    await expect.poll(async () => (await pageLines(jobId, first)).map((l) => l.text),
                      { timeout: 30_000 }).toEqual(UNASSIGNED_LINES)
    // The page nobody ticked kept its boxes and its lines.
    expect((await getPageDetail(jobId, second)).elements).toHaveLength(2)
    expect(await pageLines(jobId, second)).toHaveLength(6)
  })

  test('a re-read over a selection touches only the pages in it', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Selective re-read'), 2)
    const [first, second] = await jobPageIds(jobId)
    // The re-read writes the same words back, so the lines themselves say nothing about
    // whether it ran. What staging a page does say is that it kept what the page carried:
    // a correction nobody has verified is put in the pool before the model reads again.
    const edited = (await pageLines(jobId, first))[0]
    await correctLine(edited.id, 'What a person typed', false)

    await page.goto(`/jobs/${jobId}`)
    await page.locator('tbody tr').first().locator('input[type="checkbox"]').click()
    await page.getByTestId('bulk-run-ocr').click()
    await expect(page.getByText(/A re-read queued for 1 page/)).toBeVisible()

    await waitForJobStatus(jobId, 'done', 60_000)
    await expect.poll(async () => (await pageCandidates(first))
      .map((c) => `${c.source}:${c.text}`), { timeout: 30_000 })
      .toEqual(['human:What a person typed'])
    // The page nobody ticked was never staged, so its pool is untouched.
    expect(await pageCandidates(second)).toHaveLength(0)
    expect(await pageLines(jobId, second)).toHaveLength(6)
  })

  test('the chip is not shown on a dataset where every page has boxes', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('All laid out'), 1)

    await page.goto(`/jobs/${jobId}`)
    // Paired with a filter that is there, so a broken selector cannot pass this silently.
    await expect(page.getByTestId('page-filter-all')).toBeVisible()
    await expect(page.getByTestId('page-filter-no-layout')).toHaveCount(0)
  })
})
