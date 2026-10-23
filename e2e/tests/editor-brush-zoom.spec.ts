import type { Page } from '@playwright/test'
import { test, expect } from '../helpers/test'
import { getPageDetail, jobPageIds, seedCompletedJob, uniqueName } from '../helpers/api'
import { dragPixels, enterEditMode, openViewer, recordLineWrites, scanZoom, toPixels } from '../helpers/viewer'
import { canvasBox, openTileEditor, seedMapJob, tileIds } from '../helpers/map'

async function setBrush(page: Page, px: number) {
  const radius = page.getByTestId('brush-radius')
  await radius.fill(String(px))
  await radius.blur()
  await expect(radius).toHaveValue(String(px))
}

const zoomIn = (page: Page) => page.getByTitle('Zoom in').click()
const zoomOut = (page: Page) => page.getByTitle('Zoom out').click()

test.describe('Scenario: the brush keeps its size on the page as the view zooms', () => {
  // README: the eraser's size is in pixels of the page as it fits the pane. A brush chosen
  // zoomed in must cover the same corners zoomed out, or every zoom is a new brush, and
  // zoomed out it swallows lines it never showed. The editor opens with the page fitted,
  // so there the circle is the setting twice over and the reach is the setting itself,
  // on a scan of any resolution.
  test('zooming out shrinks the brush circle and its reach with the scan', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Brush zoom'))
    const [pageId] = await jobPageIds(jobId)
    await openViewer(page, jobId, pageId)
    await enterEditMode(page)
    await page.getByTestId('tool-erase').click()
    await setBrush(page, 20)
    const base = await scanZoom(page)

    // The Paragraph's lines sit mid-page, so they stay in view at every zoom used here.
    const detail = await getPageDetail(jobId, pageId)
    const [first, second] = detail.elements[1].lines
    expect(first.polygon).toHaveLength(4)
    const lineNow = async (id: number) => (await getPageDetail(jobId, pageId)).elements
      .flatMap((e: { lines: { id: number; polygon: unknown[] }[] }) => e.lines)
      .find((l: { id: number }) => l.id === id)!
    const hover = async (line: { polygon: [number, number][] }) => {
      const c = await toPixels(page, line.polygon[0])
      await page.mouse.move(c.x + 30, c.y + 30, { steps: 3 })
    }
    // A sweep passing 18 px beside the corner: inside a 20 px reach, outside a 16 px one.
    const beside = async (line: { polygon: [number, number][] }) => {
      const c = await toPixels(page, line.polygon[0])
      await dragPixels(page, { x: c.x - 40, y: c.y - 18 }, { x: c.x + 40, y: c.y - 18 })
    }

    await hover(first)
    const brush = page.getByTestId('erase-brush')
    await expect(brush).toHaveCSS('width', '40px')
    await beside(first)
    await expect.poll(async () => (await lineNow(first.id)).polygon.length).toBe(3)
    await expect(page.getByTestId('editor-notice')).toHaveText('1 reshaped')

    // One step out is 0.8x: the same 20 scan pixels are 16 on the glass, the circle shows
    // it, the rail still says 20, and the same 18 px sweep now misses.
    await zoomOut(page)
    await expect.poll(async () => (await scanZoom(page)) / base).toBeCloseTo(0.8, 2)
    await hover(second)
    await expect(brush).toHaveCSS('width', '32px')
    await expect(page.getByTestId('brush-radius')).toHaveValue('20')
    const written = recordLineWrites(page)
    await beside(second)

    // One step back in is the fitted page again: the reach is 20, and the sweep that
    // missed takes the corner.
    await zoomIn(page)
    await expect.poll(async () => (await scanZoom(page)) / base).toBeCloseTo(1, 2)
    await hover(second)
    await expect(brush).toHaveCSS('width', '40px')
    expect(written).toEqual([])
    await beside(second)
    await expect.poll(async () => (await lineNow(second.id)).polygon.length).toBe(3)
    // The sweep that missed sent nothing ahead of the one that took the corner.
    expect(written).toEqual([second.id])
  })

  test('the tile editor scales its brush circle with the zoom too', async ({ page }) => {
    const jobId = await seedMapJob(uniqueName('Brush zoom tiles'))
    const [tileId] = await tileIds(jobId)
    await openTileEditor(page, jobId, tileId)
    await page.getByTestId('tool-erase').click()
    await setBrush(page, 20)
    // The middle of the tile stays on the glass at every zoom used here, where a corner of
    // the canvas may be clipped away once it outgrows the pane.
    const hoverMiddle = async () => {
      const b = await canvasBox(page)
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 3 })
    }
    await hoverMiddle()
    const circle = page.getByTestId('erase-brush').locator('circle').first()
    await expect(circle).toHaveAttribute('r', '20')
    const before = await canvasBox(page)

    await zoomIn(page)
    await expect.poll(async () => (await canvasBox(page)).width / before.width).toBeCloseTo(1.25, 2)
    await hoverMiddle()
    await expect(circle).toHaveAttribute('r', '25')
    await expect(page.getByTestId('brush-radius')).toHaveValue('20')
  })
})
