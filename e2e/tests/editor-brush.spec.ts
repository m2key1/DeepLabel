import type { Page } from '@playwright/test'
import { test, expect } from '../helpers/test'
import { getPageDetail, jobPageIds, seedCompletedJob, uniqueName } from '../helpers/api'
import { dragPixels, enterEditMode, openViewer, recordLineWrites, scanRect, toPixels } from '../helpers/viewer'
import { openTileEditor, seedMapJob, tileIds } from '../helpers/map'

const VIEWER_BRUSH_KEY = 'deeplabel.viewer.brushRadius'
const MAP_BRUSH_KEY = 'deeplabel.map.brushRadius'
// One wheel notch, as a mouse sends it.
const NOTCH = 100
// What a notch is worth: a step the hand can count, from the 4 px floor to the 120 px ceiling.
const STEP_PX = 4

async function shiftWheel(page: Page, notches: number) {
  await page.keyboard.down('Shift')
  for (let i = 0; i < Math.abs(notches); i++) await page.mouse.wheel(0, notches < 0 ? -NOTCH : NOTCH)
  await page.keyboard.up('Shift')
}

async function setBrush(page: Page, px: number) {
  const radius = page.getByTestId('brush-radius')
  await radius.fill(String(px))
  await radius.blur()
  await expect(radius).toHaveValue(String(px))
}

const stored = (page: Page, key: string) => page.evaluate((k) => localStorage.getItem(k), key)

test.describe('Scenario: sizing the eraser from the wheel', () => {
  // README: the eraser is a brush with a size. Reaching for the slider in the rail for every
  // change of size breaks the sweep; the wheel under the hand that is already on the page
  // does not. Shift keeps it apart from the plain wheel, which scrolls the scan, and from
  // Ctrl+wheel, which zooms it.
  test('Shift+wheel over the scan grows and shrinks the brush, and the sweep reaches as far as it shows',
    async ({ page }) => {
      const jobId = await seedCompletedJob(uniqueName('Brush wheel'))
      const [pageId] = await jobPageIds(jobId)
      await openViewer(page, jobId, pageId)
      await enterEditMode(page)
      await page.getByTestId('tool-erase').click()
      await setBrush(page, 20)
      // The brush is measured against the page as it fits the pane, which is how the editor
      // opens: the circle is the setting twice over and the reach is the setting itself.

      const detail = await getPageDetail(jobId, pageId)
      const [line] = detail.elements[1].lines
      expect(line.polygon).toHaveLength(4)
      const corner = await toPixels(page, line.polygon[0])
      // The wheel speaks to what is under the pointer: the brush circle sits there too.
      await page.mouse.move(corner.x + 30, corner.y + 30, { steps: 3 })
      const brush = page.getByTestId('erase-brush')
      await expect(brush).toHaveCSS('width', '40px')

      // Up grows, 4 px a notch; the number in the rail, the circle and the stored size agree.
      await shiftWheel(page, -3)
      await expect(page.getByTestId('brush-radius')).toHaveValue('32')
      await expect(brush).toHaveCSS('width', '64px')
      expect(await stored(page, VIEWER_BRUSH_KEY)).toBe('32')

      // Down shrinks, and stops at the floor rather than vanishing.
      await shiftWheel(page, 10)
      await expect(page.getByTestId('brush-radius')).toHaveValue('4')
      await expect(brush).toHaveCSS('width', '8px')
      expect(await stored(page, VIEWER_BRUSH_KEY)).toBe('4')

      // Without Shift the wheel is still the scroll it always was: the brush is not touched.
      await page.mouse.wheel(0, -NOTCH)
      await page.mouse.wheel(0, NOTCH)
      await expect(page.getByTestId('brush-radius')).toHaveValue('4')

      // The size is what the brush reaches with. At 4 px a sweep passing 12 px beside the
      // corner misses it; four notches up, the same sweep takes it.
      const beside = async () => {
        const c = await toPixels(page, line.polygon[0])
        await dragPixels(page, { x: c.x - 40, y: c.y - 12 }, { x: c.x + 40, y: c.y - 12 })
      }
      const written = recordLineWrites(page)
      await beside()

      await page.mouse.move(corner.x + 30, corner.y + 30, { steps: 3 })
      await shiftWheel(page, -4)
      await expect(page.getByTestId('brush-radius')).toHaveValue('20')
      expect(written).toEqual([])
      await beside()
      await expect.poll(async () =>
        (await getPageDetail(jobId, pageId)).elements[1].lines[0].polygon.length).toBe(3)
      await expect(page.getByTestId('editor-notice')).toHaveText('1 reshaped')
      expect(written).toEqual([line.id])

      // Another tool in hand, Shift+wheel is nobody's: the brush keeps the size it had.
      await page.getByTestId('tool-select').click()
      await page.mouse.move(corner.x + 30, corner.y + 30, { steps: 3 })
      await shiftWheel(page, -2)
      expect(await stored(page, VIEWER_BRUSH_KEY)).toBe('20')
      await page.getByTestId('tool-erase').click()
      await expect(page.getByTestId('brush-radius')).toHaveValue('20')
    })

  // The tile editor sweeps with the same brush, so the same wheel sizes it.
  test('the tile editor sizes its brush from Shift+wheel too', async ({ page }) => {
    const jobId = await seedMapJob(uniqueName('Brush wheel tiles'))
    const [tileId] = await tileIds(jobId)
    await openTileEditor(page, jobId, tileId)
    await page.getByTestId('tool-erase').click()
    await setBrush(page, 20)
    const canvas = page.getByTestId('tile-canvas')
    await canvas.hover({ position: { x: 40, y: 40 } })
    await shiftWheel(page, -2)
    await expect(page.getByTestId('brush-radius')).toHaveValue('28')
    expect(await stored(page, MAP_BRUSH_KEY)).toBe('28')
    await shiftWheel(page, 3)
    await expect(page.getByTestId('brush-radius')).toHaveValue('16')
    expect(await stored(page, MAP_BRUSH_KEY)).toBe('16')
  })
})

test.describe('Scenario: the brush and the eye', () => {
  // Hiding a region class with the eye takes its boxes off the scan; its lines stay, drawn
  // and dotted as erasable. The brush must take what it shows: a sweep over such a line
  // reshapes it like any other. Hidden classes are kept in the browser between sessions,
  // so a brush that skipped them would look broken for good to whoever hid the boxes to
  // see the lines. What the eye really hides - the Line class itself - is not drawn and
  // not erased.
  test('a line stays erasable while the class of its region is hidden', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Brush hidden class'))
    const [pageId] = await jobPageIds(jobId)
    await openViewer(page, jobId, pageId)
    await enterEditMode(page)
    await page.getByTestId('tool-erase').click()
    await setBrush(page, 20)

    const detail = await getPageDetail(jobId, pageId)
    const paragraph = detail.elements.find((e: { class_name: string }) => e.class_name === 'Paragraph')!
    const header = detail.elements.find((e: { class_name: string }) => e.class_name === 'Header')!
    const [line] = paragraph.lines
    expect(line.polygon).toHaveLength(4)
    const penRow = (name: string) => page.locator(`[data-testid="pen-row"][data-class="${name}"]`)

    await penRow('Paragraph').getByTitle('hide').click()
    await expect(page.locator(`[data-testid="region-box"][data-id="${paragraph.id}"]`)).toHaveCount(0)
    await expect(page.locator(`[data-testid="region-box"][data-id="${header.id}"]`)).toHaveCount(1)
    const poly = page.locator(`[data-testid="line-poly"][data-id="${line.id}"]`)
    await expect(poly).toHaveCount(1)
    await expect(page.locator(`[data-testid="line-erase-corners"][data-id="${line.id}"]`)).toHaveAttribute('data-corners', '4')

    const corner = await toPixels(page, line.polygon[0])
    await dragPixels(page, { x: corner.x - 40, y: corner.y - 10 }, { x: corner.x + 40, y: corner.y - 10 })
    await expect.poll(async () =>
      (await getPageDetail(jobId, pageId)).elements.flatMap((e: { lines: { id: number; polygon: unknown[] }[] }) => e.lines)
        .find((l: { id: number }) => l.id === line.id)!.polygon.length).toBe(3)
    await expect(page.getByTestId('editor-notice')).toHaveText('1 reshaped')

    // The Line class hidden: nothing drawn, nothing dotted, nothing taken.
    const [other] = header.lines
    await penRow('Line').getByTitle('hide').click()
    await expect(poly).toHaveCount(0)
    await expect(page.getByTestId('line-erase-corners')).toHaveCount(0)
    const written = recordLineWrites(page)
    const c = await toPixels(page, other.polygon[0])
    const sweepOther = () => dragPixels(page, { x: c.x - 40, y: c.y - 10 }, { x: c.x + 40, y: c.y - 10 })
    await sweepOther()

    // Shown again, the same sweep takes the corner - and is the only write there was.
    await penRow('Line').getByTitle('show').click()
    await expect(page.locator(`[data-testid="line-poly"][data-id="${other.id}"]`)).toHaveCount(1)
    expect(written).toEqual([])
    await sweepOther()
    await expect.poll(async () =>
      (await getPageDetail(jobId, pageId)).elements.flatMap((e: { lines: { id: number; polygon: unknown[] }[] }) => e.lines)
        .find((l: { id: number }) => l.id === other.id)!.polygon.length).toBe(3)
    expect(written).toEqual([other.id])
  })
})

test.describe('Scenario: a sweep that starts beside the scan', () => {
  // README: the eraser "rubs out the corners under it". A corner on the margin is taken
  // by sweeping in from beyond the edge of the page rather than by aiming the press at
  // it - and with the scan zoomed out, beyond the edge is the pane around it. A stroke
  // begun there has to erase like one begun on the scan, instead of doing nothing.
  test('an eraser stroke that starts in the gutter beside the scan takes the corner it crosses',
    async ({ page }) => {
      const jobId = await seedCompletedJob(uniqueName('Brush gutter'))
      const [pageId] = await jobPageIds(jobId)
      await openViewer(page, jobId, pageId)
      await enterEditMode(page)
      await page.getByTestId('tool-erase').click()
      await setBrush(page, 20)

      // One step out is 0.8x, which leaves a gutter all round the scan.
      const fitted = await scanRect(page)
      await page.getByTitle('Zoom out').click()
      await expect.poll(async () => (await scanRect(page)).width / fitted.width).toBeCloseTo(0.8, 2)
      const scan = await scanRect(page)
      const pane = (await page.getByTestId('overlay-pane').boundingBox())!
      const gutter = scan.left - pane.x
      expect(gutter).toBeGreaterThan(20)

      const detail = await getPageDetail(jobId, pageId)
      const [first, second] = detail.elements[1].lines
      expect(first.polygon).toHaveLength(4)
      expect(second.polygon).toHaveLength(4)
      const polygonOf = async (id: number) => (await getPageDetail(jobId, pageId)).elements
        .flatMap((e: { lines: { id: number; polygon: unknown[] }[] }) => e.lines)
        .find((l: { id: number }) => l.id === id)!.polygon

      // Begun on the scan, a sweep along the first line's top edge takes its left corner.
      const onScan = await toPixels(page, first.polygon[0])
      await dragPixels(page, { x: scan.left + 10, y: onScan.y }, { x: onScan.x + 40, y: onScan.y })
      await expect.poll(async () => (await polygonOf(first.id)).length).toBe(3)
      await expect(page.getByTestId('editor-notice')).toHaveText('1 reshaped')

      // Begun in the gutter at the second line's corner height, the same sweep must take
      // that corner too.
      const corner = await toPixels(page, second.polygon[0])
      await dragPixels(page, { x: pane.x + gutter / 2, y: corner.y }, { x: corner.x + 40, y: corner.y })
      await expect.poll(async () => (await polygonOf(second.id)).length).toBe(3)
      await expect(page.getByTestId('editor-notice')).toHaveText('1 reshaped')
      expect(await polygonOf(first.id)).toHaveLength(3)
    })
})
