import { test, expect } from '../helpers/test'
import { backendFetch, getJob, identity, shareJob, uniqueName } from '../helpers/api'
import { seedSession, useSession } from '../helpers/session'
import {
  atLifeSize, JSON_HEADERS,
  type NormPoint, TILE, canvasBox, clickAt, clickTile, detectInBox, detectInOutline, dragVertex,
  drawPolygon, eraseStroke, jobClasses, openTileEditor, rightClickTile, roundPoints, seedMapJob,
  seedRegion, strokeTile, stubLineFor, tileIds, tileRegions,
} from '../helpers/map'

// A square well inside the tile, big enough that its centre is far from every vertex
// (so a select click can't be mistaken for a vertex grab) and from the close-snap radius.
const SQUARE: NormPoint[] = [[0.2, 0.2], [0.6, 0.2], [0.6, 0.6], [0.2, 0.6]]
const SQUARE_CENTRE: NormPoint = [0.4, 0.4]
const OTHER: NormPoint[] = [[0.7, 0.7], [0.9, 0.7], [0.9, 0.9], [0.7, 0.9]]

test.describe('Scenario: annotating a map tile', () => {
  test('hovering a row of the region list lights up that region on the tile', async ({ page }) => {
    const jobId = await seedMapJob(uniqueName('Tile hover'))
    const [tileId] = await tileIds(jobId)
    const cls = (await jobClasses(jobId)).find((c) => c.id !== 0)!
    const first = await seedRegion(tileId, cls.id, SQUARE)
    const second = await seedRegion(tileId, cls.id, OTHER)
    await openTileEditor(page, jobId, tileId)

    const region = (id: number) => page.locator(`[data-testid="map-region"][data-region-id="${id}"]`)
    const lit = page.locator('[data-testid="map-region"][data-hovered]')
    await expect(page.getByTestId('map-region')).toHaveCount(2)
    await expect(lit).toHaveCount(0)

    const rows = page.getByTestId('region-row')
    await rows.nth(1).hover()
    await expect(lit).toHaveCount(1)
    const hovered = await lit.getAttribute('data-region-id')
    expect([String(first.id), String(second.id)]).toContain(hovered)
    await rows.nth(0).hover()
    await expect(lit).toHaveCount(1)
    expect(await lit.getAttribute('data-region-id')).not.toBe(hovered)
    await expect(region(Number(hovered))).not.toHaveAttribute('data-hovered', 'true')

    await page.getByTestId('tile-canvas').hover()
    await expect(lit).toHaveCount(0)
  })

  test('a drawn polygon reaches the backend with the geometry that was clicked', async ({ page }) => {
    const jobId = await seedMapJob(uniqueName('Tile draw'))
    const [tileId] = await tileIds(jobId)
    await openTileEditor(page, jobId, tileId)

    await expect(page.getByTestId('map-region')).toHaveCount(0)
    await drawPolygon(page, SQUARE)

    // Backend oracle: one region, the seeded 'buildings' class, and the exact corners
    // that were clicked - not merely "something was created".
    await expect.poll(async () => (await tileRegions(jobId, tileId)).length).toBe(1)
    const [region] = await tileRegions(jobId, tileId)
    expect(roundPoints(region.points)).toEqual(SQUARE)
    expect(region.kind).toBe('polygon')
    expect(region.holes).toEqual([])
    // A human drew it, so it counts as reviewed geometry the way create_region promises.
    expect(region.checked).toBe(true)

    // The overlay agrees with the backend rather than only with itself.
    const drawn = page.getByTestId('map-region')
    await expect(drawn).toHaveCount(1)
    await expect(drawn).toHaveAttribute('data-class-id', String(region.class_id))
  })

  test('Alt is the hand for as long as it is held, and gives the tool back after',
    async ({ page }) => {
      const jobId = await seedMapJob(uniqueName('Tile alt hand'))
      const [tileId] = await tileIds(jobId)
      await openTileEditor(page, jobId, tileId)
      await expect(page.getByTestId('tool-draw')).toHaveAttribute('aria-pressed', 'true')

      await page.keyboard.down('Alt')
      await expect(page.getByTestId('tool-hand')).toHaveAttribute('aria-pressed', 'true')
      await expect(page.getByTestId('tool-draw')).toHaveAttribute('aria-pressed', 'false')

      // The pen is off while it is held: the clicks that trace a square place nothing.
      await drawPolygon(page, SQUARE)
      await expect(page.getByTestId('map-region')).toHaveCount(0)

      await page.keyboard.up('Alt')
      await expect(page.getByTestId('tool-draw')).toHaveAttribute('aria-pressed', 'true')
      await expect(page.getByTestId('tool-hand')).toHaveAttribute('aria-pressed', 'false')

      // Paired: the same clicks now draw, and draw the square that was clicked.
      await drawPolygon(page, SQUARE)
      await expect(page.getByTestId('map-region')).toHaveCount(1)
      await expect.poll(async () => (await tileRegions(jobId, tileId)).length).toBe(1)
      expect(roundPoints((await tileRegions(jobId, tileId))[0].points)).toEqual(SQUARE)
    })

  test('undo removes the polygon and redo restores it, backend included', async ({ page }) => {
    const jobId = await seedMapJob(uniqueName('Tile undo'))
    const [tileId] = await tileIds(jobId)
    await openTileEditor(page, jobId, tileId)

    await drawPolygon(page, SQUARE)
    await expect.poll(async () => (await tileRegions(jobId, tileId)).length).toBe(1)
    const created = (await tileRegions(jobId, tileId))[0]

    await page.keyboard.press('Control+z')
    await expect.poll(async () => (await tileRegions(jobId, tileId)).length).toBe(0)
    await expect(page.getByTestId('map-region')).toHaveCount(0)

    await page.keyboard.press('Control+Shift+z')
    await expect.poll(async () => (await tileRegions(jobId, tileId)).length).toBe(1)
    const restored = (await tileRegions(jobId, tileId))[0]
    // Restored, not redrawn: the id survives, so revisions and exports stay coherent.
    expect(restored.id).toBe(created.id)
    expect(roundPoints(restored.points)).toEqual(SQUARE)
    await expect(page.getByTestId('map-region')).toHaveCount(1)
  })

  test('a selected polygon is reassigned by picking another class', async ({ page }) => {
    const jobId = await seedMapJob(uniqueName('Tile reclass'))
    const [tileId] = await tileIds(jobId)
    await openTileEditor(page, jobId, tileId)

    await drawPolygon(page, SQUARE)
    await expect.poll(async () => (await tileRegions(jobId, tileId)).length).toBe(1)
    const before = (await tileRegions(jobId, tileId))[0]

    // Select it, then pick the second drawable class from the palette.
    await page.getByRole('button', { name: 'Select' }).click()
    await clickTile(page, SQUARE_CENTRE)
    await expect(page.getByTestId('map-region')).toHaveAttribute('data-selected', 'true')

    const classes = await jobClasses(jobId)
    const target = classes.filter((c) => c.id !== 0).find((c) => c.id !== before.class_id)!
    await page.getByTestId('pen-row').filter({ hasText: target.name })
      .getByRole('button', { name: target.name, exact: true }).click()

    await expect.poll(async () => (await tileRegions(jobId, tileId))[0].class_id).toBe(target.id)
    // Geometry is untouched by a class change.
    expect(roundPoints((await tileRegions(jobId, tileId))[0].points)).toEqual(SQUARE)
  })

  test('deleting a selected polygon clears it everywhere', async ({ page }) => {
    const jobId = await seedMapJob(uniqueName('Tile delete'))
    const [tileId] = await tileIds(jobId)
    await openTileEditor(page, jobId, tileId)

    await drawPolygon(page, SQUARE)
    await drawPolygon(page, OTHER)
    await expect.poll(async () => (await tileRegions(jobId, tileId)).length).toBe(2)
    const [first] = await tileRegions(jobId, tileId)

    await page.getByRole('button', { name: 'Select' }).click()
    await clickTile(page, SQUARE_CENTRE)
    await page.keyboard.press('Delete')

    await expect.poll(async () => (await tileRegions(jobId, tileId)).length).toBe(1)
    // The survivor is the other one - so a delete that wiped both would fail here.
    const remaining = await tileRegions(jobId, tileId)
    expect(remaining.map((r) => r.id)).not.toContain(first.id)
    await expect(page.getByTestId('map-region')).toHaveCount(1)
  })

  // The eraser brush sweeps away every vertex within its radius (20px by default, against
  // a 512px tile). These cover the merge that put it on top of the extracted geometry.
  test('the eraser brush removes the vertices it sweeps', async ({ page }) => {
    const jobId = await seedMapJob(uniqueName('Tile erase'))
    const [tileId] = await tileIds(jobId)
    await openTileEditor(page, jobId, tileId)

    await drawPolygon(page, SQUARE)
    await expect.poll(async () => (await tileRegions(jobId, tileId)).length).toBe(1)

    await page.getByRole('button', { name: 'Erase' }).click()
    await eraseStroke(page, SQUARE[0]) // a dab on one corner

    // The square loses exactly that corner and keeps the other three.
    await expect.poll(async () => (await tileRegions(jobId, tileId))[0].points.length).toBe(3)
    const [region] = await tileRegions(jobId, tileId)
    expect(roundPoints(region.points)).toEqual(SQUARE.slice(1))
  })

  test('a freehand stroke is drawn as a line, not as a rash of dots', async ({ page }) => {
    const jobId = await seedMapJob(uniqueName('Tile stroke dots'))
    const [tileId] = await tileIds(jobId)
    await openTileEditor(page, jobId, tileId)

    // Two corners by hand first: those keep their dots while the stroke is drawn.
    await clickTile(page, [0.2, 0.2])
    await clickTile(page, [0.5, 0.2])
    const dots = page.getByTestId('draft-dot')
    await expect(dots).toHaveCount(2)

    const box = await canvasBox(page)
    const at = (p: NormPoint) => ({ x: box.x + p[0] * box.width, y: box.y + p[1] * box.height })
    const path: NormPoint[] = [[0.5, 0.3], [0.45, 0.45], [0.35, 0.55], [0.25, 0.5]]
    await page.mouse.move(at(path[0]).x, at(path[0]).y)
    await page.mouse.down()
    for (const p of path.slice(1)) {
      const to = at(p)
      await page.mouse.move(to.x, to.y, { steps: 20 })
    }
    // Mid-stroke: the placed corners and the point the stroke set out from, no more.
    await expect(dots).toHaveCount(3)
    await page.mouse.up()

    // Once it is down the stroke is a handful of corners, not the hundreds it sampled.
    await expect.poll(async () => (await dots.count()) > 2).toBe(true)
    expect(await dots.count()).toBeLessThan(20)
  })

  test('a stroke says when it is back where it began, and closes there', async ({ page }) => {
    const jobId = await seedMapJob(uniqueName('Tile stroke close'))
    const [tileId] = await tileIds(jobId)
    await openTileEditor(page, jobId, tileId)

    const box = await canvasBox(page)
    const at = (p: NormPoint) => ({ x: box.x + p[0] * box.width, y: box.y + p[1] * box.height })
    const loop: NormPoint[] = [[0.25, 0.25], [0.6, 0.25], [0.6, 0.6], [0.25, 0.6], [0.25, 0.25]]
    const closer = page.getByTestId('draft-close')

    await page.mouse.move(at(loop[0]).x, at(loop[0]).y)
    await page.mouse.down()
    for (const p of loop.slice(1, -1)) await page.mouse.move(at(p).x, at(p).y, { steps: 20 })
    // Away from where it started: the way out is shown, and is not offering to be taken.
    await expect(closer).toHaveCount(1)
    await expect(closer).not.toHaveAttribute('data-armed', 'true')
    // The point it set out from is still on the tile, so there is something to aim at.
    await expect(page.getByTestId('draft-dot')).toHaveCount(1)

    await page.mouse.move(at(loop[4]).x, at(loop[4]).y, { steps: 20 })
    await expect(closer).toHaveAttribute('data-armed', 'true')
    await page.mouse.up()

    // Letting go there drew the shape, and left nothing in hand.
    await expect.poll(async () => (await tileRegions(jobId, tileId)).length).toBe(1)
    const [region] = await tileRegions(jobId, tileId)
    expect(region.kind).toBe('polygon')
    expect(region.points.length).toBeGreaterThan(2)
    expect(region.points.length).toBeLessThan(20)
    await expect(closer).toHaveCount(0)
    await expect(page.getByTestId('draft-dot')).toHaveCount(0)
  })

  test('with every class removed the pen starts nothing, and says why', async ({ page }) => {
    const jobId = await seedMapJob(uniqueName('Tile no class'))
    const [tileId] = await tileIds(jobId)
    for (const cls of await jobClasses(jobId)) {
      if (cls.id !== 0) {
        await backendFetch(`/api/jobs/${jobId}/map-classes/${cls.id}`, { method: 'DELETE' })
      }
    }
    expect((await jobClasses(jobId)).filter((c) => c.id !== 0)).toEqual([])
    await openTileEditor(page, jobId, tileId)

    // Neither single clicks nor a held stroke begin a shape there is no class to file under.
    for (const point of SQUARE) await clickTile(page, point)
    await expect(page.getByTestId('editor-notice'))
      .toHaveText('There is no class to draw with. Add one first.')
    await strokeTile(page, [[0.25, 0.25], [0.6, 0.25], [0.6, 0.6], [0.25, 0.6], [0.25, 0.25]])
    await expect(page.getByTestId('draft-dot')).toHaveCount(0)
    await expect(page.getByTestId('draft-close')).toHaveCount(0)
    expect(await tileRegions(jobId, tileId)).toEqual([])

    // Once there is a class again the same clicks draw, so the selectors above can see a
    // draft when there is one.
    await backendFetch(`/api/jobs/${jobId}/map-classes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'roads', color: [200, 40, 40] }),
    })
    await page.reload()
    await expect(page.getByTestId('tile-canvas')).toBeVisible()
    await clickTile(page, SQUARE[0])
    await expect(page.getByTestId('draft-dot')).toHaveCount(1)
    for (const point of SQUARE.slice(1)) await clickTile(page, point)
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await tileRegions(jobId, tileId)).length).toBe(1)
    const [region] = await tileRegions(jobId, tileId)
    const [roads] = (await jobClasses(jobId)).filter((c) => c.name === 'roads')
    expect(region.class_id).toBe(roads.id)
    expect(roundPoints(region.points)).toEqual(SQUARE)
  })

  test('a shape being drawn is drawn in the colour of the class it will be filed under',
    async ({ page }) => {
      const jobId = await seedMapJob(uniqueName('Tile draft colour'))
      const [tileId] = await tileIds(jobId)
      const [first, second] = (await jobClasses(jobId)).filter((c) => c.id !== 0)
      const hex = (rgb: number[]) => `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`
      expect(hex(first.color)).not.toBe(hex(second.color))
      await openTileEditor(page, jobId, tileId)

      await clickTile(page, SQUARE[0])
      await clickTile(page, SQUARE[1])
      await expect(page.getByTestId('draft-dot')).toHaveCount(2)
      await expect(page.getByTestId('draft-dot').first()).toHaveAttribute('fill', hex(first.color))
      await expect(page.getByTestId('draft-line')).toHaveAttribute('stroke', hex(first.color))

      // Picking another class mid-shape changes what it will be filed under, so its colour.
      await page.keyboard.press('2')
      await expect(page.getByTestId('draft-dot').first()).toHaveAttribute('fill', hex(second.color))
      await expect(page.getByTestId('draft-line')).toHaveAttribute('stroke', hex(second.color))

      await clickTile(page, SQUARE[2])
      await page.keyboard.press('Enter')
      await expect.poll(async () => (await tileRegions(jobId, tileId)).map((r) => r.class_id))
        .toEqual([second.id])
    })

  test('one undo puts back everything an eraser stroke took', async ({ page }) => {
    const jobId = await seedMapJob(uniqueName('Tile erase undo'))
    const [tileId] = await tileIds(jobId)
    await openTileEditor(page, jobId, tileId)

    await drawPolygon(page, SQUARE)
    await expect.poll(async () => (await tileRegions(jobId, tileId)).length).toBe(1)
    const [drawn] = await tileRegions(jobId, tileId)

    await page.getByRole('button', { name: 'Erase' }).click()
    await eraseStroke(page, SQUARE[0])
    await expect.poll(async () => (await tileRegions(jobId, tileId))[0].points.length).toBe(3)

    await page.keyboard.press('Control+z')
    // The corner is back on the same region, not on a redrawn one.
    await expect.poll(async () => (await tileRegions(jobId, tileId))[0].points.length).toBe(4)
    const [restored] = await tileRegions(jobId, tileId)
    expect(restored.id).toBe(drawn.id)
    expect(roundPoints(restored.points)).toEqual(SQUARE)

    await page.keyboard.press('Control+Shift+z')
    await expect.poll(async () => (await tileRegions(jobId, tileId))[0].points.length).toBe(3)
    expect(roundPoints((await tileRegions(jobId, tileId))[0].points)).toEqual(SQUARE.slice(1))
  })

  test('erasing below three vertices deletes the whole polygon', async ({ page }) => {
    const jobId = await seedMapJob(uniqueName('Tile erase floor'))
    const [tileId] = await tileIds(jobId)
    await openTileEditor(page, jobId, tileId)

    await drawPolygon(page, SQUARE)
    await drawPolygon(page, OTHER)
    await expect.poll(async () => (await tileRegions(jobId, tileId)).length).toBe(2)

    await page.getByRole('button', { name: 'Erase' }).click()
    // Sweeping the square's top edge takes two of its four corners; two is below the
    // polygon floor, so the region goes rather than becoming a degenerate sliver.
    await eraseStroke(page, SQUARE[0], SQUARE[1])

    await expect.poll(async () => (await tileRegions(jobId, tileId)).length).toBe(1)
    // The untouched second polygon is what survived - a stroke that wiped both would fail.
    const remaining = await tileRegions(jobId, tileId)
    expect(roundPoints(remaining[0].points)).toEqual(OTHER)
  })

  // Clicking past the edge of the image is how a vertex is put *on* it: the alternative
  // is a pixel-perfect click on the border, which no annotator should have to aim.
  test('a click past the edge of the tile puts the vertex on the edge', async ({ page }) => {
    const jobId = await seedMapJob(uniqueName('Tile edge click'))
    const [tileId] = await tileIds(jobId)
    await openTileEditor(page, jobId, tileId)

    // A 512px tile in a 1440x900 viewport leaves real blank pane right of and below it.
    const box = await canvasBox(page)
    await clickTile(page, [0.2, 0.2])
    await clickAt(page, box.x + box.width + 60, box.y + box.height * 0.6)
    await clickAt(page, box.x + box.width * 0.6, box.y + box.height + 40)
    await page.keyboard.press('Enter')

    await expect.poll(async () => (await tileRegions(jobId, tileId)).length).toBe(1)
    const [region] = await tileRegions(jobId, tileId)
    // Clamped onto the edge it was aimed past - neither dropped nor stored out of range.
    expect(roundPoints(region.points)).toEqual([[0.2, 0.2], [1, 0.6], [0.6, 1]])
  })

  test('a traced line takes an endpoint from past the bottom edge', async ({ page }) => {
    const jobId = await seedMapJob(uniqueName('Tile edge line'), 1, 'map_lines')
    const [tileId] = await tileIds(jobId)
    await openTileEditor(page, jobId, tileId)

    const box = await canvasBox(page)
    await clickTile(page, [0.2, 0.4])
    await clickAt(page, box.x + box.width * 0.8, box.y + box.height + 50)
    await page.keyboard.press('Enter')

    // Two points is a whole line, even when one of them was placed off the tile.
    await expect.poll(async () => (await tileRegions(jobId, tileId)).length).toBe(1)
    const [region] = await tileRegions(jobId, tileId)
    expect(region.kind).toBe('polyline')
    expect(roundPoints(region.points)).toEqual([[0.2, 0.4], [0.8, 1]])
  })

  // Line snapping. A line drawn towards one it is meant to meet should land on it rather
  // than a pixel short or past, so junctions are exact instead of nearly-exact. One screen
  // pixel is 1/512 normalized at zoom 1, well inside the 12px snap radius.
  const PX = 1 / TILE.width
  const LINE_A: NormPoint[] = [[0.2, 0.3], [0.8, 0.3]]

  test('a line drawn near an existing one snaps onto it', async ({ page }) => {
    const jobId = await seedMapJob(uniqueName('Tile snap draw'), 1, 'map_lines')
    const [tileId] = await tileIds(jobId)
    await openTileEditor(page, jobId, tileId)

    // On by default: snapping is wanted far more often than not.
    await expect(page.getByTestId('snap-toggle')).toBeChecked()
    await drawPolygon(page, LINE_A)
    await expect.poll(async () => (await tileRegions(jobId, tileId)).length).toBe(1)
    const [a] = await tileRegions(jobId, tileId)
    const aY = a.points[0][1] // whatever the click actually rounded to, both ends share it

    // End the new line 6px below A's midspan: it lands on A, not where it was clicked.
    await drawPolygon(page, [[0.5, 0.75], [0.5, 0.3 + 6 * PX]])
    await expect.poll(async () => (await tileRegions(jobId, tileId)).length).toBe(2)
    const b = (await tileRegions(jobId, tileId))[1]
    expect(b.points).toHaveLength(2)
    // Exactly on A, and only the perpendicular offset was absorbed - x is untouched.
    expect(b.points[1][1]).toBeCloseTo(aY, 6)
    expect(b.points[1][0]).toBeCloseTo(0.5, 2)
  })

  test('a vertex inside the snap radius wins over the segment it sits on', async ({ page }) => {
    const jobId = await seedMapJob(uniqueName('Tile snap vertex'), 1, 'map_lines')
    const [tileId] = await tileIds(jobId)
    await openTileEditor(page, jobId, tileId)

    await drawPolygon(page, LINE_A)
    await expect.poll(async () => (await tileRegions(jobId, tileId)).length).toBe(1)
    const [a] = await tileRegions(jobId, tileId)

    // 3px short of A's end and 5px below it: nearer the segment (5px) than the endpoint
    // (5.8px), so only the vertex rule can land it on the corner rather than beside it.
    await drawPolygon(page, [[0.5, 0.75], [0.8 - 3 * PX, 0.3 + 5 * PX]])
    await expect.poll(async () => (await tileRegions(jobId, tileId)).length).toBe(2)
    const b = (await tileRegions(jobId, tileId))[1]
    // The shared corner, to the last decimal: two lines meeting at one point.
    expect(b.points[1]).toEqual(a.points[1])
  })

  test('with snapping off the drawn point is kept as clicked', async ({ page }) => {
    const jobId = await seedMapJob(uniqueName('Tile snap off'), 1, 'map_lines')
    const [tileId] = await tileIds(jobId)
    await openTileEditor(page, jobId, tileId)

    await drawPolygon(page, LINE_A)
    await expect.poll(async () => (await tileRegions(jobId, tileId)).length).toBe(1)
    const [a] = await tileRegions(jobId, tileId)

    await page.getByTestId('snap-toggle').uncheck()
    await drawPolygon(page, [[0.5, 0.75], [0.5, 0.3 + 6 * PX]])
    await expect.poll(async () => (await tileRegions(jobId, tileId)).length).toBe(2)
    const b = (await tileRegions(jobId, tileId))[1]
    // Where the pointer was, not where the line is: a deliberate near-miss stays a near-miss.
    expect(b.points[1][1]).toBeCloseTo(0.3 + 6 * PX, 2)
    expect(b.points[1][1]).toBeGreaterThan(a.points[0][1] + 3 * PX)
  })

  test('dragging a vertex near another line snaps it onto that line', async ({ page }) => {
    const jobId = await seedMapJob(uniqueName('Tile snap drag'), 1, 'map_lines')
    const [tileId] = await tileIds(jobId)
    await openTileEditor(page, jobId, tileId)

    await drawPolygon(page, LINE_A)
    await drawPolygon(page, [[0.5, 0.75], [0.5, 0.55]])
    await expect.poll(async () => (await tileRegions(jobId, tileId)).length).toBe(2)
    const [a, b] = await tileRegions(jobId, tileId)

    // Drawing a line leaves it selected, so its handles are already out - clicking the
    // line again to "select" it would land on the midpoint handle and insert a vertex.
    await page.getByRole('button', { name: 'Select', exact: true }).click()
    // The shape on the canvas, not its row in the list: both say which region they are.
    await expect(page.locator(`[data-testid="map-region"][data-region-id="${b.id}"][data-selected="true"]`)).toHaveCount(1)
    // Pull its free end up to within 6px of the first line.
    await dragVertex(page, [0.5, 0.55], [0.5, 0.3 + 6 * PX])

    await expect.poll(async () => (await tileRegions(jobId, tileId))[1].points[1][1])
      .toBeCloseTo(a.points[0][1], 6)
    const moved = (await tileRegions(jobId, tileId))[1]
    expect(moved.id).toBe(b.id) // the same line, re-shaped - not a new one
    expect(moved.points[1][0]).toBeCloseTo(0.5, 2)
  })

  // Zoomed in to work, the tile fills the pane and the chrome is the only "outside" left,
  // so mid-shape it has to place vertices too - and must not also work its own control.
  test('holding Alt with the eraser in hand puts the brush away until it is let go', async ({ page }) => {
    const jobId = await seedMapJob(uniqueName('Tile alt erase'))
    const [tileId] = await tileIds(jobId)
    await openTileEditor(page, jobId, tileId)
    await page.getByRole('button', { name: 'Erase' }).click()
    const box = await canvasBox(page)
    await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.4)
    const brush = page.getByTestId('erase-brush')
    await expect(brush).toHaveCount(1)

    await page.keyboard.down('Alt')
    await expect(page.getByTestId('tool-hand')).toHaveAttribute('aria-pressed', 'true')
    await expect(brush).toHaveCount(0)

    await page.keyboard.up('Alt')
    await expect(page.getByTestId('tool-erase')).toHaveAttribute('aria-pressed', 'true')
    await expect(brush).toHaveCount(1)
  })

  test('mid-shape a click on the tool rail places a vertex instead of switching tools', async ({ page }) => {
    const jobId = await seedMapJob(uniqueName('Tile chrome click'))
    const [tileId] = await tileIds(jobId)
    await openTileEditor(page, jobId, tileId)

    const box = await canvasBox(page)
    const select = page.getByRole('button', { name: 'Select', exact: true })
    const btn = (await select.boundingBox())!
    const [bx, by] = [btn.x + btn.width / 2, btn.y + btn.height / 2]
    // The rail sits left of the tile, so a click on it can only mean the left edge.
    expect(bx).toBeLessThan(box.x)

    await clickTile(page, [0.3, 0.3])
    await clickTile(page, [0.7, 0.3])
    await clickAt(page, bx, by)
    await page.keyboard.press('Enter')

    await expect.poll(async () => (await tileRegions(jobId, tileId)).length).toBe(1)
    const [region] = await tileRegions(jobId, tileId)
    expect(region.points).toHaveLength(3)
    expect(roundPoints(region.points.slice(0, 2))).toEqual([[0.3, 0.3], [0.7, 0.3]])
    expect(region.points[2][0]).toBe(0)
    expect(region.points[2][1]).toBeCloseTo((by - box.y) / box.height, 2)

    // The button never saw the click - the draw tool is still the one in hand...
    await expect(page.locator('footer')).toContainText('Draw -')
    // ...and it works again the moment nothing is being drawn.
    await select.click()
    await expect(page.locator('footer')).toContainText('Select -')
  })

  // Right-click is the third way to confirm a shape, next to Enter and a double-click, so
  // a drawing hand never has to leave the mouse. It must not cost the two right-click
  // behaviours that were there first: the vertex delete, and the browser's own menu.
  test('right-click finishes a polygon the way Enter does', async ({ page }) => {
    const jobId = await seedMapJob(uniqueName('Tile rclick'))
    const [tileId] = await tileIds(jobId)
    await openTileEditor(page, jobId, tileId)

    await drawPolygon(page, SQUARE, 'right-click')

    // Same oracle as the Enter case: the exact corners clicked, closed into one polygon.
    await expect.poll(async () => (await tileRegions(jobId, tileId)).length).toBe(1)
    const [region] = await tileRegions(jobId, tileId)
    expect(roundPoints(region.points)).toEqual(SQUARE)
    expect(region.kind).toBe('polygon')
    await expect(page.getByTestId('map-region')).toHaveCount(1)
  })

  test('right-click finishes a traced line, open where it was left', async ({ page }) => {
    // Right-click and Enter finish a line wherever the pointer is - and two points is a
    // whole line. Only a trace brought back to its first point is closed; see below.
    const jobId = await seedMapJob(uniqueName('Tile rclick line'), 1, 'map_lines')
    const [tileId] = await tileIds(jobId)
    await openTileEditor(page, jobId, tileId)

    const trace: NormPoint[] = [[0.2, 0.3], [0.5, 0.35], [0.8, 0.3]]
    await drawPolygon(page, trace, 'right-click')

    await expect.poll(async () => (await tileRegions(jobId, tileId)).length).toBe(1)
    const [region] = await tileRegions(jobId, tileId)
    expect(region.kind).toBe('polyline')
    expect(roundPoints(region.points)).toEqual(trace)
    // Open, not closed: the first point is not repeated at the end.
    expect(region.holes).toEqual([])
  })

  test('a trace brought back to its first point closes there', async ({ page }) => {
    const jobId = await seedMapJob(uniqueName('Tile line close'), 1, 'map_lines')
    const [tileId] = await tileIds(jobId)
    await openTileEditor(page, jobId, tileId)

    const trace: NormPoint[] = [[0.25, 0.25], [0.65, 0.25], [0.65, 0.65]]
    const closer = page.getByTestId('draft-close')
    // Two points make a line that could be finished, but not one that could be closed:
    // the way out is only offered once there is an area to enclose.
    for (const point of trace.slice(0, 2)) await clickTile(page, point)
    await expect(closer).toHaveCount(0)
    await clickTile(page, trace[2])
    await expect(closer).toHaveCount(1)

    await clickTile(page, trace[0])
    await expect.poll(async () => (await tileRegions(jobId, tileId)).length).toBe(1)
    const [region] = await tileRegions(jobId, tileId)
    // Still a traced line - it encloses nothing - but one that ends where it began.
    expect(region.kind).toBe('polyline')
    expect(roundPoints(region.points)).toEqual([...trace, trace[0]])
    await expect(closer).toHaveCount(0)
  })

  test('a closed trace has one handle where it meets itself, and keeps it closed', async ({ page }) => {
    const jobId = await seedMapJob(uniqueName('Tile line seam'), 1, 'map_lines')
    const [tileId] = await tileIds(jobId)
    await openTileEditor(page, jobId, tileId)

    const trace: NormPoint[] = [[0.25, 0.25], [0.65, 0.25], [0.65, 0.65]]
    for (const point of trace) await clickTile(page, point)
    await clickTile(page, trace[0])
    await expect.poll(async () => (await tileRegions(jobId, tileId)).length).toBe(1)

    // Four stored points, three corners: the seam is one handle, not two stacked. The
    // trace is selected already - drawing one selects it - so nothing has to be clicked,
    // which would land on a midpoint handle and insert a vertex.
    await page.getByTestId('tool-select').click()
    await expect(page.getByTestId('vertex-handle')).toHaveCount(3)

    // Dragging that handle takes both ends with it, so the trace is still closed after.
    await dragVertex(page, trace[0], [0.3, 0.4])
    await expect
      .poll(async () => roundPoints((await tileRegions(jobId, tileId))[0].points))
      .toEqual([[0.3, 0.4], trace[1], trace[2], [0.3, 0.4]])
  })

  test('with nothing being drawn, right-click still removes a vertex', async ({ page }) => {
    const jobId = await seedMapJob(uniqueName('Tile rclick vertex'))
    const [tileId] = await tileIds(jobId)
    await openTileEditor(page, jobId, tileId)

    await drawPolygon(page, SQUARE)
    await expect.poll(async () => (await tileRegions(jobId, tileId)).length).toBe(1)

    await page.getByRole('button', { name: 'Select' }).click()
    await clickTile(page, SQUARE_CENTRE)
    await expect(page.getByTestId('map-region')).toHaveAttribute('data-selected', 'true')

    // The confirming handler sits on the whole canvas; if it swallowed this the polygon
    // would keep all four corners.
    const handles = page.getByTestId('vertex-handle')
    await expect(handles).toHaveCount(SQUARE.length)
    await handles.first().click({ button: 'right' })

    await expect.poll(async () => (await tileRegions(jobId, tileId))[0].points.length).toBe(3)
    expect(roundPoints((await tileRegions(jobId, tileId))[0].points)).toEqual(SQUARE.slice(1))
  })

  test('right-click on empty canvas draws nothing', async ({ page }) => {
    const jobId = await seedMapJob(uniqueName('Tile rclick idle'))
    const [tileId] = await tileIds(jobId)
    await openTileEditor(page, jobId, tileId)

    // No draft in hand, so the gesture is inert - it must not close an empty shape into
    // a region, and the editor must still be usable afterwards.
    await rightClickTile(page, SQUARE_CENTRE)
    await expect(page.getByTestId('map-region')).toHaveCount(0)

    await drawPolygon(page, SQUARE)
    await expect.poll(async () => (await tileRegions(jobId, tileId)).length).toBe(1)
  })

  // Area detect: select part of a tile, run an edge detector over it, and get traced
  // lines back as ordinary regions. The e2e stack runs a stub detector (the real one needs
  // OpenCV), so the geometry below is exactly what the stub draws for a given area.
  test('detecting in an outlined area adds the traced lines', async ({ page }) => {
    const jobId = await seedMapJob(uniqueName('Tile detect'), 1, 'map_lines')
    const [tileId] = await tileIds(jobId)
    await openTileEditor(page, jobId, tileId)

    await page.getByTestId('tool-detect').click()
    await expect(page.getByTestId('detect-method')).toHaveValue('centreline')
    await detectInOutline(page, SQUARE)

    await expect.poll(async () => (await tileRegions(jobId, tileId)).length).toBe(1)
    const [region] = await tileRegions(jobId, tileId)
    expect(region.kind).toBe('polyline')
    expect(roundPoints(region.points)).toEqual(roundPoints(stubLineFor(SQUARE)))
    // Machine output, so it is not reviewed — unlike anything drawn by hand.
    expect(region.checked).toBe(false)
    await expect(page.getByTestId('map-region')).toHaveCount(1)
  })

  test('detecting in a dragged box adds the traced lines', async ({ page }) => {
    const jobId = await seedMapJob(uniqueName('Tile detect box'), 1, 'map_lines')
    const [tileId] = await tileIds(jobId)
    await openTileEditor(page, jobId, tileId)

    await page.getByTestId('tool-detect').click()
    await page.getByRole('button', { name: 'Box' }).click()
    await detectInBox(page, [0.2, 0.2], [0.6, 0.6])

    await expect.poll(async () => (await tileRegions(jobId, tileId)).length).toBe(1)
    const [region] = await tileRegions(jobId, tileId)
    // The drag corners become the same ring the outline mode produces, so the stub's
    // line lands in the same place — one selection path, two gestures.
    expect(roundPoints(region.points)).toEqual(roundPoints(stubLineFor(SQUARE)))
  })

  test('one undo removes a whole detection', async ({ page }) => {
    const jobId = await seedMapJob(uniqueName('Tile detect undo'), 1, 'map_lines')
    const [tileId] = await tileIds(jobId)
    await openTileEditor(page, jobId, tileId)

    await drawPolygon(page, [[0.7, 0.7], [0.9, 0.7], [0.9, 0.9]])  // a hand-traced line first
    await expect.poll(async () => (await tileRegions(jobId, tileId)).length).toBe(1)

    await page.getByTestId('tool-detect').click()
    await detectInOutline(page, SQUARE)
    await expect.poll(async () => (await tileRegions(jobId, tileId)).length).toBe(2)

    await page.keyboard.press('Control+z')
    // The detection goes; the hand-traced line stays, so undo took one step, not two.
    await expect.poll(async () => (await tileRegions(jobId, tileId)).length).toBe(1)
    expect((await tileRegions(jobId, tileId))[0].kind).toBe('polyline')
    expect(roundPoints((await tileRegions(jobId, tileId))[0].points)).toEqual(
      [[0.7, 0.7], [0.9, 0.7], [0.9, 0.9]])
  })

  test('detected lines are editable like hand-traced ones', async ({ page }) => {
    const jobId = await seedMapJob(uniqueName('Tile detect edit'), 1, 'map_lines')
    const [tileId] = await tileIds(jobId)
    await openTileEditor(page, jobId, tileId)

    await page.getByTestId('tool-detect').click()
    await detectInOutline(page, SQUARE)
    await expect.poll(async () => (await tileRegions(jobId, tileId)).length).toBe(1)

    // The eraser takes a vertex off it, which only works on a real, selectable region.
    await page.getByRole('button', { name: 'Erase' }).click()
    await eraseStroke(page, stubLineFor(SQUARE)[0])
    await expect.poll(async () => (await tileRegions(jobId, tileId))[0].points.length).toBe(2)
  })

  test('a detector that fails says so without ending the session', async ({ page }) => {
    const jobId = await seedMapJob(uniqueName('Tile detect fails'), 1, 'map_lines')
    const [tileId] = await tileIds(jobId)
    await openTileEditor(page, jobId, tileId)

    // The stack is configured, so the tool is offered; this makes the detector itself fail.
    await page.route('**/regions/detect', (route) =>
      route.fulfill({ status: 502, contentType: 'application/json',
                      json: { detail: 'edge detection failed: no such model' } }))
    await page.getByTestId('tool-detect').click()
    await detectInOutline(page, SQUARE)

    // A failure to report, not a page to replace: the editor stays, and so does the work.
    await expect(page.getByTestId('editor-notice')).toContainText('no such model')
    await expect(page.getByTestId('tile-canvas')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Select', exact: true })).toBeEnabled()
    expect(await tileRegions(jobId, tileId)).toHaveLength(0)
  })

  test('the detect tool is disabled when the server has no detector', async ({ page }) => {
    const jobId = await seedMapJob(uniqueName('Tile detect off'), 1, 'map_lines')
    const [tileId] = await tileIds(jobId)
    await page.route('**/api/edge-methods', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json',
                      json: { configured: false, methods: [] } }))
    await openTileEditor(page, jobId, tileId)

    // Offering a button that can only fail is worse than not offering it.
    await expect(page.getByTestId('tool-detect')).toBeDisabled()
    await page.keyboard.press('t')
    await expect(page.getByTestId('detect-panel')).toHaveCount(0)
    // Everything else about the tile is unaffected.
    await drawPolygon(page, SQUARE)
    await expect.poll(async () => (await tileRegions(jobId, tileId)).length).toBe(1)
  })

  test('a polygon job has no detect tool', async ({ page }) => {
    const jobId = await seedMapJob(uniqueName('Tile detect absent'))
    const [tileId] = await tileIds(jobId)
    await openTileEditor(page, jobId, tileId)
    // Detection produces traced lines, so it belongs to the jobs that annotate them.
    await expect(page.getByTestId('tool-detect')).toHaveCount(0)
  })

  // A traced line covers the ink it traces, so fading it is how the trace gets checked
  // against the scan underneath - the job the fill slider does for polygons.
  test('the lines slider fades the traces without touching the geometry', async ({ page }) => {
    const jobId = await seedMapJob(uniqueName('Tile line opacity'), 1, 'map_lines')
    const [tileId] = await tileIds(jobId)
    await openTileEditor(page, jobId, tileId)

    await drawPolygon(page, [[0.2, 0.3], [0.8, 0.35]])
    await expect.poll(async () => (await tileRegions(jobId, tileId)).length).toBe(1)
    const before = (await tileRegions(jobId, tileId))[0]

    // The drawn stroke is the last path of the pair - the first is the invisible fat twin
    // that carries the pointer events.
    const stroke = page.locator('[data-testid="map-region"] path').last()
    await expect(stroke).toHaveAttribute('stroke-opacity', '1')

    await page.getByTestId('line-opacity').fill('0.3')
    await expect(stroke).toHaveAttribute('stroke-opacity', '0.3')
    await expect(page.getByText('Lines 30%')).toBeVisible()

    // Nothing but the display changed: the trace is still there, unedited.
    await page.getByTestId('line-opacity').fill('0')
    await expect(stroke).toHaveAttribute('stroke-opacity', '0')
    expect((await tileRegions(jobId, tileId))[0].points).toEqual(before.points)
    await expect(page.getByTestId('map-region')).toHaveCount(1)
  })

  test('a polygon job gets the fill slider instead of the lines one', async ({ page }) => {
    const jobId = await seedMapJob(uniqueName('Tile fill slider'))
    const [tileId] = await tileIds(jobId)
    await openTileEditor(page, jobId, tileId)
    // Polylines are stroked and polygons are filled; each job gets the slider that steers
    // what it actually draws.
    await expect(page.getByTestId('line-opacity')).toHaveCount(0)
    await expect(page.getByText(/^Fill \d+%$/)).toBeVisible()
  })

  test('marking a tile reviewed is what the job page counts', async ({ page }) => {
    const jobId = await seedMapJob(uniqueName('Tile reviewed'), 2)
    const [tileId] = await tileIds(jobId)
    await openTileEditor(page, jobId, tileId)

    // click(), not check(): the box is controlled by an async PATCH, so its state
    // only flips once the round-trip lands and check()'s immediate assertion loses.
    const reviewed = page.getByTestId('tile-reviewed')
    await expect(reviewed).not.toBeChecked()
    await reviewed.click()
    await expect(reviewed).toBeChecked()

    // Only this tile counts - the job's second tile stays unreviewed.
    await expect.poll(async () => (await getJob(jobId)).tiles_reviewed).toBe(1)
  })

  // Export preview. The editing stroke is a constant 2.5 screen px whatever the job
  // exports at, so the width that ends up in the mask was previously only visible by
  // exporting one. At zoom 1 a stroke-width of N is exactly N image pixels.
  const TRACE: NormPoint[] = [[0.2, 0.3], [0.8, 0.35]]

  test('a click on the midpoint dot of a selected line inserts a vertex there and keeps it selected', async ({ page }) => {
    const jobId = await seedMapJob(uniqueName('Tile midpoint insert'), 1, 'map_lines')
    const [tileId] = await tileIds(jobId)
    await openTileEditor(page, jobId, tileId)
    await drawPolygon(page, TRACE)
    await expect.poll(async () => (await tileRegions(jobId, tileId)).length).toBe(1)

    await page.getByRole('button', { name: 'Select' }).click()
    await clickTile(page, [0.35, 0.3125])
    await expect(page.getByTestId('midpoint-handle')).toHaveCount(1)
    await clickTile(page, [0.5, 0.325])

    await expect.poll(async () => (await tileRegions(jobId, tileId))[0].points.length).toBe(3)
    const [start, inserted, end] = (await tileRegions(jobId, tileId))[0].points
    expect(roundPoints([start, end])).toEqual(roundPoints([TRACE[0], TRACE[1]]))
    expect(inserted[0]).toBeCloseTo(0.5, 2)
    expect(inserted[1]).toBeCloseTo(0.325, 2)
    await expect(page.getByTestId('vertex-handle')).toHaveCount(3)
    await expect(page.getByTestId('map-region')).toHaveAttribute('data-selected', 'true')
  })

  test('export preview draws traces at the width the mask export will stroke them', async ({ page }) => {
    const jobId = await seedMapJob(uniqueName('Tile export preview'), 1, 'map_lines')
    const [tileId] = await tileIds(jobId)
    await openTileEditor(page, jobId, tileId)

    await drawPolygon(page, TRACE)
    await expect.poll(async () => (await tileRegions(jobId, tileId)).length).toBe(1)

    await page.getByRole('button', { name: 'Select' }).click()
    await clickTile(page, [0.5, 0.325])
    await expect(page.getByTestId('map-region')).toHaveAttribute('data-selected', 'true')
    await expect(page.getByTestId('vertex-handle').first()).toBeVisible()

    // The visible stroke is the last path of the group; the earlier ones are the
    // transparent fat twin and, in preview, the selection halo.
    const stroke = page.locator('[data-testid="map-region"] path').last()
    await expect(stroke).toHaveAttribute('stroke-width', '3.5') // selected editing stroke

    await atLifeSize(page)
    await page.getByTestId('export-preview-toggle').check()
    // The seeded job exports at the backend default of 3.
    await expect(stroke).toHaveAttribute('stroke-width', '3')
    // Square endpoints, like PIL's line() - joint='curve' only rounds the joins.
    await expect(stroke).toHaveAttribute('stroke-linecap', 'butt')
    // Editing carries on at export thickness: the handles are still there to drag.
    await expect(page.getByTestId('vertex-handle').first()).toBeVisible()
    await expect(page.getByTestId('map-region')).toHaveAttribute('data-selected', 'true')

    // The lines slider still fades the preview, which is how the ink underneath is checked.
    await page.getByTestId('line-opacity').fill('0.5')
    await expect(stroke).toHaveAttribute('stroke-opacity', '0.5')

    // Getting the handles out of the way for a clean look at the stroke is the Handles
    // slider's job here, exactly as in normal editing - the preview does not decide it.
    await page.getByTestId('handle-opacity').fill('0')
    await expect(page.getByTestId('vertex-handle').first().locator('xpath=..'))
      .toHaveAttribute('opacity', '0')
    await page.getByTestId('handle-opacity').fill('1')

    await page.getByTestId('export-preview-toggle').uncheck()
    await expect(stroke).toHaveAttribute('stroke-width', '3.5')
    await expect(stroke).toHaveAttribute('stroke-linecap', 'round')
    await expect(page.getByTestId('vertex-handle').first()).toBeVisible()
  })

  test('the width slider previews only, until it is explicitly saved to the job', async ({ page }) => {
    const jobId = await seedMapJob(uniqueName('Tile export width'), 1, 'map_lines')
    const [tileId] = await tileIds(jobId)
    await openTileEditor(page, jobId, tileId)

    await drawPolygon(page, TRACE)
    await expect.poll(async () => (await tileRegions(jobId, tileId)).length).toBe(1)

    const stroke = page.locator('[data-testid="map-region"] path').last()
    await atLifeSize(page)
    await page.getByTestId('export-preview-toggle').check()
    await expect(page.getByTestId('export-width-saved')).toHaveText('saved 3')

    await page.getByTestId('export-width').fill('6')
    await expect(stroke).toHaveAttribute('stroke-width', '6')
    // Trying a width changes nothing the export reads - that takes the button.
    await expect(page.getByTestId('export-width-saved')).toHaveText('saved 3')
    expect((await getJob(jobId)).line_width).toBe(3)

    await page.getByTestId('export-width-save').click()
    await expect.poll(async () => (await getJob(jobId)).line_width).toBe(6)
    // The marker moves without a refetch, and the button retires: nothing left to save.
    await expect(page.getByTestId('export-width-saved')).toHaveText('saved 6')
    await expect(page.getByTestId('export-width-save')).toHaveCount(0)

    // The marker is also the way back to the saved width.
    await page.getByTestId('export-width').fill('9')
    await expect(stroke).toHaveAttribute('stroke-width', '9')
    await page.getByTestId('export-width-saved').click()
    await expect(page.getByTestId('export-width')).toHaveValue('6')
    await expect(page.getByTestId('export-width-save')).toHaveCount(0)
  })

  // The rail's tail is about area and about mask export, and a line job's single class
  // already counts its traces in the list above it.
  test('a line job drops the coverage panel and the export hint', async ({ page }) => {
    // Exact: the job name shows in the breadcrumb, and getByText is a case-insensitive
    // substring match, so a loose 'Coverage' would find the heading in any name too.
    const heading = page.getByText('Coverage', { exact: true })
    const lineJob = await seedMapJob(uniqueName('Tile plain rail'), 1, 'map_lines')
    const [lineTile] = await tileIds(lineJob)
    await openTileEditor(page, lineJob, lineTile)
    await expect(heading).toHaveCount(0)
    await expect(page.getByText('Export masks from the job page.')).toHaveCount(0)

    // A polygon job keeps both - the uncovered-background figure is the point of them.
    const polyJob = await seedMapJob(uniqueName('Tile full rail'))
    const [polyTile] = await tileIds(polyJob)
    await openTileEditor(page, polyJob, polyTile)
    await expect(heading).toBeVisible()
    await expect(page.getByText('Uncovered', { exact: true })).toBeVisible()
    await expect(page.getByText('Export masks from the job page.')).toBeVisible()
  })

  // The list is the only unbounded part of the rail. It used to overflow its box rather
  // than scroll, so past ~20 regions it painted straight over the coverage panel below.
  test('a long region list scrolls instead of covering the panels below it', async ({ page }) => {
    const jobId = await seedMapJob(uniqueName('Tile long list'))
    const [tileId] = await tileIds(jobId)
    const classes = (await jobClasses(jobId)).filter((c) => c.id !== 0)
    for (let i = 0; i < 30; i++) {
      const cx = 0.03 + (i % 6) * 0.15
      const cy = 0.03 + Math.floor(i / 6) * 0.15
      await backendFetch(`/api/pages/${tileId}/regions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          class_id: classes[i % classes.length].id,
          points: [[cx, cy], [cx + 0.1, cy], [cx + 0.1, cy + 0.1], [cx, cy + 0.1]],
          holes: [],
        }),
      })
    }
    await openTileEditor(page, jobId, tileId)
    await expect(page.getByText('Regions (30)')).toBeVisible()

    // The list took the overflow itself - otherwise the assertion below passes vacuously.
    const list = page.getByTestId('region-list')
    expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight + 1)).toBe(true)

    // And it ends above the panels rather than running down over them.
    const listBox = (await list.boundingBox())!
    const coverage = (await page.getByText('Coverage', { exact: true }).boundingBox())!
    const hint = (await page.getByText('Export masks from the job page.').boundingBox())!
    expect(listBox.y + listBox.height).toBeLessThanOrEqual(coverage.y)
    expect(coverage.y).toBeLessThan(hint.y)
    expect(hint.y + hint.height).toBeLessThanOrEqual(page.viewportSize()!.height)
  })

  test('a polygon job has no export preview', async ({ page }) => {
    const jobId = await seedMapJob(uniqueName('Tile no preview'))
    const [tileId] = await tileIds(jobId)
    await openTileEditor(page, jobId, tileId)
    // A filled region has no stroke width to preview; line_width steers nothing here.
    await expect(page.getByTestId('export-preview-toggle')).toHaveCount(0)
  })

  test('a viewer can preview widths but cannot save one', async ({ page }) => {
    const jobId = await seedMapJob(uniqueName('Tile preview viewer'), 1, 'map_lines')
    const [tileId] = await tileIds(jobId)
    await openTileEditor(page, jobId, tileId)
    await drawPolygon(page, TRACE)
    await expect.poll(async () => (await tileRegions(jobId, tileId)).length).toBe(1)

    const username = `viewer-${Date.now()}`
    await useSession(page.context(), seedSession('viewer', username))
    await shareJob(jobId, [username])
    await openTileEditor(page, jobId, tileId)

    // Previewing is reading: a viewer judging a dataset's line width gets the same picture.
    const stroke = page.locator('[data-testid="map-region"] path').last()
    await atLifeSize(page)
    await page.getByTestId('export-preview-toggle').check()
    await page.getByTestId('export-width').fill('6')
    await expect(stroke).toHaveAttribute('stroke-width', '6')
    await expect(page.getByTestId('export-width-save')).toHaveCount(0)
  })

  // Freehand: a held press streams points as it moves, and the release keeps only the
  // ones that bend the outline.
  test('a dragged stroke traces an outline, simplified to its corners on release', async ({ page }) => {
    const jobId = await seedMapJob(uniqueName('Tile freehand'))
    const [tileId] = await tileIds(jobId)
    await openTileEditor(page, jobId, tileId)

    // Three straight legs of the square in one stroke: the sweep puts down a point every
    // few pixels, so anything but four corners means the simplification did not run.
    await strokeTile(page, SQUARE)
    await page.keyboard.press('Enter')

    await expect.poll(async () => (await tileRegions(jobId, tileId)).length).toBe(1)
    const [region] = await tileRegions(jobId, tileId)
    expect(roundPoints(region.points)).toEqual(SQUARE)
  })

  test('a freehand line snaps its end onto the line it reaches', async ({ page }) => {
    const jobId = await seedMapJob(uniqueName('Tile freehand snap'), 1, 'map_lines')
    const [tileId] = await tileIds(jobId)
    await openTileEditor(page, jobId, tileId)

    await drawPolygon(page, LINE_A)
    await expect.poll(async () => (await tileRegions(jobId, tileId)).length).toBe(1)
    const [a] = await tileRegions(jobId, tileId)

    await strokeTile(page, [[0.5, 0.75], [0.5, 0.3 + 6 * PX]])
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await tileRegions(jobId, tileId)).length).toBe(2)
    const b = (await tileRegions(jobId, tileId))[1]
    // A straight sweep simplifies to its two ends, and the end joins the line it reached.
    expect(b.points).toHaveLength(2)
    expect(roundPoints([b.points[0]])).toEqual([[0.5, 0.75]])
    expect(b.points[1][1]).toBeCloseTo(a.points[0][1], 6)
  })

  test('Backspace takes back the last point of a shape in progress', async ({ page }) => {
    const jobId = await seedMapJob(uniqueName('Tile backspace'))
    const [tileId] = await tileIds(jobId)
    await openTileEditor(page, jobId, tileId)

    for (const point of SQUARE) await clickTile(page, point)
    await clickTile(page, [0.4, 0.8])
    await page.keyboard.press('Backspace')
    await page.keyboard.press('Enter')

    await expect.poll(async () => (await tileRegions(jobId, tileId)).length).toBe(1)
    const [region] = await tileRegions(jobId, tileId)
    expect(roundPoints(region.points)).toEqual(SQUARE)
  })

  // Select-tool editing beyond single vertices: redrawing a stretch of an outline,
  // extending a traced line, merging, cutting and moving whole shapes.
  const sorted = (pts: NormPoint[]) =>
    roundPoints(pts).sort((a, b) => a[0] - b[0] || a[1] - b[1])

  test('clicking two dots of a selected outline redraws the stretch between them', async ({ page }) => {
    const jobId = await seedMapJob(uniqueName('Tile redraw'))
    const [tileId] = await tileIds(jobId)
    await openTileEditor(page, jobId, tileId)

    await drawPolygon(page, SQUARE)
    await expect.poll(async () => (await tileRegions(jobId, tileId)).length).toBe(1)
    await page.getByRole('button', { name: 'Select', exact: true }).click()
    await expect(page.getByTestId('vertex-handle')).toHaveCount(4)

    // From the top-right dot, out to a new point, back in at the bottom-right dot: the
    // short side between the two dots is what gets replaced, the other three stay.
    await clickTile(page, SQUARE[1])
    await clickTile(page, [0.8, 0.4])
    await clickTile(page, SQUARE[2])

    await expect.poll(async () => (await tileRegions(jobId, tileId))[0].points.length).toBe(5)
    const [region] = await tileRegions(jobId, tileId)
    expect(roundPoints(region.points)).toEqual([[0.6, 0.6], [0.2, 0.6], [0.2, 0.2], [0.6, 0.2], [0.8, 0.4]])
  })

  test('a traced line grows from an end dot with Enter', async ({ page }) => {
    const jobId = await seedMapJob(uniqueName('Tile extend'), 1, 'map_lines')
    const [tileId] = await tileIds(jobId)
    await openTileEditor(page, jobId, tileId)

    await drawPolygon(page, LINE_A)
    await expect.poll(async () => (await tileRegions(jobId, tileId)).length).toBe(1)
    await page.getByRole('button', { name: 'Select', exact: true }).click()

    await clickTile(page, LINE_A[1])
    await clickTile(page, [0.8, 0.6])
    await page.keyboard.press('Enter')

    await expect.poll(async () => (await tileRegions(jobId, tileId))[0].points.length).toBe(3)
    const [line] = await tileRegions(jobId, tileId)
    expect(roundPoints(line.points)).toEqual([[0.2, 0.3], [0.8, 0.3], [0.8, 0.6]])
  })

  test('a polygon drawn along a neighbour picks up the vertices between two snapped dots', async ({ page }) => {
    const jobId = await seedMapJob(uniqueName('Tile contour'))
    const [tileId] = await tileIds(jobId)
    await openTileEditor(page, jobId, tileId)

    const shape: NormPoint[] = [[0.2, 0.2], [0.6, 0.2], [0.6, 0.6], [0.4, 0.7], [0.2, 0.6]]
    await drawPolygon(page, shape)
    await expect.poll(async () => (await tileRegions(jobId, tileId)).length).toBe(1)
    const [first] = await tileRegions(jobId, tileId)

    // Two clicks on the neighbour's dots, in order: the lower tip between them comes
    // along, so the shared border has no sliver and no gap.
    await drawPolygon(page, [shape[2], shape[4], [0.2, 0.9], [0.6, 0.9]])
    await expect.poll(async () => (await tileRegions(jobId, tileId)).length).toBe(2)
    const second = (await tileRegions(jobId, tileId))[1]
    expect(second.points).toHaveLength(5)
    expect(second.points.slice(0, 3)).toEqual([first.points[2], first.points[3], first.points[4]])
    expect(roundPoints(second.points.slice(3))).toEqual([[0.2, 0.9], [0.6, 0.9]])
  })

  test('shift-click gathers polygons and m merges them into their union', async ({ page }) => {
    const jobId = await seedMapJob(uniqueName('Tile merge'))
    const [tileId] = await tileIds(jobId)
    await openTileEditor(page, jobId, tileId)

    await drawPolygon(page, SQUARE)
    await drawPolygon(page, [[0.5, 0.5], [0.8, 0.5], [0.8, 0.8], [0.5, 0.8]])
    await expect.poll(async () => (await tileRegions(jobId, tileId)).length).toBe(2)
    const [first] = await tileRegions(jobId, tileId)

    await page.getByRole('button', { name: 'Select', exact: true }).click()
    await clickTile(page, SQUARE_CENTRE)
    await page.keyboard.down('Shift')
    await clickTile(page, [0.7, 0.7])
    await page.keyboard.up('Shift')
    await page.keyboard.press('m')

    await expect.poll(async () => (await tileRegions(jobId, tileId)).length).toBe(1)
    const [merged] = await tileRegions(jobId, tileId)
    expect(merged.id).toBe(first.id)
    expect(merged.holes).toEqual([])
    expect(sorted(merged.points)).toEqual(sorted([
      [0.2, 0.2], [0.6, 0.2], [0.6, 0.5], [0.8, 0.5], [0.8, 0.8], [0.5, 0.8], [0.5, 0.6], [0.2, 0.6],
    ]))
  })

  test('s arms the scissors and a click cuts a traced line in two', async ({ page }) => {
    const jobId = await seedMapJob(uniqueName('Tile cut'), 1, 'map_lines')
    const [tileId] = await tileIds(jobId)
    await openTileEditor(page, jobId, tileId)

    await drawPolygon(page, LINE_A)
    await expect.poll(async () => (await tileRegions(jobId, tileId)).length).toBe(1)
    const [line] = await tileRegions(jobId, tileId)
    await page.getByRole('button', { name: 'Select', exact: true }).click()

    // Straight onto the midpoint dot: with the scissors armed it must cut, not insert a vertex.
    await page.keyboard.press('s')
    await clickTile(page, [0.5, 0.3])

    await expect.poll(async () => (await tileRegions(jobId, tileId)).length).toBe(2)
    const halves = await tileRegions(jobId, tileId)
    expect(halves.map((r) => r.kind)).toEqual(['polyline', 'polyline'])
    expect(halves.find((r) => r.id === line.id)).toBeDefined()
    expect(halves.map((r) => roundPoints(r.points))).toEqual([[[0.2, 0.3], [0.5, 0.3]], [[0.5, 0.3], [0.8, 0.3]]])
  })

  test('dragging a selected polygon moves it whole', async ({ page }) => {
    const jobId = await seedMapJob(uniqueName('Tile move'))
    const [tileId] = await tileIds(jobId)
    await openTileEditor(page, jobId, tileId)

    await drawPolygon(page, SQUARE)
    await expect.poll(async () => (await tileRegions(jobId, tileId)).length).toBe(1)
    await page.getByRole('button', { name: 'Select', exact: true }).click()

    await strokeTile(page, [SQUARE_CENTRE, [0.5, 0.5]])

    await expect.poll(async () => roundPoints((await tileRegions(jobId, tileId))[0].points))
      .toEqual(roundPoints(SQUARE.map(([x, y]) => [x + 0.1, y + 0.1])))
    await expect(page.getByTestId('map-region')).toHaveCount(1)
  })
})

test.describe('Scenario: two people on one tile', () => {
  test('a colleague\'s shape appears without reloading', async ({ page }) => {
    const colleague = `tile-live-${Date.now()}`
    seedSession('member', colleague)
    const jobId = await seedMapJob(uniqueName('Tile live'))
    await shareJob(jobId, [colleague])
    const [tileId] = await tileIds(jobId)
    await openTileEditor(page, jobId, tileId)
    await expect(page.getByTestId('map-region')).toHaveCount(0)

    const classes = await jobClasses(jobId)
    const theirs = await backendFetch(`/api/pages/${tileId}/regions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...identity(colleague, 'member') },
      body: JSON.stringify({ class_id: classes.find((c) => c.id !== 0)!.id, points: SQUARE }),
    })

    const shown = page.getByTestId('map-region')
    await expect(shown).toHaveCount(1)
    await expect(shown).toHaveAttribute('data-region-id', String(theirs.id))
    expect(roundPoints((await tileRegions(jobId, tileId))[0].points)).toEqual(SQUARE)
  })
})

test.describe('Scenario: the tile editor when something goes wrong', () => {
  test('detection whose methods could not be loaded says so instead of doing nothing', async ({ page }) => {
    const jobId = await seedMapJob(uniqueName('Detect without methods'), 1, 'map_lines')
    const [tileId] = await tileIds(jobId)
    await page.route('**/api/edge-methods', (route) => route.fulfill({ status: 500, body: 'down' }))
    await openTileEditor(page, jobId, tileId)

    await page.getByTestId('tool-detect').click()
    await detectInOutline(page, SQUARE)
    await expect(page.getByTestId('detect-error')).toBeVisible()
    await expect(page.getByText('Loading methods…')).toHaveCount(0)
    expect(await tileRegions(jobId, tileId)).toEqual([])
  })

  test('an undo that is refused leaves the tile on screen and the region in place', async ({ page }) => {
    const jobId = await seedMapJob(uniqueName('Refused undo'))
    const [tileId] = await tileIds(jobId)
    // This tab hears nothing after loading, so the colleague's edit below stays unseen here.
    await page.route('**/api/pages/*/events**', (route) => route.abort())
    await openTileEditor(page, jobId, tileId)
    await drawPolygon(page, SQUARE)
    await expect.poll(async () => (await tileRegions(jobId, tileId)).length).toBe(1)
    const [region] = await tileRegions(jobId, tileId)

    // Moved by a colleague since it was drawn: the undo of the drawing would discard that.
    await backendFetch(`/api/regions/${region.id}`, {
      method: 'PATCH',
      headers: { ...JSON_HEADERS, ...identity('colleague', 'admin') },
      body: JSON.stringify({ points: OTHER }),
    })
    const refused = page.waitForResponse((r) => r.url().endsWith('/revert'))
    await page.keyboard.press('ControlOrMeta+z')
    expect((await refused).status()).toBe(409)

    await expect(page.getByText('changed by colleague since you loaded it')).toBeVisible()
    await expect(page.getByTestId('tile-canvas')).toBeVisible()
    await expect(page.getByTestId('map-region')).toHaveCount(1)
    expect((await tileRegions(jobId, tileId)).map((r) => r.id)).toEqual([region.id])
  })

  test('switching to Select halfway through a shape drops the shape and leaves the tools working',
    async ({ page }) => {
      const jobId = await seedMapJob(uniqueName('Half a shape'))
      const [tileId] = await tileIds(jobId)
      await openTileEditor(page, jobId, tileId)
      await expect(page.getByTestId('tool-draw')).toHaveAttribute('aria-pressed', 'true')
      await clickTile(page, [0.2, 0.2])
      await clickTile(page, [0.6, 0.2])

      await page.keyboard.press('v')
      await expect(page.getByTestId('tool-select')).toHaveAttribute('aria-pressed', 'true')
      await page.getByTestId('tool-draw').click()
      await expect(page.getByTestId('tool-draw')).toHaveAttribute('aria-pressed', 'true')

      // A fresh shape starts from nothing, not from the two corners left behind.
      await drawPolygon(page, OTHER)
      await expect.poll(async () => (await tileRegions(jobId, tileId)).length).toBe(1)
      expect(roundPoints((await tileRegions(jobId, tileId))[0].points)).toEqual(OTHER)
    })
})
