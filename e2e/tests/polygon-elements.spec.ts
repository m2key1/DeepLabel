import { test, expect } from '../helpers/test'
import { getPageDetail, jobPageIds, seedCompletedJob, uniqueName } from '../helpers/api'
import { LANDSCAPE, clickAt, dragAt, enterEditMode, openViewer, toPixels } from '../helpers/viewer'

type Pt = [number, number]
interface Element { id: number; class_name: string; bbox: number[]; polygon: Pt[] | null }

const elements = async (jobId: string, pageId: number): Promise<Element[]> =>
  (await getPageDetail(jobId, pageId)).elements
const paragraph = async (jobId: string, pageId: number) =>
  (await elements(jobId, pageId)).find((e) => e.class_name === 'Paragraph')!
const near = (ring: Pt[]) => ring.map(([x, y]) => [expect.closeTo(x, 2), expect.closeTo(y, 2)])

// The stub runner's Paragraph, and a point inside it between its lines.
const PARAGRAPH: Pt[] = [[0.1, 0.2], [0.9, 0.2], [0.9, 0.85], [0.1, 0.85]]
const PARAGRAPH_GAP: Pt = [0.5, 0.42]

async function switchTo(page: import('@playwright/test').Page, name: string, shape: 'box' | 'polygon') {
  await page.goto('/')
  const card = page.getByTestId('job-card').filter({ hasText: name })
  await card.getByTestId('job-menu').click()
  await card.getByTestId('processing-open').click()
  await page.locator(`[data-testid="processing-layout-shape-option"][data-shape="${shape}"]`).click()
  await expect(page.getByTestId('processing-layout-shape-note')).toBeVisible()
  await page.getByTestId('processing-save').click()
}

test.describe('Scenario: layout elements as outlines', () => {
  test('a dataset switched to polygons gets its boxes as outlines, and switched back keeps them', async ({ page }) => {
    const name = uniqueName('Outlined layout')
    const jobId = await seedCompletedJob(name, 1, LANDSCAPE)
    const [pageId] = await jobPageIds(jobId)
    expect((await paragraph(jobId, pageId)).polygon).toBeNull()

    await switchTo(page, name, 'polygon')
    await expect.poll(async () => (await paragraph(jobId, pageId)).polygon).toEqual(PARAGRAPH)
    await openViewer(page, jobId, pageId)
    await enterEditMode(page)
    await expect(page.locator('[data-testid="region-box"][data-shape="outline"]')).toHaveCount(2)

    await switchTo(page, name, 'box')
    await openViewer(page, jobId, pageId)
    await enterEditMode(page)
    await expect(page.locator('[data-testid="region-box"][data-shape="box"]')).toHaveCount(2)
    await expect(page.locator('[data-testid="region-box"][data-shape="outline"]')).toHaveCount(0)
    // Kept for switching back.
    expect((await paragraph(jobId, pageId)).polygon).toEqual(PARAGRAPH)
  })

  test('an outline is reshaped like a line, and the pen draws new ones', async ({ page }) => {
    const name = uniqueName('Reshaped outline')
    const jobId = await seedCompletedJob(name, 1, LANDSCAPE)
    const [pageId] = await jobPageIds(jobId)
    await switchTo(page, name, 'polygon')
    await expect.poll(async () => (await paragraph(jobId, pageId)).polygon).toEqual(PARAGRAPH)
    await openViewer(page, jobId, pageId)
    await enterEditMode(page)

    // Selected, the element offers a line's corner and side handles, not a box's eight.
    await clickAt(page, PARAGRAPH_GAP)
    await expect(page.getByTestId('element-outline')).toBeVisible()
    await expect(page.getByTestId('line-vertex-handle')).toHaveCount(4)
    await expect(page.getByTestId('element-handle')).toHaveCount(0)

    // A corner moved on its own, its box following the outline's bounds.
    await dragAt(page, PARAGRAPH[0], [0.2, 0.3], { ctrl: true })
    await expect.poll(async () => (await paragraph(jobId, pageId)).polygon)
      .toEqual(near([[0.2, 0.3], [0.9, 0.2], [0.9, 0.85], [0.1, 0.85]]))
    expect((await paragraph(jobId, pageId)).bbox).toEqual(near([[0.1, 0.2], [0.9, 0.85]]).flat())

    // A side clicked gains a corner; a corner right-clicked goes again.
    await page.getByTestId('line-edge-handle').nth(2).click()
    await expect.poll(async () => (await paragraph(jobId, pageId)).polygon?.length).toBe(5)
    await expect(page.getByTestId('line-vertex-handle')).toHaveCount(5)
    await page.getByTestId('line-vertex-handle').nth(3).click({ button: 'right' })
    await expect.poll(async () => (await paragraph(jobId, pageId)).polygon?.length).toBe(4)

    // The Header pen, shaped as an outline: a corner a click, closed on the first.
    await page.locator('[data-testid="pen-pill"][data-class="Header"]').click()
    await page.getByTestId('element-pen-polygon').click()
    const corners: Pt[] = [[0.02, 0.9], [0.08, 0.9], [0.05, 0.97]]
    for (const corner of [...corners, corners[0]]) {
      const { x, y } = await toPixels(page, corner)
      await page.mouse.click(x, y)
    }
    await expect.poll(async () => (await elements(jobId, pageId)).length).toBe(3)
    const drawn = (await elements(jobId, pageId)).find((e) => e.bbox[0] < 0.05)!
    expect(drawn.class_name).toBe('Header')
    expect(drawn.polygon).toEqual(near(corners))

    await page.keyboard.press('ControlOrMeta+z')
    await expect.poll(async () => (await elements(jobId, pageId)).length).toBe(2)
  })
})
