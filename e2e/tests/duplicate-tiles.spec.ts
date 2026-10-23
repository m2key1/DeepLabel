import { test, expect } from '../helpers/test'
import { backendFetch, getJob, setPagesDeleted, uniqueName, waitForJobStatus } from '../helpers/api'
import { TILE, seedWithDuplicate, tileBlob, tilesOf } from '../helpers/map'

test.describe('Scenario: a map job that received the same tile twice', () => {
  test('the tile editor steps over the duplicate, which has nothing to show', async ({ page }) => {
    const { jobId, tiles } = await seedWithDuplicate(uniqueName('Duplicate tile'))
    expect(tiles.map((t) => t.status)).toEqual(['done', 'duplicate', 'done'])
    const [first, , last] = tiles

    await page.goto(`/jobs/${jobId}/tiles/${first.id}`)
    await expect(page.getByText('tile 1 / 2', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Next →' }).click()
    await expect(page).toHaveURL(new RegExp(`/tiles/${last.id}$`))
    await expect(page.getByText('tile 2 / 2', { exact: true })).toBeVisible()
  })

  // A duplicate is no work, so it is on neither side of a bar: 2/2, the same total the
  // annotated and reviewed bars count against, not 3/3.
  test('the progress strip counts the two real tiles, not the duplicate', async ({ page }) => {
    const { jobId } = await seedWithDuplicate(uniqueName('Duplicate progress'))
    const counters = (await getJob(jobId)).counters
    expect({ total: counters.pages_total, ingested: counters.pages_ingested }).toEqual({ total: 2, ingested: 2 })

    await page.goto(`/jobs/${jobId}`)
    const ingested = page.getByTestId('phase-strip').locator('[data-phase="ingest"]')
    await expect(ingested).toHaveText('Ingested2/2')
  })

  test('deleting the original lets the same tile be uploaded again and used', async () => {
    const { jobId, tiles } = await seedWithDuplicate(uniqueName('Re-upload tile'))
    const [original] = tiles
    await setPagesDeleted(jobId, [original.id])

    const form = new FormData()
    form.append('files', tileBlob(0), 'tile_1_restored.png')
    await backendFetch(`/api/jobs/${jobId}/pages/upload`, { method: 'POST', body: form })
    await waitForJobStatus(jobId, 'done')

    const added = (await tilesOf(jobId)).find((t) => !tiles.some((old) => old.id === t.id))!
    expect({ status: added.status, width: added.width }).toEqual({ status: 'done', width: TILE.width })
  })
})
