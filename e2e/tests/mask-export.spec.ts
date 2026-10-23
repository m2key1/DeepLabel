import type { Page } from '@playwright/test'
import { test, expect } from '../helpers/test'
import { BACKEND, backendFetch, uniqueName } from '../helpers/api'
import {
  type NormPoint, drawPolygon, openTileEditor, seedMapJob, tileIds, tileRegions,
} from '../helpers/map'
import { zipEntries } from '../helpers/zip'

const SQUARE: NormPoint[] = [[0.2, 0.2], [0.6, 0.2], [0.6, 0.6], [0.2, 0.6]]

const HEADERS = {
  'X-Frontend-Secret': 'e2e-secret',
  'X-Auth-User': 'e2e-seeder',
  'X-Auth-Role': 'admin',
}

async function annotateTile(page: Page, jobId: string, tileId: number) {
  await openTileEditor(page, jobId, tileId)
  await drawPolygon(page, SQUARE)
  await expect.poll(async () => (await tileRegions(jobId, tileId)).length).toBe(1)
}

async function maskZip(jobId: string): Promise<Buffer> {
  const res = await fetch(`${BACKEND}/api/jobs/${jobId}/maskset`, { headers: HEADERS })
  if (!res.ok) throw new Error(`maskset download failed: ${res.status} ${await res.text()}`)
  return Buffer.from(await res.arrayBuffer())
}

test.describe('Scenario: exporting a mask set for training', () => {
  test('only reviewed tiles are exported, and the dialog counts what it will write', async ({ page }) => {
    const jobId = await seedMapJob(uniqueName('Mask export'), 2)
    const [first, second] = await tileIds(jobId)
    await annotateTile(page, jobId, first)
    await annotateTile(page, jobId, second)

    // Nothing reviewed yet: the export refuses rather than shipping a half-annotated set.
    await expect.poll(async () => (await backendFetch(`/api/jobs/${jobId}/maskset/preview`)).tiles).toBe(0)
    const refused = await fetch(`${BACKEND}/api/jobs/${jobId}/maskset`, { headers: HEADERS })
    expect(refused.status).toBe(400)

    // Review exactly one tile.
    await openTileEditor(page, jobId, first)
    await page.getByTestId('tile-reviewed').click()
    await expect(page.getByTestId('tile-reviewed')).toBeChecked()
    await expect.poll(async () => (await backendFetch(`/api/jobs/${jobId}/maskset/preview`)).tiles).toBe(1)

    // The dialog reports the same scope the backend would write.
    await page.goto(`/jobs/${jobId}`)
    await page.getByRole('button', { name: 'Export to server' }).click()
    const preview = page.getByTestId('mask-export-preview')
    await expect(preview).toHaveAttribute('data-tiles', '1')
    await expect(preview).toHaveAttribute('data-regions', '1')

    // The zip carries one mask + one sidecar for the reviewed tile, plus the class map -
    // the unreviewed tile is absent.
    const entries = zipEntries(await maskZip(jobId))
    expect(entries.filter((n) => n.endsWith('.png'))).toHaveLength(1)
    expect(entries.filter((n) => n.startsWith('annotations/') && n.endsWith('.json'))).toHaveLength(1)
    expect(entries).toContain('class_map.json')
  })

  // The download used to be a plain link to the API route, so a server that answered with
  // an error instead of a zip replaced the whole app with that response - the user was
  // thrown out of the site by a button that should have said "nothing to export yet".
  test('the mask download reports a refusal in place instead of navigating away', async ({ page }) => {
    const jobId = await seedMapJob(uniqueName('Mask download'), 1)
    const [tileId] = await tileIds(jobId)
    await annotateTile(page, jobId, tileId)

    // Annotated but not reviewed: nothing to export, and the button says so rather than
    // offering a click that can only fail.
    await page.goto(`/jobs/${jobId}`)
    const masks = page.getByRole('button', { name: 'Masks (zip)' })
    await expect(masks).toBeDisabled()
    await expect(page.getByTitle(/mark tiles reviewed/i)).toBeVisible()

    await openTileEditor(page, jobId, tileId)
    await page.getByTestId('tile-reviewed').click()
    await expect(page.getByTestId('tile-reviewed')).toBeChecked()

    // Now it downloads - the app stays where it was, and the file is named after the job.
    await page.goto(`/jobs/${jobId}`)
    await expect(masks).toBeEnabled()
    const download = await Promise.all([page.waitForEvent('download'), masks.click()])
    expect((await download[0]).suggestedFilename()).toMatch(/-masks\.zip$/)
    await expect(page.getByRole('button', { name: 'Export to server' })).toBeVisible()

    // And a refusal is a message on the page, not a page of its own.
    await page.route('**/maskset', (route) =>
      route.fulfill({ status: 400, contentType: 'application/json',
                      json: { detail: 'no tiles to export' } }))
    await masks.click()
    await expect(page.getByText('no tiles to export')).toBeVisible()
    expect(new URL(page.url()).pathname).toBe(`/jobs/${jobId}`)
  })

  // The datasets list used to offer every map job the text pipeline's json/md/txt/zip. A
  // tile's annotations are regions, not elements and lines, so all four downloaded an empty
  // file that looked like a successful export.
  test('the datasets list offers a map job its masks, not the text formats', async ({ page }) => {
    const name = uniqueName('Mask menu')
    const jobId = await seedMapJob(name, 1)
    const [tileId] = await tileIds(jobId)
    await annotateTile(page, jobId, tileId)

    await page.goto('/')
    const card = page.getByTestId('job-card').filter({ hasText: name })
    await card.getByRole('button', { name: 'Download' }).click()

    const masks = card.getByRole('button', { name: 'Masks (zip)' })
    await expect(masks).toBeVisible()
    for (const format of ['zip', 'json', 'md', 'txt']) {
      await expect(card.getByRole('link', { name: format, exact: true })).toHaveCount(0)
    }
    // These tiles were uploaded ready-made, so there is no source map to stitch them into.
    await expect(card.getByRole('button', { name: 'Full maps (zip)' })).toHaveCount(0)
    // Annotated but unreviewed: the entry is off rather than offering a click that only fails.
    await expect(masks).toBeDisabled()

    await openTileEditor(page, jobId, tileId)
    await page.getByTestId('tile-reviewed').click()
    await expect(page.getByTestId('tile-reviewed')).toBeChecked()

    await page.goto('/')
    await card.getByRole('button', { name: 'Download' }).click()
    const download = await Promise.all([page.waitForEvent('download'), masks.click()])
    expect((await download[0]).suggestedFilename()).toMatch(/-masks\.zip$/)
    // Still on the datasets list: the download is a fetch, not a navigation.
    expect(new URL(page.url()).pathname).toBe('/')
  })

  // The card's review bar deep-links into the tile table, where the chips used to be the
  // text pipeline's: "Layout unchecked" for a flag the rest of the app calls reviewed, next
  // to two filters that matched no tile at all (a map job's element counters are all 0).
  test('the tile table filters speak about review, not layout and lines', async ({ page }) => {
    const name = uniqueName('Tile filters')
    const jobId = await seedMapJob(name, 2)
    const [first] = await tileIds(jobId)

    await openTileEditor(page, jobId, first)
    await page.getByTestId('tile-reviewed').click()
    await expect(page.getByTestId('tile-reviewed')).toBeChecked()

    await page.goto('/')
    await page.getByTestId('job-card').filter({ hasText: name })
      .getByTestId('layout-progress-link').click()
    await expect(page).toHaveURL(new RegExp(`/jobs/${jobId}\\?filter=layout-unchecked$`))

    // Each chip carries its own count, so match the label and leave the tally alone.
    await expect(page.getByTestId('page-filter-layout-unchecked')).toHaveText(/^Not reviewed/)
    await expect(page.getByTestId('page-filter-reviewed')).toHaveText(/^Reviewed/)
    await expect(page.getByTestId('page-filter-unreviewed-lines')).toHaveCount(0)

    // And both review filters actually select something, which the text tests never could.
    // Each is pinned to the tile it must show: a count alone is satisfied by the row the
    // previous filter left standing while the next answer is still on its way.
    const rows = page.getByRole('row').filter({ hasText: '.png' })
    await expect(rows).toHaveCount(1)
    await expect(rows.filter({ hasText: 'tile_2.png' })).toHaveCount(1)
    await expect(page.getByTestId('page-filter-reviewed')).toHaveText('Reviewed · 1')
    // The chip's filter is the table's own query, so the backend answers for it too.
    const reviewed = await backendFetch(`/api/jobs/${jobId}/page-rows?filter=reviewed`)
    expect(reviewed.matched).toBe(1)
    expect(reviewed.rows.map((r: { id: number }) => r.id)).toEqual([first])
    await page.getByTestId('page-filter-reviewed').click()
    await expect(rows.filter({ hasText: 'tile_1.png' })).toHaveCount(1)
    await expect(rows.filter({ hasText: 'tile_2.png' })).toHaveCount(0)
    await page.getByTestId('page-filter-all').click()
    await expect(rows).toHaveCount(2)
  })

  test('a job whose tiles were uploaded cannot be asked to fuse them', async ({ page }) => {
    const jobId = await seedMapJob(uniqueName('No fusion'), 1)
    await page.goto(`/jobs/${jobId}`)
    await expect(page.getByRole('button', { name: 'Masks (zip)' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Full maps (zip)' })).toHaveCount(0)

    // The dialog hides the variant for the same reason, and the server refuses it anyway.
    await page.getByRole('button', { name: 'Export to server' }).click()
    await expect(page.getByTestId('mask-export-fused')).toHaveCount(0)
    const refused = await fetch(`${BACKEND}/api/jobs/${jobId}/maskset?fused=true`, { headers: HEADERS })
    expect(refused.status).toBe(400)
    expect(await refused.text()).toContain('tiled source maps')
  })

  test('include_all exports the unreviewed tiles too, each under its own name', async ({ page }) => {
    const jobId = await seedMapJob(uniqueName('Mask export all'), 2)
    const [first, second] = await tileIds(jobId)
    await annotateTile(page, jobId, first)
    await annotateTile(page, jobId, second)

    const res = await fetch(`${BACKEND}/api/jobs/${jobId}/maskset?include_all=true`, { headers: HEADERS })
    expect(res.status).toBe(200)
    const masks = zipEntries(Buffer.from(await res.arrayBuffer())).filter((n) => n.endsWith('.png'))
    // Two distinct entries: a name collision would silently drop one tile's mask.
    expect(masks).toHaveLength(2)
    expect(new Set(masks).size).toBe(2)
  })
})
