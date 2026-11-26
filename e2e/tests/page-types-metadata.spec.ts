import { expect, test } from '../helpers/test'
import {
  backendFetch, correctLine, deleteLine, jobPageIds, pageLines, seedCompletedJob, uniqueName, waitForJobStatus,
} from '../helpers/api'
import { openDatasetMenu } from '../helpers/dataset'

const COVER = 2
const BLANK = 3

const pagesOfType = async (jobId: string, typeId: number): Promise<number[]> =>
  (await backendFetch(`/api/jobs/${jobId}/page-rows?filter=type:${typeId}`)).rows.map((r: { id: number }) => r.id)

const pageTypes = async (jobId: string) =>
  (await backendFetch(`/api/jobs/${jobId}/page-types`)).types as
    { id: number; name: string; run_lines: boolean; run_ocr: boolean; pages: number }[]

const texts = async (jobId: string, pageId: number) => (await pageLines(jobId, pageId)).map((l) => l.text)

test.describe('Scenario: page types', () => {
  test('a cover set from the table is passed by when the text is read again', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Page types'), 3)
    const [cover, text] = await jobPageIds(jobId)
    // An unchecked correction on each: a re-read that starts clean clears it where it reads again.
    const [coverLine] = await pageLines(jobId, cover)
    const [textLine] = await pageLines(jobId, text)
    await correctLine(coverLine.id, 'Titelblatt', false)
    await correctLine(textLine.id, 'Verbessert', false)

    await page.goto(`/jobs/${jobId}`)
    await expect(page.locator('[data-page-row]')).toHaveCount(3)
    await expect(page.getByTestId('page-type-tag')).toHaveCount(0)
    await page.getByRole('checkbox', { name: 'Select scan_1.png' }).click()
    await page.getByTestId('bulk-page-type').selectOption({ label: 'Cover' })

    await expect.poll(() => pagesOfType(jobId, COVER)).toEqual([cover])
    await expect(page.locator(`[data-page-row="${cover}"]`).getByTestId('page-type-tag')).toHaveText('Cover')
    await expect(page.getByTestId('page-type-tag')).toHaveCount(1)
    await expect(page.getByTestId(`page-filter-type:${COVER}`)).toHaveText('Cover · 1')

    await backendFetch(`/api/jobs/${jobId}/rerun`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from_phase: 'ocr', keep_text: false }),
    })
    await waitForJobStatus(jobId, 'done')
    const corrected = async (pageId: number) => (await pageLines(jobId, pageId))[0].corrected_text
    expect(await corrected(cover)).toBe('Titelblatt')
    expect(await corrected(text)).toBeNull()
    expect((await texts(jobId, text)).every((t) => t !== null)).toBe(true)
    // Nor does the dataset count it as a page reading missed.
    expect((await backendFetch(`/api/jobs/${jobId}/steps-not-run`)).ocr).toBe(0)
  })

  test('a page line detection found nothing on is offered as blank, and taken with a click', async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Found nothing'), 2)
    const [read, empty] = await jobPageIds(jobId)
    for (const line of await pageLines(jobId, empty)) await deleteLine(line.id)

    await page.goto(`/jobs/${jobId}`)
    await expect(page.getByTestId('page-filter-found-nothing')).toHaveText('Found nothing · 1')
    await expect(page.locator(`[data-page-row="${read}"]`).getByTestId('blank-offer')).toHaveCount(0)
    const offer = page.locator(`[data-page-row="${empty}"]`).getByTestId('blank-offer')
    await expect(offer).toHaveText('Blank?')
    // Offered, not applied.
    expect(await pagesOfType(jobId, BLANK)).toEqual([])

    await offer.click()
    await expect.poll(() => pagesOfType(jobId, BLANK)).toEqual([empty])
    await expect(page.locator(`[data-page-row="${empty}"]`).getByTestId('page-type-tag')).toHaveText('Blank')
    await expect(offer).toHaveCount(0)
    await expect(page.getByTestId('page-filter-found-nothing')).toHaveCount(0)
    await expect(page.getByTestId(`page-filter-type:${BLANK}`)).toHaveText('Blank · 1')
  })

  test("a dataset's page types are renamed and switched from its menu", async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Own page types'), 2)
    await page.goto(`/jobs/${jobId}`)
    await (await openDatasetMenu(page, 'dataset-more')).getByTestId('page-types').click()

    const cover = page.locator(`[data-testid="page-type"][data-type-id="${COVER}"]`)
    await expect(page.locator('[data-testid="page-type"][data-type-id="1"]').getByTestId('page-type-pages'))
      .toHaveText('2')
    await expect(cover.getByRole('checkbox', { name: 'Read text on Cover pages' })).not.toBeChecked()
    await cover.getByRole('textbox', { name: 'Name of Cover' }).fill('Einband')
    await cover.getByRole('textbox', { name: 'Name of Cover' }).press('Enter')
    await expect.poll(async () => (await pageTypes(jobId)).find((t) => t.id === COVER)?.name).toBe('Einband')

    await cover.getByRole('checkbox', { name: 'Read text on Einband pages' }).check()
    await expect.poll(async () => (await pageTypes(jobId)).find((t) => t.id === COVER)?.run_ocr).toBe(true)
    await expect(cover.getByRole('checkbox', { name: 'Read text on Einband pages' })).toBeChecked()

    // Reading reads the lines found, so line detection off takes reading with it (#169).
    await cover.getByRole('checkbox', { name: 'Find lines on Einband pages' }).uncheck()
    await expect.poll(async () => {
      const type = (await pageTypes(jobId)).find((t) => t.id === COVER)
      return [type?.run_lines, type?.run_ocr]
    }).toEqual([false, false])
    await expect(cover.getByRole('checkbox', { name: 'Read text on Einband pages' })).not.toBeChecked()
    await expect(cover.getByRole('checkbox', { name: 'Read text on Einband pages' })).toBeDisabled()
    await expect(cover.getByRole('checkbox', { name: 'Find lines on Einband pages' })).toBeEnabled()
  })
})

const metadataOf = async (path: string) => (await backendFetch(path)).metadata as { key: string; value: string }[]

test.describe('Scenario: metadata', () => {
  test("a dataset's fields are written in its Info", async ({ page }) => {
    const name = uniqueName('Described volume')
    const jobId = await seedCompletedJob(name, 1)
    await page.goto('/')
    const card = page.getByTestId('job-card').filter({ hasText: name })
    await card.getByTestId('job-info-toggle').click()
    const fields = card.getByTestId('job-metadata')
    await expect(fields).toContainText('None yet')

    await fields.getByTestId('metadata-edit').click()
    await fields.getByRole('textbox', { name: 'Field 1' }).fill('Shelfmark')
    await fields.getByRole('textbox', { name: 'Value 1' }).fill('Rep. 17')
    await fields.getByTestId('metadata-add').click()
    await fields.getByRole('textbox', { name: 'Field 2' }).fill('Date')
    await fields.getByRole('textbox', { name: 'Value 2' }).fill('1781')
    await fields.getByTestId('metadata-save').click()

    await expect.poll(() => metadataOf(`/api/jobs/${jobId}/info`))
      .toEqual([{ key: 'Shelfmark', value: 'Rep. 17' }, { key: 'Date', value: '1781' }])
    await expect(fields.getByTestId('metadata-row')).toHaveText(['ShelfmarkRep. 17', 'Date1781'])
  })

  test("a page's type and fields are set from its Info in the viewer", async ({ page }) => {
    const jobId = await seedCompletedJob(uniqueName('Described page'), 1)
    const [pageId] = await jobPageIds(jobId)
    await page.goto(`/jobs/${jobId}/pages/${pageId}`)
    await page.getByTestId('page-info').click()
    const panel = page.getByTestId('page-info-panel')
    await expect(panel.getByTestId('page-info-steps')).toHaveText('A run finds its layout, finds its lines and reads its text.')

    await panel.getByTestId('page-info-type').selectOption({ label: 'Cover' })
    await expect.poll(() => pagesOfType(jobId, COVER)).toEqual([pageId])
    await expect(panel.getByTestId('page-info-steps')).toHaveText('A run finds its layout and finds its lines.')

    await panel.getByTestId('metadata-edit').click()
    await panel.getByRole('textbox', { name: 'Field 1' }).fill('Folio')
    await panel.getByRole('textbox', { name: 'Value 1' }).fill('1r')
    await panel.getByTestId('metadata-save').click()
    await expect.poll(() => metadataOf(`/api/jobs/${jobId}/pages/${pageId}`)).toEqual([{ key: 'Folio', value: '1r' }])
    await expect(panel.getByTestId('metadata-row')).toHaveText(['Folio1r'])
  })
})
