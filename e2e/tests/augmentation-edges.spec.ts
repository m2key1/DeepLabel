import { test, expect } from '../helpers/test'
import {
  backendFetch, createTraining, listTrainings, markLinesChecked, seedCompletedJob, uniqueName,
} from '../helpers/api'

const json = { 'Content-Type': 'application/json' }
const NOTHING = { transform: { __class_fullname__: 'Compose', p: 1.0, transforms: [] } }

test.describe('Scenario: a run trained on the crops as scanned', () => {
  test('its run page says it had no augmentation, not a custom one', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Plain crops'), 2)
    await markLinesChecked(jobId, 12)
    const name = uniqueName('No augmentation run')
    await createTraining({
      task: 'ocr', name, dataset_job_ids: [jobId], target: 'local',
      epochs: 1, batch_size: 4, val_fraction: 0.3, augmentation: NOTHING,
    })
    await expect.poll(async () => (await listTrainings()).find((t) => t.name === name)?.augmentation ?? null,
                      { timeout: 30_000 }).toEqual(NOTHING)
    const run = (await listTrainings()).find((t) => t.name === name)!

    await page.goto(`/models/runs/${run.id}?tab=settings`)
    const settings = page.getByTestId('run-settings')
    const augmentation = settings.locator('div').filter({ has: page.getByText('augmentation', { exact: true }) })
    await expect(augmentation.locator('dd')).toHaveText('none')
  })
})

test.describe('Scenario: keeping pipelines apart by name', () => {
  test('duplicating a pipeline whose name fills the field still gives the copy a name of its own',
    async () => {
      const long = 'A'.repeat(80)
      const original = await backendFetch('/api/augmentations/pipelines', {
        method: 'POST', headers: json, body: JSON.stringify({ task: 'ocr', name: long, spec: NOTHING }),
      })
      const first = await backendFetch(`/api/augmentations/pipelines/${original.id}/duplicate`,
                                       { method: 'POST' })
      const second = await backendFetch(`/api/augmentations/pipelines/${original.id}/duplicate`,
                                        { method: 'POST' })
      expect(new Set([original.name, first.name, second.name]).size).toBe(3)
      for (const copy of [first, second]) expect(copy.name.length).toBeLessThanOrEqual(80)
    })

  test('a pipeline whose steps are not a list is refused as a bad request', async () => {
    const malformed = { transform: { __class_fullname__: 'Compose', p: 1.0, transforms: null } }
    await expect(backendFetch('/api/augmentations/pipelines', {
      method: 'POST', headers: json,
      body: JSON.stringify({ task: 'ocr', name: uniqueName('Malformed'), spec: malformed }),
    })).rejects.toThrow(/ 400 /)
  })
})

test.describe('Scenario: following a pointer into Settings', () => {
  test('the nav bar\'s sharing state opens the section that changes it', async ({ page }) => {
    await page.goto('/')
    await page.getByTestId('user-menu').click()
    await page.getByTestId('visibility-state').click()
    await expect(page).toHaveURL(/\/people\/dev\?section=together$/)
    await expect(page.getByTestId('share-activity')).toBeVisible()
  })
})
