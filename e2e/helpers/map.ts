import { expect, type Page } from '@playwright/test'
import { backendFetch, waitForJobStatus } from './api'
import { scanPng } from './image'

// Map tile jobs, annotation-only: no tiling and no prediction, so the backend ingests
// the uploads in its own worker thread with pure Pillow. That path needs neither a GPU
// nor a stub runner, which is what makes the tile editor reachable from e2e at all.

export type NormPoint = [number, number]

// Square tiles, small enough to sit fully inside the viewport at zoom 1 so every
// normalized coordinate is clickable without scrolling the canvas.
export const TILE = { width: 512, height: 512 }

export interface Region {
  id: number
  order_idx: number
  class_id: number
  class_name: string
  points: NormPoint[]
  holes: NormPoint[][]
  kind: string
  checked: boolean
}

export async function createMapJob(
  name: string, tileCount = 1, task: 'map_segmentation' | 'map_lines' = 'map_segmentation',
): Promise<string> {
  const form = new FormData()
  form.append('name', name)
  form.append('task', task)
  form.append('run_predict', 'false')
  form.append('run_tile', 'false')
  for (let i = 0; i < tileCount; i++) {
    // Distinct content per tile: ingest drops byte-identical uploads as duplicates,
    // which would quietly shrink a multi-tile job to one usable tile.
    const png = scanPng(TILE.width, TILE.height, i)
    form.append('files', new Blob([new Uint8Array(png)], { type: 'image/png' }), `tile_${i + 1}.png`)
  }
  const res = await backendFetch('/api/jobs', { method: 'POST', body: form })
  return res.job_id
}

export async function seedMapJob(
  name: string, tileCount = 1, task: 'map_segmentation' | 'map_lines' = 'map_segmentation',
): Promise<string> {
  const jobId = await createMapJob(name, tileCount, task)
  await waitForJobStatus(jobId, 'done')
  return jobId
}

export async function tileIds(jobId: string): Promise<number[]> {
  const job = await backendFetch(`/api/jobs/${jobId}`)
  return [...job.pages].sort((a, b) => a.idx - b.idx).map((p: { id: number }) => p.id)
}

export interface Tile {
  id: number
  idx: number
  status: string
  filename: string
  width: number | null
  deleted: boolean
}

export const tileBlob = (variant: number) =>
  new Blob([new Uint8Array(scanPng(TILE.width, TILE.height, variant))], { type: 'image/png' })

export async function tilesOf(jobId: string): Promise<Tile[]> {
  const job = await backendFetch(`/api/jobs/${jobId}`)
  return [...job.pages].sort((a: Tile, b: Tile) => a.idx - b.idx)
}

/** A map job whose second upload is byte-identical to the first, so ingest keeps it as a
 *  duplicate: what a re-exported folder with the same tile under two names produces.
 *  Its tiles are tile_1.png, tile_1_again.png (the duplicate) and tile_2.png. */
export async function seedWithDuplicate(name: string): Promise<{ jobId: string; tiles: Tile[] }> {
  const form = new FormData()
  form.append('name', name)
  form.append('task', 'map_segmentation')
  form.append('run_predict', 'false')
  form.append('run_tile', 'false')
  form.append('files', tileBlob(0), 'tile_1.png')
  form.append('files', tileBlob(0), 'tile_1_again.png')
  form.append('files', tileBlob(1), 'tile_2.png')
  const { job_id: jobId } = await backendFetch('/api/jobs', { method: 'POST', body: form })
  await waitForJobStatus(jobId, 'done')
  return { jobId, tiles: await tilesOf(jobId) }
}

/** A tile's regions straight from the API - the state oracle. Soft-deleted ones are
 *  already excluded server-side, so this is what the editor should be showing. */
export async function tileRegions(jobId: string, pageId: number): Promise<Region[]> {
  const detail = await backendFetch(`/api/jobs/${jobId}/pages/${pageId}`)
  return detail.regions
}

export async function jobClasses(
  jobId: string,
): Promise<{ id: number; name: string; color: number[]; priority: number; regions: number }[]> {
  const res = await backendFetch(`/api/jobs/${jobId}/map-classes`)
  return res.classes
}

export const JSON_HEADERS = { 'Content-Type': 'application/json' }

export async function addJobClass(jobId: string, name: string, color: number[]): Promise<{ id: number }> {
  return backendFetch(`/api/jobs/${jobId}/map-classes`, {
    method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ name, color }),
  })
}

/** A region placed straight through the API, as if someone had drawn it. */
export async function seedRegion(
  pageId: number, classId: number, points: NormPoint[], kind: 'polygon' | 'polyline' = 'polygon',
): Promise<Region> {
  return backendFetch(`/api/pages/${pageId}/regions`, {
    method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ class_id: classId, points, kind }),
  })
}

export async function openTileEditor(page: Page, jobId: string, pageId: number) {
  await page.goto(`/jobs/${jobId}/tiles/${pageId}`)
  await expect(page.getByTestId('tile-canvas')).toBeVisible()
}

/** The tile's box in viewport coordinates. Exported so a test can aim past its edges:
 *  a click outside the image is clamped onto the nearest point of it. */
export async function canvasBox(page: Page) {
  const canvas = page.getByTestId('tile-canvas')
  await expect(canvas).toBeVisible()
  // Once it has stopped moving. The viewer frames the tile over a few frames - and frames
  // it again when the panels beside it settle - so a box measured the moment it appears
  // is a few pixels from where the click will land, which is a vertex placed off target.
  const box = await canvas.evaluate((el) => new Promise<
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
        reject(new Error('the tile never stopped moving'))
        return
      }
      last = now
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }))
  if (!box.width || !box.height) throw new Error('tile canvas is not measurable')
  return box
}

/** Click at a viewport position, on the tile or off it. */
export async function clickAt(page: Page, x: number, y: number) {
  await page.mouse.move(x, y, { steps: 5 })
  await page.mouse.click(x, y)
}

export async function clickTile(page: Page, [nx, ny]: NormPoint) {
  const box = await canvasBox(page)
  await page.mouse.move(box.x + box.width * nx, box.y + box.height * ny, { steps: 5 })
  // Measured again after the move, and clicked where the tile is now. Selecting something
  // on this page can move the panels beside the canvas and the canvas with them, so a
  // position worked out before the pointer got there can be a few pixels stale by the
  // time the button goes down - which is a vertex placed off target.
  const now = await canvasBox(page)
  await page.mouse.click(now.x + now.width * nx, now.y + now.height * ny)
}

export async function rightClickTile(page: Page, [nx, ny]: NormPoint) {
  const box = await canvasBox(page)
  const x = box.x + box.width * nx
  const y = box.y + box.height * ny
  await page.mouse.move(x, y, { steps: 5 })
  await page.mouse.click(x, y, { button: 'right' })
}

/**
 * Draw one shape by clicking each vertex, then finishing it. Enter rather than a click on
 * the first vertex: the close-snap radius is 12 screen px, so a small shape would close
 * itself early and drop the later vertices. `finish: 'right-click'` uses the other
 * confirming gesture, which finishes wherever the pointer is - here, the last vertex.
 * In a line job the same gesture traces a polyline.
 */
/** Draw the tile at one screen pixel per tile pixel. The export-width previews are drawn
 *  at the thickness the exporter will stroke them *as they appear on the tile*, so reading
 *  that thickness in the tile's own pixels means looking at it life-size. The editor opens
 *  with the whole tile in view instead, which is a different scale on every pane size. */
export async function atLifeSize(page: Page) {
  await page.getByTitle('Reset zoom').click()
  await expect(page.getByTestId('tile-canvas')).toBeVisible()
}

export async function drawPolygon(
  page: Page, points: NormPoint[], finish: 'enter' | 'right-click' = 'enter',
) {
  for (const point of points) await clickTile(page, point)
  if (finish === 'right-click') await rightClickTile(page, points[points.length - 1])
  else await page.keyboard.press('Enter')
}

/**
 * One held stroke: press on the first point, sweep through the rest, release on the
 * last. The canvas captures the pointer on the press, so only that has to land on it.
 * A single point is a dab - press and release without moving.
 */
export async function strokeTile(page: Page, points: NormPoint[]) {
  const box = await canvasBox(page)
  const [first, ...rest] = points.map(([nx, ny]) => ({ x: box.x + box.width * nx, y: box.y + box.height * ny }))
  await page.mouse.move(first.x, first.y, { steps: 5 })
  await page.mouse.down()
  for (const p of rest) await page.mouse.move(p.x, p.y, { steps: 12 })
  await page.mouse.up()
}

/** One eraser stroke from `from` to `to`; the same point twice is the single dab of a press. */
export async function eraseStroke(page: Page, from: NormPoint, to: NormPoint = from) {
  await strokeTile(page, from === to ? [from] : [from, to])
}

/** Drag a selected region's vertex handle from one normalized point to another. */
export async function dragVertex(page: Page, from: NormPoint, to: NormPoint) {
  await strokeTile(page, [from, to])
}

/** Outline an area with the detect tool and run the detector on it. */
export async function detectInOutline(page: Page, points: NormPoint[]) {
  for (const point of points) await clickTile(page, point)
  await page.keyboard.press('Enter')
}

/** Drag the detect tool's box over an area and run the detector on it. */
export async function detectInBox(page: Page, from: NormPoint, to: NormPoint) {
  const box = await canvasBox(page)
  const at = ([nx, ny]: NormPoint) => ({ x: box.x + box.width * nx, y: box.y + box.height * ny })
  const a = at(from)
  const b = at(to)
  await page.mouse.move(a.x, a.y, { steps: 5 })
  await page.mouse.down()
  await page.mouse.move(b.x, b.y, { steps: 12 })
  await page.mouse.up()
}

/** Where the e2e stub puts its line: a diagonal inset a quarter into the area's bbox. */
export function stubLineFor(area: NormPoint[]): NormPoint[] {
  const xs = area.map((p) => p[0])
  const ys = area.map((p) => p[1])
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)]
  const [y0, y1] = [Math.min(...ys), Math.max(...ys)]
  const dx = (x1 - x0) / 4
  const dy = (y1 - y0) / 4
  return [[x0 + dx, y0 + dy], [x0 + 2 * dx, y0 + 2 * dy], [x1 - dx, y1 - dy]]
}

/** Normalized [0,1] region geometry, rounded, so assertions can name exact values. */
export function roundPoints(points: NormPoint[], places = 2): NormPoint[] {
  const f = 10 ** places
  return points.map(([x, y]) => [Math.round(x * f) / f, Math.round(y * f) / f] as NormPoint)
}
