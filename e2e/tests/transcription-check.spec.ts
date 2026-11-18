import { test, expect } from '../helpers/test'
import {
  backendFetch, importStubModel, jobPageIds, listEvaluations, markLinesChecked, pageLines, seedCompletedJob, uniqueName,
} from '../helpers/api'
import { datasetAction } from '../helpers/dataset'

const WRONG = 'Ganz falscher Text'

// README: "Check transcriptions..." reads a dataset's checked lines with a model and lists
// those whose confident reading looks nothing like their text; from there a line can take
// the reading, staying checked, or be unchecked - never automatically (#126).
test.describe('Scenario: wrong ground truth is found before a training run, and fixed in place', () => {
  test('a check finds the line whose text belongs elsewhere, and its reading is taken by one click', async ({ page }) => {
    test.setTimeout(180_000)
    const name = uniqueName('Checked set')
    const jobId = await seedCompletedJob(name, 1)
    await markLinesChecked(jobId, 4)
    const [pageId] = await jobPageIds(jobId)
    const byText = async (text: string) => (await pageLines(jobId, pageId)).find((l) => l.text === text)!.id
    const header1 = await byText('Sample Header line 1')
    const header2 = await byText('Sample Header line 2')
    const header3 = await byText('Sample Header line 3')
    // A transcription that belongs to another line: the misreading stub reads the line as
    // its stub text with one letter's case flipped, confidently, so it is the one likely error.
    await backendFetch(`/api/lines/${header1}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ corrected_text: WRONG, checked: true }),
    })
    importStubModel('ocr', `${name} reader`, 'stub-misread')
    const line = async (id: number) => (await pageLines(jobId, pageId)).find((l) => l.id === id)!

    await page.goto(`/jobs/${jobId}`)
    await datasetAction(page, 'check-open')
    await page.getByTestId('check-model').selectOption({ label: `${name} reader` })
    await page.getByTestId('start-check').click()

    // The check opens on its likely transcription errors.
    await expect(page).toHaveURL(/\/evaluations\/\d+\?cer_min=0\.5&conf_min=0\.8$/)
    const checkId = Number(new URL(page.url()).pathname.split('/').pop())
    const checks = async () => (await backendFetch(`/api/jobs/${jobId}/checks`)).checks as { id: number; status: string }[]
    await expect.poll(async () => (await checks()).map((c) => `${c.id} ${c.status}`), { timeout: 90_000 })
      .toEqual([`${checkId} done`])
    // It is no score of the model.
    expect((await listEvaluations()).some((e) => e.id === checkId)).toBe(false)
    await expect(page.getByRole('heading', { level: 1, name: 'Transcription check' })).toBeVisible()
    const rows = page.getByTestId('eval-line')
    await expect(rows).toHaveCount(1)
    await expect(rows.first()).toHaveAttribute('data-line-id', String(header1))

    const scored = (await backendFetch(`/api/evaluations/${checkId}/lines?limit=50`)).lines as
      { line_id: number; reading: { prediction: string; confidence: number } }[]
    const reading = scored.find((l) => l.line_id === header1)!.reading
    // The stub flips the first letter of the second line it is sent, at 85% confidence.
    expect([reading.prediction, reading.confidence]).toEqual(['sample Header line 1', 0.85])
    // A line this far off is shown as its two texts rather than a diff of them.
    await expect(rows.first().getByTestId('line-texts')).toHaveText(`text${WRONG}read${reading.prediction}`)
    await expect(rows.first().getByTestId('line-diff')).toHaveCount(0)

    await rows.first().getByTestId('take-reading').click()
    await expect(rows.first().getByTestId('line-fixed')).toHaveAttribute('data-outcome', 'taken')
    await expect.poll(async () => {
      const fixed = await line(header1)
      return [fixed.corrected_text, fixed.checked]
    }).toEqual([reading.prediction, true])

    // From all the lines, another is left out of training.
    await page.locator('[data-testid="line-view"][data-view="all"]').click()
    const row = (id: number) => page.locator(`[data-testid="eval-line"][data-line-id="${id}"]`)
    await row(header2).getByTestId('uncheck-line').click()
    await expect(row(header2).getByTestId('line-fixed')).toHaveAttribute('data-outcome', 'unchecked')
    await expect.poll(async () => (await line(header2)).checked).toBe(false)
    expect((await line(header2)).corrected_text).toBe(null)

    // Once edited, a line offers no fix from a reading taken before the edit.
    await page.reload()
    await expect(row(header1).getByTestId('line-changed')).toBeVisible()
    await expect(row(header1).getByTestId('take-reading')).toHaveCount(0)
    await expect(row(header2).getByTestId('line-changed')).toBeVisible()
    await expect(row(header3).getByTestId('take-reading')).toBeVisible()
    await expect(row(header3).getByTestId('line-diff')).toBeVisible()

    // The dataset keeps the check for later.
    await page.goto(`/jobs/${jobId}`)
    await datasetAction(page, 'check-open')
    await expect(page.getByTestId('earlier-check')).toHaveCount(1)
    await expect(page.getByTestId('earlier-check').getByRole('link'))
      .toHaveAttribute('href', `/evaluations/${checkId}?cer_min=0.5&conf_min=0.8`)
  })
})
