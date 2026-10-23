import { test, expect } from '../helpers/test'
import { getPageDetail, jobPageIds, pageLines, seedCompletedJob, seedJobWithoutLayout, uniqueName } from '../helpers/api'
import { LANDSCAPE, clickAt, enterEditMode, openViewer } from '../helpers/viewer'

// A point inside the Paragraph box but between its line polygons, so clicking
// selects the element rather than one of its lines.
const PARAGRAPH_GAP: [number, number] = [0.5, 0.42]

test.describe('Scenario: working from the region list', () => {
  test('hovering a row in edit mode lights up that region on the scan', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Region hover'), 1, LANDSCAPE)
    const [pageId] = await jobPageIds(jobId)
    await openViewer(page, jobId, pageId)
    await enterEditMode(page)

    const rows = page.getByTestId('region-row')
    await expect(rows).toHaveCount(2)
    const boxes = page.getByTestId('region-box')
    await expect(boxes).toHaveCount(2)
    const ids = await boxes.evaluateAll((els) => els.map((e) => e.getAttribute('data-id')))
    const box = (id: string | null) => page.locator(`[data-testid="region-box"][data-id="${id}"]`)
    await expect(page.locator('[data-testid="region-box"][data-hovered]')).toHaveCount(0)

    await rows.nth(1).hover()
    await expect(box(ids[1])).toHaveAttribute('data-hovered', 'true')
    await expect(box(ids[0])).not.toHaveAttribute('data-hovered', 'true')
    await expect(page.locator('[data-testid="region-box"][data-hovered]')).toHaveCount(1)

    await rows.nth(0).hover()
    await expect(box(ids[0])).toHaveAttribute('data-hovered', 'true')
    await expect(box(ids[1])).not.toHaveAttribute('data-hovered', 'true')

    await page.getByTestId('region-count').hover()
    await expect(page.locator('[data-testid="region-box"][data-hovered]')).toHaveCount(0)
  })

  test('the list mirrors the page and drives selection and visibility', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Region list'), 1, LANDSCAPE)
    const [pageId] = await jobPageIds(jobId)
    await openViewer(page, jobId, pageId)
    await enterEditMode(page)

    // Every region of the page is listed in reading order with its line count.
    // The stub lays out one Header and one Paragraph, 3 lines each.
    const rows = page.getByTestId('region-row')
    await expect(rows).toHaveCount(2)
    await expect(rows.nth(0)).toContainText('Header')
    await expect(rows.nth(1)).toContainText('Paragraph')
    await expect(page.getByTestId('region-count')).toHaveText('2 · 6 lines')

    // Clicking a row selects that region - the element handles appear for it, and the row
    // says so to a screen reader as well as by its colour.
    const headerButton = rows.nth(0).getByRole('button', { name: /^1\s*Header/ })
    const paragraphButton = rows.nth(1).getByRole('button', { name: /^2\s*Paragraph/ })
    await headerButton.click()
    await expect(rows.nth(0)).toHaveAttribute('data-selected', 'true')
    await expect(headerButton).toHaveAttribute('aria-pressed', 'true')
    await expect(paragraphButton).toHaveAttribute('aria-pressed', 'false')
    await expect(page.getByTestId('element-handle').first()).toBeVisible()

    // Selecting on the scan flows back into the list, so the two never disagree.
    await clickAt(page, PARAGRAPH_GAP)
    await expect(rows.nth(1)).toHaveAttribute('data-selected', 'true')
    await expect(rows.nth(0)).toHaveAttribute('data-selected', 'false')
    await expect(paragraphButton).toHaveAttribute('aria-pressed', 'true')
    await expect(headerButton).toHaveAttribute('aria-pressed', 'false')

    // Hiding a region removes its box and its lines from the scan, and the row
    // stays listed so it can be brought back.
    const lineIds = async () => {
      const detail = await getPageDetail(jobId, pageId)
      return detail.elements.flatMap((e: { lines: { id: number }[] }) => e.lines).map((l: { id: number }) => l.id)
    }
    const allLines = await lineIds()
    expect(allLines).toHaveLength(6)
    await expect(page.getByTestId('region-box')).toHaveCount(2)
    // Each eye is named for the row it hides, so they are told apart without the list.
    await expect(rows.nth(0).getByRole('button', { name: 'Hide Header 1' })).toBeVisible()
    await rows.nth(1).getByRole('button', { name: 'Hide Paragraph 2' }).click()
    await expect(page.getByTestId('region-box')).toHaveCount(1)
    await expect(rows).toHaveCount(2)
    // Nothing was deleted - hiding is a view state only.
    expect(await lineIds()).toEqual(allLines)

    await rows.nth(1).getByRole('button', { name: 'Show Paragraph 2' }).click()
    await expect(page.getByTestId('region-box')).toHaveCount(2)

    // Grouping by class labels the sections instead of listing in reading order.
    await page.getByLabel('Sort regions').selectOption('class')
    await expect(page.getByTestId('region-list')).toContainText('Header')
    await expect(rows).toHaveCount(2)
  })

  test('a hidden region also leaves the click target, so it cannot be edited by accident', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Region hide'), 1, LANDSCAPE)
    const [pageId] = await jobPageIds(jobId)
    await openViewer(page, jobId, pageId)
    await enterEditMode(page)

    // Put the pen down first: with one loaded, a click on empty canvas is the first
    // corner of a box, not a bid to select whatever used to be there.
    await page.getByTestId('tool-select').click()
    const paragraphRow = page.getByTestId('region-row').filter({ hasText: 'Paragraph' })
    await paragraphRow.getByRole('button', { name: 'Hide Paragraph 2' }).click()
    await clickAt(page, PARAGRAPH_GAP)
    await expect(page.getByTestId('element-handle')).toHaveCount(0)

    // Bringing it back through the list restores it as a selectable region.
    await paragraphRow.getByRole('button', { name: 'Show Paragraph 2' }).click()
    await clickAt(page, PARAGRAPH_GAP)
    await expect(page.getByTestId('element-handle').first()).toBeVisible()
  })

  test('a page that skipped layout accounts for its lines instead of listing nothing', async ({ page }) => {
    const jobId = await seedJobWithoutLayout(uniqueName('No layout list'))
    const [pageId] = await jobPageIds(jobId)
    // The stub puts every line of a page without layout into one invisible orphan bucket:
    // no content element at all, six lines that belong to nothing.
    const detail = await getPageDetail(jobId, pageId)
    expect(detail.elements.filter((e: { kind: string }) => e.kind === 'content')).toHaveLength(0)
    expect(await pageLines(jobId, pageId)).toHaveLength(6)

    await openViewer(page, jobId, pageId)
    await enterEditMode(page)

    // Nothing to list as a region, but the lines are still counted and named as unassigned
    // rather than the page reading as empty.
    await expect(page.getByTestId('region-row')).toHaveCount(0)
    await expect(page.getByTestId('region-count')).toHaveText('0 · 6 lines')
    const unassigned = page.getByTestId('region-unassigned')
    await expect(unassigned).toContainText('Unassigned')
    await expect(unassigned).toContainText('6')
    await expect(page.getByTestId('region-list')).toContainText('No layout regions')
  })
})
