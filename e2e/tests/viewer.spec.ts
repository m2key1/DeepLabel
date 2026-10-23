import { execSync } from 'node:child_process'
import { test, expect } from '../helpers/test'
import type { Locator } from '@playwright/test'
import {
  OVERLAY_DEFAULTS, backendFetch, correctLine, getJob, getPageDetail, identity, jobPageIds,
  markLinesChecked, pageLines, seedCompletedJob, setPageOverlays, uniqueName,
} from '../helpers/api'
import {
  LANDSCAPE, center, hoverAt, clickAt, clickOnScan, enterEditMode, openViewer, pinchOut,
  scanFractionAt, scanRect, scanTurn, scanZoom, twistBy,
} from '../helpers/viewer'

const DEV = identity('dev', 'admin')

// What one notch of a real mouse wheel reports, and what d3-zoom's normalization makes
// of it: the zoom is multiplied by 2 ** STEP for every notch.
const NOTCH = 120
const STEP = NOTCH * 0.002
// The zoom is spent over frames, so what it settles at is what a test can assert.
const settled = (ratio: () => Promise<number>, want: number) =>
  expect.poll(ratio, { timeout: 5_000 }).toBeCloseTo(want, 3)

// What counts as "it did not move" on the screen. Converting the cursor between window
// pixels and the viewer's own coordinates lands a fraction of a pixel off - about a
// quarter of one per notch, measured - so a notch of zoom is asked to hold its point
// within a pixel. The bugs this guards against, an anchor read against the wrong box or
// a constraint dragging the scan sideways, move it by tens of them.
const STEADY_PX = 1

// The same rounding, but read after a long chain of notches rather than one: zooming all
// the way out to the floor is thirty of them, and what each rounds by is still there at
// the end. Two pixels of a scan two hundred wide is the shape of the claim - a centring
// that had actually gone wrong would be off by a quarter of the pane.
const CENTRED_PX = 2

function markDuplicate(pageId: number) {
  const script = [
    'from app import config, store',
    'conn = store.connect(config.DB_PATH)',
    `conn.execute("UPDATE pages SET status = 'duplicate' WHERE id = ?", (${pageId},))`,
    'conn.commit()',
  ].join('\n')
  execSync('docker compose -f ../compose.e2e.yml exec -T backend python -', { input: script })
}

async function seedViewer(pageCount = 2) {
  const jobId = await seedCompletedJob(uniqueName('Viewer'), pageCount, LANDSCAPE)
  const pageIds = await jobPageIds(jobId)
  return { jobId, pageIds }
}

test.describe('Scenario: reading a processed page', () => {
  // What a page opens with is a setting of the signed-in user's, shared by every spec.
  // Saying which one this scenario means keeps it independent of whatever ran before.
  test.beforeEach(({ page }) => setPageOverlays(page))

  test('arrow keys move between pages and escape returns to the dataset', async ({ page }) => {
    const { jobId, pageIds } = await seedViewer()
    await openViewer(page, jobId, pageIds[0])
    await expect(page.getByText('Page 1')).toBeVisible()

    await page.keyboard.press('ArrowRight')
    await expect(page).toHaveURL(new RegExp(`/pages/${pageIds[1]}$`))
    // Wait for the new page to render before the next keypress: the URL changes
    // ahead of React, and a stale handler would refuse to navigate further.
    await expect(page.getByText('Page 2')).toBeVisible()
    await page.keyboard.press('ArrowLeft')
    await expect(page).toHaveURL(new RegExp(`/pages/${pageIds[0]}$`))
    await expect(page.getByText('Page 1')).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(page).toHaveURL(new RegExp(`/jobs/${jobId}$`))
  })

  // README: "a duplicate row ... the tile editor and the page viewer step over it". The
  // stub runner keeps identical scans as pages of their own, so the middle page is made
  // the duplicate the real runner would have recorded.
  test('arrow keys step over a duplicate scan in both directions', async ({ page }) => {
    const { jobId, pageIds } = await seedViewer(3)
    const [first, duplicate, last] = pageIds
    markDuplicate(duplicate)
    const statuses = [...(await getJob(jobId)).pages]
      .sort((a: { idx: number }, b: { idx: number }) => a.idx - b.idx)
      .map((p: { status: string }) => p.status)
    expect(statuses[1]).toBe('duplicate')
    expect([statuses[0], statuses[2]]).not.toContain('duplicate')

    await openViewer(page, jobId, first)
    await expect(page.getByText('Page 1')).toBeVisible()
    await page.keyboard.press('ArrowRight')
    await expect(page).toHaveURL(new RegExp(`/pages/${last}$`))
    await expect(page.getByText('Page 3')).toBeVisible()
    await page.keyboard.press('ArrowLeft')
    await expect(page).toHaveURL(new RegExp(`/pages/${first}$`))
    await expect(page.getByText('Page 1')).toBeVisible()
    await expect(page.getByText('Page 2')).toHaveCount(0)
  })

  test('clicking an element focuses it and escape steps back out', async ({ page }) => {
    const { jobId, pageIds } = await seedViewer(1)
    await openViewer(page, jobId, pageIds[0])

    await clickAt(page, [0.5, 0.1])
    await expect(page.getByText('Element 1')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByText('Element 1')).not.toBeVisible()
  })

  test('ctrl+wheel zooms in on finer tiles, alt-drag pans, double-click resets', async ({ page }) => {
    // A scan with room above the fitted level in its pyramid: 2400 wide puts the top at
    // level 12, and a pane around a thousand pixels frames it at level 10 or so, which
    // leaves something finer for zooming in to go and fetch.
    const jobId = await seedCompletedJob(uniqueName('Viewer'), 1, { width: 2400, height: 1600 })
    const pageIds = await jobPageIds(jobId)

    // Every deep-zoom level the viewer asks for, listened to before the page is opened so
    // the tiles it opens with are counted too.
    const levels = new Set<number>()
    page.on('request', (req) => {
      const hit = /\/tiles\/\d+\/(\d+)\/\d+_\d+\.jpg/.exec(req.url())
      if (hit) levels.add(Number(hit[1]))
    })
    await openViewer(page, jobId, pageIds[0])

    const pane = page.getByTestId('overlay-pane')
    const box = await pane.boundingBox()
    if (!box) throw new Error('overlay pane not visible')
    const paneCenter = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    await expect.poll(() => levels.size, { timeout: 10_000 }).toBeGreaterThan(0)
    const fittedTop = Math.max(...levels)
    // Fitted, it never asks for the full-size level - which is the whole point of tiling.
    expect(fittedTop).toBeLessThan(12)

    await page.mouse.move(paneCenter.x, paneCenter.y)
    await page.keyboard.down('Control')
    for (let i = 0; i < 6; i++) await page.mouse.wheel(0, -NOTCH)
    await page.keyboard.up('Control')
    await expect.poll(() => Math.max(...levels), { timeout: 10_000 }).toBeGreaterThan(fittedTop)

    const before = await scanRect(page)
    await page.keyboard.down('Alt')
    await page.mouse.move(paneCenter.x, paneCenter.y)
    await page.mouse.down()
    await page.mouse.move(paneCenter.x - 150, paneCenter.y - 100, { steps: 8 })
    await page.mouse.up()
    await page.keyboard.up('Alt')
    // The scan follows the hand exactly: 150 left and 100 up.
    await expect.poll(async () => Math.round((await scanRect(page)).left - before.left))
      .toBe(-150)
    expect(Math.round((await scanRect(page)).top - before.top)).toBe(-100)

    await pane.dblclick({ position: { x: 8, y: 8 } })
    await settled(() => scanZoom(page), 1)
  })

  test('ctrl+wheel also zooms the scan out below the width of its pane', async ({ page }) => {
    const { jobId, pageIds } = await seedViewer(1)
    await openViewer(page, jobId, pageIds[0])

    const pane = page.getByTestId('overlay-pane')
    const ratio = () => scanZoom(page)
    // It opens fitted to the pane, which is the size there was no way down from.
    expect(await ratio()).toBeCloseTo(1, 3)

    const rect = (await pane.boundingBox())!
    await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2)
    await page.keyboard.down('Control')
    // A notch of a real mouse is 120, which d3-zoom's scaling makes 0.24 of a power of
    // two, so six of them leave the scan at 2^-1.44 of the pane.
    for (let i = 0; i < 6; i++) await page.mouse.wheel(0, NOTCH)
    await settled(ratio, 2 ** (-6 * STEP))

    // And it stops at a quarter, the same floor the tile editor uses.
    for (let i = 0; i < 30; i++) await page.mouse.wheel(0, NOTCH)
    await page.keyboard.up('Control')

    await settled(ratio, 0.25)
  })

  test('a scan smaller than its pane sits centred in it', async ({ page }) => {
    const { jobId, pageIds } = await seedViewer(1)
    await openViewer(page, jobId, pageIds[0])

    const pane = page.getByTestId('overlay-pane')
    // The empty strip either side of the scan, measured inside the pane's border.
    const gaps = async () => {
      const scan = await scanRect(page)
      return pane.evaluate((el, s) => {
        const inner = el.getBoundingClientRect().left + el.clientLeft
        return { left: s.left - inner, right: inner + el.clientWidth - (s.left + s.width),
                 pane: el.clientWidth }
      }, scan)
    }

    const fitted = await gaps()
    expect(fitted.left).toBeCloseTo(0, 1)
    expect(fitted.right).toBeCloseTo(0, 1)

    const rect = (await pane.boundingBox())!
    await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2)
    await page.keyboard.down('Control')
    for (let i = 0; i < 30; i++) await page.mouse.wheel(0, NOTCH)
    await page.keyboard.up('Control')
    await expect.poll(async () => (await gaps()).left, { timeout: 5_000 }).toBeGreaterThan(1)

    // At the quarter floor three quarters of the pane is empty, and it is split evenly.
    const shrunk = await gaps()
    expect(Math.abs(shrunk.left - shrunk.right)).toBeLessThan(CENTRED_PX)
    expect(Math.abs(shrunk.left - shrunk.pane * 0.375)).toBeLessThan(CENTRED_PX)
    expect(Math.abs(shrunk.right - shrunk.pane * 0.375)).toBeLessThan(CENTRED_PX)
  })

  test('a flick of the wheel is paid in full and stays about the cursor', async ({ page }) => {
    const { jobId, pageIds } = await seedViewer(1)
    await openViewer(page, jobId, pageIds[0])

    const pane = page.getByTestId('overlay-pane')
    const ratio = () => scanZoom(page)
    const under = (x: number) => scanFractionAt(page, x)
    expect(await ratio()).toBeCloseTo(1, 3)

    // One flick of a real wheel reaches the page as a burst of events inside a single
    // frame, which page.mouse.wheel cannot reproduce - it waits for each one to land.
    const at = await pane.evaluate((el) => {
      const box = el.getBoundingClientRect()
      return { x: box.left + el.clientLeft + el.clientWidth * 0.35, y: box.top + box.height / 2 }
    })
    const aimed = await under(at.x)
    await pane.evaluate((el, { x, y }) => {
      for (let i = 0; i < 4; i++) {
        el.dispatchEvent(new WheelEvent('wheel', {
          deltaY: -120, clientX: x, clientY: y, ctrlKey: true, bubbles: true, cancelable: true,
        }))
      }
    }, at)

    // All four notches are paid, none dropped or run together.
    await settled(ratio, 2 ** (4 * STEP))
    // And the point they were aimed at is still under them at the end of it.
    expect(aimed).toBeCloseTo(0.35, 3)
    expect(await under(at.x)).toBeCloseTo(0.35, 2)
  })

  test('a wheel that reports a whole gesture at once cannot teleport the scan',
    async ({ page }) => {
      const { jobId, pageIds } = await seedViewer(1)
      await openViewer(page, jobId, pageIds[0])

      const pane = page.getByTestId('overlay-pane')
      const at = await pane.evaluate((el) => {
        const box = el.getBoundingClientRect()
        return { x: box.left + el.clientLeft + el.clientWidth * 0.5, y: box.top + box.height / 2 }
      })
      // An accelerated wheel reports thousands of delta in one event; unchecked that is
      // 2 ** 8 in a single frame. It is capped at 2 ** 0.5 and the rest is dropped.
      //
      // Measured as the factor the scan grew by, not the size it ended at: the cap is a
      // statement about one event, and the size it started from is whatever the panes
      // around it had settled to.
      const before = await scanZoom(page)
      await pane.evaluate((el, { x, y }) => {
        el.dispatchEvent(new WheelEvent('wheel', {
          deltaY: -4000, clientX: x, clientY: y, ctrlKey: true, bubbles: true, cancelable: true,
        }))
      }, at)

      await settled(async () => (await scanZoom(page)) / before, 2 ** 0.5)
    })

  test('zooming holds the point under the cursor as the scan outgrows the pane', async ({ page }) => {
    const { jobId, pageIds } = await seedViewer(1)
    await openViewer(page, jobId, pageIds[0])

    const pane = page.getByTestId('overlay-pane')
    // Sixty percent across the pane's inner width, which is what the scan's width is a
    // percentage of - so the fractions below hold whatever the pane happens to measure.
    const at = (frac: number) => pane.evaluate((el, f) => {
      const box = el.getBoundingClientRect()
      return { x: box.left + el.clientLeft + el.clientWidth * f, y: box.top + box.height / 2 }
    }, frac)
    // Where in the scan a point is, as a fraction of the scan's width.
    const under = (x: number) => scanFractionAt(page, x)

    // How far the aimed point has slid under the cursor, on the screen.
    const slipPx = async (x: number, aimed: number) =>
      Math.abs((await under(x)) - aimed) * (await scanRect(page)).width

    const middle = await at(0.5)
    await page.mouse.move(middle.x, middle.y)
    await page.keyboard.down('Control')
    // Down to the 0.25 floor and back up in notches, which is not a whole number of them
    // from where it started - so zooming back in steps over the fitted width instead of
    // landing on it, which is where the scan stops being narrower than the pane.
    for (let i = 0; i < 30; i++) await page.mouse.wheel(0, NOTCH)
    await settled(() => scanZoom(page), 0.25)
    const cursor = await at(0.6)
    await page.mouse.move(cursor.x, cursor.y)
    for (let i = 0; i < 7; i++) await page.mouse.wheel(0, -NOTCH)
    await settled(() => scanZoom(page), 0.25 * 2 ** (7 * STEP))

    // Each notch is measured from where the one before it left the scan. Asked instead
    // how far a point has moved since the floor, this would be reporting nine notches'
    // worth of the fraction of a pixel every conversion rounds by, multiplied by the four
    // and a half times the scan has grown since - which says nothing about the notch that
    // crosses the pane's width, and is what this is here to watch.
    const notch = async () => {
      const aimed = await under(cursor.x)
      await page.mouse.wheel(0, -NOTCH)
      await new Promise((r) => setTimeout(r, 400))
      return slipPx(cursor.x, aimed)
    }

    // Still the narrower one, with empty pane on both sides of it, and the point stays.
    expect(await notch()).toBeLessThan(STEADY_PX)
    expect(await scanZoom(page)).toBeLessThan(1)

    // The next takes it past the pane's width, and the point still does not move.
    expect(await notch()).toBeLessThan(STEADY_PX)
    await page.keyboard.up('Control')
    await settled(() => scanZoom(page), 0.25 * 2 ** (9 * STEP))
    expect(await scanZoom(page)).toBeGreaterThan(1)
  })

  // Every touch device reaches the viewer through these: a Mac trackpad reports a pinch as
  // a wheel with ctrl held, but a finger - and Safari, which does not use the wheel at all
  // - arrives as two pointers, and the viewer's own gesture handling is off because the
  // overlay is what they land on.
  test('two fingers pinch the scan bigger, and a slight crookedness does not turn it',
    async ({ page }) => {
      const { jobId, pageIds } = await seedViewer(1)
      await openViewer(page, jobId, pageIds[0])
      expect(await scanZoom(page)).toBeCloseTo(1, 3)

      await pinchOut(page, 2)

      // The fingers began 120 apart and ended 240, so the scan is twice the size. The
      // press itself is the first reading, so none of the spread is spent finding it.
      await settled(() => scanZoom(page), 2)
      // And spreading them is not turning them, however the hand was held.
      expect(Math.abs(await scanTurn(page))).toBeLessThan(1)
    })

  test('layout boxes, labels, confidence and reading order overlays toggle', async ({ page }) => {
    const { jobId, pageIds } = await seedViewer(1)
    await openViewer(page, jobId, pageIds[0])
    const overlay = page.getByTestId('overlay-box')

    await expect(overlay.locator('rect[data-id]')).toHaveCount(2)
    await expect(overlay.getByText('Header', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Labels' }).click()
    await expect(overlay.getByText('Header', { exact: true })).not.toBeVisible()

    // The Paragraph element's worst line is 0.55, rendered with the red stroke.
    await page.getByRole('button', { name: 'Confidence' }).click()
    await expect(overlay.locator('rect[stroke="#dc2626"]')).toHaveCount(1)

    // Layout and Lines are independent overlays: both can be on, or neither.
    await page.getByRole('button', { name: 'Lines', exact: true }).click()
    await expect(overlay.locator('svg polygon')).toHaveCount(6)
    await expect(overlay.locator('rect[data-id]')).toHaveCount(2)
    await page.getByRole('button', { name: 'Layout', exact: true }).click()
    await expect(overlay.locator('rect[data-id]')).toHaveCount(0)
    await expect(overlay.locator('svg polygon')).toHaveCount(6)

    await page.getByRole('button', { name: 'Order' }).click()
    await expect(overlay.locator('marker#ro-arrow')).toHaveCount(1)
  })

  // The loupe shows the crop the model reads, but nothing on the page said which region
  // became it - and on a line the backend refuses to straighten that region is an upright
  // box swallowing the neighbours, which is exactly when someone needs to see it.
  test('the region a line is actually cut from is drawn, and says when it is not straightened',
    async ({ page }) => {
      const jobId = await seedCompletedJob(uniqueName('Cut from'), 1)
      const [pageId] = await jobPageIds(jobId)
      const lines = await pageLines(jobId, pageId)
      const meta = await getPageDetail(jobId, pageId)
      const aspect = meta.width / meta.height

      const leaning = (degrees: number) => {
        const rad = (degrees * Math.PI) / 180
        const [ux, uy] = [Math.cos(rad), Math.sin(rad)]
        const [nx, ny] = [-uy, ux]
        return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => [
          (0.5 * aspect + ((a * 0.4) / 2) * ux + ((b * 0.05) / 2) * nx) / aspect,
          0.5 + ((a * 0.4) / 2) * uy + ((b * 0.05) / 2) * ny,
        ])
      }
      const reshape = (id: number, polygon: number[][]) => backendFetch(`/api/lines/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...DEV },
        body: JSON.stringify({ polygon }),
      })
      await reshape(lines[0].id, leaning(10))   // straightened
      await reshape(lines[1].id, leaning(45))   // inside the band it will not straighten

      await setPageOverlays(page, { ...OVERLAY_DEFAULTS, lines: true })
      await openViewer(page, jobId, pageId)
      const region = page.getByTestId('crop-region')
      const rows = page.getByTestId('line-row')
      await rows.filter({ hasText: 'Sample Header line 1' }).first().click()
      await expect(region).toHaveAttribute('data-deskewed', 'true')
      await expect(page.getByTestId('loupe-complaints')).not.toContainText('not straightened')
      // The straightened crop is the line's 0.05 page heights plus 12% padding either side,
      // in the scan's pixels, brought up to the stub model's 256 px.
      const upscale = 256 / (0.05 * 1.24 * meta.height)
      expect(upscale).toBeGreaterThan(1.5)
      await expect(page.getByTestId('loupe-complaints')).toContainText(`upscaled ${upscale.toFixed(1)}x`)

      // Left upright, the crop is the box around the leaning line, tall enough to need none.
      await rows.filter({ hasText: 'Sample Header line 2' }).first().click()
      await expect(region).toHaveAttribute('data-deskewed', 'false')
      await expect(page.getByTestId('loupe-complaints')).toContainText('not straightened')
      expect(256 / (0.45 / Math.SQRT2 * 1.24 * meta.height)).toBeLessThan(1.5)
      await expect(page.getByTestId('loupe-complaints')).not.toContainText('upscaled')

      // And the crop is shown at the size the model resizes it to, on request.
      const crop = page.getByTestId('loupe-crop')
      await expect(crop).toHaveAttribute('data-true-scale', 'false')
      await page.getByTestId('loupe-true-scale').click()
      await expect(crop).toHaveAttribute('data-true-scale', 'true')
      expect(Math.round((await crop.boundingBox())!.height)).toBe(256)

      await setPageOverlays(page)
    })

  // The per-character confidence profile places each character as a fraction of the crop's
  // width, and the crop is the line laid flat. Drawn with a gradient in objectBoundingBox
  // units it ran left to right across the bounding box instead, so on a tilted line the
  // colours sat beside the characters they scored rather than on them.
  test('the confidence colours run along a tilted line, not across the page',
    async ({ page }) => {
      const jobId = await seedCompletedJob(uniqueName('Tilted heat'), 1)
      const [pageId] = await jobPageIds(jobId)
      const [line] = await pageLines(jobId, pageId)
      const meta = await getPageDetail(jobId, pageId)
      const aspect = meta.width / meta.height

      // A long thin line leaning 20 degrees in pixel space - inside the backend's deskew
      // window, so the crop really is rotated and the overlay has to follow it.
      const rad = (20 * Math.PI) / 180
      const [ux, uy] = [Math.cos(rad), Math.sin(rad)]
      const [nx, ny] = [-uy, ux]
      const corners: number[][] = []
      for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        corners.push([(0.5 * aspect + (a * 0.5) / 2 * ux + (b * 0.05) / 2 * nx) / aspect,
                      0.5 + (a * 0.5) / 2 * uy + (b * 0.05) / 2 * ny])
      }
      await backendFetch(`/api/lines/${line.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...identity('dev', 'admin') },
        body: JSON.stringify({ polygon: corners }),
      })

      // Both explicitly: the gradient lives inside the lines layer, and every spec shares
      // this user's overlay settings, so a blind toggle would turn off what a neighbour left on.
      await setPageOverlays(page, { ...OVERLAY_DEFAULTS, lines: true, confidence: true })
      await openViewer(page, jobId, pageId)
      const grad = page.locator(`linearGradient[id$="-${line.id}"]`).first()
      await expect(grad).toHaveAttribute('gradientUnits', 'userSpaceOnUse')

      // The gradient's own direction, measured back in pixel space, is the line's 20 degrees
      // - not the 0 degrees a bounding-box gradient would give.
      const vec = await grad.evaluate((el) => ({
        x1: Number(el.getAttribute('x1')), y1: Number(el.getAttribute('y1')),
        x2: Number(el.getAttribute('x2')), y2: Number(el.getAttribute('y2')),
      }))
      const deg = (Math.atan2(vec.y2 - vec.y1, (vec.x2 - vec.x1) * aspect) * 180) / Math.PI
      expect(Math.abs(deg - 20)).toBeLessThan(1.5)

      await setPageOverlays(page)
    })

  test('hovering a line magnifies it in the loupe', async ({ page }) => {
    const { jobId, pageIds } = await seedViewer(1)
    await openViewer(page, jobId, pageIds[0])
    await page.getByRole('button', { name: 'Lines', exact: true }).click()

    const detail = await getPageDetail(jobId, pageIds[0])
    const line = detail.elements.find((e: { class_name: string }) => e.class_name === 'Paragraph').lines[1]
    await hoverAt(page, center(line.polygon))

    const loupeImage = page.getByTestId('line-loupe').locator('img')
    await expect(loupeImage).toBeVisible()
    // The browser keeps a crop for a year, so the URL carries both the revision and the
    // recipe the server named - otherwise a reshape, or a change to the way crops are cut,
    // goes on showing the pixels from before it.
    expect(await loupeImage.getAttribute('src'))
      .toBe(`/api/lines/${line.id}/crop?b=${line.crop_recipe}_${line.revision}`)
  })

  test('arrow keys move the loupe even while the cursor rests on a row', async ({ page }) => {
    const { jobId, pageIds } = await seedViewer(1)
    await openViewer(page, jobId, pageIds[0])

    const detail = await getPageDetail(jobId, pageIds[0])
    const header = detail.elements.find((e: { class_name: string }) => e.class_name === 'Header')
    const loupeImage = page.getByTestId('line-loupe').locator('img')

    // Park the cursor on the first row; the loupe shows that line via hover.
    await page.getByTestId('line-row').filter({ hasText: 'Sample Header line 1' }).hover()
    await expect(loupeImage).toHaveAttribute('src', new RegExp(`/api/lines/${header.lines[0].id}/crop`))

    // Keyboard navigation must win over the parked hover.
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await expect(loupeImage).toHaveAttribute('src', new RegExp(`/api/lines/${header.lines[1].id}/crop`))
  })

  // The bar used to wrap: a long filename, or a pill naming the models a read is out with,
  // added a row and pushed the scan itself down the screen.
  test('the top bar keeps its height when there is not room for everything on it',
    async ({ page }) => {
      const { jobId, pageIds } = await seedViewer(1)
      await openViewer(page, jobId, pageIds[0])

      const header = page.getByTestId('viewer-header')
      const roomy = (await header.boundingBox())!

      await page.setViewportSize({ width: 640, height: 900 })
      const cramped = (await header.boundingBox())!
      expect(cramped.height).toBe(roomy.height)
      // Narrower, but still one row - and the controls are what kept their size, so the
      // bar is still usable at the width that used to break it.
      expect(cramped.width).toBeLessThan(roomy.width)
      await expect(page.getByTestId('run-menu')).toBeVisible()
    })

  // A line too long to fit at full height used to run off the side of the loupe and have
  // to be scrolled. It is fitted to the width instead, padded above and below.
  test('a line too wide for the loupe is fitted to it rather than scrolled',
    async ({ page }) => {
      const { jobId, pageIds } = await seedViewer(1)
      await openViewer(page, jobId, pageIds[0])
      await page.getByTestId('line-row').first().hover()

      const loupe = page.getByTestId('line-loupe')
      const crop = loupe.locator('img')
      await expect(crop).toBeVisible()
      const box = (await loupe.boundingBox())!
      const shown = (await crop.boundingBox())!
      // Inside the loupe on both axes, so there is nothing off-screen to scroll to.
      expect(shown.width).toBeLessThanOrEqual(Math.ceil(box.width))
      expect(shown.height).toBeLessThanOrEqual(Math.ceil(box.height))
      const overflow = await loupe.evaluate((el) => {
        const scroller = el.firstElementChild as HTMLElement
        return scroller.scrollWidth - scroller.clientWidth
      })
      expect(overflow).toBeLessThanOrEqual(1)
    })

  // The panes used to be sized by a viewport calculation that guessed at the chrome above
  // them, so anything that changed that height - a resized loupe most of all - pushed the
  // whole page into scrolling and took the scan half off the screen.
  test('the page itself never scrolls, whatever the loupe is set to', async ({ page }) => {
    const { jobId, pageIds } = await seedViewer(1)
    await openViewer(page, jobId, pageIds[0])

    // Nothing between the viewer and the document may have anywhere to scroll to.
    const scrollers = () => page.evaluate(() => {
      const found: string[] = []
      let el = document.querySelector('[data-testid="viewer-header"]')?.parentElement ?? null
      while (el) {
        if (el.scrollHeight - el.clientHeight > 1) found.push(el.tagName.toLowerCase())
        el = el.parentElement
      }
      return found
    })
    const paneHeight = async () =>
      Math.round((await page.getByTestId('overlay-pane').boundingBox())!.height)

    expect(await scrollers()).toEqual([])
    const roomy = await paneHeight()
    expect(roomy).toBeGreaterThan(200)

    // Drag the loupe to its full height. The panes give up the room; the page does not grow.
    const grip = (await page.getByTestId('loupe-divider').boundingBox())!
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
    await page.mouse.down()
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2 + 400, { steps: 8 })
    await page.mouse.up()
    await expect.poll(async () =>
      Math.round((await page.getByTestId('line-loupe').boundingBox())!.height)).toBe(360)

    expect(await scrollers()).toEqual([])
    expect(await paneHeight()).toBeLessThan(roomy - 200)

    // And the same holds with the editing rail alongside.
    await enterEditMode(page)
    expect(await scrollers()).toEqual([])
    const railed = (await page.getByTestId('overlay-pane').boundingBox())!
    const viewport = page.viewportSize()!
    expect(railed.y + railed.height).toBeLessThanOrEqual(viewport.height)
  })

  test('the loupe is dragged taller, and the crop grows with it', async ({ page }) => {
    const { jobId, pageIds } = await seedViewer(1)
    await openViewer(page, jobId, pageIds[0])
    await page.getByTestId('line-row').first().hover()

    const loupe = page.getByTestId('line-loupe')
    const crop = loupe.locator('img')
    await expect(crop).toBeVisible()
    const was = (await loupe.boundingBox())!
    const wasCrop = (await crop.boundingBox())!
    expect(Math.round(was.height)).toBe(80)

    const grip = (await page.getByTestId('loupe-divider').boundingBox())!
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
    await page.mouse.down()
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2 + 90, { steps: 5 })
    await page.mouse.up()

    await expect.poll(async () => Math.round((await loupe.boundingBox())!.height)).toBe(170)
    // Hovered again: the loupe follows the pointer, and the pointer went to the bar.
    await page.getByTestId('line-row').first().hover()
    // The point of the bar: a bigger box is a bigger crop, not the same crop in more air.
    await expect(crop).toBeVisible()
    expect((await crop.boundingBox())!.height).toBeGreaterThan(wasCrop.height + 20)

    // Kept with the browser, like the dividers beside it, and still there after a reload.
    expect(await page.evaluate(() => localStorage.getItem('deeplabel.loupeHeight'))).toBe('170')
    await page.reload()
    await page.getByTestId('line-row').first().hover()
    await expect.poll(async () => Math.round((await loupe.boundingBox())!.height)).toBe(170)

    // And double-clicking the bar puts it back where it started.
    await page.getByTestId('loupe-divider').dblclick()
    await expect.poll(async () => Math.round((await loupe.boundingBox())!.height)).toBe(80)
  })

  // The editor used to stand taller than the text it replaced, so opening one shoved every
  // row under it down and closing it snatched them back - which loses a click aimed at a
  // candidate underneath, between its mousedown and its mouseup.
  test('clicking into a line leaves everything below it where it was', async ({ page }) => {
    const { jobId, pageIds } = await seedViewer(1)
    await openViewer(page, jobId, pageIds[0])

    const rows = page.getByTestId('line-row')
    const below = rows.nth(2)
    const before = (await below.boundingBox())!
    await rows.first().getByTestId('line-text').click()
    await expect(page.getByTestId('line-editor')).toBeVisible()

    const after = (await below.boundingBox())!
    expect(after.y).toBe(before.y)
  })

  // Clicking a wrapped line used to collapse it into one scrolling row.
  test('editing a line keeps the rows its text needs', async ({ page }) => {
    const { jobId, pageIds } = await seedViewer(1)
    const lines = await pageLines(jobId, pageIds[0])
    // Long enough that the panel has to wrap it over several rows.
    const long = `${'Sehr lange Zeile mit vielen Woertern '.repeat(6)}Ende`
    await correctLine(lines[0].id, long, false)

    await openViewer(page, jobId, pageIds[0])
    const row = page.getByTestId('line-row').filter({ hasText: 'Ende' })
    const shown = (await row.getByTestId('line-text').boundingBox())!
    expect(shown.height).toBeGreaterThan(30)   // more than one row of 24px line-height

    await row.getByTestId('line-text').click()
    const editor = page.getByTestId('line-editor')
    await expect(editor).toBeVisible()
    const box = (await editor.boundingBox())!
    // The editor stands as tall as the text did rather than becoming a single row, and
    // holds all of it without scrolling.
    expect(box.height).toBeGreaterThanOrEqual(shown.height)
    const hidden = await editor.evaluate((el) => el.scrollHeight - el.clientHeight)
    expect(hidden).toBeLessThanOrEqual(1)
    await expect(editor).toHaveValue(long)
  })

  test('the scan can be copied, and says so where the browser will not', async ({ page }) => {
    const { jobId, pageIds } = await seedViewer(1)
    await openViewer(page, jobId, pageIds[0])
    // On a secure origin the clipboard is there, so the button offers the copy itself.
    await expect(page.getByTestId('copy-image')).toBeVisible()
    await expect(page.getByTestId('open-image')).toHaveCount(0)

    // A deployment served over plain http has no clipboard to write to. The control must
    // still be there - vanishing is what made it look like a missing feature.
    await page.addInitScript(() => {
      Reflect.deleteProperty(window, 'ClipboardItem')
    })
    await openViewer(page, jobId, pageIds[0])
    const fallback = page.getByTestId('open-image')
    await expect(fallback).toBeVisible()
    await expect(fallback).toHaveAttribute('href', /\/rendition\?kind=screen/)
    await expect(page.getByTestId('copy-image')).toHaveCount(0)
  })

  test('the line list re-sorts by confidence', async ({ page }) => {
    const { jobId, pageIds } = await seedViewer(1)
    await openViewer(page, jobId, pageIds[0])

    await expect(page.getByTestId('line-text').first()).toHaveText('Sample Header line 1')
    await page.getByTitle('Sort the lines').selectOption('line')
    await expect(page.getByTestId('line-text').first()).toHaveText('Sample Paragraph line 1')
  })
})

test.describe('Scenario: turning the page under the hand', () => {
  test.beforeEach(({ page }) => setPageOverlays(page))

  // Twelve steps of two degrees, one finger at a time - so the angle between them advances
  // a degree at a time, and the reading at four is the first to clear the deadband. The
  // three degrees before it are dropped.
  const TWIST = 24
  const TURNED = 21

  test('two fingers turn the scan, and the deadband is all that is lost', async ({ page }) => {
    const { jobId, pageIds } = await seedViewer(1)
    await openViewer(page, jobId, pageIds[0])
    expect(Math.abs(await scanTurn(page))).toBeLessThan(1)

    await twistBy(page, TWIST)

    await settled(() => scanTurn(page), TURNED)
  })

  // A level hand sits exactly on the wrap at half a turn, where the first step across
  // reads as a full circle and tilts a page that was only being spread.
  test('a hand that has barely turned does not turn the page, held level or not',
    async ({ page }) => {
      const { jobId, pageIds } = await seedViewer(1)
      await openViewer(page, jobId, pageIds[0])

      await twistBy(page, 3)

      await expect.poll(() => scanTurn(page), { timeout: 2_000 }).toBe(0)
    })

  test('an element is picked by where it is on the page, not where it was on the screen',
    async ({ page }) => {
      const { jobId, pageIds } = await seedViewer(1)
      await openViewer(page, jobId, pageIds[0])
      // Header on top, Paragraph below: a click converted against the untilted rectangle
      // lands in the wrong one.
      await clickOnScan(page, [0.5, 0.525])
      await expect(page.getByText('Element 2')).toBeVisible()
      await page.keyboard.press('Escape')

      await twistBy(page, TWIST)
      await settled(() => scanTurn(page), TURNED)
      await clickOnScan(page, [0.5, 0.1])

      await expect(page.getByText('Element 1')).toBeVisible()
      await expect(page.getByText('Element 2')).not.toBeVisible()
    })

  test('the turn comes back out with the rest of the view', async ({ page }) => {
    const { jobId, pageIds } = await seedViewer(1)
    await openViewer(page, jobId, pageIds[0])

    await twistBy(page, TWIST)
    await settled(() => scanTurn(page), TURNED)

    await page.getByTestId('overlay-pane').dblclick()

    await settled(() => scanTurn(page), 0)
    await settled(() => scanZoom(page), 1)
  })
})

test.describe('Scenario: throwing a line away from the list', () => {
  const texts = (jobId: string, pageId: number) =>
    pageLines(jobId, pageId).then((lines) => lines.map((l) => l.text))

  test('a row that carries an edit does not shove its neighbours out of line',
    async ({ page }) => {
      const { jobId, pageIds } = await seedViewer(1)
      const lines = await pageLines(jobId, pageIds[0])
      await correctLine(lines[0].id, 'Settled by hand')
      await openViewer(page, jobId, pageIds[0])

      const rows = page.getByTestId('line-row')
      const edited = rows.filter({ hasText: 'Settled by hand' })
      const plain = rows.filter({ hasText: lines[1].text as string })
      await expect(edited.getByText('edited', { exact: true })).toHaveCount(1)
      await expect(plain.getByText('edited', { exact: true })).toHaveCount(0)

      // The chip sits in a slot every row keeps, filled or not, so what a row carries
      // never decides where the row beside it puts anything.
      const column = async (testId: string) => {
        const boxes = await Promise.all(
          (await page.getByTestId(testId).all()).map(async (n) => (await n.boundingBox())!))
        expect(boxes.length).toBeGreaterThan(3)
        return { x: new Set(boxes.map((b) => b.x)).size, w: new Set(boxes.map((b) => b.width)).size }
      }

      expect(await column('edited-slot')).toEqual({ x: 1, w: 1 })

      // And the readings are a column: same left edge, same width, whatever they read.
      expect(await column('line-confidence')).toEqual({ x: 1, w: 1 })
    })

  test('a narrow panel stacks each row: the reading on top, its badges and actions below',
    async ({ page }) => {
      const { jobId, pageIds } = await seedViewer(1)
      const lines = await pageLines(jobId, pageIds[0])
      await correctLine(lines[0].id, 'Settled by hand')
      await openViewer(page, jobId, pageIds[0])

      const row = page.getByTestId('line-row').first()
      const text = row.getByTestId('line-text')
      const rail = [row.getByText('edited', { exact: true }), row.getByTestId('line-confidence'),
                    row.getByTestId('delete-line'), row.getByTitle('Re-run OCR on this line')]
      const box = async (locator: Locator) => (await locator.boundingBox())!

      // Wide, one line: the reading and its rail side by side.
      for (const item of rail) {
        await expect(item).toBeVisible()
        expect(Math.abs((await box(item)).y + (await box(item)).height / 2
          - ((await box(text)).y + (await box(text)).height / 2))).toBeLessThan(6)
      }

      // Narrow, two: the reading has the row's width, and everything else sits under it.
      await page.setViewportSize({ width: 760, height: 900 })
      await expect.poll(async () => (await box(text)).width / (await box(row)).width).toBeGreaterThan(0.8)
      const textBottom = (await box(text)).y + (await box(text)).height
      for (const item of rail) {
        await expect(item).toBeVisible()
        expect((await box(item)).y).toBeGreaterThanOrEqual(textBottom - 1)
      }

      // And back to one line with the room.
      await page.setViewportSize({ width: 1440, height: 900 })
      await expect.poll(async () => (await box(row.getByTestId('line-confidence'))).y)
        .toBeLessThan(textBottom - 1)
    })

  test('a double-click leaves the view alone while the page is being edited',
    async ({ page }) => {
      const { jobId, pageIds } = await seedViewer(1)
      await openViewer(page, jobId, pageIds[0])

      const pane = page.getByTestId('overlay-pane')
      const box = (await pane.boundingBox())!
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.keyboard.down('Control')
      for (let i = 0; i < 4; i++) await page.mouse.wheel(0, -NOTCH)
      await page.keyboard.up('Control')
      await expect.poll(() => scanZoom(page)).toBeGreaterThan(1.2)

      // Outside edit mode a double-click still refits, as it always has.
      await pane.dblclick({ position: { x: 8, y: 8 } })
      await settled(() => scanZoom(page), 1)

      // Inside it, two clicks are two steps through what is under the cursor, and a
      // click that misses the scan by a few pixels must not refit the page under the
      // hand. The 1x button is how the view is reset.
      await enterEditMode(page)
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.keyboard.down('Control')
      for (let i = 0; i < 4; i++) await page.mouse.wheel(0, -NOTCH)
      await page.keyboard.up('Control')
      await expect.poll(() => scanZoom(page)).toBeGreaterThan(1.2)
      // Taken here, not before: the rail narrows the pane, so the same wheel lands on a
      // different ratio inside edit mode than outside it.
      const editing = await scanZoom(page)

      await pane.dblclick({ position: { x: 8, y: 8 } })
      await page.waitForTimeout(600)
      expect(await scanZoom(page)).toBeCloseTo(editing, 2)
    })

  test('a row shows its buttons without waiting for the cursor', async ({ page }) => {
    const { jobId, pageIds } = await seedViewer(1)
    await openViewer(page, jobId, pageIds[0])

    const row = page.getByTestId('line-row').first()
    await page.mouse.move(0, 0)
    for (const button of [row.getByTestId('delete-line'), row.getByTitle('Re-run OCR on this line')]) {
      await expect(button).toBeVisible()
      await expect(button).toHaveCSS('opacity', '1')
    }
  })

  test('the line and its box go, with no edit mode to enter first', async ({ page }) => {
    const { jobId, pageIds } = await seedViewer(1)
    await openViewer(page, jobId, pageIds[0])
    await page.getByRole('button', { name: 'Lines', exact: true }).click()

    const overlay = page.getByTestId('overlay-box')
    await expect(overlay.locator('svg polygon')).toHaveCount(6)
    const doomed = page.getByTestId('line-row').filter({ hasText: 'Sample Paragraph line 2' })
    await doomed.getByTestId('delete-line').click()

    // Backend oracle: the row is gone from the page, not merely from the list.
    await expect.poll(() => texts(jobId, pageIds[0])).toEqual([
      'Sample Header line 1', 'Sample Header line 2', 'Sample Header line 3',
      'Sample Paragraph line 1', 'Sample Paragraph line 3',
    ])
    await expect(doomed).toHaveCount(0)
    // The box it was cut from goes with it.
    await expect(overlay.locator('svg polygon')).toHaveCount(5)
  })

  test('a line somebody checked asks first, and stays when the answer is no',
    async ({ page }) => {
      const { jobId, pageIds } = await seedViewer(1)
      const [first] = await pageLines(jobId, pageIds[0])
      const reading = first.text as string
      await backendFetch(`/api/lines/${first.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...DEV },
        body: JSON.stringify({ checked: true }),
      })
      await openViewer(page, jobId, pageIds[0])
      const row = page.getByTestId('line-row').filter({ hasText: reading })

      page.once('dialog', (dialog) => dialog.dismiss())
      await row.getByTestId('delete-line').click()
      await expect(row).toBeVisible()
      expect(await texts(jobId, pageIds[0])).toContain(reading)

      page.once('dialog', (dialog) => dialog.accept())
      await row.getByTestId('delete-line').click()
      await expect.poll(() => texts(jobId, pageIds[0])).not.toContain(reading)
    })
})

test.describe('Scenario: how far the OCR fell from what was settled', () => {
  test('the page reports its own error rate over the lines people checked', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Error rate'), 1, LANDSCAPE)
    const [pageId] = await jobPageIds(jobId)
    const lines = await pageLines(jobId, pageId)
    expect(lines.map((l) => l.text)).toEqual([
      'Sample Header line 1', 'Sample Header line 2', 'Sample Header line 3',
      'Sample Paragraph line 1', 'Sample Paragraph line 2', 'Sample Paragraph line 3',
    ])

    await openViewer(page, jobId, pageId)
    // Nothing has been checked off, so there is nothing to measure yet.
    await expect(page.getByTestId('viewer-header')).toBeVisible()
    await expect(page.getByTestId('page-error-rate')).toHaveCount(0)

    // A line checked off as it was read: no errors, and its length still counts - leaving
    // it out would measure only the lines somebody had to change.
    await markLinesChecked(jobId, 1)
    // One letter swapped, and one letter added: two character errors over the three
    // references (20 + 20 + 21 = 61 characters, 12 words), and two of the words differ.
    await correctLine(lines[1].id, 'Sample Header line X')
    await correctLine(lines[2].id, 'Sample Header line 33')
    await expect.poll(async () => (await pageLines(jobId, pageId)).filter((l) => l.checked).length)
      .toBe(3)

    await page.reload()
    const pill = page.getByTestId('page-error-rate')
    await expect(pill).toHaveAttribute('data-lines', '3')
    await expect(pill).toHaveAttribute('data-cer', '0.0328')
    await expect(pill).toHaveAttribute('data-wer', '0.1667')
    await expect(pill).toContainText('CER 3.28%')
    await expect(pill).toContainText('WER 16.67%')
  })
})

test.describe('Scenario: a narrow panel inside one element', () => {
  test('the element view gives the reading the room, as the page view does', async ({ page }) => {
    const { jobId, pageIds } = await seedViewer(1)
    const lines = await pageLines(jobId, pageIds[0])
    await correctLine(lines[0].id, 'Settled by hand')
    await openViewer(page, jobId, pageIds[0])
    await clickAt(page, [0.5, 0.1])
    await expect(page.getByText('Element 1')).toBeVisible()
    await expect(page.getByTestId('delete-line').first()).toBeVisible()

    // Narrow, the element's rows keep their actions as the page's rows do.
    await page.setViewportSize({ width: 760, height: 900 })
    await expect(page.getByText('Element 1')).toBeVisible()
    await expect(page.getByTestId('line-row').first()).toBeVisible()
    await expect(page.getByTestId('delete-line').first()).toBeVisible()
  })
})
