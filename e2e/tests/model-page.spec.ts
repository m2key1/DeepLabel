import { test, expect } from '../helpers/test'
import {
  TEST_SCAN_WIDTH, backendFetch, createTraining, importStubModel, listEvaluations, listTrainings, markLinesChecked,
  markTestPages, seedDistinctPagesJob, uniqueName,
} from '../helpers/api'

const pct = (cer: number) => `${(cer * 100).toFixed(2)}%`

interface SplitCount { pages: number; items: number }
interface StoredPreflight {
  result: { split: { datasets: ({ job_id: string } & Record<'train' | 'val' | 'test', SplitCount>)[] } }
}

// README: a model and the run that made it are one page (#123). It opens on what the model
// is, what it learned from, how the training went and how well it reads; every other figure
// is one tab away.
test.describe('Scenario: a model page says what a model learned from and how it went', () => {
  test('a finished run opens as its model, with scores, data, training and lines at first sight', async ({ page }) => {
    test.setTimeout(240_000)
    const trainJob = await seedDistinctPagesJob(uniqueName('Model page train'), 2, 300)
    await markLinesChecked(trainJob, 12)
    const testJob = await seedDistinctPagesJob(uniqueName('Model page test'), 1, 340, TEST_SCAN_WIDTH)
    await markLinesChecked(testJob, 6)
    await markTestPages(testJob)
    const name = uniqueName('Model page')
    const base = importStubModel('ocr', `${name} base`, 'stub-misread')
    await createTraining({
      task: 'ocr', name, dataset_job_ids: [trainJob], target: 'local', base_model_id: base,
      epochs: 3, batch_size: 4, val_fraction: 0.3, test_job_ids: [testJob],
    })
    const run = async () => (await listTrainings()).find((t) => t.name === name)
    await expect.poll(async () => (await run())?.status, { timeout: 90_000 }).toBe('done')
    const finished = (await run())!
    const scores = async () => (await listEvaluations()).filter((e) => e.training_id === finished.id)
    await expect.poll(async () => (await scores()).filter((e) => e.status === 'done').length,
                      { timeout: 120_000 }).toBe(4)
    const evals = await scores()
    const scoreOf = (modelId: number, onTest: boolean) =>
      evals.find((e) => e.model_id === modelId && (onTest ? e.source.jobs !== undefined : e.source.snapshot !== undefined))!
    const preflight = await backendFetch(`/api/trainings/${finished.id}/preflight`) as StoredPreflight
    const split = (jobId: string) => preflight.result.split.datasets.find((d) => d.job_id === jobId)!

    // The run's own address forwards to the model it made.
    await page.goto(`/models/runs/${finished.id}`)
    await expect(page).toHaveURL(new RegExp(`/models/${finished.model_id}(\\?|$)`))
    await expect(page.getByRole('heading', { level: 1, name })).toBeVisible()

    // Scores: the model and its base on each material, in Automatic decoding.
    const cell = (role: string, material: string) =>
      page.locator(`[data-testid="score-row"][data-role="${role}"] [data-material="${material}"]`)
    await expect(cell('new', 'valid')).toContainText(pct(scoreOf(finished.model_id!, false).cer!))
    await expect(cell('base', 'valid')).toContainText(pct(scoreOf(base, false).cer!))
    await expect(cell('new', testJob)).toContainText(pct(scoreOf(finished.model_id!, true).cer!))
    await expect(cell('base', testJob)).toContainText(pct(scoreOf(base, true).cer!))

    // Trained on: each dataset with the lines it gave to each split, as the pre-flight cut them.
    const dataset = (jobId: string, column: string) =>
      page.locator(`[data-testid="trained-on-row"][data-job="${jobId}"] [data-column="${column}"]`)
    await expect(dataset(trainJob, 'train')).toHaveText(String(split(trainJob).train.items))
    await expect(dataset(trainJob, 'val')).toHaveText(String(split(trainJob).val.items))
    await expect(dataset(testJob, 'test')).toHaveText(String(split(testJob).test.items))

    // Training at a glance.
    const fact = (key: string) => page.locator(`[data-testid="training-facts"] [data-fact="${key}"] dd`)
    await expect(fact('epochs')).toHaveText('3')
    await expect(fact('ran-on')).toHaveText('Local GPU')
    // Batch 4, accumulated up to the effective batch the stub backend declares.
    const accum = finished.grad_accum_steps!
    await expect(fact('lines-per-step')).toHaveText(`${4 * accum} (4 × ${accum})`)
    expect(accum).toBe(4)

    // The lines are the first tab, on the headline material: the test set.
    await expect(page.getByRole('tab', { name: 'Lines' })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByTestId('eval-line')).toHaveCount(scoreOf(finished.model_id!, true).line_count!)
  })

  test('a run without a model keeps its own address and shows what it trained on', async ({ page }) => {
    test.setTimeout(120_000)
    const trainJob = await seedDistinctPagesJob(uniqueName('Cancelled train'), 2, 360)
    await markLinesChecked(trainJob, 12)
    const name = uniqueName('Cancelled run')
    await createTraining({ task: 'ocr', name, dataset_job_ids: [trainJob], target: 'local', epochs: 3 })
    const id = (await listTrainings()).find((t) => t.name === name)!.id
    await backendFetch(`/api/trainings/${id}/cancel`, { method: 'POST' })
    await expect.poll(async () => (await listTrainings()).find((t) => t.id === id)?.status).toBe('cancelled')

    await page.goto(`/models/runs/${id}`)
    await expect(page.getByRole('heading', { level: 1, name })).toBeVisible()
    await expect(page).toHaveURL(new RegExp(`/models/runs/${id}(\\?|$)`))
    await expect(page.locator(`[data-testid="trained-on-row"][data-job="${trainJob}"]`)).toBeVisible()
    await expect(page.getByRole('tab', { name: 'Training' })).toBeVisible()
    await expect(page.getByTestId('score-row')).toHaveCount(0)
  })
})
