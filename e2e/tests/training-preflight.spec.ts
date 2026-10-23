import { test, expect } from '../helpers/test'
import {
  backendFetch, correctLine, getPageDetail, jobPageIds, listTrainings, markLinesChecked, seedDistinctPagesJob,
  uniqueName,
} from '../helpers/api'
import { JSON_HEADERS } from '../helpers/map'
import { pickDataset } from '../helpers/training'

const CYRILLIC_A = 'а'
const SHARP_S = 'ß'

async function firstLineId(jobId: string): Promise<number> {
  const [pageId] = await jobPageIds(jobId)
  const detail = await getPageDetail(jobId, pageId)
  return detail.elements[0].lines[0].id
}

interface StoredPreflight {
  id: number
  status: string
  result: {
    split: {
      totals: Record<'train' | 'val' | 'test', { pages: number; items: number }>
      duplicate_count: number
    }
    text: { characters: { codepoints: string[]; train: number; test: number; flags: string[] }[] }
    findings: { code: string; level: string }[]
  }
}

test.describe('Scenario: the training pre-flight', () => {
  // README: "Next does not start the run: it opens the pre-flight, a review step
  // of its own ... computed by a background job when the step opens ... Back returns to the
  // settings as they were, and Train starts the run from the review. It warns and never
  // blocks ... The pre-flight the review showed is stored with the run and shown again on
  // the run's page".
  test('Next opens a review, Back keeps the settings, and the run keeps that review', async ({ page }) => {
    // Two distinct scans to train on, and a test set whose one page is a copy of the first
    // of them - the same content hash on both sides of the split.
    const trainName = uniqueName('Preflight train')
    const testName = uniqueName('Preflight test')
    const trainId = await seedDistinctPagesJob(trainName, 2)
    const testId = await seedDistinctPagesJob(testName, 1)
    // A Cyrillic a where the stub wrote "Sample", and a sharp s only the test set holds.
    await correctLine(await firstLineId(trainId), `S${CYRILLIC_A}mple Header line 1`)
    await correctLine(await firstLineId(testId), `Sample Header line 1 ${SHARP_S}`)
    await markLinesChecked(trainId, 12)
    await markLinesChecked(testId, 6)

    const started: number[] = []
    page.on('response', async (res) => {
      if (res.request().method() === 'POST' && res.url().endsWith('/api/trainings/preflights') && res.ok()) {
        started.push((await res.json()).id)
      }
    })

    const runName = uniqueName('Preflight run')
    await page.goto('/models/train?task=ocr')
    await page.getByLabel('Model name').fill(runName)
    await pickDataset(page, trainName)
    await page.getByLabel('Test dataset').selectOption({ label: `${testName} (6)` })
    await page.getByTestId('advanced-toggle').click()
    await page.getByLabel('Epochs', { exact: true }).fill('2')

    // The settings carry no review of their own, and none is computed while they are edited.
    await expect(page.getByText('12 checked lines selected')).toBeVisible()
    await expect(page.getByTestId('preflight')).toHaveCount(0)
    await page.getByRole('button', { name: 'Next', exact: true }).click()
    const review = page.getByTestId('training-review')
    await expect(review.getByTestId('preflight')).toHaveAttribute('data-status', 'done')
    await expect.poll(() => started.length).toBe(1)
    await expect(review.getByTestId('preflight-settings').locator('[data-setting="epochs"] dd')).toHaveText('2')
    await expect(page.getByLabel('Model name')).toHaveCount(0)

    // Back is the settings exactly as they were left, and the next review reads the change.
    await review.getByRole('button', { name: 'Back' }).click()
    await expect(review).toHaveCount(0)
    await expect(page.getByLabel('Model name')).toHaveValue(runName)
    await expect(page.getByLabel('Epochs', { exact: true })).toHaveValue('2')
    await page.getByLabel('Epochs', { exact: true }).fill('1')
    await page.getByRole('button', { name: 'Next', exact: true }).click()

    const report = review.getByTestId('preflight-report')
    await expect(report.getByTestId('preflight-settings').locator('[data-setting="epochs"] dd')).toHaveText('1')
    await expect(review.getByTestId('preflight')).toHaveAttribute('data-status', 'done')
    await expect.poll(() => started.length).toBe(2)
    // 12 lines on two pages; at the form's 10% neither page goes to validation; the test
    // set's 6 lines sit on one page.
    const total = report.getByTestId('preflight-split-total')
    await expect(total.locator('[data-split="train"]')).toHaveText('12 / 2 p')
    await expect(total.locator('[data-split="val"]')).toHaveText('0 / 0 p')
    await expect(total.locator('[data-split="test"]')).toHaveText('6 / 1 p')
    await expect(report.locator('[data-testid="preflight-finding"][data-code="duplicates"]'))
      .toHaveText(/1 scan sits in more than one split/)
    await expect(report.locator('[data-testid="preflight-finding"][data-code="empty_split"]'))
      .toHaveText(/The valid split is empty/)
    const lookalike = report.locator('[data-testid="preflight-char"][data-char="U+0430"]')
    await expect(lookalike).toHaveAttribute('data-flags', 'rare lookalike')
    await expect(lookalike).toContainText('looks like Latin a (U+0061)')
    const sharpS = report.locator('[data-testid="preflight-char"][data-char="U+00DF"]')
    await expect(sharpS).toHaveAttribute('data-flags', 'split_only')
    await expect(sharpS.locator('[data-split="train"]')).toHaveText('0')
    await expect(sharpS.locator('[data-split="test"]')).toHaveText('1')
    // An ordinary letter is ranked with the rest and flagged with nothing.
    await expect(report.locator('[data-testid="preflight-char"][data-char="U+0065"]')).toHaveAttribute('data-flags', '')

    // Back and on again with nothing changed shows the same review rather than another.
    await review.getByRole('button', { name: 'Back' }).click()
    await expect(page.getByLabel('Epochs', { exact: true })).toHaveValue('1')
    await page.getByRole('button', { name: 'Next', exact: true }).click()
    await expect(review.getByTestId('preflight')).toHaveAttribute('data-status', 'done')
    await expect(report.getByTestId('preflight-settings').locator('[data-setting="epochs"] dd')).toHaveText('1')

    // Warnings only: the run starts with all of them standing.
    await review.getByRole('button', { name: 'Train', exact: true }).click()
    await expect(page).toHaveURL(/\/models\?tab=runs$/)

    await expect.poll(async () => (await listTrainings()).some((t) => t.name === runName)).toBe(true)
    const run = (await listTrainings()).find((t) => t.name === runName)!
    expect(started).toHaveLength(2)
    const reviewedId = started[1]
    // The run kept the very review the form showed rather than computing another.
    await expect.poll(async () => (await backendFetch(`/api/trainings/${run.id}/preflight`) as StoredPreflight).id)
      .toBe(reviewedId)
    const stored = await backendFetch(`/api/trainings/${run.id}/preflight`) as StoredPreflight
    expect(stored.status).toBe('done')
    expect(stored.result.split.totals).toEqual({
      train: { pages: 2, items: 12 }, val: { pages: 0, items: 0 }, test: { pages: 1, items: 6 } })
    expect(stored.result.split.duplicate_count).toBe(1)
    const storedSharpS = stored.result.text.characters.find((c) => c.codepoints[0] === 'U+00DF')!
    expect([storedSharpS.train, storedSharpS.test, storedSharpS.flags]).toEqual([0, 1, ['split_only']])
    expect(stored.result.findings.filter((f) => f.level === 'warn').map((f) => f.code).sort())
      .toEqual(['duplicates', 'empty_split', 'lookalike', 'split_only'])

    await page.goto(`/models/runs/${run.id}?tab=data`)
    const onRun = page.getByTestId('preflight-report')
    await expect(onRun.getByTestId('preflight-split-total').locator('[data-split="train"]')).toHaveText('12 / 2 p')
    await expect(onRun.locator('[data-testid="preflight-finding"][data-code="duplicates"]')).toBeVisible()
    await expect(onRun.locator('[data-testid="preflight-char"][data-char="U+0430"]'))
      .toHaveAttribute('data-flags', 'rare lookalike')

    // Each tile carries its own flag's mark, and the filter picks one kind out of grid and table.
    const characters = stored.result.text.characters
    const withFlag = (flag: string) => characters.filter((c) => c.flags.includes(flag)).length
    const tile = (cp: string) => onRun.locator(`[data-testid="preflight-charset"] [data-char="${cp}"]`)
    const filter = (view: string) => onRun.locator(`[data-testid="preflight-char-filter"][data-view="${view}"]`)
    const tableRows = onRun.getByTestId('preflight-char')
    await expect(tile('U+0430').getByTestId('preflight-char-marks')).toHaveText('≈')
    await expect(tile('U+00DF').getByTestId('preflight-char-marks')).toHaveText('∅')
    await expect(tile('U+0065')).toBeVisible()
    await expect(tile('U+0065').getByTestId('preflight-char-marks')).toHaveCount(0)
    await expect(filter('lookalike')).toHaveText(`≈lookalike${withFlag('lookalike')}`)
    await expect(filter('split_only')).toHaveText(`∅not in train${withFlag('split_only')}`)
    await expect(tableRows).toHaveCount(Math.min(characters.length, 40))

    await filter('lookalike').click()
    await expect(filter('lookalike')).toHaveAttribute('aria-pressed', 'true')
    await expect(tableRows).toHaveCount(withFlag('lookalike'))
    await expect(tile('U+0430')).toHaveAttribute('data-dimmed', 'false')
    await expect(tile('U+00DF')).toHaveAttribute('data-dimmed', 'true')
    await filter('lookalike').click()
    await expect(filter('all')).toHaveAttribute('aria-pressed', 'true')
    await expect(tile('U+00DF')).toHaveAttribute('data-dimmed', 'false')
    await expect(tableRows).toHaveCount(Math.min(characters.length, 40))

    const finished = ['done', 'error', 'cancelled']
    if (!finished.includes((await listTrainings()).find((t) => t.id === run.id)!.status)) {
      await backendFetch(`/api/trainings/${run.id}/cancel`, { method: 'POST' }).catch(() => undefined)
    }
  })

  test('a run submitted without a review gets one computed at submit', async ({ page }) => {
    const jobId = await seedDistinctPagesJob(uniqueName('Preflight api'), 2, 20)
    await markLinesChecked(jobId, 12)
    const runName = uniqueName('Preflight api run')
    const created = await backendFetch('/api/trainings', {
      method: 'POST', headers: JSON_HEADERS,
      body: JSON.stringify({ task: 'ocr', name: runName, target: 'local', epochs: 1, batch_size: 4,
                             val_fraction: 0.5, dataset_job_ids: [jobId] }),
    })
    expect(created.preflight_id).toEqual(expect.any(Number))
    await expect.poll(async () => (await backendFetch(`/api/trainings/${created.id}/preflight`) as StoredPreflight).status,
                      { timeout: 30_000 }).toBe('done')
    const stored = await backendFetch(`/api/trainings/${created.id}/preflight`) as StoredPreflight
    // Half of two distinct pages validates: 6 lines a side.
    expect(stored.result.split.totals).toEqual({
      train: { pages: 1, items: 6 }, val: { pages: 1, items: 6 }, test: { pages: 0, items: 0 } })

    await page.goto(`/models/runs/${created.id}?tab=data`)
    await expect(page.getByTestId('preflight-split-total').locator('[data-split="val"]')).toHaveText('6 / 1 p')
    // Each digit is on two of the six training lines, which is worth a note, not a warning.
    await expect(page.locator('[data-testid="preflight-finding"][data-code="rare"]'))
      .toHaveAttribute('data-level', 'info')
    await expect(page.locator('[data-testid="preflight-finding"][data-level="warn"]')).toHaveCount(0)
    await expect(page.getByTestId('preflight-report').getByText('Nothing stood out')).toBeVisible()

    await backendFetch(`/api/trainings/${created.id}/cancel`, { method: 'POST' }).catch(() => undefined)
  })
})
