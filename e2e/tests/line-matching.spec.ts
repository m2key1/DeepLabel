import { test, expect } from '../helpers/test'
import {
  correctLine, identity, jobPageIds, pageCandidates, pageLines, resetLlmStats,
  seedDistinctPagesJob, seedLlmConnection, uniqueName,
} from '../helpers/api'
import { openViewer } from '../helpers/viewer'
import { datasetAction } from '../helpers/dataset'

const DEV = identity('dev', 'admin')

// 'stub-extra' answers with the six lines the runner read plus one the segmentation never
// found, so exactly one of its readings has no line to sit on.
const EXTRA = 'stub-extra'
const STRAY = 'Marginal note the segmenter missed'
const TARGET = 'Sample Paragraph line 3'

async function readOnePage(page: import('@playwright/test').Page, jobId: string, connection: string) {
  await page.goto(`/jobs/${jobId}`)
  await datasetAction(page, 'llm-read-open')
  await page.locator(`[data-testid="llm-pick"][data-label="${connection} ${EXTRA}"]`)
    .getByRole('checkbox').check()
  await page.getByTestId('llm-start').click()
}

async function seedStrayReading(page: import('@playwright/test').Page, name: string) {
  const jobId = await seedDistinctPagesJob(uniqueName(name), 1)
  const connection = uniqueName('Over-reader')
  await seedLlmConnection(connection, [EXTRA], DEV)
  await resetLlmStats()
  await readOnePage(page, jobId, connection)

  const [pageId] = await jobPageIds(jobId)
  await expect.poll(async () =>
    (await pageCandidates(pageId)).filter((c) => c.source === 'llm' && c.line_id === null).length,
  { timeout: 30_000 }).toBe(1)
  const target = (await pageLines(jobId, pageId)).find((l) => l.text === TARGET)!
  return { jobId, pageId, target }
}

const stray = (pageId: number) =>
  pageCandidates(pageId).then((held) => held.find((c) => c.text === STRAY)!)

test.describe('Scenario: a reading that matched no line', () => {
  test('it is dragged onto the line it belongs to', async ({ page }) => {
    const { jobId, pageId, target } = await seedStrayReading(page, 'Stray reading')

    await openViewer(page, jobId, pageId)
    const reading = page.getByTestId('unmatched-reading')
    await expect(reading).toHaveCount(1)
    await expect(reading).toContainText(STRAY)

    await reading.dragTo(page.getByTestId('line-row').filter({ hasText: TARGET }))

    // Backend oracle: it sits on that line, and carries no score - a person's pairing is
    // not a measurement.
    await expect.poll(async () => {
      const held = await stray(pageId)
      return { line: held.line_id, similarity: held.similarity }
    }).toEqual({ line: target.id, similarity: null })

    // The line says it now - putting a reading on a line is taking it - so it is the line
    // rather than one of its choices, and what it displaced is offered in its place.
    await expect.poll(async () =>
      (await pageLines(jobId, pageId)).find((l) => l.id === target.id)!.corrected_text).toBe(STRAY)
    await page.getByTestId('line-row').filter({ hasText: STRAY }).click()
    await expect(page.getByTestId('line-candidate').filter({ hasText: STRAY })).toHaveCount(0)
    await expect(page.getByTestId('line-candidate').filter({ hasText: TARGET })).toBeVisible()
    await expect(page.getByTestId('unmatched-reading').filter({ hasText: STRAY })).toHaveCount(0)

    // What this model used to say about that line went back to the pool in its place: one
    // reader is one reading per line, however the reading got there.
    const displaced = page.getByTestId('unmatched-reading')
    await expect(displaced).toHaveCount(1)
    await expect(displaced).toContainText(TARGET)
    expect((await pageCandidates(pageId)).find((c) => c.text === TARGET)!.line_id).toBeNull()
  })

  test('clicking it and then the line does the same, without a drag', async ({ page }) => {
    const { jobId, pageId, target } = await seedStrayReading(page, 'Stray clicked')

    await openViewer(page, jobId, pageId)
    const reading = page.getByTestId('unmatched-reading')
    await reading.click()
    await expect(reading).toHaveAttribute('aria-pressed', 'true')
    await page.getByTestId('line-row').filter({ hasText: TARGET }).click()

    await expect.poll(async () => (await stray(pageId)).line_id).toBe(target.id)
  })

  test('Escape puts it down again without attaching anything', async ({ page }) => {
    const { jobId, pageId } = await seedStrayReading(page, 'Stray disarmed')

    await openViewer(page, jobId, pageId)
    const reading = page.getByTestId('unmatched-reading')
    await reading.click()
    await expect(reading).toHaveAttribute('aria-pressed', 'true')
    await page.keyboard.press('Escape')
    await expect(reading).toHaveAttribute('aria-pressed', 'false')

    await page.getByTestId('line-row').filter({ hasText: TARGET }).click()
    expect((await stray(pageId)).line_id).toBeNull()
  })

  test('a reading dropped on the wrong line is released where it landed', async ({ page }) => {
    const { jobId, pageId, target } = await seedStrayReading(page, 'Stray released')

    await openViewer(page, jobId, pageId)
    await page.getByTestId('unmatched-reading').click()
    await page.getByTestId('line-row').filter({ hasText: TARGET }).click()
    await expect.poll(async () => (await stray(pageId)).line_id).toBe(target.id)

    // The line reads as the dropped reading now, so that is what names its row. Opened, it
    // lists that reading as in use - not offered, since choosing it would change nothing -
    // and lets it go from there.
    const row = page.getByTestId('line-row').filter({ hasText: STRAY })
    await row.click()
    await expect(page.getByTestId('line-candidate').filter({ hasText: STRAY })).toHaveCount(0)
    const inUse = page.getByTestId('line-candidate-in-use').filter({ hasText: STRAY })
    await expect(inUse).toHaveCount(1)
    await expect(inUse.getByTestId('release-candidate')).toHaveAccessibleName('Release this reading')
    await expect(row.getByTestId('delete-line')).toHaveAccessibleName('Delete line')
    await inUse.getByTestId('release-candidate').click()

    await expect.poll(async () => (await stray(pageId)).line_id).toBeNull()
    // Back in the panel, beside the reading it displaced when it landed.
    await expect(page.getByTestId('unmatched-reading').filter({ hasText: STRAY })).toHaveCount(1)
    await expect(page.getByTestId('unmatched-reading')).toHaveCount(2)
  })
})

test.describe('Scenario: taking a reading without reaching for the mouse', () => {
  test('a reading dropped on a line becomes what the line says', async ({ page }) => {
    const { jobId, pageId, target } = await seedStrayReading(page, 'Drop takes it')
    expect(target.text).not.toBe(STRAY)

    await openViewer(page, jobId, pageId)
    await page.getByTestId('unmatched-reading').click()
    await page.getByTestId('line-row').filter({ hasText: TARGET }).click()

    // Attached, and taken: putting it there is the decision, not a step towards one.
    await expect.poll(async () => (await stray(pageId)).line_id).toBe(target.id)
    await expect.poll(async () =>
      (await pageLines(jobId, pageId)).find((l) => l.id === target.id)!.corrected_text)
      .toBe(STRAY)
  })

  test('a line somebody has reviewed keeps what they reviewed', async ({ page }) => {
    const { jobId, pageId, target } = await seedStrayReading(page, 'Drop spares checked')
    await correctLine(target.id, 'What a person settled on', true)

    await openViewer(page, jobId, pageId)
    await page.getByTestId('unmatched-reading').click()
    await page.getByTestId('line-row').filter({ hasText: 'What a person settled on' }).click()

    // The reading is filed against the line, and the line is left exactly as reviewed.
    await expect.poll(async () => (await stray(pageId)).line_id).toBe(target.id)
    const after = (await pageLines(jobId, pageId)).find((l) => l.id === target.id)!
    expect(after.corrected_text).toBe('What a person settled on')
    expect(after.checked).toBe(true)
  })
})

test.describe('Scenario: room for the readings and the lines at once', () => {
  test('they get a scroller each, and the divider decides the share', async ({ page }) => {
    const { jobId, pageId } = await seedStrayReading(page, 'Split panel')
    await openViewer(page, jobId, pageId)

    const readings = page.getByTestId('unmatched-pane')
    const lines = page.getByTestId('lines-pane')
    await expect(readings).toBeVisible()
    await expect(lines).toBeVisible()

    // The share of the panel they may take, which is what the divider sets. Their drawn
    // height follows their content up to it, so a page with one stray reading shows one
    // row however much room it is offered - the share is the thing that moved.
    const share = () => readings.evaluate((el) => el.style.maxHeight)
    const before = await share()
    const bar = (await page.getByTestId('readings-divider').boundingBox())!
    await page.mouse.move(bar.x + bar.width / 2, bar.y + bar.height / 2)
    await page.mouse.down()
    await page.mouse.move(bar.x + bar.width / 2, bar.y + 160, { steps: 8 })
    await page.mouse.up()
    await expect.poll(share).not.toBe(before)

    // And it is remembered, so the share is settled once rather than page by page.
    const after = await share()
    await openViewer(page, jobId, pageId)
    expect(await page.getByTestId('unmatched-pane').evaluate((el) => el.style.maxHeight))
      .toBe(after)
  })

  test('they fold down to their count, and stay folded', async ({ page }) => {
    const { jobId, pageId } = await seedStrayReading(page, 'Folded readings')
    await openViewer(page, jobId, pageId)

    const toggle = page.getByTestId('unmatched-toggle')
    await expect(toggle).toHaveText('1 reading matched no line')
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(page.getByTestId('unmatched-reading')).toHaveCount(1)
    await expect(page.getByTestId('readings-divider')).toBeVisible()

    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(page.getByTestId('unmatched-reading')).toHaveCount(0)
    await expect(page.getByTestId('readings-divider')).toHaveCount(0)
    await expect(page.getByTestId('line-row').first()).toBeVisible()

    // Remembered: the next page opens folded too.
    await openViewer(page, jobId, pageId)
    await expect(page.getByTestId('unmatched-toggle')).toHaveAttribute('aria-expanded', 'false')
    await expect(page.getByTestId('unmatched-reading')).toHaveCount(0)
    await page.getByTestId('unmatched-toggle').click()
    await expect(page.getByTestId('unmatched-reading')).toHaveCount(1)
  })

  test('a page with nothing unmatched is one list, not two', async ({ page }) => {
    const jobId = await seedDistinctPagesJob(uniqueName('Nothing stray'), 1)
    const [pageId] = await jobPageIds(jobId)
    await openViewer(page, jobId, pageId)

    // Paired with the lines that are there, so a broken selector cannot pass this.
    await expect(page.getByTestId('line-row').first()).toBeVisible()
    await expect(page.getByTestId('unmatched-pane')).toHaveCount(0)
    await expect(page.getByTestId('lines-pane')).toHaveCount(0)
  })
})

test.describe('Scenario: choosing a reading for a line', () => {
  test('the whole row accepts it, not a link at the end of it', async ({ page }) => {
    const { jobId, pageId } = await seedStrayReading(page, 'Row accept')
    const lines = await pageLines(jobId, pageId)
    const header = lines.find((l) => l.text === 'Sample Header line 1')!

    await openViewer(page, jobId, pageId)
    const row = page.getByTestId('line-row').filter({ hasText: 'Sample Header line 1' })
    // The model read this line exactly as the page has it, so its reading is the one
    // already in use - correct the line first, so there is something left to choose.
    await row.getByTestId('line-text').click()
    await page.getByTestId('line-editor').fill('Something else')
    await page.keyboard.press('Enter')

    // The click lands on the row itself, not on a link at the far end of it.
    const candidate = page.getByTestId('line-candidate').filter({ hasText: 'Sample Header line 1' })
    await candidate.getByTestId('accept-candidate').click()

    await expect.poll(async () =>
      (await pageLines(jobId, pageId)).find((l) => l.id === header.id)!.corrected_text,
    ).toBe('Sample Header line 1')
  })
})
