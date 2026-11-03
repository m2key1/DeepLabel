import { test, expect } from '../helpers/test'
import { openSettings, saveSettings } from '../helpers/dataset-settings'
import { backendFetch, getJob, getPageDetail, jobPageIds, seedCompletedJob, uniqueName } from '../helpers/api'
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

type Level = 'box' | 'rotated' | 'polygon'

async function switchTo(page: import('@playwright/test').Page, name: string, shape: Level) {
  await openSettings(page, name)
  await page.locator(`[data-testid="processing-layout-shape-option"][data-shape="${shape}"]`).click()
  await expect(page.getByTestId('processing-layout-shape-note')).toBeVisible()
  await saveSettings(page)
}

// Whether a ring's top side runs level with the page, as an upright box's does.
const upright = (ring: Pt[]) => Math.abs(ring[0][1] - ring[1][1]) < 1e-6 && Math.abs(ring[1][0] - ring[2][0]) < 1e-6

test.describe('Scenario: layout elements as outlines', () => {
  test('a dataset switched to polygons gets its boxes as outlines, and switched back has boxes again', async ({ page }) => {
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
    // Aligned keeps boxes only: the outline is gone, the box it fitted stays.
    expect(await paragraph(jobId, pageId)).toMatchObject({ polygon: null, bbox: near([[0.1, 0.2], [0.9, 0.85]]).flat() })
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
    await page.locator('[data-testid="element-pen-polygon"][data-class="Header"]').click()
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

test.describe('Scenario: a dataset that allows rotated boxes', () => {
  test('lowering squares the polygons it had, and the pens draw and switch only what it allows', async ({ page }) => {
    const name = uniqueName('Rotated layout')
    const jobId = await seedCompletedJob(name, 1, LANDSCAPE)
    const [pageId] = await jobPageIds(jobId)
    await switchTo(page, name, 'polygon')
    await expect.poll(async () => (await paragraph(jobId, pageId)).polygon).toEqual(PARAGRAPH)
    const pentagon: Pt[] = [[0.1, 0.2], [0.9, 0.2], [0.9, 0.85], [0.5, 0.95], [0.1, 0.85]]
    await backendFetch(`/api/elements/${(await paragraph(jobId, pageId)).id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ polygon: pentagon }),
    })

    // The count comes before anything changes, and again in the confirm on save.
    await openSettings(page, name)
    await page.locator('[data-testid="processing-layout-shape-option"][data-shape="rotated"]').click()
    await expect(page.getByTestId('processing-layout-shape-note'))
      .toHaveText('1 polygon becomes a rotated box around it. The revision history keeps the old shapes.')
    const asked = page.waitForEvent('dialog').then(async (dialog) => {
      const message = dialog.message()
      await dialog.accept()
      return message
    })
    await saveSettings(page)
    expect(await asked).toBe('1 polygon becomes a rotated box around it. Save?')
    expect((await getJob(jobId)).layout_shape).toBe('rotated')
    const squared = (await paragraph(jobId, pageId)).polygon!
    expect(squared).toHaveLength(4)

    // Every class offers an upright and a rotated box, and no outline; the Line pen keeps its two.
    await openViewer(page, jobId, pageId)
    await enterEditMode(page)
    await expect(page.locator('[data-testid="element-pen-rotated"][data-class="Header"]')).toBeVisible()
    await expect(page.locator('[data-testid="element-pen-box"][data-class="Header"]')).toBeVisible()
    await expect(page.locator('[data-testid="element-pen-polygon"]')).toHaveCount(0)
    await expect(page.getByTestId('line-pen-polygon')).toBeVisible()

    // A rotated box: one end of a side, its other end, then the height.
    await page.locator('[data-testid="element-pen-rotated"][data-class="Header"]').click()
    for (const corner of [[0.05, 0.88], [0.35, 0.92], [0.345, 0.96]] as Pt[]) {
      const { x, y } = await toPixels(page, corner)
      await page.mouse.click(x, y)
    }
    await expect.poll(async () => (await elements(jobId, pageId)).length).toBe(3)
    const drawn = (await elements(jobId, pageId)).find((e) => e.class_name === 'Header' && e.bbox[1] > 0.86)!
    expect(drawn.polygon).toHaveLength(4)
    expect(upright(drawn.polygon!)).toBe(false)

    // Selected, it turns upright through its shape switch, which offers no polygon here.
    await expect(page.getByTestId('element-shape-rotated')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('element-shape-polygon')).toHaveCount(0)
    await page.getByTestId('element-shape-box').click()
    await expect.poll(async () => upright((await elements(jobId, pageId)).find((e) => e.id === drawn.id)!.polygon!))
      .toBe(true)
  })
})
