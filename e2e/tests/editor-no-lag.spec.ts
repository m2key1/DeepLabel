import type { Page, Route } from '@playwright/test'
import { test, expect } from '../helpers/test'
import { getPageDetail, jobPageIds, seedCompletedJob, uniqueName } from '../helpers/api'
import { LANDSCAPE, clickAt, dragAt, enterEditMode, openViewer } from '../helpers/viewer'
import {
  type NormPoint, clickTile, drawPolygon, openTileEditor, seedMapJob, seedRegion, jobClasses, tileIds, tileRegions,
} from '../helpers/map'

interface Line { id: number; polygon: [number, number][] }
interface Element { id: number; class_name: string; kind: string; bbox: number[]; lines: Line[] }

const elements = async (jobId: string, pageId: number): Promise<Element[]> =>
  (await getPageDetail(jobId, pageId)).elements
const lineIds = async (jobId: string, pageId: number) =>
  (await elements(jobId, pageId)).flatMap((e) => e.lines.map((l) => l.id)).sort((a, b) => a - b)

// A point inside the Paragraph box but between its lines, so a click picks the box.
const PARAGRAPH_GAP: [number, number] = [0.5, 0.42]

const middle = (l: Line): [number, number] => [
  l.polygon.reduce((s, p) => s + p[0], 0) / l.polygon.length,
  l.polygon.reduce((s, p) => s + p[1], 0) / l.polygon.length,
]

/** Holds every request the matcher catches until `release` is called - a slow link. */
async function holdRequests(page: Page, url: string | RegExp, method: string) {
  let release: () => void = () => undefined
  const released = new Promise<void>((resolve) => { release = resolve })
  const held: string[] = []
  await page.route(url, async (route: Route) => {
    if (route.request().method() !== method) return route.fallback()
    held.push(route.request().url())
    await released
    await route.fallback()
  })
  return { held, release: () => release() }
}

async function seedEditor(page: Page) {
  const jobId = await seedCompletedJob(uniqueName('No lag'), 1, LANDSCAPE)
  const [pageId] = await jobPageIds(jobId)
  await openViewer(page, jobId, pageId)
  await enterEditMode(page)
  return { jobId, pageId, els: await elements(jobId, pageId) }
}

test.describe('Scenario: editing over a slow link', () => {
  test('a deleted line leaves the screen before the server has answered', async ({ page }) => {
    const { jobId, pageId, els } = await seedEditor(page)
    const line = els.find((e) => e.class_name === 'Paragraph')!.lines[0]
    const slow = await holdRequests(page, /\/api\/pages\/\d+\/delete$/, 'POST')

    await expect(page.locator(`[data-testid="line-poly"][data-id="${line.id}"]`)).toHaveCount(1)
    await clickAt(page, middle(line))
    await page.keyboard.press('Delete')

    await expect.poll(() => slow.held.length).toBe(1)
    await expect(page.locator(`[data-testid="line-poly"][data-id="${line.id}"]`)).toHaveCount(0)
    expect(await lineIds(jobId, pageId)).toContain(line.id)

    slow.release()
    await expect.poll(() => lineIds(jobId, pageId)).not.toContain(line.id)
    expect(await lineIds(jobId, pageId)).toHaveLength(5)
  })

  test('a refused delete brings the line back and says who changed it', async ({ page }) => {
    const { jobId, pageId, els } = await seedEditor(page)
    const line = els.find((e) => e.class_name === 'Paragraph')!.lines[0]
    await page.route(/\/api\/pages\/\d+\/delete$/, (route) => route.fulfill({
      status: 409, contentType: 'application/json',
      body: JSON.stringify({ detail: { code: 'conflict', message: 'changed by bob since you loaded it', author: 'bob',
                                       changed_at: null, revision: 99, current: {} } }),
    }))

    await clickAt(page, middle(line))
    await page.keyboard.press('Delete')

    await expect(page.getByRole('alert')).toHaveText('Delete line refused - changed by bob since you loaded it')
    await expect(page.locator(`[data-testid="line-poly"][data-id="${line.id}"]`)).toHaveCount(1)
    expect(await lineIds(jobId, pageId)).toHaveLength(6)
  })

  test('a class change shows at once and is saved behind it', async ({ page }) => {
    const { jobId, pageId, els } = await seedEditor(page)
    const para = els.find((e) => e.class_name === 'Paragraph')!
    const slow = await holdRequests(page, /\/api\/elements\/\d+$/, 'PATCH')

    await clickAt(page, PARAGRAPH_GAP)
    await page.getByTestId('selected-class').selectOption('BigParagraph')

    await expect.poll(() => slow.held.length).toBe(1)
    await expect(page.getByTestId('selected-class')).toHaveValue('BigParagraph')
    expect((await elements(jobId, pageId)).find((e) => e.id === para.id)!.class_name).toBe('Paragraph')

    slow.release()
    await expect.poll(async () => (await elements(jobId, pageId)).find((e) => e.id === para.id)!.class_name)
      .toBe('BigParagraph')
  })

  test('a box drawn over a slow link can be reclassed before it is saved, and is saved once', async ({ page }) => {
    const { jobId, pageId, els } = await seedEditor(page)
    const slow = await holdRequests(page, /\/api\/pages\/\d+\/elements$/, 'POST')

    await page.locator('[data-testid="pen-pill"][data-class="Paragraph"]').click()
    await dragAt(page, [0.03, 0.3], [0.08, 0.55])
    await expect.poll(() => slow.held.length).toBe(1)
    await expect(page.locator('[data-testid="region-box"]')).toHaveCount(els.length + 1)
    await page.getByTestId('selected-class').selectOption('Header')
    await expect(page.getByTestId('selected-class')).toHaveValue('Header')
    expect(await elements(jobId, pageId)).toHaveLength(els.length)

    slow.release()
    await expect.poll(async () => (await elements(jobId, pageId)).filter((e) => e.bbox[2] < 0.1).map((e) => e.class_name))
      .toEqual(['Header'])
    expect(await elements(jobId, pageId)).toHaveLength(els.length + 1)
  })

  test('a gathered set is deleted in one request', async ({ page }) => {
    const { jobId, pageId, els } = await seedEditor(page)
    const deletes: string[] = []
    page.on('request', (r) => {
      if (r.method() === 'DELETE' || /\/delete$/.test(r.url())) deletes.push(`${r.method()} ${new URL(r.url()).pathname}`)
    })
    const boxes = els.filter((e) => e.kind !== 'orphan').map((e) => e.bbox)
    await dragAt(page,
      [Math.min(...boxes.map((b) => b[0])) - 0.01, Math.min(...boxes.map((b) => b[1])) - 0.01],
      [Math.max(...boxes.map((b) => b[2])) + 0.01, Math.max(...boxes.map((b) => b[3])) + 0.01], { shift: true })
    await expect(page.locator('[data-testid="region-box"][data-merged]')).toHaveCount(boxes.length)

    await page.keyboard.press('Delete')

    await expect.poll(async () => (await elements(jobId, pageId)).filter((e) => e.kind !== 'orphan')).toHaveLength(0)
    expect(deletes).toEqual([`POST /api/pages/${pageId}/delete`])
    expect(await lineIds(jobId, pageId)).toHaveLength(6)
  })

  test('Layout complete flips before the server has answered', async ({ page }) => {
    const { jobId, pageId } = await seedEditor(page)
    const slow = await holdRequests(page, new RegExp(`/api/pages/${pageId}$`), 'PATCH')
    const toggle = page.getByRole('button', { name: /Layout complete/ })
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')

    await toggle.click()

    await expect.poll(() => slow.held.length).toBe(1)
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')
    slow.release()
    await expect.poll(async () => (await getPageDetail(jobId, pageId)).layout_checked).toBe(true)
  })

  test('an edit taken back before the server answered is taken back there too', async ({ page }) => {
    const { jobId, pageId, els } = await seedEditor(page)
    const line = els.find((e) => e.class_name === 'Paragraph')!.lines[0]
    const slow = await holdRequests(page, /\/api\/pages\/\d+\/delete$/, 'POST')

    await clickAt(page, middle(line))
    await page.keyboard.press('Delete')
    await expect(page.locator(`[data-testid="line-poly"][data-id="${line.id}"]`)).toHaveCount(0)
    await page.keyboard.press('ControlOrMeta+z')
    await expect(page.locator(`[data-testid="line-poly"][data-id="${line.id}"]`)).toHaveCount(1)

    slow.release()
    await expect.poll(async () => {
      const reverts = await page.evaluate(() => performance.getEntriesByType('resource')
        .filter((e) => e.name.includes('/revert')).length)
      return reverts
    }).toBe(1)
    await expect.poll(() => lineIds(jobId, pageId)).toContain(line.id)
    expect(await lineIds(jobId, pageId)).toHaveLength(6)
  })
})

const SQUARE: NormPoint[] = [[0.2, 0.2], [0.6, 0.2], [0.6, 0.6], [0.2, 0.6]]
const NEIGHBOUR: NormPoint[] = [[0.5, 0.5], [0.8, 0.5], [0.8, 0.8], [0.5, 0.8]]

async function seedTile(page: Page) {
  const jobId = await seedMapJob(uniqueName('Tile no lag'))
  const [tileId] = await tileIds(jobId)
  const cls = (await jobClasses(jobId)).find((c) => c.id !== 0)!
  const square = await seedRegion(tileId, cls.id, SQUARE)
  const neighbour = await seedRegion(tileId, cls.id, NEIGHBOUR)
  await openTileEditor(page, jobId, tileId)
  await page.getByRole('button', { name: 'Select', exact: true }).click()
  return { jobId, tileId, square, neighbour }
}

const shape = (page: Page, id: number) => page.locator(`[data-testid="map-region"][data-region-id="${id}"]`)

test.describe('Scenario: tracing a map tile over a slow link', () => {
  test('a deleted shape leaves the tile before the server has answered', async ({ page }) => {
    const { jobId, tileId, square } = await seedTile(page)
    const slow = await holdRequests(page, /\/api\/pages\/\d+\/regions\/batch$/, 'POST')
    await expect(shape(page, square.id)).toHaveCount(1)

    await clickTile(page, [0.3, 0.3])
    await page.keyboard.press('Delete')

    await expect.poll(() => slow.held.length).toBe(1)
    await expect(shape(page, square.id)).toHaveCount(0)
    expect((await tileRegions(jobId, tileId)).map((r) => r.id)).toContain(square.id)
    slow.release()
    await expect.poll(async () => (await tileRegions(jobId, tileId)).map((r) => r.id)).not.toContain(square.id)
  })

  test('a refused delete puts the shape back and says who changed it', async ({ page }) => {
    const { jobId, tileId, square } = await seedTile(page)
    await page.route(/\/api\/pages\/\d+\/regions\/batch$/, (route) => route.fulfill({
      status: 409, contentType: 'application/json',
      body: JSON.stringify({ detail: { code: 'conflict', message: 'changed by bob since you loaded it', author: 'bob',
                                       changed_at: null, revision: 99, current: {} } }),
    }))

    await clickTile(page, [0.3, 0.3])
    await page.keyboard.press('Delete')

    await expect(page.getByTestId('editor-notice'))
      .toHaveText('Delete shape refused - changed by bob since you loaded it')
    await expect(shape(page, square.id)).toHaveCount(1)
    expect(await tileRegions(jobId, tileId)).toHaveLength(2)
  })

  test('a merge is one request, and one undo before it is saved takes it back', async ({ page }) => {
    const { jobId, tileId, square, neighbour } = await seedTile(page)
    const writes: string[] = []
    page.on('request', (r) => {
      if (['POST', 'PATCH', 'DELETE'].includes(r.method()) && /\/api\/(regions|pages)\//.test(r.url())) {
        writes.push(`${r.method()} ${new URL(r.url()).pathname}`)
      }
    })
    const slow = await holdRequests(page, /\/api\/pages\/\d+\/regions\/batch$/, 'POST')

    await clickTile(page, [0.3, 0.3])
    await page.keyboard.down('Shift')
    await clickTile(page, [0.75, 0.75])
    await page.keyboard.up('Shift')
    await page.keyboard.press('m')
    await expect(shape(page, neighbour.id)).toHaveCount(0)
    await page.keyboard.press('Control+z')
    await expect(shape(page, neighbour.id)).toHaveCount(1)

    slow.release()
    await expect.poll(() => writes.filter((w) => w.endsWith('/revert')).length).toBe(1)
    expect(writes.filter((w) => !w.endsWith('/revert'))).toEqual([`POST /api/pages/${tileId}/regions/batch`])
    await expect.poll(async () => (await tileRegions(jobId, tileId)).map((r) => r.id).sort())
      .toEqual([square.id, neighbour.id].sort())
    expect((await tileRegions(jobId, tileId)).find((r) => r.id === square.id)!.points).toEqual(SQUARE)
  })

  test('a shape drawn over a slow link shows at once and is saved once', async ({ page }) => {
    const jobId = await seedMapJob(uniqueName('Tile draw no lag'))
    const [tileId] = await tileIds(jobId)
    await openTileEditor(page, jobId, tileId)
    const slow = await holdRequests(page, /\/api\/pages\/\d+\/regions\/batch$/, 'POST')

    await drawPolygon(page, SQUARE)

    await expect.poll(() => slow.held.length).toBe(1)
    await expect(page.getByTestId('map-region')).toHaveCount(1)
    expect(await tileRegions(jobId, tileId)).toHaveLength(0)
    slow.release()
    await expect.poll(async () => (await tileRegions(jobId, tileId)).length).toBe(1)
    await expect(page.getByTestId('map-region')).toHaveCount(1)
  })
})
