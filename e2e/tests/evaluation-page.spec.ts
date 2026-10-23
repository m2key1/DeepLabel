import { test, expect } from '../helpers/test'
import type { Page } from '@playwright/test'
import {
  backendFetch, createTraining, importStubModel, jobPageIds, listEvaluations, listRegistryModels, listTrainings,
  markLinesChecked, pageLines, seedCompletedJob, seedDistinctPagesJob, uniqueName,
} from '../helpers/api'
import { JSON_HEADERS } from '../helpers/map'

// A misreading stub model reads the n-th scored line (by line id) as: exact, first letter's
// case flipped, last digit raised by one, first space dropped with a full stop appended - at
// confidence 0.95, 0.85, 0.75, 0.65. A stub page's lines read "Sample Header line 1-3"
// then "Sample Paragraph line 1-3", so four checked lines score 4 edits over 83 characters.
const misreading = (name: string) => ({ id: importStubModel('ocr', `${name} reader`, 'stub-misread') })

async function evaluationDetail(evalId: number): Promise<{ status: string; line_rows: number }> {
  return backendFetch(`/api/evaluations/${evalId}`)
}

async function reviewQueue(jobId: string): Promise<{ id: number; flagged: boolean }[]> {
  return (await backendFetch(`/api/jobs/${jobId}/review`)).lines
}

/** A dataset with its first four lines checked, and a misreading model evaluated on them. */
async function evaluatedDataset(name: string) {
  const jobId = await seedCompletedJob(name, 1)
  await markLinesChecked(jobId, 4)
  const [pageId] = await jobPageIds(jobId)
  const lines = await pageLines(jobId, pageId)
  const byText = (text: string) => lines.find((l) => l.text === text)!.id
  const model = misreading(name)
  const evalId = await evaluate(model.id, jobId, 'beam')
  return {
    jobId, pageId, evalId, model,
    ids: {
      header1: byText('Sample Header line 1'), header2: byText('Sample Header line 2'),
      header3: byText('Sample Header line 3'), paragraph1: byText('Sample Paragraph line 1'),
      paragraph2: byText('Sample Paragraph line 2'),
    },
  }
}

async function evaluate(modelId: number, jobId: string, decode: string): Promise<number> {
  const created = await backendFetch('/api/evaluations', {
    method: 'POST', headers: JSON_HEADERS,
    body: JSON.stringify({ model_id: modelId, job_ids: [jobId], decode }),
  })
  await expect.poll(async () => evaluationDetail(created.id), { timeout: 30_000 })
    .toMatchObject({ status: 'done', line_rows: 4 })
  return created.id
}

const tile = (page: Page, testid: string) => page.getByTestId(testid)
const lineIds = async (page: Page) =>
  (await page.getByTestId('eval-line').evaluateAll((rows) => rows.map((r) => Number(r.getAttribute('data-line-id')))))
const cerColumn = (page: Page) => page.getByTestId('eval-line').locator('[data-col="cer"]')

test.describe('Scenario: an evaluation has a page of its own', () => {
  // README: "Every evaluation has a page of its own ... reached from ... the Evaluations
  // list under Models", with the headline figures computed from the per-line records.
  test('the Evaluations list opens a page whose figures come from the scored lines', async ({ page }) => {
    const name = uniqueName('Scored set')
    const { jobId, pageId, evalId, ids } = await evaluatedDataset(name)

    await page.goto('/models')
    await page.getByTestId('evaluations-list').click()
    await expect(page).toHaveURL(/\/models\/evaluations$/)
    await page.getByTestId('evaluation-row').filter({ hasText: name }).getByTestId('evaluation-open').click()
    await expect(page).toHaveURL(new RegExp(`/evaluations/${evalId}(\\?|$)`))

    // 4 edits over 83 characters; 5 word errors over 16 words, order-free or not.
    await expect(tile(page, 'headline-cer')).toHaveText(/^CER\s*4\.82%\s*83 chars$/)
    await expect(tile(page, 'headline-wer')).toHaveText(/^WER\s*31\.25%\s*16 words$/)
    await expect(tile(page, 'headline-bow-wer')).toHaveText(/^bag-of-words WER\s*31\.25%$/)
    // 11 words matched regardless of order, of 15 read and 16 in the ground truth.
    await expect(tile(page, 'headline-bow-precision')).toHaveText(/^bag-of-words precision\s*73\.33%$/)
    await expect(tile(page, 'headline-bow-recall')).toHaveText(/^bag-of-words recall\s*68\.75%$/)
    await expect(tile(page, 'headline-lines')).toHaveText(/^lines\s*4$/)
    await expect(tile(page, 'headline-substitutions')).toHaveText(/^substitutions\s*2\s*50%$/)
    await expect(tile(page, 'headline-insertions')).toHaveText(/^insertions\s*1\s*25%$/)
    await expect(tile(page, 'headline-deletions')).toHaveText(/^deletions\s*1\s*25%$/)
    await expect(tile(page, 'class-case')).toHaveText(/^case errors\s*1\s*50% of substitutions$/)
    await expect(tile(page, 'class-digits')).toHaveText(/^digits accuracy\s*75\.0%\s*of 4$/)

    // Worst first by default; ties keep line order.
    await expect(cerColumn(page)).toHaveText(['8.70%', '5.00%', '5.00%', '0.00%'])
    expect(await lineIds(page)).toEqual([ids.paragraph1, ids.header2, ids.header3, ids.header1])
    const worst = page.getByTestId('eval-line').first()
    await expect(worst.locator('[data-op="deletion"]')).toHaveText('␣')
    await expect(worst.locator('[data-op="insertion"]')).toHaveText('.')
    await expect(worst.locator('[data-op="substitution"]')).toHaveCount(0)
    await expect(page.getByTestId('eval-line').nth(1).locator('[data-op="substitution"]')).toHaveCount(1)

    await page.getByTestId('sort-order').click()
    await expect(cerColumn(page)).toHaveText(['0.00%', '5.00%', '5.00%', '8.70%'])
    await page.getByRole('button', { name: 'Confidence', exact: true }).click()
    // The rows the previous sort left standing would satisfy a one-off read, so wait for the new order.
    await expect.poll(() => lineIds(page)).toEqual([ids.paragraph1, ids.header3, ids.header2, ids.header1])
    await expect(page.getByTestId('eval-line').first().locator('[data-col="confidence"]')).toHaveText('65%')

    await page.getByTestId('section-nav-item').filter({ hasText: 'Confusions' }).click()
    const subs = page.getByTestId('confusions-substitutions').getByTestId('confusion-row')
    await expect(subs).toHaveCount(2)
    const cells = (row: number) => subs.nth(row).getByRole('cell')
    await expect(cells(0).nth(0)).toHaveText('3')
    await expect(cells(0).nth(1)).toHaveText('4')
    await expect(cells(0).nth(2)).toHaveText('1')
    await expect(cells(1).nth(0)).toHaveText('S')
    await expect(cells(1).nth(1)).toHaveText('s')

    // A row opens its line in the page editor, selected - from the keyboard as well.
    await page.getByTestId('section-nav-item').filter({ hasText: 'Lines' }).click()
    const open = page.locator(`[data-testid="eval-line"][data-line-id="${ids.paragraph1}"]`)
      .getByRole('link', { name: 'Sample Paragraph line 1', exact: true })
    await open.focus()
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(new RegExp(`/jobs/${jobId}/pages/${pageId}\\?line=${ids.paragraph1}$`))
    await expect(page.getByTestId('line-row').filter({ hasText: 'Sample Paragraph line 1' }))
      .toHaveAttribute('data-hot', 'true')
    await expect(page.getByTestId('line-row').filter({ hasText: 'Sample Header line 1' }))
      .not.toHaveAttribute('data-hot', 'true')
  })

  // README: "Send to review flags every line in the current filter for its dataset's
  // review queue, checked or not, until a person checks or corrects it."
  test('send to review queues every line of the current filter, though they are checked', async ({ page }) => {
    const { jobId, evalId, ids } = await evaluatedDataset(uniqueName('Review set'))
    // Only the unchecked line the stub OCR doubted is review work to begin with.
    expect(await reviewQueue(jobId)).toEqual([expect.objectContaining({ id: ids.paragraph2, flagged: false })])

    await page.goto(`/evaluations/${evalId}`)
    await page.getByLabel('CER from (%)').fill('5')
    await page.getByRole('button', { name: 'Apply' }).click()
    await expect(page.getByTestId('lines-total')).toHaveText('3 lines')
    await expect.poll(() => lineIds(page)).toEqual([ids.paragraph1, ids.header2, ids.header3])
    await page.getByTestId('send-to-review').click()
    await expect(page.getByTestId('review-sent')).toContainText('3 lines flagged')

    await expect.poll(async () => (await reviewQueue(jobId)).map((l) => [l.id, l.flagged]))
      .toEqual([[ids.header2, true], [ids.header3, true], [ids.paragraph1, true], [ids.paragraph2, false]])
    expect((await reviewQueue(jobId)).map((l) => l.id)).not.toContain(ids.header1)
  })

  test('a failed request empties the table, and the next one that answers clears the error', async ({ page }) => {
    const { evalId, ids } = await evaluatedDataset(uniqueName('Failing set'))
    await page.goto(`/evaluations/${evalId}`)
    await expect(page.getByTestId('eval-line')).toHaveCount(4)
    await expect(page.getByTestId('send-to-review')).toHaveText('Send 4 to review')

    const failing = (url: URL) => url.pathname === `/api/evaluations/${evalId}/lines`
    await page.route(failing, (route) => route.fulfill({
      status: 500, contentType: 'application/json', body: JSON.stringify({ detail: 'The lines could not be read' }) }))
    await page.getByLabel('CER from (%)').fill('1')
    await page.getByRole('button', { name: 'Apply' }).click()
    await expect(page.getByTestId('lines-error')).toHaveText('The lines could not be read')
    // Nothing of the last answer stays standing as if it were this filter's.
    await expect(page.getByTestId('eval-line')).toHaveCount(0)
    await expect(page.getByTestId('send-to-review')).toHaveText('Send 0 to review')
    await expect(page.getByTestId('send-to-review')).toBeDisabled()

    await page.unroute(failing)
    // A decimal comma reads as a point: 4.5% keeps the three lines at 5% and above.
    await page.getByLabel('CER from (%)').fill('4,5')
    await page.getByRole('button', { name: 'Apply' }).click()
    await expect(page).toHaveURL(/[?&]cer_min=0\.045(&|$)/)
    await expect.poll(() => lineIds(page)).toEqual([ids.paragraph1, ids.header2, ids.header3])
    await expect(page.getByTestId('send-to-review')).toHaveText('Send 3 to review')
    await expect(page.getByTestId('lines-error')).toHaveCount(0)
  })

  test('moving to another evaluation shows nothing of the last one while the next loads', async ({ page }) => {
    const { jobId, evalId, model } = await evaluatedDataset(uniqueName('Two decodes'))
    const greedyId = await evaluate(model.id, jobId, 'greedy')

    await page.goto(`/evaluations/${evalId}`)
    const decodes = page.getByTestId('decode-switch')
    await expect(decodes.getByRole('button', { name: 'beam' })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('evaluation-title')).toBeVisible()
    await expect(page.getByTestId('eval-line')).toHaveCount(4)

    let release = () => {}
    const held = new Promise<void>((resolve) => { release = resolve })
    await page.route((url) => url.pathname === `/api/evaluations/${greedyId}`, async (route) => {
      await held
      await route.continue()
    })
    await decodes.getByRole('button', { name: 'greedy' }).click()
    await expect(page).toHaveURL(new RegExp(`/evaluations/${greedyId}(\\?|$)`))
    await expect(page.getByTestId('evaluation-title')).toHaveCount(0)
    await expect(page.getByTestId('eval-line')).toHaveCount(0)

    release()
    await expect(decodes.getByRole('button', { name: 'greedy' })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('evaluation-title')).toBeVisible()
    await expect(page.getByTestId('eval-line')).toHaveCount(4)
  })

  // README: the page is "reached from the run page's scores", and "a switch moves the
  // whole page to another decode the same model was scored with on the same material".
  test("a run's score opens its evaluation, and the decode switch moves to the sibling", async ({ page }) => {
    test.setTimeout(180_000)
    const jobId = await seedDistinctPagesJob(uniqueName('Run pages'), 2)
    await markLinesChecked(jobId, 12)
    const name = uniqueName('Paged run')
    await createTraining({
      task: 'ocr', name, dataset_job_ids: [jobId], target: 'local', base_model_id: misreading(name).id,
      epochs: 1, batch_size: 4, val_fraction: 0.3,
    })
    const run = async () => (await listTrainings()).find((t) => t.name === name)
    await expect.poll(async () => (await run())?.status, { timeout: 60_000 }).toBe('done')
    const finished = (await run())!
    const trained = (await listRegistryModels()).find((m) => m.name === name)!
    await expect.poll(async () =>
      (await listEvaluations()).filter((e) => e.training_id === finished.id && e.status === 'done').length,
      { timeout: 60_000 }).toBe(6)
    const evals = (await listEvaluations()).filter((e) => e.training_id === finished.id && e.model_id === trained.id)
    const beam = evals.find((e) => e.decode === 'beam')!
    const greedy = evals.find((e) => e.decode === 'greedy')!
    await expect.poll(async () => (await evaluationDetail(beam.id)).line_rows).toBe(6)

    await page.goto(`/models/runs/${finished.id}`)
    await page.getByTestId('score-valid-new').getByRole('link').click()
    await expect(page).toHaveURL(new RegExp(`/evaluations/${beam.id}(\\?|$)`))
    await expect(page.getByTestId('evaluation-title')).toHaveText(name)
    // The valid page's six lines: 5 edits over 129 characters.
    await expect(tile(page, 'headline-cer')).toHaveText(/^CER\s*3\.88%\s*129 chars$/)
    await expect(tile(page, 'headline-lines')).toHaveText(/^lines\s*6$/)
    await expect(page.getByTestId('eval-line')).toHaveCount(6)

    const decodes = page.getByTestId('decode-switch')
    await expect(decodes.getByRole('button')).toHaveText(['beam', 'rescored', 'greedy'])
    await decodes.getByRole('button', { name: 'greedy' }).click()
    await expect(page).toHaveURL(new RegExp(`/evaluations/${greedy.id}(\\?|$)`))
    await expect(decodes.getByRole('button', { name: 'greedy' })).toHaveAttribute('aria-pressed', 'true')
  })
})
