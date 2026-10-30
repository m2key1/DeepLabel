import { test, expect } from '../helpers/test'
import {
  backendFetch, getJob, getPageDetail, jobPageIds, markLayoutChecked, seedCompletedJob,
  setElementChecked, uniqueName,
} from '../helpers/api'
import { seedWithDuplicate } from '../helpers/map'

type Counts = Record<string, number>
const chipCounts = async (jobId: string): Promise<Counts> =>
  (await backendFetch(`/api/jobs/${jobId}/page-rows?limit=1`)).counts

test.describe('Scenario: lines and layout are reviewed apart', () => {
  test('a page with every line checked and a page with its layout checked each light one chip',
    async ({ page }) => {
      const jobId = await seedCompletedJob(uniqueName('Two review chips'), 2)
      const [linesDone, layoutDone] = await jobPageIds(jobId)
      for (const element of (await getPageDetail(jobId, linesDone)).elements) {
        await setElementChecked(element.id)
      }
      await markLayoutChecked(layoutDone)
      await expect.poll(() => chipCounts(jobId)).toMatchObject(
        { all: 2, 'lines-reviewed': 1, 'layout-reviewed': 1, 'layout-unchecked': 1 })

      await page.goto(`/jobs/${jobId}`)
      await expect(page.getByTestId('page-filter-lines-reviewed')).toHaveText('Lines reviewed · 1')
      await expect(page.getByTestId('page-filter-layout-reviewed')).toHaveText('Layout reviewed · 1')
      await expect(page.getByTestId('page-filter-all')).toHaveText('All · 2')
      await expect(page.getByTestId('job-review-count')).toHaveText('Pages checked 1/2')
      await expect(page.getByTestId('job-review-count')).toHaveAttribute('title', '1 of 2 pages with every line checked')
      await expect(page.getByRole('button', { name: /Fully reviewed/ })).toHaveCount(0)
      await expect(page.getByRole('button', { name: /Lines reviewed/ })).toHaveCount(1)

      const row = (filename: string) => page.getByRole('row').filter({ hasText: filename })
      await page.getByTestId('page-filter-lines-reviewed').click()
      await expect(page).toHaveURL(/filter=lines-reviewed$/)
      await expect(row('scan_1.png')).toHaveCount(1)
      await expect(row('scan_2.png')).toHaveCount(0)

      await page.getByTestId('page-filter-layout-reviewed').click()
      await expect(page).toHaveURL(/filter=layout-reviewed$/)
      await expect(row('scan_2.png')).toHaveCount(1)
      await expect(row('scan_1.png')).toHaveCount(0)
    })
})

test.describe('Scenario: a scan uploaded twice is one page of work', () => {
  test('the duplicate is flagged in the list and left out of every count', async ({ page }) => {
    const name = uniqueName('Counted once')
    const { jobId, tiles } = await seedWithDuplicate(name)
    expect(tiles.map((t) => [t.filename, t.status])).toEqual([
      ['tile_1.png', 'done'], ['tile_1_again.png', 'duplicate'], ['tile_2.png', 'done']])
    expect((await chipCounts(jobId)).all).toBe(2)
    const info = await backendFetch(`/api/jobs/${jobId}/info`)
    expect({ pages: info.pages, pages_duplicate: info.pages_duplicate }).toEqual({ pages: 2, pages_duplicate: 1 })
    expect((await getJob(jobId)).pages_live).toBe(2)

    await page.goto(`/jobs/${jobId}`)
    await expect(page.getByTestId('page-filter-all')).toHaveText('All · 2')
    await expect(page.getByTestId('page-filter-layout-unchecked')).toHaveText('Not reviewed · 2')
    const row = (filename: string) => page.getByRole('row').filter({ hasText: filename })
    await expect(row('tile_1_again.png').getByTestId('page-duplicate')).toHaveText('duplicate')
    await expect(row('tile_2.png')).toHaveCount(1)
    await expect(row('tile_2.png').getByTestId('page-duplicate')).toHaveCount(0)

    await page.goto('/')
    const card = page.getByTestId('job-card').filter({ hasText: name })
    await card.getByTestId('job-info-toggle').click()
    await expect(card.getByTestId('job-info').locator('[data-field="pages"]'))
      .toContainText('2 tiles · 1 duplicate not counted')
  })
})
