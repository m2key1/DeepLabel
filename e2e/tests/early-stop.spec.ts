import { test, expect } from '../helpers/test'
import {
  backendFetch, createTraining, listRegistryModels, listTrainings, markLinesChecked, seedDistinctPagesJob, uniqueName,
} from '../helpers/api'
import { pickDataset, startTraining } from '../helpers/training'

async function checkedMaterial(name: string): Promise<{ jobId: string; datasetName: string }> {
  const datasetName = uniqueName(name)
  const jobId = await seedDistinctPagesJob(datasetName, 2, 40)
  await markLinesChecked(jobId, 12)
  return { jobId, datasetName }
}

async function openForm(page: import('@playwright/test').Page, modelName: string, datasetName: string) {
  await page.goto('/models/train?task=ocr')
  await page.getByLabel('Model name').fill(modelName)
  await pickDataset(page, datasetName)
  await page.getByTestId('advanced-toggle').click()
}

// Decision 313: a fine-tune left on the defaults stops after ten validations without a
// better score, and a run past its best can be ended keeping that best.
test.describe('Scenario: a fine-tune stops once its validation stops improving', () => {
  test('a run from a trained model starts with early stop on, and it reaches the run', async ({ page }) => {
    const { datasetName } = await checkedMaterial('Early stop data')
    const modelName = uniqueName('Stops early')
    await openForm(page, modelName, datasetName)

    await expect(page.getByTestId('early-stop-toggle')).toBeChecked()
    await expect(page.getByLabel('Patience')).toHaveValue('10')
    await expect(page.getByTestId('submit-summary')).toContainText('early stop after 10')

    await startTraining(page)
    await expect.poll(async () => (await listTrainings()).find((t) => t.name === modelName)?.hyperparams)
      .toEqual({ patience: 10 })
  })

  test('a run from scratch starts with it off, and a long one is warned about', async ({ page }) => {
    const { datasetName } = await checkedMaterial('No early stop data')
    const modelName = uniqueName('Trains it all')
    await openForm(page, modelName, datasetName)

    await page.getByLabel('Base model').selectOption('')
    await expect(page.getByTestId('early-stop-toggle')).not.toBeChecked()
    await page.getByLabel('Epochs', { exact: true }).fill('20')
    const warning = page.getByTestId('no-early-stop-warning')
    await expect(warning).toHaveText('Early stop is off: all 20 epochs run, even after validation stops improving.')

    await page.getByTestId('early-stop-toggle').check()
    await expect(warning).toHaveCount(0)
    await page.getByTestId('early-stop-toggle').uncheck()
    await expect(warning).toBeVisible()

    await startTraining(page)
    await expect.poll(async () => (await listTrainings()).find((t) => t.name === modelName)?.hyperparams)
      .toEqual({})
  })

  test('a run past its best is stopped there, and that epoch becomes the model', async ({ page }) => {
    test.setTimeout(180_000)
    const { jobId } = await checkedMaterial('Stalling data')
    const base = (await listRegistryModels()).find((m) => m.task === 'ocr' && m.is_default)!
    // [stalls]: the stub is best after epoch 2 and worse for 38 epochs after, a second each;
    // it has no early stopping of its own, so only the button ends it before then.
    const created = await createTraining({
      task: 'ocr', name: uniqueName('Past its best [stalls]'), target: 'local', base_model_id: base.id,
      val_fraction: 0.5, dataset_job_ids: [jobId],
    })

    await page.goto(`/models/runs/${created.id}`)
    const stalled = page.locator('[data-testid="run-check"][data-check="stalled"]')
    await expect(stalled).toContainText('Validation has not improved since epoch 2', { timeout: 120_000 })
    await expect(page.getByTestId('finish-training')).toHaveText('Stop and keep epoch 2')
    // Named after the headline the stub declares, CER, at its best so far (#151).
    const best = page.getByTestId('stat-best')
    await expect(best.locator('dt')).toHaveText('best CER')
    await expect(best.locator('dd')).toHaveText(['20.00%', 'e2'])
    await stalled.getByTestId('keep-best').click()

    await expect.poll(async () => (await listTrainings()).find((t) => t.id === created.id)?.status,
                      { timeout: 60_000 }).toBe('done')
    const run = (await listTrainings()).find((t) => t.id === created.id)!
    // The stub's score at epoch 2, its best.
    expect(run.metrics?.val_metric).toBe(0.2)
    expect(run.model_id).not.toBeNull()
    const progress = await backendFetch(`/api/trainings/${created.id}/progress`)
    const lastEpoch = Math.max(...progress.points.map((p: { epoch: number }) => p.epoch))
    // Stopped after the notice (epoch 12 at the earliest) and well before its 40 epochs ran out.
    expect(lastEpoch).toBeGreaterThanOrEqual(12)
    expect(lastEpoch).toBeLessThan(40)
  })
})
