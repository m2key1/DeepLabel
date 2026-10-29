import { test, expect } from '../helpers/test'
import { createDataset, wizardStep } from '../helpers/new-dataset'
import { getJob, uniqueName, waitForJobStatus } from '../helpers/api'

// The fixture archive (e2e/stub/iiif/server.py), as the backend reaches it on the stack's
// network. A run token keeps each scenario's pages its own; the last canvas of the v3
// manifest fails its first full-size download.
const ARCHIVE = 'http://iiif:8000'
const run = () => `r${Date.now()}${Math.floor(Math.random() * 1000)}`
const ATTRIBUTION = 'Example town archive, Council minutes, Nr. 17'
const RIGHTS = 'http://creativecommons.org/licenses/by/4.0/'

type Page = { filename: string; status: string }

test.describe('Scenario: a dataset made from a IIIF manifest', () => {
  test('pages picked by range download, a failed one comes back on retry, and the annotations export',
    async ({ page }) => {
      const token = run()
      const manifest = `${ARCHIVE}/v3/manifest.json?run=${token}`
      const name = uniqueName('From IIIF')
      await page.goto('/new')
      await page.getByLabel('Job name').fill(name)
      await page.getByTestId('source-iiif').click()
      await page.getByLabel('IIIF manifest or collection URL').fill(manifest)
      await page.getByTestId('iiif-load').click()

      await expect(page.getByTestId('iiif-label')).toHaveText('Council minutes 1781')
      await expect(page.getByTestId('iiif-pages')).toHaveText('4, IIIF Presentation 3')
      await expect(page.getByTestId('iiif-attribution')).toHaveText(ATTRIBUTION)
      await expect(page.getByTestId('iiif-rights')).toHaveText(RIGHTS)

      await page.getByTestId('wizard-next').click()
      await expect(page.getByTestId('page-pick')).toHaveText(['1 · fol. 1r', '2 · fol. 1v', '3 · fol. 2r', '4 · fol. 2v'])
      // The thumbnails come through the backend, which reached the archive for them.
      await expect(page.getByTestId('page-pick').first().locator('img'))
        .toHaveJSProperty('naturalWidth', 240)
      await page.getByTestId('page-range').fill('2-5')
      await page.getByRole('button', { name: 'Apply' }).click()
      await expect(page.getByTestId('page-range-error')).toHaveText('Give page numbers from 1 to 4, like 3-22, 35.')
      await page.getByTestId('page-range').fill('2-4')
      await page.getByRole('button', { name: 'Apply' }).click()
      await expect(page.getByTestId('page-picker-count')).toHaveText('3 of 4 pages included')
      await expect(page.getByTestId('page-pick').first()).toHaveAttribute('data-included', 'false')
      await expect(page.getByTestId('new-job-summary').locator('[data-label="Source"]'))
        .toContainText('IIIF - Council minutes 1781')

      await createDataset(page)
      await expect(page).toHaveURL(/\/jobs\/[0-9a-f]{12}$/)
      const jobId = page.url().split('/').pop()!
      await waitForJobStatus(jobId, 'done', 60_000)

      const job = await getJob(jobId)
      expect(job.iiif_source).toEqual({ manifest, label: 'Council minutes 1781', attribution: ATTRIBUTION, rights: RIGHTS })
      expect((job.pages as Page[]).map((p) => [p.filename, p.status])).toEqual([
        ['0002_fol-1v.jpg', 'done'], ['0003_fol-2r.jpg', 'done'], ['0004_fol-2v.jpg', 'unreadable']])
      expect(job.unreadable.map((p: { error: string }) => p.error))
        .toEqual(['0004_fol-2v.jpg: the server answered 404 for the image'])

      await expect(page.getByTestId('iiif-source-attribution')).toHaveText(ATTRIBUTION)
      await expect(page.getByTestId('iiif-source-manifest')).toHaveAttribute('href', manifest)
      await expect(page.getByTestId('iiif-failed')).toContainText('One page could not be downloaded')
      await page.getByTestId('iiif-retry').click()
      await expect.poll(async () => {
        const after = await getJob(jobId)
        return [after.status, after.error, after.unreadable, (after.pages as Page[]).map((p) => p.status)]
      }, { timeout: 60_000 }).toEqual(['done', null, [], ['done', 'done', 'done']])
      await expect(page.getByTestId('iiif-failed')).toHaveCount(0)
      await expect(page.getByTestId('iiif-source-line')).toBeVisible()

      await page.getByRole('button', { name: /^Export/ }).click()
      const annotations = page.locator('[data-testid="export-format"][data-format="iiif"]')
      await expect(annotations).toHaveAttribute('href', `/api/jobs/${jobId}/export?format=iiif`)
      const archive = await page.request.get(`/api/jobs/${jobId}/export?format=iiif`)
      expect(archive.status()).toBe(200)
      // A zip names its files in plain text, whatever it compresses.
      const listing = (await archive.body()).toString('latin1')
      for (const entry of ['SOURCE.txt', 'annotations/0002_fol-1v.json', 'annotations/0003_fol-2r.json',
                           'annotations/0004_fol-2v.json']) {
        expect(listing).toContain(entry)
      }
      expect(listing).not.toContain('images/')
    })

  test('a collection lists its manifests, and either version loads', async ({ page }) => {
    const token = run()
    await page.goto('/new')
    await page.getByTestId('source-iiif').click()
    await page.getByLabel('IIIF manifest or collection URL').fill(`${ARCHIVE}/collection.json?run=${token}`)
    await page.getByTestId('iiif-load').click()

    const members = page.getByTestId('iiif-member')
    await expect(members).toHaveText(['1781', '1782'])
    await expect(page.getByTestId('iiif-manifest')).toHaveCount(0)
    await members.nth(1).click()
    await expect(page.getByTestId('iiif-label')).toHaveText('Council minutes 1782')
    await expect(page.getByTestId('iiif-pages')).toHaveText('2, IIIF Presentation 2')
    await expect(members.nth(1)).toHaveAttribute('data-selected', 'true')
    await members.nth(0).click()
    await expect(page.getByTestId('iiif-pages')).toHaveText('4, IIIF Presentation 3')
  })

  test('an internal address is refused, and map datasets have no IIIF source', async ({ page }) => {
    await page.goto('/new')
    await page.getByLabel('Job name').fill(uniqueName('Refused'))
    await page.getByTestId('source-iiif').click()
    await page.getByLabel('IIIF manifest or collection URL').fill('http://backend:8000/api/jobs')
    await page.getByTestId('iiif-load').click()
    await expect(page.getByTestId('iiif-error'))
      .toHaveText(/backend is a private or internal address, which DeepLabel does not fetch from/)
    await expect(page.getByTestId('wizard-missing')).toHaveText('Load a IIIF manifest')

    await page.getByTestId('task-map_segmentation').click()
    await expect(page.getByTestId('source-iiif')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Upload files' })).toBeVisible()
    await page.getByTestId('task-text').click()
    await expect(page.getByTestId('source-iiif')).toBeVisible()
  })
})
