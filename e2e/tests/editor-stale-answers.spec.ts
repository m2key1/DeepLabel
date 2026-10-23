import type { Page, Response, Route } from '@playwright/test'
import { test, expect } from '../helpers/test'
import { backendFetch, getJob, identity, jobPageIds, seedDistinctPagesJob, uniqueName } from '../helpers/api'
import { openViewer } from '../helpers/viewer'
import {
  type NormPoint, JSON_HEADERS, canvasBox, clickTile, dragVertex, eraseStroke, jobClasses, openTileEditor, roundPoints,
  seedMapJob, seedRegion, tileIds, tileRegions,
} from '../helpers/map'

const SQUARE: NormPoint[] = [[0.2, 0.2], [0.6, 0.2], [0.6, 0.6], [0.2, 0.6]]
const SQUARE_CENTRE: NormPoint = [0.4, 0.4]
const THEIRS: NormPoint[] = [[0.25, 0.25], [0.65, 0.25], [0.65, 0.65], [0.25, 0.65]]
const OTHER: NormPoint[] = [[0.7, 0.7], [0.9, 0.7], [0.9, 0.9], [0.7, 0.9]]
const THEIRS_CENTRE: NormPoint = [0.45, 0.45]
const TOUCHING: NormPoint[] = [[0.5, 0.5], [0.8, 0.5], [0.8, 0.8], [0.5, 0.8]]
const TOUCHING_CENTRE: NormPoint = [0.7, 0.7]

/** Holds every request matching `url` until `release` is called, so a test can turn to
 *  another page while the answer for the first one is still out. */
async function holdRequests(page: Page, url: string, method = 'GET') {
  let release = () => {}
  const held = new Promise<void>((resolve) => { release = resolve })
  await page.route(url, async (route: Route) => {
    if (route.request().method() !== method) return route.fallback()
    await held
    await route.continue()
  })
  return () => release()
}

/** Until the answer has been read and React has drawn what it did with it. */
async function settled(page: Page, answer: Promise<Response>) {
  await (await answer).finished()
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
}

async function firstDrawableClass(jobId: string): Promise<number> {
  return (await jobClasses(jobId)).filter((c) => c.id !== 0)[0].id
}

async function selectShape(page: Page, at: NormPoint) {
  await page.getByRole('button', { name: 'Select', exact: true }).click()
  await clickTile(page, at)
  await expect(page.locator('[data-testid="map-region"][data-selected="true"]')).toHaveCount(1)
}

const selectSquare = (page: Page) => selectShape(page, SQUARE_CENTRE)

/** Where the selected shape's first corner is drawn, as a fraction of the tile. */
async function firstHandle(page: Page): Promise<NormPoint> {
  const box = await canvasBox(page)
  const handle = page.getByTestId('vertex-handle').first()
  const cx = Number(await handle.getAttribute('cx'))
  const cy = Number(await handle.getAttribute('cy'))
  return [Math.round((cx / box.width) * 100) / 100, Math.round((cy / box.height) * 100) / 100]
}

test.describe('Scenario: a save the tile editor could not make', () => {
  test("a colleague's change refuses the drag and keeps the editor open with theirs shown", async ({ page }) => {
    const jobId = await seedMapJob(uniqueName('Tile conflict'))
    const [tileId] = await tileIds(jobId)
    const region = await seedRegion(tileId, await firstDrawableClass(jobId), SQUARE)
    // This tab hears nothing after loading, as on a dropped connection.
    await page.route('**/api/pages/*/events**', (route) => route.abort())
    await openTileEditor(page, jobId, tileId)
    await selectSquare(page)

    await backendFetch(`/api/regions/${region.id}`, {
      method: 'PATCH',
      headers: { ...JSON_HEADERS, ...identity('colleague', 'admin') },
      body: JSON.stringify({ points: THEIRS }),
    })
    const answer = page.waitForResponse((r) => r.url().endsWith(`/api/regions/${region.id}`)
                                             && r.request().method() === 'PATCH')
    await dragVertex(page, [0.2, 0.2], [0.1, 0.1])
    expect((await answer).status()).toBe(409)

    // Said in the footer, not by taking the whole editor down.
    await expect(page.getByTestId('editor-notice'))
      .toHaveText('colleague changed this region since you loaded it - theirs is shown now; make your change again to replace it.')
    await expect(page.getByTestId('tile-canvas')).toBeVisible()
    await expect(page.getByTestId('map-region')).toHaveCount(1)
    // The colleague's shape stands on the server and is what the tile now shows.
    await expect.poll(async () => roundPoints((await tileRegions(jobId, tileId))[0].points)).toEqual(THEIRS)
    await expect.poll(() => firstHandle(page)).toEqual(THEIRS[0])
  })

  test('a vertex drag the server failed puts the corner back and says why', async ({ page }) => {
    const jobId = await seedMapJob(uniqueName('Tile drag failed'))
    const [tileId] = await tileIds(jobId)
    const region = await seedRegion(tileId, await firstDrawableClass(jobId), SQUARE)
    await openTileEditor(page, jobId, tileId)
    await selectSquare(page)
    await expect.poll(() => firstHandle(page)).toEqual(SQUARE[0])

    await page.route(`**/api/regions/${region.id}`, (route) => route.request().method() === 'PATCH'
      ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ detail: 'disk full' }) })
      : route.fallback())
    await dragVertex(page, [0.2, 0.2], [0.1, 0.1])

    await expect(page.getByTestId('editor-notice')).toContainText('disk full')
    await expect.poll(() => firstHandle(page)).toEqual(SQUARE[0])
    expect(roundPoints((await tileRegions(jobId, tileId))[0].points)).toEqual(SQUARE)
  })
  test("an eraser stroke a colleague's change refuses keeps the editor open with theirs shown", async ({ page }) => {
    const jobId = await seedMapJob(uniqueName('Erase conflict'))
    const [tileId] = await tileIds(jobId)
    const region = await seedRegion(tileId, await firstDrawableClass(jobId), SQUARE)
    await page.route('**/api/pages/*/events**', (route) => route.abort())
    await openTileEditor(page, jobId, tileId)
    await expect(page.getByTestId('map-region')).toHaveAttribute('data-region-id', String(region.id))

    await backendFetch(`/api/regions/${region.id}`, {
      method: 'PATCH',
      headers: { ...JSON_HEADERS, ...identity('colleague', 'admin') },
      body: JSON.stringify({ points: THEIRS }),
    })
    const answer = page.waitForResponse((r) => r.url().endsWith(`/api/regions/${region.id}`)
                                             && r.request().method() === 'PATCH')
    await page.getByRole('button', { name: 'Erase' }).click()
    await eraseStroke(page, SQUARE[0])
    expect((await answer).status()).toBe(409)

    await expect(page.getByTestId('editor-notice'))
      .toHaveText('colleague changed this region since you loaded it - theirs is shown now; make your change again to replace it.')
    await expect(page.getByTestId('tile-canvas')).toBeVisible()
    await expect.poll(async () => roundPoints((await tileRegions(jobId, tileId))[0].points)).toEqual(THEIRS)
    await selectShape(page, THEIRS_CENTRE)
    await expect.poll(() => firstHandle(page)).toEqual(THEIRS[0])
    await expect(page.getByTestId('vertex-handle')).toHaveCount(4)
  })

  test('a merge the server half made says why, shows the tile as it stands and can be taken back', async ({ page }) => {
    const jobId = await seedMapJob(uniqueName('Merge failed'))
    const [tileId] = await tileIds(jobId)
    const classId = await firstDrawableClass(jobId)
    const kept = await seedRegion(tileId, classId, SQUARE)
    const dropped = await seedRegion(tileId, classId, TOUCHING)
    await openTileEditor(page, jobId, tileId)
    await expect(page.getByTestId('map-region')).toHaveCount(2)

    await page.route(`**/api/regions/${dropped.id}`, (route) => route.request().method() === 'DELETE'
      ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ detail: 'disk full' }) })
      : route.fallback())
    await selectSquare(page)
    await page.keyboard.down('Shift')
    await clickTile(page, TOUCHING_CENTRE)
    await page.keyboard.up('Shift')
    await page.keyboard.press('m')

    await expect(page.getByTestId('editor-notice')).toContainText('disk full')
    await expect(page.getByTestId('tile-canvas')).toBeVisible()
    // The union was saved before the delete failed: both stand on the server and on screen.
    await expect.poll(async () => (await tileRegions(jobId, tileId)).map((r) => [r.id, r.points.length]))
      .toEqual([[kept.id, 8], [dropped.id, 4]])
    await expect(page.locator(`[data-testid="map-region"][data-region-id="${dropped.id}"]`)).toHaveCount(1)
    await expect(page.locator(`[data-testid="map-region"][data-region-id="${kept.id}"]`)).toHaveCount(1)

    // The half that was made is one step back.
    await page.keyboard.press('Control+z')
    await expect.poll(async () => roundPoints((await tileRegions(jobId, tileId))
      .find((r) => r.id === kept.id)!.points)).toEqual(SQUARE)
  })
})

test.describe('Scenario: turning tiles faster than they answer', () => {
  test('a tile that answers late is not drawn over the one turned to after it', async ({ page }) => {
    const jobId = await seedMapJob(uniqueName('Tile late answer'), 2)
    const [first, second] = await tileIds(jobId)
    const classId = await firstDrawableClass(jobId)
    await seedRegion(first, classId, SQUARE)
    const secondRegion = await seedRegion(second, classId, OTHER)
    await openTileEditor(page, jobId, second)
    await expect(page.getByTestId('map-region')).toHaveAttribute('data-region-id', String(secondRegion.id))

    const release = await holdRequests(page, `**/api/jobs/${jobId}/pages/${first}`)
    const late = page.waitForResponse((r) => r.url().endsWith(`/api/jobs/${jobId}/pages/${first}`))
    const asked = page.waitForRequest((r) => r.url().endsWith(`/api/jobs/${jobId}/pages/${first}`))
    await page.getByRole('button', { name: '← Prev' }).click()
    await expect(page).toHaveURL(new RegExp(`/tiles/${first}$`))
    await asked
    // The tile turned back to has answered before the late one does, as on a slow line.
    const prompt = page.waitForResponse((r) => r.url().endsWith(`/api/jobs/${jobId}/pages/${second}`))
    await page.getByRole('button', { name: 'Next →' }).click()
    await expect(page).toHaveURL(new RegExp(`/tiles/${second}$`))
    await settled(page, prompt)
    await expect(page.getByTestId('map-region')).toHaveAttribute('data-region-id', String(secondRegion.id))

    release()
    await settled(page, late)
    await expect(page.getByTestId('map-region')).toHaveCount(1)
    await expect(page.getByTestId('map-region')).toHaveAttribute('data-region-id', String(secondRegion.id))
  })

  test('an undo that answers after the next tile opened is not applied to it', async ({ page }) => {
    const jobId = await seedMapJob(uniqueName('Tile late undo'), 2)
    const [first, second] = await tileIds(jobId)
    const classId = await firstDrawableClass(jobId)
    const firstRegion = await seedRegion(first, classId, SQUARE)
    const secondRegion = await seedRegion(second, classId, OTHER)
    await openTileEditor(page, jobId, first)
    await selectSquare(page)
    await page.keyboard.press('Delete')
    await expect.poll(async () => (await tileRegions(jobId, first)).length).toBe(0)
    await expect(page.getByTestId('map-region')).toHaveCount(0)

    const release = await holdRequests(page, `**/api/pages/${first}/revert`, 'POST')
    const late = page.waitForResponse((r) => r.url().endsWith(`/api/pages/${first}/revert`))
    await page.keyboard.press('Control+z')
    await page.getByRole('button', { name: 'Next →' }).click()
    await expect(page).toHaveURL(new RegExp(`/tiles/${second}$`))
    await expect(page.getByTestId('map-region')).toHaveAttribute('data-region-id', String(secondRegion.id))

    release()
    await settled(page, late)
    // The server took the delete back on the tile it was made on...
    await expect.poll(async () => (await tileRegions(jobId, first)).map((r) => r.id)).toEqual([firstRegion.id])
    // ...and the tile on screen shows only its own shape.
    await expect(page.getByTestId('map-region')).toHaveCount(1)
    await expect(page.getByTestId('map-region')).toHaveAttribute('data-region-id', String(secondRegion.id))
  })

  test('the tile left behind is not shown or edited while the next one loads', async ({ page }) => {
    const jobId = await seedMapJob(uniqueName('Tile still loading'), 2)
    const [first, second] = await tileIds(jobId)
    const classId = await firstDrawableClass(jobId)
    const firstRegion = await seedRegion(first, classId, SQUARE)
    const secondRegion = await seedRegion(second, classId, OTHER)
    await openTileEditor(page, jobId, first)
    await selectSquare(page)
    await page.keyboard.press('Delete')
    await expect.poll(async () => (await tileRegions(jobId, first)).length).toBe(0)
    await expect(page.getByTestId('map-region')).toHaveCount(0)

    const releaseUndo = await holdRequests(page, `**/api/pages/${first}/revert`, 'POST')
    const releaseTile = await holdRequests(page, `**/api/jobs/${jobId}/pages/${second}`)
    const undone = page.waitForResponse((r) => r.url().endsWith(`/api/pages/${first}/revert`))
    const loaded = page.waitForResponse((r) => r.url().endsWith(`/api/jobs/${jobId}/pages/${second}`))
    const asked = page.waitForRequest((r) => r.url().endsWith(`/api/jobs/${jobId}/pages/${second}`))
    await page.keyboard.press('Control+z')
    await page.getByRole('button', { name: 'Next →' }).click()
    await expect(page).toHaveURL(new RegExp(`/tiles/${second}$`))
    await asked

    // The undo lands while the next tile is still out: the tile it belongs to is gone.
    releaseUndo()
    await settled(page, undone)
    await expect.poll(async () => (await tileRegions(jobId, first)).map((r) => r.id)).toEqual([firstRegion.id])
    await expect(page.getByTestId('tile-canvas')).toHaveCount(0)
    await expect(page.getByTestId('map-region')).toHaveCount(0)

    releaseTile()
    await settled(page, loaded)
    await expect(page.getByTestId('tile-canvas')).toBeVisible()
    await expect(page.getByTestId('map-region')).toHaveCount(1)
    await expect(page.getByTestId('map-region')).toHaveAttribute('data-region-id', String(secondRegion.id))
  })

  test('a scan that answers late is not shown over the one turned to after it', async ({ page }) => {
    const jobId = await seedDistinctPagesJob(uniqueName('Viewer late answer'), 2)
    const [first, second] = await jobPageIds(jobId)
    const name = (id: number) => (getJob(jobId) as Promise<{ pages: { id: number; filename: string }[] }>)
      .then((job) => job.pages.find((p) => p.id === id)!.filename)
    const [firstName, secondName] = [await name(first), await name(second)]
    expect(firstName).not.toBe(secondName)
    await openViewer(page, jobId, second)
    await expect(page.getByText(secondName, { exact: true })).toBeVisible()

    const release = await holdRequests(page, `**/api/jobs/${jobId}/pages/${first}`)
    const late = page.waitForResponse((r) => r.url().endsWith(`/api/jobs/${jobId}/pages/${first}`))
    const asked = page.waitForRequest((r) => r.url().endsWith(`/api/jobs/${jobId}/pages/${first}`))
    await page.keyboard.press('ArrowLeft')
    await expect(page).toHaveURL(new RegExp(`/pages/${first}$`))
    await asked
    // Back, rather than the arrow: a page still loading has no neighbours to step to.
    const prompt = page.waitForResponse((r) => r.url().endsWith(`/api/jobs/${jobId}/pages/${second}`))
    await page.goBack()
    await expect(page).toHaveURL(new RegExp(`/pages/${second}$`))
    await settled(page, prompt)
    await expect(page.getByText(secondName, { exact: true })).toBeVisible()

    release()
    await settled(page, late)
    await expect(page.getByText(secondName, { exact: true })).toBeVisible()
    await expect(page.getByText(firstName, { exact: true })).toHaveCount(0)
  })
})

test.describe('Scenario: typing a brush size', () => {
  test('a two-digit size can be typed digit by digit', async ({ page }) => {
    const jobId = await seedMapJob(uniqueName('Brush typing'))
    const [tileId] = await tileIds(jobId)
    await openTileEditor(page, jobId, tileId)
    await page.getByRole('button', { name: 'Erase' }).click()
    const radius = page.getByTestId('brush-radius')

    await radius.click()
    await radius.press('ControlOrMeta+a')
    await radius.pressSequentially('30')
    await expect(radius).toHaveValue('30')
    // A size inside the bounds takes as it is typed, before the box is left.
    await expect.poll(() => page.evaluate(() => localStorage.getItem('deeplabel.map.brushRadius'))).toBe('30')

    // A size below the floor is left as typed until it is settled, then held at the floor.
    await radius.press('ControlOrMeta+a')
    await radius.pressSequentially('3')
    await expect(radius).toHaveValue('3')
    await radius.press('Enter')
    await expect(radius).toHaveValue('4')
    await expect.poll(() => page.evaluate(() => localStorage.getItem('deeplabel.map.brushRadius'))).toBe('4')

    // An emptied box keeps the size it had rather than dropping to the floor.
    await radius.press('ControlOrMeta+a')
    await radius.pressSequentially('30')
    await expect.poll(() => page.evaluate(() => localStorage.getItem('deeplabel.map.brushRadius'))).toBe('30')
    await radius.press('ControlOrMeta+a')
    await radius.press('Backspace')
    await expect(radius).toHaveValue('')
    await radius.press('Enter')
    await expect(radius).toHaveValue('30')
    await expect.poll(() => page.evaluate(() => localStorage.getItem('deeplabel.map.brushRadius'))).toBe('30')
  })
})

test.describe('Scenario: sizing the panes from the keyboard', () => {
  test('the divider beside the OCR panel moves with the arrow keys and says where it is', async ({ page }) => {
    const jobId = await seedDistinctPagesJob(uniqueName('Divider keys'), 2)
    const [, pageId] = await jobPageIds(jobId)
    await openViewer(page, jobId, pageId)

    const divider = page.getByRole('separator', { name: 'Width of the OCR panel' })
    await expect(divider).toHaveAttribute('aria-valuenow', '50')
    await expect(divider).toHaveAttribute('aria-valuemin', '0')
    await expect(divider).toHaveAttribute('aria-valuemax', '70')
    const panel = page.locator(`[id="${await divider.getAttribute('aria-controls')}"]`)
    await expect(panel).toHaveCount(1)
    const before = (await panel.boundingBox())!.width

    await divider.focus()
    await divider.press('ArrowLeft')
    await divider.press('ArrowLeft')
    await expect(divider).toHaveAttribute('aria-valuenow', '54')
    // The arrows that turn the page elsewhere move the divider here, and only that.
    await expect(page).toHaveURL(new RegExp(`/pages/${pageId}$`))
    await expect.poll(async () => (await panel.boundingBox())!.width).toBeGreaterThan(before)
    await expect.poll(() => page.evaluate(() => Number(localStorage.getItem('deeplabel.ocrFrac')))).toBeCloseTo(0.54, 5)

    await divider.press('ArrowRight')
    await expect(divider).toHaveAttribute('aria-valuenow', '52')
  })
})
