import { test, expect } from '../helpers/test'
import {
  TEST_SCAN_WIDTH, backendFetch, createTraining, importStubModel, listEvaluations, listTrainings, markLinesChecked,
  markTestPages, seedDistinctPagesJob, setModelColumn, uniqueName,
} from '../helpers/api'

const pct = (cer: number) => `${(cer * 100).toFixed(2)}%`

// README: the Evaluations list is one table (#124): a row per model, a column per thing it was
// scored on, one score per cell in the mode Automatic reads with, beside its change against
// the model it was trained from.
test.describe('Scenario: every model against every test set, at a glance', () => {
  test('one row per model, one Automatic score per cell with its change, each opening its evaluation', async ({ page }) => {
    test.setTimeout(240_000)
    const trainJob = await seedDistinctPagesJob(uniqueName('List train'), 2, 600)
    await markLinesChecked(trainJob, 12)
    const testName = uniqueName('List test')
    const testJob = await seedDistinctPagesJob(testName, 1, 640, TEST_SCAN_WIDTH)
    await markLinesChecked(testJob, 6)
    await markTestPages(testJob)
    const name = uniqueName('Listed model')
    const base = importStubModel('ocr', `${name} base`, 'stub-misread')
    await createTraining({ task: 'ocr', name, dataset_job_ids: [trainJob], target: 'local', base_model_id: base,
                           epochs: 3, batch_size: 4, val_fraction: 0.3, test_job_ids: [testJob] })
    const run = async () => (await listTrainings()).find((t) => t.name === name)
    await expect.poll(async () => (await run())?.status, { timeout: 90_000 }).toBe('done')
    const trained = (await run())!.model_id!
    // A second score of the base on the same test pages, in another mode: the cell stays one.
    const evaluate = (modelId: number, decode: string) => backendFetch('/api/evaluations', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model_id: modelId, job_ids: [testJob], decode }),
    })
    await evaluate(base, 'greedy')
    // A trained stub misreads exactly as its base does, so their change is nothing; a model
    // that reads every line right, recorded as trained from the base, has one to show.
    const exact = importStubModel('ocr', `${name} exact`, 'stub-slow')
    setModelColumn(exact, 'trained_from', base)
    await evaluate(exact, 'rescored')
    const models = [base, trained, exact]
    const done = async () => (await listEvaluations()).filter((e) => models.includes(e.model_id) && e.status === 'done')
    await expect.poll(async () => (await done()).length, { timeout: 120_000 }).toBe(6)
    const runId = (await run())!.id
    const evals = await done()
    // What the run scored, in the mode Automatic reads with: the base's greedy score is not one of them.
    const score = (model: number, onTest: boolean) => evals.find((e) => e.model_id === model && e.training_id === runId
      && (onTest ? e.source.jobs?.[0] === testJob : e.source.snapshot === runId))!
    const exactScore = evals.find((e) => e.model_id === exact)!
    expect(score(trained, false).cer).toBe(score(base, false).cer)
    expect(score(trained, true).cer).toBe(score(base, true).cer)

    // A search narrows the rows to the models it names, and the columns to where they were scored.
    await page.goto('/models/evaluations')
    await page.getByRole('searchbox', { name: 'Search models' }).fill(name)
    const row = (model: number) => page.locator(`[data-testid="eval-model-row"][data-model="${model}"]`)
    const cell = (model: number, material: string) => row(model).locator(`[data-material="${material}"]`)
    await expect(row(trained)).toHaveCount(1)
    await expect(row(base)).toHaveCount(1)
    await expect(row(exact)).toHaveCount(1)
    await expect(page.getByRole('columnheader', { name: testName })).toBeVisible()

    // The trained model on its own run's validation lines and on the test set, reading as its
    // base does there; the exact reader gains the base's whole error rate.
    await expect(cell(trained, 'valid').getByRole('link')).toHaveText(pct(score(trained, false).cer!))
    await expect(cell(trained, testJob).getByRole('link')).toHaveText(pct(score(trained, true).cer!))
    await expect(cell(trained, 'valid').getByTestId('score-change')).toHaveCount(0)
    await expect(cell(trained, testJob).getByTestId('score-change')).toHaveCount(0)
    await expect(cell(exact, testJob).getByRole('link')).toHaveText(pct(exactScore.cer!))
    await expect(cell(exact, testJob).getByTestId('score-change'))
      .toHaveText(`▼ ${((score(base, true).cer! - exactScore.cer!) * 100).toFixed(2)}`)
    // The base: its Automatic score, not the greedy one, and no run of its own to be validated on.
    await expect(cell(base, testJob).getByRole('link')).toHaveAttribute('href', `/evaluations/${score(base, true).id}`)
    await expect(cell(base, testJob).getByRole('link')).toHaveText(pct(score(base, true).cer!))
    await expect(cell(base, 'valid')).toHaveText('-')

    await cell(trained, testJob).getByRole('link').click()
    await expect(page).toHaveURL(new RegExp(`/evaluations/${score(trained, true).id}(\\?|$)`))

    // The search outlives a visit to an evaluation.
    await page.goBack()
    await expect(page.getByRole('searchbox', { name: 'Search models' })).toHaveValue(name)
    await page.getByRole('searchbox', { name: 'Search models' }).fill(`${name} base`)
    await expect(row(base)).toHaveCount(1)
    await expect(row(trained)).toHaveCount(0)
  })
})
