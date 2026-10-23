import { expect, type Page } from '@playwright/test'

// The overlay works in page-normalized [0, 1] coordinates; these helpers convert
// them to viewport pixels against the live overlay box so drags land exactly
// where the app's own hit-testing expects them.

export type NormPoint = [number, number]

// Landscape scans keep the whole page inside the viewport, so normalized drag
// targets are always clickable without scrolling.
export const LANDSCAPE = { width: 800, height: 600 }

/** The overlay box, once the scan under it has stopped moving.
 *
 *  The scan is animated into place - a pane resize on entering edit mode, a zoom easing
 *  to its target - and a point measured while it is still moving is clicked somewhere
 *  else by the time the mouse arrives. */
async function overlayBounds(page: Page) {
  const overlay = page.getByTestId('overlay-box')
  await expect(overlay).toHaveAttribute('data-scan', 'ready')
  const box = await overlay.evaluate((el) => new Promise<
    { x: number; y: number; width: number; height: number }
  >((resolve, reject) => {
    let last = el.getBoundingClientRect()
    let frames = 0
    const tick = () => {
      const now = el.getBoundingClientRect()
      if (now.x === last.x && now.y === last.y && now.width === last.width) {
        resolve({ x: now.x, y: now.y, width: now.width, height: now.height })
        return
      }
      if (++frames > 120) {
        reject(new Error('the scan never stopped moving'))
        return
      }
      last = now
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }))
  if (!box.width || !box.height) throw new Error('overlay box is not measurable')
  return box
}

export async function toPixels(page: Page, [nx, ny]: NormPoint) {
  const box = await overlayBounds(page)
  return { x: box.x + box.width * nx, y: box.y + box.height * ny }
}

export async function openViewer(page: Page, jobId: string, pageId: number) {
  await page.goto(`/jobs/${jobId}/pages/${pageId}`)
  await expect(page.getByTestId('overlay-box')).toHaveAttribute('data-scan', 'ready')
  // The loupe bar mounts shortly after load and shifts the layout down; wait for
  // it so coordinate measurements are taken against the settled layout.
  await expect(page.getByTestId('line-loupe')).toBeVisible()
  // Drawn is not the same as framed: the pane is still being resized by the panels
  // arriving around it, and the scan is re-fitted a frame after each one.
  await overlayBounds(page)
}

/** Where the scan is drawn, in viewport pixels. The scan is painted to a canvas that
 *  fills the whole pane, so its own extent is the overlay box held over it. */
export async function scanRect(page: Page) {
  const box = await overlayBounds(page)
  return { left: box.x, top: box.y, width: box.width, height: box.height }
}

/** The scan's drawn width as a multiple of the pane it sits in - the number the zoom
 *  controls are expressed in, where 1 is the scan at the pane's width. */
export async function scanZoom(page: Page) {
  const scan = await scanRect(page)
  const pane = await page.getByTestId('overlay-pane').evaluate((el) => el.clientWidth)
  return scan.width / pane
}

/** Where a point of the page lands in the window, through the overlay's own transform -
 *  so it follows the scan through a turn, which `toPixels` measuring a bounding rectangle
 *  cannot. */
export async function pageToScreen(page: Page, [nx, ny]: NormPoint) {
  const pane = await page.getByTestId('overlay-pane').evaluate((el) => {
    const r = el.getBoundingClientRect()
    return { x: r.left + el.clientLeft, y: r.top + el.clientTop }
  })
  const local = await page.getByTestId('overlay-box').evaluate((el, at) => {
    const m = new DOMMatrixReadOnly(getComputedStyle(el).transform)
    const lx = at[0] * el.clientWidth
    const ly = at[1] * el.clientHeight
    return { x: m.a * lx + m.c * ly + m.e, y: m.b * lx + m.d * ly + m.f }
  }, [nx, ny])
  return { x: pane.x + local.x, y: pane.y + local.y }
}

/** How far the view is turned, in degrees clockwise. Read off the overlay's transform,
 *  because a turned box's bounding rectangle says nothing about the turn. */
export async function scanTurn(page: Page) {
  return page.getByTestId('overlay-box').evaluate((el) => {
    const m = new DOMMatrixReadOnly(getComputedStyle(el).transform)
    return (Math.atan2(m.b, m.a) * 180) / Math.PI
  })
}

/** Put two fingers on the pane and move them, as a touch device would. Playwright drives
 *  one mouse, so the pointers are dispatched in the page - the same events a finger
 *  delivers, and the same handlers they land in. */
export async function twoFingers(
  page: Page,
  steps: { a: [number, number]; b: [number, number] }[],
) {
  await page.getByTestId('overlay-pane').evaluate((pane, frames) => {
    const ev = (type: string, id: number, at: number[], buttons: number) =>
      new PointerEvent(type, {
        pointerId: id, pointerType: 'touch', isPrimary: id === 1, bubbles: true,
        cancelable: true, clientX: at[0], clientY: at[1], button: 0, buttons,
      })
    const [first, ...rest] = frames
    pane.dispatchEvent(ev('pointerdown', 1, first.a, 1))
    pane.dispatchEvent(ev('pointerdown', 2, first.b, 1))
    for (const f of rest) {
      pane.dispatchEvent(ev('pointermove', 1, f.a, 1))
      pane.dispatchEvent(ev('pointermove', 2, f.b, 1))
    }
    const last = frames[frames.length - 1]
    pane.dispatchEvent(ev('pointerup', 1, last.a, 0))
    pane.dispatchEvent(ev('pointerup', 2, last.b, 0))
  }, steps)
}

/** Two fingers spreading apart from the middle of the pane, by the given factor. */
export async function pinchOut(page: Page, factor: number, from = 60) {
  const pane = (await page.getByTestId('overlay-pane').boundingBox())!
  const mid = { x: pane.x + pane.width / 2, y: pane.y + pane.height / 2 }
  const steps = []
  for (let i = 0; i <= 10; i++) {
    const r = from * (1 + ((factor - 1) * i) / 10)
    steps.push({ a: [mid.x - r, mid.y] as [number, number],
                 b: [mid.x + r, mid.y] as [number, number] })
  }
  await twoFingers(page, steps)
}

/** Two fingers turning about the middle of the pane, through the given angle. */
export async function twistBy(page: Page, degrees: number, radius = 140) {
  const pane = (await page.getByTestId('overlay-pane').boundingBox())!
  const mid = { x: pane.x + pane.width / 2, y: pane.y + pane.height / 2 }
  const at = (d: number) => {
    const rad = (d * Math.PI) / 180
    return { a: [mid.x + radius * Math.cos(rad), mid.y + radius * Math.sin(rad)] as [number, number],
             b: [mid.x - radius * Math.cos(rad), mid.y - radius * Math.sin(rad)] as [number, number] }
  }
  const steps = []
  for (let i = 0; i <= 12; i++) steps.push(at((degrees * i) / 12))
  await twoFingers(page, steps)
}

/** How far across the scan a viewport x sits, as a fraction of its width. */
export async function scanFractionAt(page: Page, clientX: number) {
  const scan = await scanRect(page)
  return (clientX - scan.left) / scan.width
}

export async function hoverAt(page: Page, point: NormPoint) {
  const { x, y } = await toPixels(page, point)
  await page.mouse.move(x, y, { steps: 5 })
}

/** Click a point of the page through the overlay's own transform, so the click follows the
 *  scan through a turn - which `clickAt`, measuring a bounding rectangle, cannot. */
export async function clickOnScan(page: Page, point: NormPoint) {
  const { x, y } = await pageToScreen(page, point)
  await page.mouse.move(x, y, { steps: 5 })
  await page.mouse.click(x, y)
}

export async function clickAt(page: Page, point: NormPoint, options: { shift?: boolean } = {}) {
  const { x, y } = await toPixels(page, point)
  if (options.shift) await page.keyboard.down('Shift')
  await page.mouse.move(x, y, { steps: 5 })
  await page.mouse.click(x, y)
  if (options.shift) await page.keyboard.up('Shift')
}

export async function dragAt(page: Page, from: NormPoint, to: NormPoint, opts: DragOptions = {}) {
  await dragPixels(page, await toPixels(page, from), await toPixels(page, to), opts)
}

export interface DragOptions {
  ctrl?: boolean
  shift?: boolean
}

/** A press-move-release in viewport pixels, with the modifier held for the whole drag. */
export async function dragPixels(
  page: Page, start: { x: number; y: number }, end: { x: number; y: number }, opts: DragOptions = {},
) {
  if (opts.ctrl) await page.keyboard.down('Control')
  if (opts.shift) await page.keyboard.down('Shift')
  await page.mouse.move(start.x, start.y, { steps: 5 })
  await page.mouse.down()
  await page.mouse.move(end.x, end.y, { steps: 12 })
  await page.mouse.up()
  if (opts.shift) await page.keyboard.up('Shift')
  if (opts.ctrl) await page.keyboard.up('Control')
}

export async function enterEditMode(page: Page) {
  await page.getByRole('button', { name: /^Edit/ }).click()
  await expect(page.getByText('Layout complete')).toBeVisible()
}

export function center(polygon: NormPoint[]): NormPoint {
  const xs = polygon.map((p) => p[0])
  const ys = polygon.map((p) => p[1])
  return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2]
}

/** The ids of the lines this tab writes from here on, in the order the writes go out. A
 *  sweep that should have missed is proved to have by a later one that hits: whatever the
 *  first sent would already be in the list ahead of it. */
export function recordLineWrites(page: Page): number[] {
  const written: number[] = []
  page.on('request', (r) => {
    const match = r.method() !== 'GET' && r.url().match(/\/api\/lines\/(\d+)(\?|$)/)
    if (match) written.push(Number(match[1]))
  })
  return written
}
