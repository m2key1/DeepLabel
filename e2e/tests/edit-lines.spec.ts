import { test, expect } from '../helpers/test'
import {
  backendFetch, getPageDetail, identity, jobPageIds, llmStats, pageCandidates, resetLlmStats,
  seedCompletedJob, seedLlmConnection, uniqueName, type Candidate,
} from '../helpers/api'
import { llmReadStatus, startLlmRead } from '../helpers/llm'
import {
  LANDSCAPE, type NormPoint, center, clickAt, dragAt, dragPixels, enterEditMode, hoverAt, openViewer,
  scanRect, scanZoom, toPixels,
} from '../helpers/viewer'

interface Line {
  id: number
  order_idx: number
  polygon: NormPoint[]
  orientation: number
  checked: boolean
  text: string | null
  corrected_text: string | null
}

interface Element {
  id: number
  class_name: string
  kind: string
  lines: Line[]
}

// Angles and right angles only hold in image pixels; normalized page coordinates are
// stretched by the page's aspect ratio, so every expected quad here is computed there.
const ASPECT = LANDSCAPE.width / LANDSCAPE.height

/** `poly` turned by `degrees` (clockwise on screen) about the centre of its bounding box. */
function rotated(poly: NormPoint[], degrees: number): NormPoint[] {
  const xs = poly.map((p) => p[0] * ASPECT)
  const ys = poly.map((p) => p[1])
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2
  const rad = (degrees * Math.PI) / 180
  return poly.map(([x, y]) => {
    const dx = x * ASPECT - cx
    const dy = y - cy
    return [(cx + dx * Math.cos(rad) - dy * Math.sin(rad)) / ASPECT, cy + dx * Math.sin(rad) + dy * Math.cos(rad)]
  })
}

const near = (poly: NormPoint[], digits = 2) =>
  poly.map(([x, y]) => [expect.closeTo(x, digits), expect.closeTo(y, digits)])

async function seedEditor(page: import('@playwright/test').Page) {
  const jobId = await seedCompletedJob(uniqueName('Line editing'), 1, LANDSCAPE)
  const [pageId] = await jobPageIds(jobId)
  await openViewer(page, jobId, pageId)
  await enterEditMode(page)
  return { jobId, pageId }
}

const elements = async (jobId: string, pageId: number): Promise<Element[]> =>
  (await getPageDetail(jobId, pageId)).elements

const paragraphLines = async (jobId: string, pageId: number) =>
  (await elements(jobId, pageId)).find((e) => e.class_name === 'Paragraph')!.lines

const lineById = async (jobId: string, pageId: number, id: number) =>
  (await elements(jobId, pageId)).flatMap((e) => e.lines).find((l) => l.id === id)!

/** The angle at each corner, in image pixels - the only space where a right angle on
 *  screen is a right angle in the numbers. */
function cornerAngles(poly: NormPoint[]): number[] {
  const P = poly.map(([x, y]) => [x * ASPECT, y])
  return P.map((c, i) => {
    const p = P[(i + P.length - 1) % P.length]
    const n = P[(i + 1) % P.length]
    const u = [p[0] - c[0], p[1] - c[1]]
    const v = [n[0] - c[0], n[1] - c[1]]
    const cos = (u[0] * v[0] + u[1] * v[1]) / (Math.hypot(...u) * Math.hypot(...v))
    return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI
  })
}

const setPolygon = (lineId: number, polygon: NormPoint[]) =>
  backendFetch(`/api/lines/${lineId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...identity('dev', 'admin') },
    body: JSON.stringify({ polygon }),
  })

async function selectLine(page: import('@playwright/test').Page, line: Line) {
  await clickAt(page, center(line.polygon))
  await expect(page.getByTestId('line-vertex-handle')).toHaveCount(4)
}

test.describe('Scenario: correcting text lines', () => {
  test('the Line pen draws a level line from a dragged side and a height click, filed as an orphan', async ({ page }) => {
    const { jobId, pageId } = await seedEditor(page)

    await page.getByRole('button', { name: 'Line', exact: true }).click()
    // The side may be dragged in one go instead of clicked twice; the height click
    // above it makes that side the bottom of the line.
    await dragAt(page, [0.03, 0.64], [0.09, 0.64])
    await clickAt(page, [0.06, 0.6])

    await expect
      .poll(async () => (await elements(jobId, pageId)).find((e) => e.kind === 'orphan')?.lines.length)
      .toBe(1)
    const drawn = (await elements(jobId, pageId)).find((e) => e.kind === 'orphan')!.lines[0]
    expect(drawn.polygon).toEqual(near([[0.03, 0.6], [0.09, 0.6], [0.09, 0.64], [0.03, 0.64]]))
  })

  test('three clicks draw a tilted line as a rectangle in reading order', async ({ page }) => {
    const { jobId, pageId } = await seedEditor(page)
    const before = (await paragraphLines(jobId, pageId)).length

    await page.getByRole('button', { name: 'Line', exact: true }).click()
    // In image pixels the side runs from (0.4, 0.98) to (0.8, 0.68), a 3-4-5 slope, and the
    // third click sits 0.1 above it - so every corner is a round number. The first click
    // is on empty canvas; the later two may land on existing lines, which a line in
    // progress must not select.
    await clickAt(page, [0.3, 0.98])
    await clickAt(page, [0.6, 0.68])
    await clickAt(page, [0.375, 0.78])

    await expect.poll(async () => (await paragraphLines(jobId, pageId)).length).toBe(before + 1)
    const drawn = (await paragraphLines(jobId, pageId)).find((l) => l.polygon[3][1] > 0.9)!
    // Top-left, top-right, bottom-right, bottom-left: the order split and merge expect.
    expect(drawn.polygon).toEqual(near([[0.255, 0.9], [0.555, 0.6], [0.6, 0.68], [0.3, 0.98]]))
  })

  test('dragging a corner keeps the opposite corner and the right angles', async ({ page }) => {
    const { jobId, pageId } = await seedEditor(page)
    const line = (await paragraphLines(jobId, pageId))[0]
    await selectLine(page, line)

    const [tl, tr, br, bl] = line.polygon
    await dragAt(page, tl, [tl[0] + 0.06, tl[1] + 0.03])
    await expect.poll(async () => (await lineById(jobId, pageId, line.id)).polygon).toEqual(
      near([
        [tl[0] + 0.06, tl[1] + 0.03],
        [tr[0], tr[1] + 0.03],
        br,
        [bl[0] + 0.06, bl[1]],
      ]),
    )
  })

  test('ctrl-dragging a corner moves only that vertex', async ({ page }) => {
    const { jobId, pageId } = await seedEditor(page)
    const line = (await paragraphLines(jobId, pageId))[0]
    await selectLine(page, line)

    const [tl, ...rest] = line.polygon
    await dragAt(page, tl, [tl[0] + 0.06, tl[1] + 0.03], { ctrl: true })
    await expect.poll(async () => (await lineById(jobId, pageId, line.id)).polygon).toEqual(
      near([[tl[0] + 0.06, tl[1] + 0.03], ...rest]),
    )
  })

  test('Ctrl pressed or released halfway through a corner drag switches between skew and resize', async ({ page }) => {
    const { jobId, pageId } = await seedEditor(page)
    const [first, second] = await paragraphLines(jobId, pageId)

    // Rigid for the first half, Ctrl for the second: the modifier at release decides.
    await selectLine(page, first)
    const [tl, ...rest] = first.polygon
    const start = await toPixels(page, tl)
    const mid = await toPixels(page, [tl[0] + 0.03, tl[1] + 0.015])
    const end = await toPixels(page, [tl[0] + 0.06, tl[1] + 0.03])
    await page.mouse.move(start.x, start.y, { steps: 5 })
    await page.mouse.down()
    await page.mouse.move(mid.x, mid.y, { steps: 6 })
    await page.keyboard.down('Control')
    await page.mouse.move(end.x, end.y, { steps: 6 })
    await page.mouse.up()
    await page.keyboard.up('Control')
    await expect.poll(async () => (await lineById(jobId, pageId, first.id)).polygon)
      .toEqual(near([[tl[0] + 0.06, tl[1] + 0.03], ...rest]))

    // The other way round on a fresh rectangle: Ctrl at first, let go halfway, so the
    // corner ends up resizing with the angles kept.
    await selectLine(page, second)
    const [tl2, tr2, br2, bl2] = second.polygon
    const start2 = await toPixels(page, tl2)
    const mid2 = await toPixels(page, [tl2[0] + 0.03, tl2[1] + 0.015])
    const end2 = await toPixels(page, [tl2[0] + 0.06, tl2[1] + 0.03])
    await page.keyboard.down('Control')
    await page.mouse.move(start2.x, start2.y, { steps: 5 })
    await page.mouse.down()
    await page.mouse.move(mid2.x, mid2.y, { steps: 6 })
    await page.keyboard.up('Control')
    await page.mouse.move(end2.x, end2.y, { steps: 6 })
    await page.mouse.up()
    await expect.poll(async () => (await lineById(jobId, pageId, second.id)).polygon)
      .toEqual(near([[tl2[0] + 0.06, tl2[1] + 0.03], [tr2[0], tr2[1] + 0.03], br2, [bl2[0] + 0.06, bl2[1]]]))
  })

  test('the rotate handle turns the line about its centre, snapping to 5 degrees with Shift', async ({ page }) => {
    const { jobId, pageId } = await seedEditor(page)
    const line = (await paragraphLines(jobId, pageId))[1]
    await selectLine(page, line)

    const handle = page.getByTestId('line-rotate-handle')
    const box = (await handle.boundingBox())!
    const grip = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    const pivot = await toPixels(page, center(line.polygon))
    // The handle starts straight above the centre. Swing it 6 degrees clockwise; Shift
    // rounds the result to the nearest 5, so the line ends up at exactly 5 degrees.
    const radius = Math.hypot(grip.x - pivot.x, grip.y - pivot.y)
    const theta = ((-90 + 6) * Math.PI) / 180
    await dragPixels(page, grip, { x: pivot.x + radius * Math.cos(theta), y: pivot.y + radius * Math.sin(theta) },
      { shift: true })

    await expect.poll(async () => (await lineById(jobId, pageId, line.id)).polygon)
      .toEqual(near(rotated(line.polygon, 5), 3))
  })

  test('turning a crop the right way up is kept without checking the line off',
    async ({ page }) => {
      const jobId = await seedCompletedJob(uniqueName('Crop turned'), 1, LANDSCAPE)
      const [pageId] = await jobPageIds(jobId)
      await openViewer(page, jobId, pageId)
      await page.getByTestId('line-row').first().click()
      // The first row is the first line of the first element, which is the Header's.
      const [line] = (await elements(jobId, pageId)).flatMap((e) => e.lines)
      expect(line.orientation).toBe(0)

      await page.getByTestId('line-rotate-cw').click()

      // The turn decides what the model reads and what the training crop looks like, so
      // it is on record straight away rather than waiting for the line to be checked.
      await expect.poll(async () => (await lineById(jobId, pageId, line.id)).orientation).toBe(90)
      expect((await lineById(jobId, pageId, line.id)).checked).toBe(false)

      // And it is still there on the next visit, which is what it was not before.
      await openViewer(page, jobId, pageId)
      await page.getByTestId('line-row').first().click()
      await page.getByTestId('line-rotate-ccw').click()

      await expect.poll(async () => (await lineById(jobId, pageId, line.id)).orientation).toBe(0)
    })

  test('the rotate keys turn the selected line by one degree', async ({ page }) => {
    const { jobId, pageId } = await seedEditor(page)
    const line = (await paragraphLines(jobId, pageId))[1]
    await selectLine(page, line)

    await page.keyboard.press('.')
    await expect.poll(async () => (await lineById(jobId, pageId, line.id)).polygon)
      .toEqual(near(rotated(line.polygon, 1), 3))

    await page.keyboard.press(',')
    await page.keyboard.press(',')
    await expect.poll(async () => (await lineById(jobId, pageId, line.id)).polygon)
      .toEqual(near(rotated(line.polygon, -1), 3))
  })

  // The test below it drags the edge of a level line, which is the one shape that cannot
  // show this: a normal computed in the page's [0,1] coordinates only points the same way
  // as the normal on screen while the edge is axis-aligned. Turn the line and it does not.
  test('dragging the edge of a turned line grows it without skewing it', async ({ page }) => {
    const { jobId, pageId } = await seedEditor(page)
    const flat = (await paragraphLines(jobId, pageId))[0]
    const turned = rotated(flat.polygon, 20)
    await setPolygon(flat.id, turned)
    expect(cornerAngles(turned).map(Math.round)).toEqual([90, 90, 90, 90])

    await page.reload()
    await enterEditMode(page)
    const line = await lineById(jobId, pageId, flat.id)
    await selectLine(page, line)

    // Straight out from the bottom edge, as somebody growing the box downwards would.
    const [, , br, bl] = line.polygon
    const mid: NormPoint = [(br[0] + bl[0]) / 2, (br[1] + bl[1]) / 2]
    const out = Math.hypot((br[0] - bl[0]) * ASPECT, br[1] - bl[1])
    const push: NormPoint = [
      mid[0] - ((br[1] - bl[1]) / out) * 0.06 / ASPECT,
      mid[1] + ((br[0] - bl[0]) * ASPECT / out) * 0.06,
    ]
    await dragAt(page, mid, push)

    // Wait for the drag to land before judging it. Polling straight for right angles would
    // pass on the untouched line, which already has four of them - and prove nothing.
    const before = JSON.stringify(line.polygon)
    await expect.poll(async () =>
      JSON.stringify((await lineById(jobId, pageId, flat.id)).polygon)).not.toBe(before)

    // It grew, and it is still a rectangle. It used to come back a parallelogram.
    const grown = (await lineById(jobId, pageId, flat.id)).polygon
    expect(cornerAngles(grown).map((a) => Math.round(a))).toEqual([90, 90, 90, 90])
  })

  test('dragging an edge grows the line without skewing it', async ({ page }) => {
    const { jobId, pageId } = await seedEditor(page)
    const line = (await paragraphLines(jobId, pageId))[0]
    await selectLine(page, line)
    await expect(page.getByTestId('line-edge-handle')).toHaveCount(4)

    const [tl, tr, br, bl] = line.polygon
    const mid: NormPoint = [(br[0] + bl[0]) / 2, (br[1] + bl[1]) / 2]
    // The sideways part of the drag must be ignored: the edge moves along its normal.
    await dragAt(page, mid, [mid[0] + 0.05, mid[1] + 0.04])

    await expect
      .poll(async () => (await paragraphLines(jobId, pageId)).find((l) => l.id === line.id)!.polygon)
      .toEqual(near([tl, tr, [br[0], br[1] + 0.04], [bl[0], bl[1] + 0.04]]))

    // Ctrl-drag translates the edge freely: the full delta applies on both axes.
    const moved = (await paragraphLines(jobId, pageId)).find((l) => l.id === line.id)!.polygon
    const [, , br2, bl2] = moved
    const mid2: NormPoint = [(br2[0] + bl2[0]) / 2, (br2[1] + bl2[1]) / 2]
    await dragAt(page, mid2, [mid2[0] + 0.05, mid2[1] + 0.03], { ctrl: true })
    await expect
      .poll(async () => (await paragraphLines(jobId, pageId)).find((l) => l.id === line.id)!.polygon)
      .toEqual(near([moved[0], moved[1], [br2[0] + 0.05, br2[1] + 0.03], [bl2[0] + 0.05, bl2[1] + 0.03]]))
  })

  test('s arms the scissors and a click cuts straight across the line there', async ({ page }) => {
    const { jobId, pageId } = await seedEditor(page)
    const line = (await paragraphLines(jobId, pageId))[1]
    await selectLine(page, line)

    const [tl, tr, br, bl] = line.polygon
    const at = center(line.polygon)
    await page.keyboard.press('s')
    await clickAt(page, at)
    await expect.poll(async () => (await paragraphLines(jobId, pageId)).length).toBe(4)
    // The original id keeps the left half, cut exactly at the click.
    expect((await lineById(jobId, pageId, line.id)).polygon).toEqual(near([tl, [at[0], tr[1]], [at[0], br[1]], bl]))
  })

  test('a stroke drawn across a tilted line cuts it along the stroke', async ({ page }) => {
    const { jobId, pageId } = await seedEditor(page)
    await page.getByRole('button', { name: 'Line', exact: true }).click()
    await clickAt(page, [0.3, 0.98])
    await clickAt(page, [0.6, 0.68])
    await clickAt(page, [0.375, 0.78])
    await expect.poll(async () => (await paragraphLines(jobId, pageId)).length).toBe(4)
    const drawn = (await paragraphLines(jobId, pageId)).find((l) => l.polygon[3][1] > 0.9)!

    // The pen leaves the new line selected. A stroke straight down at x = 0.33 crosses
    // its top side a quarter of the way along and its bottom side a tenth along.
    await page.keyboard.press('s')
    await dragAt(page, [0.33, 0.7], [0.33, 0.99])

    await expect.poll(async () => (await paragraphLines(jobId, pageId)).length).toBe(5)
    const halves = (await paragraphLines(jobId, pageId))
      .filter((l) => l.polygon[3][1] > 0.9)
      .sort((a, b) => a.polygon[0][0] - b.polygon[0][0])
    expect(halves.map((l) => l.id)).toContain(drawn.id)
    expect(halves[0].polygon).toEqual(near([[0.255, 0.9], [0.33, 0.825], [0.33, 0.95], [0.3, 0.98]]))
    expect(halves[1].polygon).toEqual(near([[0.33, 0.825], [0.555, 0.6], [0.6, 0.68], [0.33, 0.95]]))
  })

  test('shift-click collects lines and m merges them', async ({ page }) => {
    const { jobId, pageId } = await seedEditor(page)
    const [first, second] = await paragraphLines(jobId, pageId)

    await selectLine(page, first)
    await clickAt(page, center(second.polygon), { shift: true })

    await page.keyboard.press('m')
    await expect.poll(async () => (await paragraphLines(jobId, pageId)).length).toBe(2)
    const merged = (await paragraphLines(jobId, pageId)).find((l) => l.id === first.id)!
    const ys = merged.polygon.map((p) => p[1])
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(0.25)
  })

  test('undo takes a merge back with what both lines read, and redo merges them again', async ({ page }) => {
    const { jobId, pageId } = await seedEditor(page)
    const [first, second, third] = await paragraphLines(jobId, pageId)
    expect([first.text, second.text]).toEqual(['Sample Paragraph line 1', 'Sample Paragraph line 2'])

    await selectLine(page, first)
    await clickAt(page, center(second.polygon), { shift: true })
    await page.keyboard.press('m')
    await expect.poll(async () => (await paragraphLines(jobId, pageId)).length).toBe(2)
    // A merge wipes what was read: the survivor has to be read again.
    expect((await paragraphLines(jobId, pageId)).find((l) => l.id === first.id)!.text).toBeNull()
    // The survivor stays selected and is drawn as the selection, not as a line-poly, so
    // the overlay shows one fewer than the page holds: five lines, four polys.
    await expect(page.getByTestId('line-poly')).toHaveCount(4)

    await page.keyboard.press('ControlOrMeta+z')
    await expect.poll(async () => (await paragraphLines(jobId, pageId)).length).toBe(3)
    // The same two lines, with their polygons and their text - not two new lines.
    const back = await paragraphLines(jobId, pageId)
    expect(back.map((l) => [l.id, l.text, l.order_idx])).toEqual([
      [first.id, 'Sample Paragraph line 1', 0],
      [second.id, 'Sample Paragraph line 2', 1],
      [third.id, 'Sample Paragraph line 3', 2],
    ])
    expect(back[0].polygon).toEqual(first.polygon)
    expect(back[1].polygon).toEqual(second.polygon)
    await expect(page.getByTestId('line-poly')).toHaveCount(5)

    await page.keyboard.press('ControlOrMeta+Shift+z')
    await expect.poll(async () => (await paragraphLines(jobId, pageId)).length).toBe(2)
    expect((await paragraphLines(jobId, pageId)).map((l) => l.id)).toEqual([first.id, third.id])
    await expect(page.getByTestId('line-poly')).toHaveCount(4)
  })
})

test.describe('Scenario: rubbing lines out with the eraser', () => {
  /** Put the brush on an exact size, so a sweep takes the corners it is aimed at. */
  async function eraserAt(page: import('@playwright/test').Page, radiusPx: number) {
    await page.getByTestId('tool-erase').click()
    const radius = page.getByTestId('brush-radius')
    await radius.fill(String(radiusPx))
    await radius.blur()
  }

  test('a sweep takes the corners under it, and the line once too few are left', async ({ page }) => {
    const { jobId, pageId } = await seedEditor(page)
    const [line, neighbour] = await paragraphLines(jobId, pageId)
    expect(line.polygon).toHaveLength(4)
    await eraserAt(page, 4)

    // A short sweep ending on one corner, with the next one far enough off to be spared.
    const [cx, cy] = line.polygon[0]
    await dragAt(page, [cx - 0.02, cy - 0.01], [cx, cy])
    await expect
      .poll(async () => (await lineById(jobId, pageId, line.id)).polygon.length)
      .toBe(3)
    await expect(page.getByTestId('editor-notice')).toHaveText('1 reshaped')

    // One more corner is one too few for an area, so the line goes with it.
    const after = await lineById(jobId, pageId, line.id)
    const [nx, ny] = after.polygon[1]
    await dragAt(page, [nx - 0.02, ny - 0.01], [nx, ny])
    await expect
      .poll(async () => (await elements(jobId, pageId)).flatMap((e) => e.lines).map((l) => l.id))
      .not.toContain(line.id)
    // Its neighbour, which the brush never reached, is untouched.
    expect((await lineById(jobId, pageId, neighbour.id)).polygon).toEqual(neighbour.polygon)
    await expect(page.getByTestId('editor-notice')).toHaveText('1 line erased')
  })

  test('the eraser has a key, and the hand says how it is held', async ({ page }) => {
    await seedEditor(page)
    const eraser = page.getByTestId('tool-erase')
    await expect(eraser).toHaveAttribute('aria-pressed', 'false')

    await page.keyboard.press('Shift+E')
    await expect(eraser).toHaveAttribute('aria-pressed', 'true')
    await expect(eraser).toHaveAttribute('title', 'Erase (Shift+E)')

    // The hand has no key of its own until one is bound; it is the held Space or Alt.
    await expect(page.getByTestId('tool-hand')).toHaveAttribute('title', 'Hand (hold Space or Alt)')
  })

  test('holding Alt with the eraser in hand puts the brush away until it is let go', async ({ page }) => {
    await seedEditor(page)
    await page.getByTestId('tool-erase').click()
    const pane = (await page.getByTestId('overlay-pane').boundingBox())!
    await page.mouse.move(pane.x + pane.width * 0.5, pane.y + pane.height * 0.5)
    const brush = page.getByTestId('erase-brush')
    await expect(brush).toHaveCount(1)

    await page.keyboard.down('Alt')
    await expect(page.getByTestId('tool-hand')).toHaveAttribute('aria-pressed', 'true')
    await expect(brush).toHaveCount(0)

    await page.keyboard.up('Alt')
    await expect(page.getByTestId('tool-erase')).toHaveAttribute('aria-pressed', 'true')
    await expect(brush).toHaveCount(1)
  })

  test('picking the eraser shows the corners of every line it would take', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Erase corners'), 1, LANDSCAPE)
    const [pageId] = await jobPageIds(jobId)
    const finished = (await elements(jobId, pageId)).find((e) => e.class_name === 'Paragraph')!.lines[0]
    await backendFetch(`/api/lines/${finished.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...identity('dev', 'admin') },
      body: JSON.stringify({ checked: true }),
    })
    const lines = (await elements(jobId, pageId)).flatMap((e) => e.lines)
    const open = lines.filter((l) => !l.checked && l.corrected_text === null)
    expect(open.length).toBe(lines.length - 1)
    await openViewer(page, jobId, pageId)
    await enterEditMode(page)

    const corners = page.getByTestId('line-erase-corners')
    await expect(corners).toHaveCount(0)
    await page.getByTestId('tool-erase').click()

    // Every line a plain sweep would take, each with exactly its own corners...
    await expect(corners).toHaveCount(open.length)
    const shown = await corners.evaluateAll((els) =>
      els.map((el) => [Number(el.getAttribute('data-id')), Number(el.getAttribute('data-corners'))]))
    expect(shown.sort((a, b) => a[0] - b[0]))
      .toEqual(open.map((l) => [l.id, l.polygon.length]).sort((a, b) => a[0] - b[0]))
    // ...and none on the one somebody has finished.
    await expect(page.locator(`[data-testid="line-erase-corners"][data-id="${finished.id}"]`)).toHaveCount(0)

    await page.getByTestId('tool-select').click()
    await expect(corners).toHaveCount(0)
  })

  test('a line somebody has read is stepped over, and Shift takes it too', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Erase checked'), 1, LANDSCAPE)
    const [pageId] = await jobPageIds(jobId)
    const before = (await elements(jobId, pageId)).find((e) => e.class_name === 'Paragraph')!.lines[0]
    await backendFetch(`/api/lines/${before.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...identity('dev', 'admin') },
      body: JSON.stringify({ checked: true }),
    })
    await openViewer(page, jobId, pageId)
    await enterEditMode(page)
    await eraserAt(page, 40)

    // Straight across the whole line: every corner is under the brush.
    const sweep = (opts: { shift?: boolean } = {}) =>
      dragAt(page, [before.polygon[0][0] - 0.02, center(before.polygon)[1]],
             [before.polygon[1][0] + 0.02, center(before.polygon)[1]], opts)

    await sweep()
    await expect(page.getByTestId('editor-notice'))
      .toHaveText('1 checked line left alone - Shift takes those too')
    expect((await lineById(jobId, pageId, before.id)).polygon).toEqual(before.polygon)

    await sweep({ shift: true })
    await expect
      .poll(async () => (await elements(jobId, pageId)).flatMap((e) => e.lines).map((l) => l.id))
      .not.toContain(before.id)
    // The sweep reached more than the checked one, so the count is the whole of it.
    await expect(page.getByTestId('editor-notice')).toContainText('erased')
  })
})

test.describe('Scenario: a line that is not a straight box', () => {
  const angleOf = (poly: NormPoint[]) => {
    const [a, b] = [poly[0], poly[1]]
    return (Math.atan2(b[1] - a[1], (b[0] - a[0]) * ASPECT) * 180) / Math.PI
  }

  test('a line is turned into a polygon and back into the box that holds it', async ({ page }) => {
    const { jobId, pageId } = await seedEditor(page)
    const line = (await paragraphLines(jobId, pageId))[0]
    const tilted = rotated(line.polygon, 8)
    await setPolygon(line.id, tilted)
    await page.reload()
    await enterEditMode(page)
    await selectLine(page, { ...line, polygon: tilted })

    await expect(page.getByTestId('line-shape-box')).toHaveAttribute('aria-pressed', 'true')
    await page.getByTestId('line-shape-polygon').click()

    // The two long sides gain a midpoint each, and the shape itself does not move.
    await expect.poll(async () => (await lineById(jobId, pageId, line.id)).polygon.length).toBe(6)
    await expect(page.getByTestId('line-vertex-handle')).toHaveCount(6)
    const six = (await lineById(jobId, pageId, line.id)).polygon
    expect([six[0], six[2], six[3], six[5]]).toEqual(near(tilted))

    // Pull the new midpoint off the line, then square it back up.
    const [mx, my] = six[1]
    await dragAt(page, [mx, my], [mx, my - 0.05])
    await expect.poll(async () => (await lineById(jobId, pageId, line.id)).polygon[1][1])
      .toBeLessThan(my - 0.03)

    await page.getByTestId('line-shape-box').click()
    await expect.poll(async () => (await lineById(jobId, pageId, line.id)).polygon.length).toBe(4)
    const boxed = (await lineById(jobId, pageId, line.id)).polygon
    expect(cornerAngles(boxed).map(Math.round)).toEqual([90, 90, 90, 90])
    expect(angleOf(boxed)).toBeCloseTo(8, 0)
    // It is the box that holds the bump, so it is taller than the line it started as.
    const height = (poly: NormPoint[]) => Math.max(...poly.map((p) => p[1])) - Math.min(...poly.map((p) => p[1]))
    expect(height(boxed)).toBeGreaterThan(height(tilted))
  })

  test('a corner is added on a side of a polygon and taken off again', async ({ page }) => {
    const { jobId, pageId } = await seedEditor(page)
    const line = (await paragraphLines(jobId, pageId))[0]
    await selectLine(page, line)

    // A four-corner line keeps its four: its side handles are the grow control, and a
    // click on one is not a request for a fifth corner. (The click itself steps out to
    // what the line sits in, as clicking a selected thing again does everywhere.)
    await expect(page.getByTestId('line-edge-handle')).toHaveCount(4)
    await page.getByTestId('line-edge-handle').first().click()
    expect((await lineById(jobId, pageId, line.id)).polygon).toHaveLength(4)

    await selectLine(page, line)
    await page.getByTestId('line-shape-polygon').click()
    await expect(page.getByTestId('line-vertex-handle')).toHaveCount(6)
    await expect.poll(async () => (await lineById(jobId, pageId, line.id)).polygon.length).toBe(6)
    const six = (await lineById(jobId, pageId, line.id)).polygon

    await page.getByTestId('line-edge-handle').first().click()
    await expect.poll(async () => (await lineById(jobId, pageId, line.id)).polygon.length).toBe(7)
    await expect(page.getByTestId('line-vertex-handle')).toHaveCount(7)
    // It sits where the side was, so the shape is unchanged until it is dragged.
    const seven = (await lineById(jobId, pageId, line.id)).polygon
    expect(seven[1]).toEqual(near([[(six[0][0] + six[1][0]) / 2, (six[0][1] + six[1][1]) / 2]])[0])

    await page.getByTestId('line-vertex-handle').nth(1).click({ button: 'right' })
    await expect.poll(async () => (await lineById(jobId, pageId, line.id)).polygon.length).toBe(6)
    expect((await lineById(jobId, pageId, line.id)).polygon).toEqual(near(six))
  })

  test('the loupe shows the line as it is now, not as it was before the edge was moved',
    async ({ page }) => {
      const { jobId, pageId } = await seedEditor(page)
      const line = (await paragraphLines(jobId, pageId))[0]
      await selectLine(page, line)

      const crop = page.getByTestId('line-loupe').locator('img')
      await expect(crop).toBeVisible()
      const wide = async () => crop.evaluate((img: HTMLImageElement) => img.naturalWidth)
      await expect.poll(wide).toBeGreaterThan(0)
      const before = await wide()

      // Pull the left-hand side further left: the crop that answers has to be wider.
      const side = page.getByTestId('line-edge-handle').nth(3)
      const box = (await side.boundingBox())!
      await dragPixels(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 },
                             { x: box.x + box.width / 2 - 60, y: box.y + box.height / 2 })
      await expect
        .poll(async () => (await lineById(jobId, pageId, line.id)).polygon[0][0])
        .toBeLessThan(line.polygon[0][0] - 0.03)

      await expect.poll(wide).toBeGreaterThan(before)
    })

  // A line very often has to start inside the one above it - a descender or a flourish
  // reaches down over where the next line begins - so the pen draws wherever it is put
  // down, a click as much as a drag, and never picks the line that is already there.
  test('the Line pen draws straight through a line that is already there', async ({ page }) => {
    const { jobId, pageId } = await seedEditor(page)
    const sitting = (await paragraphLines(jobId, pageId))[0]
    const inside = center(sitting.polygon)
    const allLines = async () => (await elements(jobId, pageId)).flatMap((e) => e.lines)
    const before = new Set((await allLines()).map((l) => l.id))
    const drawnSince = async () => (await paragraphLines(jobId, pageId)).filter((l) => !before.has(l.id))
    await page.getByRole('button', { name: 'Line', exact: true }).click()

    // Three clicks, the first on top of the line already there: start, end, height.
    await clickAt(page, inside)
    await expect(page.getByTestId('line-vertex-handle')).toHaveCount(0)
    await clickAt(page, [inside[0] + 0.12, inside[1]])
    await expect(page.getByTestId('line-draft')).toBeAttached()
    await clickAt(page, [inside[0] + 0.12, inside[1] + 0.05])
    await expect.poll(async () => (await allLines()).length).toBe(before.size + 1)
    // It belongs to the paragraph it was drawn inside, like any line drawn within a box.
    expect((await drawnSince()).map((l) => l.polygon)).toEqual([near([
      [inside[0], inside[1]],
      [inside[0] + 0.12, inside[1]],
      [inside[0] + 0.12, inside[1] + 0.05],
      [inside[0], inside[1] + 0.05],
    ])])
    await expect(page.getByTestId('line-vertex-handle')).toHaveCount(4)

    // From inside the line just drawn, and still selected, a drag lays the next side down.
    const start: [number, number] = [inside[0] + 0.02, inside[1] + 0.02]
    await dragAt(page, start, [start[0] + 0.1, start[1]])
    await clickAt(page, [start[0] + 0.1, start[1] + 0.04])
    await expect.poll(async () => (await allLines()).length).toBe(before.size + 2)
    const second = (await drawnSince()).find((l) => Math.abs(l.polygon[0][0] - start[0]) < 0.005)!
    expect(second.polygon).toEqual(near([
      [start[0], start[1]],
      [start[0] + 0.1, start[1]],
      [start[0] + 0.1, start[1] + 0.04],
      [start[0], start[1] + 0.04],
    ]))
  })

  test('the Line pen lays down a polygon, closed by clicking its first corner', async ({ page }) => {
    const { jobId, pageId } = await seedEditor(page)

    await page.getByRole('button', { name: 'Line', exact: true }).click()
    await page.getByTestId('line-pen-polygon').click()

    // Clear of every seeded box, so the first click starts a line rather than picking one.
    const corners: NormPoint[] = [[0.03, 0.3], [0.09, 0.29], [0.09, 0.37], [0.03, 0.38]]
    for (const corner of corners) await clickAt(page, corner)

    // With three corners down the first one is the way out, and says so under the cursor.
    const closer = page.locator('[data-testid="line-poly-close"]')
    await expect(closer).toHaveCount(1)
    await hoverAt(page, corners[0])
    await expect(closer).toHaveAttribute('data-armed', 'true')
    await clickAt(page, corners[0])

    await expect
      .poll(async () => (await elements(jobId, pageId)).find((e) => e.kind === 'orphan')?.lines.length)
      .toBe(1)
    const drawn = (await elements(jobId, pageId)).find((e) => e.kind === 'orphan')!.lines[0]
    expect(drawn.polygon).toEqual(near(corners))
    // The pen is done with it: nothing half-drawn is left behind.
    await expect(closer).toHaveCount(0)
  })

  test('the polygon pen dots every corner as it is clicked', async ({ page }) => {
    const { jobId, pageId } = await seedEditor(page)
    await page.getByRole('button', { name: 'Line', exact: true }).click()
    await page.getByTestId('line-pen-polygon').click()

    const corners: NormPoint[] = [[0.03, 0.3], [0.09, 0.29], [0.09, 0.37]]
    const dots = page.getByTestId('line-poly-corner')
    await expect(dots).toHaveCount(0)
    for (const [i, corner] of corners.entries()) {
      await clickAt(page, corner)
      await expect(dots).toHaveCount(i + 1)
    }

    // They go when the line does, rather than being left behind on the scan.
    await page.keyboard.press('Escape')
    await expect(dots).toHaveCount(0)
  })

  test('the polygon pen traces a line freehand while the button is held', async ({ page }) => {
    const { jobId, pageId } = await seedEditor(page)
    const before = (await elements(jobId, pageId)).flatMap((e) => e.lines).length
    await page.getByRole('button', { name: 'Line', exact: true }).click()
    await page.getByTestId('line-pen-polygon').click()

    // A stroke down the empty left margin, bending as it goes, in one press.
    const stroke: NormPoint[] = [[0.03, 0.3], [0.05, 0.33], [0.04, 0.37], [0.06, 0.4], [0.03, 0.42]]
    const points = []
    for (const at of stroke) points.push(await toPixels(page, at))
    await page.mouse.move(points[0].x, points[0].y)
    await page.mouse.down()
    for (const p of points.slice(1)) await page.mouse.move(p.x, p.y, { steps: 8 })
    await page.mouse.up()

    // The stroke is a run of corners, not the two ends of a straight line - and not one
    // per pixel the hand travelled either.
    const drawn = page.getByTestId('line-poly-draft')
    await expect(drawn).toBeVisible()
    // Drawn in the Line pen's own colour, as a layout box being drawn is in its class's.
    const lineSwatch = await page.locator('[data-testid="pen-row"][data-class="Line"]')
      .getByTestId('pen-swatch').evaluate((el) => getComputedStyle(el).backgroundColor)
    expect(lineSwatch).toMatch(/^rgb\(/)
    expect(await drawn.evaluate((el) => getComputedStyle(el).stroke)).toBe(lineSwatch)
    const traced = (await drawn.getAttribute('points'))!.trim().split(/\s+/).length
    expect(traced).toBeGreaterThan(2)
    expect(traced).toBeLessThan(40)

    // Closing it on the first corner commits the line it traced.
    await clickAt(page, stroke[0])
    await expect
      .poll(async () => (await elements(jobId, pageId)).flatMap((e) => e.lines).length)
      .toBe(before + 1)
  })

  test('a freehand stroke that comes back to where it began closes there', async ({ page }) => {
    const { jobId, pageId } = await seedEditor(page)
    const before = (await elements(jobId, pageId)).flatMap((e) => e.lines).length
    await page.getByRole('button', { name: 'Line', exact: true }).click()
    await page.getByTestId('line-pen-polygon').click()

    // One press, round the empty left margin and back onto the corner it started at.
    const loop: NormPoint[] = [[0.03, 0.3], [0.08, 0.32], [0.08, 0.4], [0.03, 0.42], [0.03, 0.3]]
    const points = []
    for (const at of loop) points.push(await toPixels(page, at))
    await page.mouse.move(points[0].x, points[0].y)
    await page.mouse.down()
    for (const p of points.slice(1)) await page.mouse.move(p.x, p.y, { steps: 8 })
    // The first corner says it is the way out before the button comes up.
    await expect(page.getByTestId('line-poly-close')).toHaveAttribute('data-armed', 'true')
    await page.mouse.up()

    // Letting go there is the close: the line is drawn, with nothing left in hand.
    await expect
      .poll(async () => (await elements(jobId, pageId)).flatMap((e) => e.lines).length)
      .toBe(before + 1)
    await expect(page.getByTestId('line-poly-close')).toHaveCount(0)
    await expect(page.getByTestId('line-poly-corner')).toHaveCount(0)
  })

  test('a corner is taken back, and the whole line abandoned, without drawing one',
    async ({ page }) => {
      const { jobId, pageId } = await seedEditor(page)
      const before = (await elements(jobId, pageId)).flatMap((e) => e.lines).length

      await page.getByRole('button', { name: 'Line', exact: true }).click()
      await page.getByTestId('line-pen-polygon').click()
      for (const corner of [[0.03, 0.3], [0.09, 0.29], [0.09, 0.37]] as NormPoint[]) {
        await clickAt(page, corner)
      }

      // Three corners could close; two cannot, so the first corner stops offering to.
      await hoverAt(page, [0.03, 0.3])
      const closer = page.locator('[data-testid="line-poly-close"]')
      await expect(closer).toHaveAttribute('data-armed', 'true')
      await page.keyboard.press('Backspace')
      await hoverAt(page, [0.03, 0.3])
      await expect(closer).not.toHaveAttribute('data-armed', 'true')

      await page.keyboard.press('Escape')
      await expect(closer).toHaveCount(0)
      await expect
        .poll(async () => (await elements(jobId, pageId)).flatMap((e) => e.lines).length)
        .toBe(before)
    })

  test('the hand moves the page under you, where the pen would have drawn on it',
    async ({ page }) => {
      const { jobId, pageId } = await seedEditor(page)
      const before = (await elements(jobId, pageId)).length

      // Zoom well in first: at the pane's width there is nowhere to pan to, and a drag
      // that runs out of room would prove nothing about how far it moved the page.
      const pane = page.getByTestId('overlay-pane')
      const box = (await pane.boundingBox())!
      const middle = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
      await page.mouse.move(middle.x, middle.y)
      await page.keyboard.down('Control')
      for (let i = 0; i < 6; i++) await page.mouse.wheel(0, -600)
      await page.keyboard.up('Control')
      await expect.poll(() => scanZoom(page)).toBeGreaterThan(2)

      await page.getByTestId('tool-hand').click()
      await expect(page.getByTestId('tool-hand')).toHaveAttribute('aria-pressed', 'true')
      const held = await scanRect(page)
      await dragPixels(page, middle, { x: middle.x - 150, y: middle.y })
      // The page follows the hand exactly: 150 pixels of drag, 150 pixels of scan.
      await expect.poll(async () => Math.round((await scanRect(page)).left - held.left)).toBe(-150)
      // And nothing else happens: no box drawn, nothing picked up.
      expect((await elements(jobId, pageId)).length).toBe(before)
      await expect(page.getByTestId('element-handle')).toHaveCount(0)

      // Escape puts it down, and the same drag stops moving the page.
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('tool-hand')).toHaveAttribute('aria-pressed', 'false')
      await page.getByTestId('tool-select').click()
      const down = await scanRect(page)
      await dragPixels(page, middle, { x: middle.x - 150, y: middle.y })
      expect(Math.round((await scanRect(page)).left - down.left)).toBe(0)
    })

  test('Alt is the hand for as long as it is held, and gives the tool back after',
    async ({ page }) => {
      const { jobId, pageId } = await seedEditor(page)
      const before = (await elements(jobId, pageId)).length

      // The pen is up and drawing, which is what Alt has to interrupt and hand back.
      await page.locator('[data-testid="pen-pill"][data-class="Paragraph"]').click()
      await dragAt(page, [0.03, 0.3], [0.08, 0.55])
      await expect.poll(async () => (await elements(jobId, pageId)).length).toBe(before + 1)

      // Zoom well in: at the pane's width there is nowhere to pan to, and a drag that
      // runs out of room would prove nothing about how far it moved the page.
      const pane = page.getByTestId('overlay-pane')
      const box = (await pane.boundingBox())!
      const middle = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
      await page.mouse.move(middle.x, middle.y)
      await page.keyboard.down('Control')
      for (let i = 0; i < 6; i++) await page.mouse.wheel(0, -600)
      await page.keyboard.up('Control')
      await expect.poll(() => scanZoom(page)).toBeGreaterThan(2)

      // Held, the palette says the hand is up - the pen is still the tool underneath.
      await page.keyboard.down('Alt')
      await expect(page.getByTestId('tool-hand')).toHaveAttribute('aria-pressed', 'true')
      await expect(page.getByTestId('tool-draw')).toHaveAttribute('aria-pressed', 'false')

      // The page follows the hand exactly, and the pen draws nothing while it does.
      const held = await scanRect(page)
      await dragPixels(page, middle, { x: middle.x - 150, y: middle.y })
      await expect.poll(async () => Math.round((await scanRect(page)).left - held.left)).toBe(-150)
      expect((await elements(jobId, pageId)).length).toBe(before + 1)

      // Let go and the hand goes with it, without any tool having been chosen again.
      await page.keyboard.up('Alt')
      await expect(page.getByTestId('tool-draw')).toHaveAttribute('aria-pressed', 'true')
      await expect(page.getByTestId('tool-hand')).toHaveAttribute('aria-pressed', 'false')
      const down = await scanRect(page)
      await dragPixels(page, middle, { x: middle.x - 150, y: middle.y })
      expect(Math.round((await scanRect(page)).left - down.left)).toBe(0)
    })

  test('the Line pen draws inside the box that is selected, instead of moving it', async ({ page }) => {
    const { jobId, pageId } = await seedEditor(page)
    const before = (await paragraphLines(jobId, pageId)).length
    const para = (await elements(jobId, pageId)).find((e) => e.class_name === 'Paragraph')!

    // Select the paragraph itself: a click in the gap between its lines, then step out.
    await clickAt(page, [0.5, 0.42])
    await expect(page.getByTestId('element-handle')).toHaveCount(8)
    const box = await getPageDetail(jobId, pageId)
      .then((d) => d.elements.find((e: Element & { bbox: number[] }) => e.id === para.id)!.bbox)

    await page.getByRole('button', { name: 'Line', exact: true }).click()
    const inside: NormPoint = [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2]
    await dragAt(page, [inside[0] - 0.05, 0.42], [inside[0] + 0.05, 0.42])
    await clickAt(page, [inside[0], 0.39])

    await expect.poll(async () => (await paragraphLines(jobId, pageId)).length).toBe(before + 1)
    // And the box it was drawn over did not move.
    await expect
      .poll(async () => (await elements(jobId, pageId)).find((e) => e.id === para.id)!)
      .toBeTruthy()
    const after = await getPageDetail(jobId, pageId)
      .then((d) => d.elements.find((e: Element & { bbox: number[] }) => e.id === para.id)!.bbox)
    expect(after).toEqual(box)
  })
})

test.describe('Scenario: picking one thing out of another under a zoom', () => {
  test('a click a few pixels on picks what is there, not the next thing under it',
    async ({ page }) => {
      const { jobId, pageId } = await seedEditor(page)
      const line = (await paragraphLines(jobId, pageId))[1]
      const scan = page.getByTestId('overlay-box')
      const drawn = page.locator(`[data-testid="line-poly"][data-id="${line.id}"]`)
      await expect(drawn).toHaveCount(1)

      // Zoom in on the middle of that line, which stays under the cursor as it grows.
      const middle = await toPixels(page, center(line.polygon))
      await page.mouse.move(middle.x, middle.y)
      await page.keyboard.down('Control')
      for (let i = 0; i < 6; i++) await page.mouse.wheel(0, -600)
      await page.keyboard.up('Control')

      // Ten pixels along the same line: further than the slop every other click measures
      // itself by, but well inside a hundredth of the page, which is the distance the
      // selection cycle used to go by - at this zoom that is 14 px of scan.
      const width = (await scan.boundingBox())!.width
      expect(0.01 * width).toBeGreaterThan(10)
      const here = await toPixels(page, center(line.polygon))

      await page.mouse.click(here.x, here.y)
      await expect(page.getByTestId('line-vertex-handle')).toHaveCount(4)
      await expect(drawn).toHaveCount(0)

      await page.mouse.click(here.x + 10, here.y)
      await expect(page.getByTestId('line-vertex-handle')).toHaveCount(4)
      await expect(drawn).toHaveCount(0)
    })
})

test.describe('Scenario: merging lines a language model has read', () => {
  // The README: "A merged line starts with no readings of its own -
  // half-readings joined would be guesswork - and no language model is asked again." The
  // halves' readings stay on record for undo.
  const PERFECT = 'stub-perfect'
  const HALVES = ['Sample Paragraph line 1', 'Sample Paragraph line 2']
  const DEV = identity('dev', 'admin')

  /** The readings offered on one line: attached to it and not set aside. */
  const liveReadingsOn = async (pageId: number, lineId: number) =>
    (await pageCandidates(pageId))
      .filter((c) => c.line_id === lineId && !c.dismissed)
      .map((c): [string | null, string] => [c.author, c.text])

  /** What the model said of the two lines about to be merged, wherever those rows are now. */
  const halvesOnRecord = async (pageId: number, reader: string): Promise<Candidate[]> =>
    (await pageCandidates(pageId)).filter((c) => c.author === reader && HALVES.includes(c.text))

  /** One page read by one stub model, so every line carries exactly one reading, with the
   *  editor open on it. */
  async function seedReadEditor(page: import('@playwright/test').Page) {
    const jobId = await seedCompletedJob(uniqueName('Merge readings'), 1, LANDSCAPE)
    const [pageId] = await jobPageIds(jobId)
    const connection = uniqueName('Merge reader')
    await seedLlmConnection(connection, [PERFECT], DEV)
    await resetLlmStats()
    await startLlmRead(page, jobId, connection, [PERFECT])
    const reader = `llm:${connection} ${PERFECT}`
    // The premise: six lines, each carrying this model's reading of it, bought with one call.
    const lines = (await elements(jobId, pageId)).flatMap((e) => e.lines)
    const held = (await pageCandidates(pageId)).filter((c) => c.source === 'llm')
    expect(held).toHaveLength(6)
    expect(Object.fromEntries(held.map((c) => [c.line_id!, [c.author, c.text, c.dismissed]])))
      .toEqual(Object.fromEntries(lines.map((l) => [l.id, [reader, l.text, false]])))
    expect((await llmStats()).calls[PERFECT]).toBe(1)
    await openViewer(page, jobId, pageId)
    await enterEditMode(page)
    return { jobId, pageId, reader }
  }

  async function mergeFirstTwo(page: import('@playwright/test').Page, jobId: string, pageId: number) {
    const [first, second] = await paragraphLines(jobId, pageId)
    expect([first.text, second.text]).toEqual(HALVES)
    await selectLine(page, first)
    await clickAt(page, center(second.polygon), { shift: true })
    await page.keyboard.press('m')
    await expect.poll(async () => (await paragraphLines(jobId, pageId)).length).toBe(2)
    return { first, second }
  }

  test('a merge drops the halves\' readings and asks no model again', async ({ page }) => {
    const { jobId, pageId, reader } = await seedReadEditor(page)
    const { first } = await mergeFirstTwo(page, jobId, pageId)

    // The merged line starts with no readings of its own: neither half's reading is
    // matched back onto it, not even the one that sat on the id it kept.
    await expect.poll(() => liveReadingsOn(pageId, first.id)).toEqual([])
    // The halves' readings stay on record for undo, but are live on no line.
    const onRecord = await halvesOnRecord(pageId, reader)
    expect(onRecord.map((c) => c.text).sort()).toEqual(HALVES)
    expect(onRecord.filter((c) => c.line_id !== null && !c.dismissed)).toEqual([])

    // The model reads the page image, which the merge did not change: its reading stays
    // done and is not queued again, so the one call already made is the only one.
    const status = await llmReadStatus(jobId)
    expect([status.done, status.pending, status.running]).toEqual([1, 0, 0])
    expect((await llmStats()).calls[PERFECT]).toBe(1)
  })

  test('a merge on a page no model has read queues nothing', async ({ page }) => {
    const { jobId, pageId } = await seedEditor(page)
    const idle = {
      pages: 1, models: [], errors: [], active: false, pending: 0, running: 0, done: 0, error: 0,
    }
    expect(await llmReadStatus(jobId)).toEqual(idle)
    const before = (await llmStats()).total

    const { first } = await mergeFirstTwo(page, jobId, pageId)

    expect(await liveReadingsOn(pageId, first.id)).toEqual([])
    // No model was ever picked for this dataset, so there is nothing to read it again with.
    expect(await llmReadStatus(jobId)).toEqual(idle)
    expect((await llmStats()).total).toBe(before)
  })

  test('undo puts the halves back with the readings they had', async ({ page }) => {
    const { jobId, pageId, reader } = await seedReadEditor(page)
    const { first, second } = await mergeFirstTwo(page, jobId, pageId)

    await page.keyboard.press('ControlOrMeta+z')
    await expect.poll(async () => (await paragraphLines(jobId, pageId)).length).toBe(3)
    await expect.poll(async () => [
      await liveReadingsOn(pageId, first.id), await liveReadingsOn(pageId, second.id),
    ]).toEqual([[[reader, 'Sample Paragraph line 1']], [[reader, 'Sample Paragraph line 2']]])
    expect((await halvesOnRecord(pageId, reader)).map((c) => c.dismissed)).toEqual([false, false])
  })
})
