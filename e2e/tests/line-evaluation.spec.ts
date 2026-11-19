import { test, expect } from '../helpers/test'
import {
  backendFetch, getPageDetail, importStubModel, jobPageIds, listEvaluations, markPageLinesChecked, seedCompletedJob,
  uniqueName,
} from '../helpers/api'
import { pickDataset } from '../helpers/training'

const pct = (value: number) => `${(value * 100).toFixed(2)}%`

interface Detail { elements: { class_name: string; lines: { id: number }[] }[] }

// README: a line model is evaluated like an OCR model, on the lines-checked pages of the
// chosen datasets: its lines are matched to the checked outlines and counted (#130).
test.describe('Scenario: a line model is scored against checked outlines', () => {
  test('Evaluate counts the found lines against the checked page, which draws both', async ({ page }) => {
    test.setTimeout(180_000)
    const name = uniqueName('Outlined set')
    const jobId = await seedCompletedJob(name, 1)
    const [pageId] = await jobPageIds(jobId)
    // The stub finds exactly the lines it drew when the dataset was read; one of them is
    // taken out of the checked page, so the model finds one line over no checked line.
    const detail = await getPageDetail(jobId, pageId) as Detail
    const lineIds = detail.elements.filter((e) => e.class_name !== 'Pagenumber').flatMap((e) => e.lines.map((l) => l.id))
    expect(lineIds.length).toBeGreaterThan(2)
    await backendFetch(`/api/lines/${lineIds[1]}`, { method: 'DELETE' })
    await markPageLinesChecked(pageId)
    const model = importStubModel('lines', `${name} finder`, 'stub-slow')
    const checked = lineIds.length - 1
    const f1 = (2 * checked) / (checked + lineIds.length)

    await page.goto(`/models/${model}`)
    await page.getByRole('button', { name: 'Evaluate…' }).click()
    await pickDataset(page, name)
    await expect(page.getByText('1 lines-checked page selected')).toBeVisible()
    await expect(page.getByLabel('Decoding')).toHaveCount(0)
    await page.getByRole('button', { name: 'Start evaluation' }).click()

    const scored = async () => (await listEvaluations()).find((e) => e.model_id === model)
    await expect.poll(async () => (await scored())?.status, { timeout: 90_000 }).toBe('done')
    const evaluation = (await scored())!
    expect(evaluation.decode).toBe('')
    expect(evaluation.metrics).toMatchObject({
      truth: checked, detected: lineIds.length, found: checked, missed: 0, merged: 0, split: 0, loose: 0, extra: 1,
    })
    expect(evaluation.metrics!.f1).toBeCloseTo(f1, 10)

    await page.goto(`/evaluations/${evaluation.id}`)
    await expect(page.getByTestId('line-f1')).toContainText(pct(f1))
    const tile = (kind: string) => page.locator(`[data-testid="line-count"][data-kind="${kind}"]`)
    await expect(tile('found')).toContainText(String(checked))
    await expect(tile('extra')).toContainText('1')
    await expect(tile('missed')).toContainText('0')
    await expect(page.getByTestId('evaluated-page')).toHaveCount(1)
    await expect(page.getByTestId('evaluated-page').locator('[data-col="f1"]')).toHaveText(pct(f1))
    // The checked outlines, every one found, and the model's lines dashed over them.
    const outlines = page.getByTestId('page-outlines')
    await expect(outlines.locator('polygon[data-kind="found"]')).toHaveCount(checked)
    await expect(outlines.locator('polygon[data-kind]:not([data-kind="found"])')).toHaveCount(0)
    await expect(outlines.locator('polygon[data-found="found"]')).toHaveCount(checked)
    await expect(outlines.locator('polygon[data-found="extra"]')).toHaveCount(1)

    // The Evaluations list has the line models apart, scored in F1.
    await page.goto('/models/evaluations')
    const lines = page.getByRole('button', { name: 'Lines', exact: true })
    await lines.click()
    await expect(lines).toHaveAttribute('aria-pressed', 'true')
    await page.getByRole('searchbox', { name: 'Search models' }).fill(`${name} finder`)
    const cell = page.locator(`[data-testid="eval-model-row"][data-model="${model}"] [data-material="${jobId}:all"]`)
    await expect(cell.getByRole('link')).toHaveText(pct(f1))
  })
})
