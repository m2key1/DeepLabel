import type { Page } from '@playwright/test'
import { test, expect } from '../helpers/test'
import { uniqueName } from '../helpers/api'
import {
  type NormPoint, addJobClass, canvasBox, clickTile, drawPolygon, jobClasses, openTileEditor, roundPoints,
  seedMapJob, seedRegion, tileIds, tileRegions,
} from '../helpers/map'

// The same square tile-editor.spec draws: far from every edge, far from the close-snap radius.
const SQUARE: NormPoint[] = [[0.2, 0.2], [0.6, 0.2], [0.6, 0.6], [0.2, 0.6]]
// Well inside the square, so cutting it out leaves a ring with a hole rather than a notch.
const INNER: NormPoint[] = [[0.3, 0.3], [0.5, 0.3], [0.5, 0.5], [0.3, 0.5]]
// Over the square's bottom-right quarter: the overlap a higher-priority class takes from it.
const CORNER: NormPoint[] = [[0.4, 0.4], [0.8, 0.4], [0.8, 0.8], [0.4, 0.8]]

const sorted = (pts: NormPoint[]) => roundPoints(pts).sort((a, b) => a[0] - b[0] || a[1] - b[1])

const penRow = (page: Page, name: string) => page.locator(`[data-testid="pen-row"][data-class="${name}"]`)
const penPill = (page: Page, name: string) => page.locator(`[data-testid="pen-pill"][data-class="${name}"]`)
// The dialog is the panel around its heading; nothing else on the page carries that title.
const removeDialog = (page: Page, name: string) =>
  page.getByRole('heading', { name: `Remove class "${name}"` }).locator('..')

test.describe("Scenario: a map tile's palette and the operations on its shapes", () => {
  // Seeded palette: buildings=1, forests=2, rivers=3, roads=4, urban=5; the editor opens
  // with buildings in hand. A removed class can never take a shape back (map-classes.spec),
  // so the count this dialog shows is the last guard before an irreversible delete.
  test('removing a class counts the regions it has right now, and offers to reassign them',
    async ({ page }) => {
      const jobId = await seedMapJob(uniqueName('Palette remove count'))
      const [tileId] = await tileIds(jobId)
      await openTileEditor(page, jobId, tileId)

      await drawPolygon(page, SQUARE)
      await expect.poll(async () => (await tileRegions(jobId, tileId)).length).toBe(1)
      const classNamed = async (name: string) => (await jobClasses(jobId)).find((c) => c.name === name)
      // The backend knows the square went to buildings.
      await expect.poll(async () => (await classNamed('buildings'))?.regions).toBe(1)
      expect((await classNamed('rivers'))?.regions).toBe(0)

      // A class nobody drew with: nothing to decide about, so no choice is offered.
      await penRow(page, 'rivers').getByTitle('Remove class').click()
      const riversDialog = removeDialog(page, 'rivers')
      await expect(riversDialog.getByText('No regions across the job use this class.')).toBeVisible()
      await expect(riversDialog.getByRole('radio')).toHaveCount(0)
      await riversDialog.getByRole('button', { name: 'Cancel' }).click()
      await expect(riversDialog).toHaveCount(0)

      // The class just drawn with: its one region has to be counted, and the two ways of
      // dealing with it offered.
      await penRow(page, 'buildings').getByTitle('Remove class').click()
      const dialog = removeDialog(page, 'buildings')
      await expect(dialog.getByText('1 region(s) across the job use this class. Choose what happens to them:'))
        .toBeVisible()
      await expect(dialog.getByRole('radio')).toHaveCount(2)
      const reassign = dialog.getByRole('radio', { name: /Reassign to/ })
      await expect(reassign).toBeVisible()
      await reassign.check()
      await dialog.getByRole('combobox').selectOption({ label: 'forests' })
      await dialog.getByRole('button', { name: 'Merge & remove' }).click()

      // The square is a forest now, with the same corners; buildings is gone from the palette.
      await expect.poll(async () => (await tileRegions(jobId, tileId))[0]?.class_id).toBe(2)
      const [region] = await tileRegions(jobId, tileId)
      expect(roundPoints(region.points)).toEqual(SQUARE)
      const names = (await jobClasses(jobId)).map((c) => c.name)
      expect(names).not.toContain('buildings')
      expect(names).toContain('forests')
      expect((await classNamed('forests'))?.regions).toBe(1)
      await expect(penRow(page, 'buildings')).toHaveCount(0)
      await expect(penRow(page, 'forests')).toHaveCount(1)
    })

  // The two clicks of a double-click arrive before the dblclick does; each must not leave
  // a corner of its own behind, or the ring ends with its last point twice.
  test('a double-click finishes the shape where the pointer is, without doubling the last corner',
    async ({ page }) => {
      const jobId = await seedMapJob(uniqueName('Palette dblclick'))
      const [tileId] = await tileIds(jobId)
      await openTileEditor(page, jobId, tileId)

      for (const point of SQUARE.slice(0, 3)) await clickTile(page, point)
      await expect(page.getByTestId('draft-dot')).toHaveCount(3)
      const [nx, ny] = SQUARE[3]
      const box = await canvasBox(page)
      await page.mouse.move(box.x + box.width * nx, box.y + box.height * ny, { steps: 5 })
      const now = await canvasBox(page)
      await page.mouse.dblclick(now.x + now.width * nx, now.y + now.height * ny)

      await expect.poll(async () => (await tileRegions(jobId, tileId)).length).toBe(1)
      const [region] = await tileRegions(jobId, tileId)
      expect(region.kind).toBe('polygon')
      expect(roundPoints(region.points)).toEqual(SQUARE)
      await expect(page.getByTestId('draft-dot')).toHaveCount(0)
      await expect(page.getByTestId('map-region')).toHaveCount(1)
    })

  // Back on the first corner, the click itself closes the shape. The dblclick that arrives
  // behind it must find nothing left in hand - not the same shape, still waiting on its
  // save, to be saved a second time.
  test('a double-click on the first corner closes the shape once', async ({ page }) => {
    const jobId = await seedMapJob(uniqueName('Palette dblclick close'))
    const [tileId] = await tileIds(jobId)
    await openTileEditor(page, jobId, tileId)

    const TRIANGLE = SQUARE.slice(0, 3)
    const creates: string[] = []
    page.on('request', (r) => {
      if (r.method() === 'POST' && r.url().endsWith(`/api/pages/${tileId}/regions`)) creates.push(r.url())
    })
    for (const point of TRIANGLE) await clickTile(page, point)
    await expect(page.getByTestId('draft-dot')).toHaveCount(3)
    const [nx, ny] = SQUARE[0]
    const box = await canvasBox(page)
    await page.mouse.move(box.x + box.width * nx, box.y + box.height * ny, { steps: 5 })
    const now = await canvasBox(page)
    await page.mouse.dblclick(now.x + now.width * nx, now.y + now.height * ny)

    // The shape has left the hand; a second save would have been sent by the dblclick
    // itself, so once the first has landed the requests already tell.
    await expect(page.getByTestId('draft-dot')).toHaveCount(0)
    await expect.poll(async () => (await tileRegions(jobId, tileId)).length).toBe(1)
    expect(creates).toHaveLength(1)
    const regions = await tileRegions(jobId, tileId)
    expect(regions).toHaveLength(1)
    expect(regions[0].kind).toBe('polygon')
    expect(roundPoints(regions[0].points)).toEqual(TRIANGLE)
    await expect(page.getByTestId('map-region')).toHaveCount(1)

    // One save is one step back.
    await page.keyboard.press('Control+z')
    await expect.poll(async () => (await tileRegions(jobId, tileId)).length).toBe(0)
    await expect(page.getByTestId('map-region')).toHaveCount(0)
  })

  test('g cuts a hole in the selected polygon, and one undo fills it in again', async ({ page }) => {
    const jobId = await seedMapJob(uniqueName('Palette hole'))
    const [tileId] = await tileIds(jobId)
    await openTileEditor(page, jobId, tileId)

    await drawPolygon(page, SQUARE)
    await expect.poll(async () => (await tileRegions(jobId, tileId)).length).toBe(1)
    const [drawn] = await tileRegions(jobId, tileId)
    expect(drawn.holes).toEqual([])
    // Drawing leaves the shape selected, which is what g works on.
    await expect(page.getByTestId('map-region')).toHaveAttribute('data-selected', 'true')

    await page.keyboard.press('g')
    await expect(page.locator('footer')).toContainText('Cutting a hole')
    await drawPolygon(page, INNER)

    // Still one region: the inner square became its hole, not a second shape.
    await expect.poll(async () => (await tileRegions(jobId, tileId))[0]?.holes.length).toBe(1)
    const regions = await tileRegions(jobId, tileId)
    expect(regions).toHaveLength(1)
    expect(regions[0].id).toBe(drawn.id)
    expect(roundPoints(regions[0].holes[0])).toEqual(INNER)
    expect(roundPoints(regions[0].points)).toEqual(SQUARE)
    await expect(page.locator('footer')).not.toContainText('Cutting a hole')

    await page.keyboard.press('Control+z')
    await expect.poll(async () => (await tileRegions(jobId, tileId))[0]?.holes).toEqual([])
    expect(roundPoints((await tileRegions(jobId, tileId))[0].points)).toEqual(SQUARE)

    await page.keyboard.press('Control+Shift+z')
    await expect.poll(async () => (await tileRegions(jobId, tileId))[0]?.holes.length).toBe(1)
    expect(roundPoints((await tileRegions(jobId, tileId))[0].holes[0])).toEqual(INNER)
  })

  test('Resolve overlaps clips the lower-priority polygon under the higher one', async ({ page }) => {
    const jobId = await seedMapJob(uniqueName('Palette overlaps'))
    const [tileId] = await tileIds(jobId)
    await openTileEditor(page, jobId, tileId)
    const classes = await jobClasses(jobId)
    const priority = (name: string) => classes.find((c) => c.name === name)!.priority
    // Smaller rank wins the shared pixels: buildings clips forests, never the other way.
    expect(priority('buildings')).toBeLessThan(priority('forests'))

    await penPill(page, 'forests').click()
    await expect(penRow(page, 'forests')).toHaveAttribute('data-active', 'true')
    await drawPolygon(page, SQUARE)
    await expect.poll(async () => (await tileRegions(jobId, tileId)).length).toBe(1)
    // Drawing selects the shape, and picking a pen with a shape selected reassigns it:
    // let go of it before changing pens.
    await page.keyboard.press('Escape')
    await penPill(page, 'buildings').click()
    await expect(penRow(page, 'buildings')).toHaveAttribute('data-active', 'true')
    await drawPolygon(page, CORNER)
    await expect.poll(async () => (await tileRegions(jobId, tileId)).length).toBe(2)

    const byClass = async () => {
      const regions = await tileRegions(jobId, tileId)
      return {
        forests: regions.find((r) => r.class_id === 2)!,
        buildings: regions.find((r) => r.class_id === 1)!,
      }
    }
    const before = await byClass()
    expect(roundPoints(before.forests.points)).toEqual(SQUARE)
    expect(roundPoints(before.buildings.points)).toEqual(CORNER)

    await page.getByRole('button', { name: 'Resolve overlaps' }).click()
    await expect(page.getByTestId('editor-notice')).toHaveText('Resolved overlaps: 1 region(s) modified')

    // The forest loses the quarter the building covers and becomes an L; the building
    // is untouched, and nothing was split off or added.
    await expect.poll(async () => (await byClass()).forests.points.length).toBe(6)
    const after = await byClass()
    expect(after.forests.id).toBe(before.forests.id)
    expect(after.forests.holes).toEqual([])
    expect(sorted(after.forests.points)).toEqual(sorted([
      [0.2, 0.2], [0.6, 0.2], [0.6, 0.4], [0.4, 0.4], [0.4, 0.6], [0.2, 0.6],
    ]))
    expect(after.buildings.id).toBe(before.buildings.id)
    expect(roundPoints(after.buildings.points)).toEqual(CORNER)
    expect(after.buildings.holes).toEqual([])
    expect(await tileRegions(jobId, tileId)).toHaveLength(2)

    // Nothing left to clip: a second pass says so and changes nothing.
    await page.getByRole('button', { name: 'Resolve overlaps' }).click()
    await expect(page.getByTestId('editor-notice')).toHaveText('No overlaps to resolve')
    expect(sorted((await byClass()).forests.points)).toEqual(sorted(after.forests.points))

    // One undo step takes the whole pass back.
    await page.keyboard.press('Control+z')
    await expect.poll(async () => roundPoints((await byClass()).forests.points)).toEqual(SQUARE)
    const restored = await byClass()
    expect(restored.forests.holes).toEqual([])
    expect(roundPoints(restored.buildings.points)).toEqual(CORNER)
  })

  // Seeded ranks: buildings 1, urban 2, roads 3, rivers 4, forests 5. Moving forests to
  // the top turns the clip above around: the building now loses the shared quarter.
  test('raising a class to the top rank makes Resolve overlaps clip the other way', async ({ page }) => {
    const jobId = await seedMapJob(uniqueName('Palette priority'))
    const [tileId] = await tileIds(jobId)
    await openTileEditor(page, jobId, tileId)
    const rankOf = (name: string) => penRow(page, name).getByTestId('class-priority')
    const shownRanks = async () => Object.fromEntries(await Promise.all(
      ['buildings', 'forests', 'rivers', 'roads', 'urban'].map(async (n) => [n, await rankOf(n).innerText()])))
    const resolve = page.getByRole('button', { name: 'Resolve overlaps' })

    expect(await shownRanks()).toEqual({ buildings: '1', urban: '2', roads: '3', rivers: '4', forests: '5' })
    await expect(resolve).toHaveAttribute('title', /higher rank wins: buildings over urban over roads over rivers over forests/)
    await expect(penRow(page, 'buildings').getByTestId('class-priority-up')).toBeDisabled()
    await expect(penRow(page, 'forests').getByTestId('class-priority-down')).toBeDisabled()

    const up = penRow(page, 'forests').getByTestId('class-priority-up')
    for (let rank = 4; rank >= 1; rank--) {
      await up.click()
      await expect(rankOf('forests')).toHaveText(String(rank))
    }

    const backendRanks = async () => Object.fromEntries(
      (await jobClasses(jobId)).map((c) => [c.name, [c.id, c.priority]]))
    await expect.poll(backendRanks).toEqual({
      forests: [2, 0], buildings: [1, 1], urban: [5, 2], roads: [4, 3], rivers: [3, 4], background: [0, 5],
    })
    expect(await shownRanks()).toEqual({ forests: '1', buildings: '2', urban: '3', roads: '4', rivers: '5' })
    await expect(up).toBeDisabled()
    await expect(penRow(page, 'forests').getByTestId('class-priority-down')).toBeEnabled()
    await expect(resolve).toHaveAttribute('title', /higher rank wins: forests over buildings over urban over roads over rivers/)

    // The order survives a reload: it is the backend's, not the page's.
    const forests = await seedRegion(tileId, 2, SQUARE)
    const buildings = await seedRegion(tileId, 1, CORNER)
    await page.reload()
    await expect(rankOf('forests')).toHaveText('1')
    await expect(rankOf('buildings')).toHaveText('2')
    await expect(page.getByTestId('map-region')).toHaveCount(2)
    await resolve.click()
    await expect(page.getByTestId('editor-notice')).toHaveText('Resolved overlaps: 1 region(s) modified')

    const byId = async () => new Map((await tileRegions(jobId, tileId)).map((r) => [r.id, r]))
    await expect.poll(async () => (await byId()).get(buildings.id)?.points.length).toBe(6)
    const after = await byId()
    expect(after.size).toBe(2)
    expect(sorted(after.get(buildings.id)!.points)).toEqual(sorted([
      [0.6, 0.4], [0.8, 0.4], [0.8, 0.8], [0.4, 0.8], [0.4, 0.6], [0.6, 0.6],
    ]))
    expect(roundPoints(after.get(forests.id)!.points)).toEqual(SQUARE)
    expect(after.get(forests.id)!.holes).toEqual([])
  })

  // A line job's palette can still hold two ranked classes, and the API takes polygons
  // into it, so x has something it could clip - it must not.
  test('x resolves nothing on line tiles and is missing from their shortcut sheet', async ({ page }) => {
    const resolveRow = () => page.getByTestId('shortcut-sheet')
      .locator('[data-testid="shortcut-row"][data-does="Resolve overlaps"]')
    const shortcutRows = () => page.getByTestId('shortcut-sheet').getByTestId('shortcut-row')
    const seedOverlap = async (task: 'map_segmentation' | 'map_lines') => {
      const jobId = await seedMapJob(uniqueName(`Resolve key ${task}`), 1, task)
      const [tileId] = await tileIds(jobId)
      const lower = task === 'map_lines' ? (await addJobClass(jobId, 'fields', [0, 160, 0])).id : 2
      const higher = await seedRegion(tileId, 1, SQUARE)
      const clipped = await seedRegion(tileId, lower, CORNER)
      await openTileEditor(page, jobId, tileId)
      await expect(page.getByTestId('map-region')).toHaveCount(2)
      return { jobId, tileId, higher, clipped }
    }

    const lines = await seedOverlap('map_lines')
    const ranks = Object.fromEntries((await jobClasses(lines.jobId)).map((c) => [c.name, c.priority]))
    expect(ranks['edge lines']).toBeLessThan(ranks['fields'])
    const before = await tileRegions(lines.jobId, lines.tileId)
    const regionWrites: string[] = []
    page.on('request', (r) => {
      if (r.method() !== 'GET' && /\/api\/(pages\/\d+\/)?regions/.test(r.url())) regionWrites.push(r.url())
    })
    // A resolve sends its first write before the next key is read, so by the time the
    // sheet opened behind x, any write x set off is already on the wire.
    await page.keyboard.press('x')
    await page.keyboard.press('?')
    await expect(page.getByTestId('shortcut-sheet')).toBeVisible()
    expect(regionWrites).toEqual([])
    expect(await tileRegions(lines.jobId, lines.tileId)).toEqual(before)
    expect(roundPoints(before.find((r) => r.id === lines.clipped.id)!.points)).toEqual(CORNER)
    await expect(page.getByTestId('editor-notice')).toHaveCount(0)
    await expect(shortcutRows().first()).toBeVisible()
    await expect(resolveRow()).toHaveCount(0)
    await page.keyboard.press('Escape')

    const polygons = await seedOverlap('map_segmentation')
    await page.keyboard.press('x')
    await expect(page.getByTestId('editor-notice')).toHaveText('Resolved overlaps: 1 region(s) modified')
    await expect.poll(async () => (await tileRegions(polygons.jobId, polygons.tileId))
      .find((r) => r.id === polygons.clipped.id)?.points.length).toBe(6)
    await page.keyboard.press('?')
    await expect(resolveRow()).toHaveCount(1)
    await expect(resolveRow().getByRole('term')).toHaveText('X')
  })

  // Ranks only decide overlaps, which line tiles do not have: a line job's palette shows
  // its classes without them, while a polygon job's shows them on every row.
  test('line tiles show no class ranks or reorder arrows, polygon tiles do', async ({ page }) => {
    const rankParts = (name: string) => penRow(page, name)
      .locator('[data-testid="class-priority"], [data-testid="class-priority-up"], [data-testid="class-priority-down"]')

    const lineJob = await seedMapJob(uniqueName('Ranks on lines'), 1, 'map_lines')
    await addJobClass(lineJob, 'fields', [0, 160, 0])
    const ranks = Object.fromEntries((await jobClasses(lineJob)).map((c) => [c.name, c.priority]))
    expect(ranks['edge lines']).toBeLessThan(ranks['fields'])
    const [lineTile] = await tileIds(lineJob)
    await openTileEditor(page, lineJob, lineTile)
    await expect(penRow(page, 'edge lines')).toHaveCount(1)
    await expect(penRow(page, 'fields')).toHaveCount(1)
    await expect(rankParts('edge lines')).toHaveCount(0)
    await expect(rankParts('fields')).toHaveCount(0)

    const polygonJob = await seedMapJob(uniqueName('Ranks on polygons'))
    const [polygonTile] = await tileIds(polygonJob)
    await openTileEditor(page, polygonJob, polygonTile)
    await expect(rankParts('buildings')).toHaveCount(3)
    await expect(penRow(page, 'buildings').getByTestId('class-priority')).toHaveText('1')
    await expect(penRow(page, 'forests').getByTestId('class-priority')).toHaveText('5')
  })

  test('Reduce polygons drops the vertex that bends nothing, and undo puts it back', async ({ page }) => {
    const jobId = await seedMapJob(uniqueName('Palette reduce'))
    const [tileId] = await tileIds(jobId)
    await openTileEditor(page, jobId, tileId)

    // The square with one extra point halfway along its top edge.
    const FIVE: NormPoint[] = [[0.2, 0.2], [0.4, 0.2], [0.6, 0.2], [0.6, 0.6], [0.2, 0.6]]
    await drawPolygon(page, FIVE)
    await expect.poll(async () => (await tileRegions(jobId, tileId))[0]?.points.length).toBe(5)
    const [drawn] = await tileRegions(jobId, tileId)
    expect(roundPoints(drawn.points)).toEqual(FIVE)

    await page.getByRole('button', { name: 'Reduce polygons' }).click()
    await expect(page.getByTestId('editor-notice')).toHaveText('Reduced 5 → 4 vertices')

    await expect.poll(async () => (await tileRegions(jobId, tileId))[0]?.points.length).toBe(4)
    const [reduced] = await tileRegions(jobId, tileId)
    // The same region with the collinear point gone - the four corners are untouched.
    expect(reduced.id).toBe(drawn.id)
    expect(roundPoints(reduced.points)).toEqual(SQUARE)
    expect(reduced.holes).toEqual([])

    await page.keyboard.press('Control+z')
    await expect.poll(async () => (await tileRegions(jobId, tileId))[0]?.points.length).toBe(5)
    expect(roundPoints((await tileRegions(jobId, tileId))[0].points)).toEqual(FIVE)
  })

  test('m joins two gathered traced lines end to end', async ({ page }) => {
    const jobId = await seedMapJob(uniqueName('Palette merge lines'), 1, 'map_lines')
    const [tileId] = await tileIds(jobId)
    await openTileEditor(page, jobId, tileId)

    const LEFT: NormPoint[] = [[0.1, 0.3], [0.3, 0.3]]
    const RIGHT: NormPoint[] = [[0.5, 0.3], [0.7, 0.3]]
    await drawPolygon(page, LEFT)
    await drawPolygon(page, RIGHT)
    await expect.poll(async () => (await tileRegions(jobId, tileId)).length).toBe(2)
    const [a, b] = await tileRegions(jobId, tileId)
    expect(roundPoints(a.points)).toEqual(LEFT)
    expect(roundPoints(b.points)).toEqual(RIGHT)

    await page.getByRole('button', { name: 'Select', exact: true }).click()
    await clickTile(page, [0.2, 0.3])
    await expect(page.locator(`[data-testid="map-region"][data-region-id="${a.id}"][data-selected="true"]`))
      .toHaveCount(1)
    await page.keyboard.down('Shift')
    await clickTile(page, [0.6, 0.3])
    await page.keyboard.up('Shift')
    await expect(page.locator('footer')).toContainText('2 gathered')
    await page.keyboard.press('m')

    // One line under the first one's id, the gap bridged from the left line's end to the
    // right line's start - the nearest pair of ends, so it never doubles back.
    await expect.poll(async () => (await tileRegions(jobId, tileId)).length).toBe(1)
    const [merged] = await tileRegions(jobId, tileId)
    expect(merged.id).toBe(a.id)
    expect(merged.kind).toBe('polyline')
    expect(merged.holes).toEqual([])
    expect(roundPoints(merged.points)).toEqual([...LEFT, ...RIGHT])
    await expect(page.getByTestId('map-region')).toHaveCount(1)

    await page.keyboard.press('Control+z')
    await expect.poll(async () => (await tileRegions(jobId, tileId)).length).toBe(2)
    const restored = await tileRegions(jobId, tileId)
    expect(roundPoints(restored.find((r) => r.id === a.id)!.points)).toEqual(LEFT)
    expect(roundPoints(restored.find((r) => r.id === b.id)!.points)).toEqual(RIGHT)
    await expect(page.getByTestId('map-region')).toHaveCount(2)
  })

  test('Space is the hand for as long as it is held, and gives the tool back after',
    async ({ page }) => {
      const jobId = await seedMapJob(uniqueName('Palette space hand'))
      const [tileId] = await tileIds(jobId)
      await openTileEditor(page, jobId, tileId)
      await expect(page.getByTestId('tool-draw')).toHaveAttribute('aria-pressed', 'true')

      await page.keyboard.down(' ')
      await expect(page.getByTestId('tool-hand')).toHaveAttribute('aria-pressed', 'true')
      await expect(page.getByTestId('tool-draw')).toHaveAttribute('aria-pressed', 'false')

      // The pen is off while it is held: the clicks that trace a square place nothing.
      await drawPolygon(page, SQUARE)
      await expect(page.getByTestId('map-region')).toHaveCount(0)
      expect(await tileRegions(jobId, tileId)).toEqual([])

      await page.keyboard.up(' ')
      await expect(page.getByTestId('tool-draw')).toHaveAttribute('aria-pressed', 'true')
      await expect(page.getByTestId('tool-hand')).toHaveAttribute('aria-pressed', 'false')

      // Paired: the same clicks now draw, and draw the square that was clicked.
      await drawPolygon(page, SQUARE)
      await expect(page.getByTestId('map-region')).toHaveCount(1)
      await expect.poll(async () => (await tileRegions(jobId, tileId)).length).toBe(1)
      expect(roundPoints((await tileRegions(jobId, tileId))[0].points)).toEqual(SQUARE)
    })
})
