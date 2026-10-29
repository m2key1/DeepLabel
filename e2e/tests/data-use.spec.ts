import { test, expect } from '../helpers/test'
import { backendFetch, getJob, markLinesChecked, seedCompletedJob, uniqueName } from '../helpers/api'
import { openDatasetMenu } from '../helpers/dataset'
import { scanPng } from '../helpers/image'
import { createDataset, wizardStep } from '../helpers/new-dataset'
import { datasetOption } from '../helpers/training'

const ALL_ON = { training: true, test: true, external_llm: true, export: true }

const setDataUse = (jobId: string, uses: Partial<typeof ALL_ON>) => backendFetch(`/api/jobs/${jobId}/data-use`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(uses),
})

test.describe('Scenario: an owner decides what a dataset may be used for', () => {
  test('training is switched off on creation, export later, and the training form leaves it out',
    async ({ page }) => {
      const name = uniqueName('Private letters')
      const trainable = uniqueName('Open register')
      // Checked lines, or the form hides it for having nothing to train on.
      await markLinesChecked(await seedCompletedJob(trainable, 1), 3)
      await page.goto('/new')
      await page.getByLabel('Job name').fill(name)
      await page.locator('input[type="file"]').setInputFiles([{ name: 'a.png', mimeType: 'image/png', buffer: scanPng() }])
      await wizardStep(page, 'review')
      const switches = page.getByTestId('new-job-data-use')
      await switches.getByText('Training', { exact: true }).click()
      await expect(switches.getByRole('switch', { name: /^Training/ })).not.toBeChecked()
      await expect(page.getByTestId('new-job-review').locator('[data-label="Data use"]')).toContainText('no training')
      await createDataset(page)
      await expect(page).toHaveURL(/\/jobs\/[0-9a-f]{12}$/)
      const jobId = page.url().split('/').pop()!
      expect((await getJob(jobId)).data_use).toEqual({ ...ALL_ON, training: false })
      await expect(page.getByTestId('data-use-chip')).toHaveText(['no training'])

      await (await openDatasetMenu(page, 'dataset-more')).getByTestId('data-use-open').click()
      await page.getByText('Export by others', { exact: true }).click()
      await expect(page.getByRole('switch', { name: /^Export by others/ })).not.toBeChecked()
      await page.getByTestId('data-use-save').click()
      await expect.poll(async () => (await getJob(jobId)).data_use).toEqual({ ...ALL_ON, training: false, export: false })
      await expect(page.getByTestId('data-use-chip')).toHaveText(['no training', 'no export'])

      await page.goto('/models/train?task=ocr')
      await expect(await datasetOption(page, trainable)).toBeVisible()
      await expect(await datasetOption(page, name)).toHaveCount(0)
      await expect(page.getByTestId('not-trainable')).toContainText('not offered')
    })

  test('an admin who neither owns nor shares it cannot export it, and the visit is listed for the owner',
    async ({ page }) => {
      const name = uniqueName('Kept register')
      const jobId = await seedCompletedJob(name, 1)
      await setDataUse(jobId, { export: false })

      // The browser is the dev admin; the dataset belongs to the seeding account.
      await page.goto(`/jobs/${jobId}`)
      await expect(page.getByTestId('data-use-chip')).toHaveText(['no export'])
      await page.getByRole('button', { name: /^Export/ }).click()
      await expect(page.getByTestId('export-blocked')).toContainText('Ask e2e-seeder for a copy')
      await expect(page.getByTestId('export-format')).toHaveCount(0)
      expect((await page.request.get(`/api/jobs/${jobId}/export?format=txt`)).status()).toBe(403)

      const visits = await backendFetch(`/api/jobs/${jobId}/data-use`)
      expect(visits.admin_visits.map((v: { username: string }) => v.username)).toEqual(['dev'])

      // Once the owner allows it again, the same menu offers the formats.
      await setDataUse(jobId, { export: true })
      await page.reload()
      await page.getByRole('button', { name: /^Export/ }).click()
      await expect(page.getByTestId('export-format').first()).toBeVisible()
      await expect(page.getByTestId('export-blocked')).toHaveCount(0)
    })
})
