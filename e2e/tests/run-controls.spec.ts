import { test, expect } from '../helpers/test'
import {
  backendFetch, getJob, jobPageIds, listTrainings, seedCompletedJob, uniqueName,
} from '../helpers/api'
import { pickDataset, startTraining } from '../helpers/training'

test.describe('Scenario: cancelling only what is still to run', () => {
  test('a finished dataset cannot be cancelled into looking unfinished', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Already done'), 1)
    expect((await getJob(jobId)).status).toBe('done')

    // A Cancel click that arrives after the run finished - a stale tab, a slow network.
    const answer = await page.request.post(`/api/jobs/${jobId}/cancel`)
    expect(answer.status()).toBe(409)
    expect((await getJob(jobId)).status).toBe('done')
  })
})

test.describe('Scenario: tuning a line-segmentation training', () => {
  test('a knob with named settings is picked from them and reaches the run', async ({ page }) => {
    const datasetName = uniqueName('Traced lines')
    const jobId = await seedCompletedJob(datasetName, 2)
    for (const pageId of await jobPageIds(jobId)) {
      await backendFetch(`/api/pages/${pageId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lines_checked: true }),
      })
    }
    const modelName = uniqueName('Line detector')

    await page.goto('/models/train?task=lines')
    await page.getByLabel('Model name').fill(modelName)
    await pickDataset(page, datasetName)
    await page.getByTestId('advanced-toggle').click()
    const modelGroup = page.getByTestId('knob-group').filter({ has: page.getByText('Model', { exact: true }) })
    await modelGroup.locator('summary').click()

    // The trainer accepts three detector sizes by name, so those are what is offered.
    const variant = page.locator('#training-knob-variant')
    await expect(variant).toBeVisible()
    await expect(variant.locator('option')).toHaveText([/^Default/, 'tiny', 'small', 'medium'])
    await variant.selectOption('small')
    await expect(page.getByTestId('tuned-count')).toHaveText('· 1 tuned')

    const answer = page.waitForResponse((r) => r.url().endsWith('/api/trainings')
                                             && r.request().method() === 'POST')
    await startTraining(page)
    expect((await answer).status()).toBe(200)

    // Backend oracle: the run carries the size that was picked, as the word it is.
    await expect.poll(async () => (await listTrainings()).find((t) => t.name === modelName)?.hyperparams)
      .toMatchObject({ variant: 'small' })
  })

  // README: a lines run trains each line as a polygon, a rotated rectangle or a box, and
  // starts on the shape its model declares. The stub's lines backend declares "box", which
  // is neither DeepLabel's own default (rotated) nor its fallback (polygon).
  test('the form starts on the line shape its model declares, and the one picked reaches the run', async ({ page }) => {
    const datasetName = uniqueName('Shaped lines')
    const jobId = await seedCompletedJob(datasetName, 2)
    for (const pageId of await jobPageIds(jobId)) {
      await backendFetch(`/api/pages/${pageId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lines_checked: true }),
      })
    }
    const modelName = uniqueName('Rotated lines')

    await page.goto('/models/train?task=lines')
    await page.getByLabel('Model name').fill(modelName)
    await pickDataset(page, datasetName)
    const shape = page.getByLabel('Line shape', { exact: true })
    await expect(shape).toHaveValue('box')
    await expect(shape.locator('option')).toHaveText([
      'Polygon - each line exactly as it is outlined',
      'Rotated rectangle - the smallest rectangle round the line, at its slant',
      "Box - the upright rectangle round the line (this model's default)",
    ])
    await shape.selectOption('rotated')
    await startTraining(page)

    // Backend oracle: the run keeps the shape that was picked, not the model's default.
    await expect.poll(async () => (await listTrainings()).find((t) => t.name === modelName)?.line_shape)
      .toBe('rotated')
    const run = (await listTrainings()).find((t) => t.name === modelName)!
    await page.goto(`/models/runs/${run.id}?tab=settings`)
    await expect(page.getByTestId('run-settings').locator('[data-setting="line shape"] dd'))
      .toHaveText('rotated rectangle')
  })

  test('an OCR run has no lines to shape', async ({ page }) => {
    await page.goto('/models/train?task=lines')
    await expect(page.getByLabel('Line shape', { exact: true })).toBeVisible()
    await page.goto('/models/train?task=ocr')
    await expect(page.getByLabel('Model name')).toBeVisible()
    await expect(page.getByLabel('Line shape', { exact: true })).toHaveCount(0)
  })
})
