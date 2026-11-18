import { test, expect } from '../helpers/test'
import {
  createTraining, importStubModel, listEvaluations, listRegistryModels, listTrainings, markLinesChecked,
  seedCompletedJob, seedDistinctPagesJob, uniqueName,
} from '../helpers/api'
import { pickDataset, startTraining } from '../helpers/training'

const pct = (cer: number) => `${(cer * 100).toFixed(2)}%`

test.describe('Scenario: what a run is scored on', () => {
  // README: the form "warns when the split would come out empty", and the warning says what
  // follows - the baseline/result comparison is skipped. A score over no lines is not a
  // score, so there must be none to show.
  test('a run whose valid split is empty gets no scores, as the form said it would', async ({ page }) => {
    const datasetName = uniqueName('One page')
    const jobId = await seedCompletedJob(datasetName, 1)
    await markLinesChecked(jobId, 6)
    const name = uniqueName('Unscored')

    await page.goto('/models/train?task=ocr')
    await page.getByLabel('Model name').fill(name)
    await pickDataset(page, datasetName)
    await expect(page.getByText('6 checked lines selected')).toBeVisible()
    // One page at the default 10%: nothing lands in validation, and the form says so.
    await expect(page.getByTestId('empty-val-warning')).toHaveText(
      'At 10% none of the 1 eligible page would land in validation - the baseline/result comparison would be skipped.')
    await page.getByTestId('advanced-toggle').click()
    await page.getByLabel('Epochs', { exact: true }).fill('1')
    await startTraining(page)

    const run = async () => (await listTrainings()).find((t) => t.name === name)
    await expect.poll(async () => (await run())?.status, { timeout: 60_000 }).toBe('done')
    const finished = (await run())!
    expect(finished.snapshot_counts).toEqual({ train: 6, val: 0 })
    // A base model it would have been compared with, had there been anything to compare on.
    expect(finished.base_model_id).not.toBeNull()
    expect((await listRegistryModels()).some((m) => m.name === name)).toBe(true)

    // Scores are queued the moment a run registers its model, so by now there would be six
    // of them - three decodes for the base and three for the new model - over nothing.
    expect((await listEvaluations()).filter((e) => e.training_id === finished.id)).toEqual([])
    await page.goto(`/models/runs/${finished.id}`)
    await expect(page.getByTestId('stat-tile').filter({ hasText: 'lines trained' })).toBeVisible()
    await expect(page.getByTestId('score-valid-base')).toHaveCount(0)
    await expect(page.getByTestId('score-valid-new')).toHaveCount(0)
  })

  // README: "Split per dataset, every dataset with two or more pages validates on at least
  // one of them, even where its fraction rounds to none".
  test('a per-dataset split validates on one page of a two-page dataset at 10%', async ({ page }) => {
    const datasetName = uniqueName('Two small pages')
    const jobId = await seedDistinctPagesJob(datasetName, 2, 40)
    await markLinesChecked(jobId, 12)
    const name = uniqueName('Per dataset')

    await page.goto('/models/train?task=ocr')
    await page.getByLabel('Model name').fill(name)
    await pickDataset(page, datasetName)
    await expect(page.getByText('12 checked lines selected')).toBeVisible()
    // A random split over the union rounds 10% of two pages to none...
    await expect(page.getByTestId('empty-val-warning')).toHaveText(
      'At 10% none of the 2 eligible pages would land in validation - the baseline/result comparison would be skipped.')
    await page.getByTestId('advanced-toggle').click()
    await page.getByLabel('Epochs', { exact: true }).fill('1')
    // ...one cut per dataset takes one of them anyway.
    await page.getByLabel('Validation data').selectOption('stratified')
    await expect(page.getByTestId('empty-val-warning')).toHaveCount(0)
    await startTraining(page)

    const run = async () => (await listTrainings()).find((t) => t.name === name)
    await expect.poll(async () => (await run())?.snapshot_counts, { timeout: 60_000 })
      .toEqual({ train: 6, val: 6 })
  })

  // README: "Both scores sit on the run's own page beside the valid-split pair". A run scores
  // each model once, in the mode Automatic reads it with (#122); the pair shown is that one.
  test("the run page's valid scores are in the mode Automatic reads with", async ({ page }) => {
    // Two pages that differ: the split divides pages by content hash, so two copies of one
    // scan would be a single key and nothing would land in validation.
    const jobId = await seedDistinctPagesJob(uniqueName('Two pages'), 2)
    await markLinesChecked(jobId, 12)
    const name = uniqueName('Headline')
    // A misreading base, whose successor misreads too, so the scores have errors to show.
    const base = { id: importStubModel('ocr', `${name} base`, 'stub-misread') }
    await createTraining({
      task: 'ocr', name, dataset_job_ids: [jobId], target: 'local', base_model_id: base.id,
      epochs: 1, batch_size: 4, val_fraction: 0.3,
    })
    const run = async () => (await listTrainings()).find((t) => t.name === name)
    await expect.poll(async () => (await run())?.status, { timeout: 60_000 }).toBe('done')
    const finished = (await run())!
    const trained = (await listRegistryModels()).find((m) => m.name === name)!
    await expect.poll(async () =>
      (await listEvaluations()).filter((e) => e.training_id === finished.id && e.status === 'done').length,
      { timeout: 60_000 }).toBe(2)

    const evals = (await listEvaluations()).filter((e) => e.training_id === finished.id)
    expect(evals.map((e) => `${e.model_id} ${e.decode}`).sort())
      .toEqual([`${trained.id} rescored`, `${base.id} rescored`].sort())
    const cerOf = (modelId: number) => evals.find((e) => e.model_id === modelId)!.cer!

    await page.goto(`/models/runs/${finished.id}`)
    await expect(page.getByTestId('score-valid-new')).toContainText(pct(cerOf(trained.id)))
    await expect(page.getByTestId('score-valid-new')).toContainText('Reranked')
    await expect(page.getByTestId('score-valid-base')).toContainText(pct(cerOf(base.id)))
  })
})
